"""Worklio AI endpoints: Ask, summaries, catch-up, composer rewrites, translation, tasks.

Streaming endpoints answer `text/event-stream`; every event is one line
`data: <json>\\n\\n` where json is one of
  {"type": "status", "text"} | {"type": "text", "delta"} | {"type": "citations", "items"}
  | {"type": "done", "conversation_id"?, "usage"?} | {"type": "error", "code", "message"}.
Gating happens before the stream starts, so it arrives as normal HTTP errors: 404 (no access),
503 ai_not_configured (no provider/key for the workspace), 403 ai_feature_disabled (an admin
turned the feature off), 403 policy:use_ai (the workspace limits AI to admins; guests never),
429 rate_limited (the workspace's per-user budget).

Admin endpoints (owners/admins): GET/PUT /workspaces/{id}/ai/settings, POST .../ai/test,
GET .../ai/usage. Any member: GET /workspaces/{id}/ai/status.
"""

import asyncio
import contextlib
import json
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import Date, cast, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import productivity
from app.ai import prompts, providers
from app.ai import workspace as ai_ws
from app.ai.client import (
    FEATURES,
    AIError,
    AIRateLimited,
    ai_json,
    ai_stream,
    ai_text,
    ai_tool_loop,
    enforce_rate_limit,
    env_ai_enabled,
)
from app.ai.keys import encrypt_key, key_hint
from app.ai.retrieval import (
    Citations,
    NotAccessible,
    build_retrieval_tools,
    channel_history_for,
    channel_labels,
    get_thread_for,
    last_read_at,
    mentioned_ids,
    render_messages,
    unread_channels_for,
    user_names,
)
from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    WorkspaceMembership,
    require_workspace_admin,
)
from app.core.config import settings
from app.core.db import SessionLocal
from app.models import Channel, User, Workspace, WorkspaceMember
from app.models.ai import AIConversation, AITurn, AIUsage
from app.models.ai_settings import WorkspaceAISettings
from app.schemas_ai import (
    AIConversationDetailOut,
    AIConversationOut,
    AIStatusOut,
    AITurnOut,
    AskIn,
    CitationOut,
    ComposeIn,
    ComposeOut,
    LLMTaskList,
    LLMTranslation,
    SummaryIn,
    TaskOut,
    TasksOut,
    TranslateIn,
    TranslateOut,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])

Emit = Callable[[dict], Awaitable[None]]

# Context budgets (characters of rendered messages) so prompts stay well inside the window.
SUMMARY_MESSAGE_LIMIT = 400
CATCH_UP_PER_CHANNEL = 40
HISTORY_TURNS = 20


# --- Gating, limits, SSE plumbing ---------------------------------------------------------


def require_env_ai() -> None:
    """Legacy (workspace-less) endpoints: only the server's env key can serve them."""
    if not env_ai_enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "ai_not_configured")


def gate(feature: str):
    """Dependency for /workspaces/{workspace_id}/... routes (see ai_ws.require_ai)."""

    async def dep(workspace_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
        await ai_ws.require_ai(db, workspace_id, user.id, feature)

    return Depends(dep)


async def _rate_limit(user: User, feature: str, workspace_id: uuid.UUID | None = None) -> None:
    try:
        await enforce_rate_limit(user.id, feature, workspace_id=workspace_id)
    except AIRateLimited as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "rate_limited",
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


def stream_response(run: Callable[[Emit], Awaitable[None]]) -> StreamingResponse:
    """Run `run(emit)` in a task and stream whatever it emits as SSE.

    AI errors become a final {"type": "error"} event; a client disconnect cancels the task.
    """

    async def events():
        queue: asyncio.Queue[dict | None] = asyncio.Queue()

        async def emit(event: dict) -> None:
            await queue.put(event)

        async def runner() -> None:
            try:
                await run(emit)
            except AIError as exc:
                await queue.put({"type": "error", "code": exc.code, "message": exc.message})
            except Exception:
                log.exception("AI stream failed")
                await queue.put(
                    {
                        "type": "error",
                        "code": "failed",
                        "message": "Worklio AI couldn't finish that. Please try again.",
                    }
                )
            finally:
                await queue.put(None)

        task = asyncio.create_task(runner())
        try:
            while (event := await queue.get()) is not None:
                yield sse(event)
        finally:
            if not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


def _now() -> datetime:
    return datetime.now(UTC)


def _context(user: User, extra: str = "") -> str:
    now = _now()
    tz = f" Their timezone is {user.timezone}." if user.timezone else ""
    lines = [
        f"Today is {now:%A, %Y-%m-%d}, {now:%H:%M} UTC.{tz}",
        f"You are helping {user.full_name} (<@{user.id}>).",
    ]
    if extra:
        lines.append(extra)
    return "<context>\n" + "\n".join(lines) + "\n</context>"


async def _stream_answer(
    emit: Emit,
    system: str,
    messages: list[dict],
    citations: Citations,
    *,
    user: User,
    feature: str,
    workspace_id: uuid.UUID | None,
    effort: str = "medium",
) -> str:
    parts: list[str] = []
    async for delta in ai_stream(
        system, messages, effort=effort, user_id=user.id, feature=feature,
        workspace_id=workspace_id,
    ):
        parts.append(delta)
        await emit({"type": "text", "delta": delta})
    text = "".join(parts)
    await emit({"type": "citations", "items": citations.used_in(text)})
    return text


async def _say(emit: Emit, text: str) -> None:
    """Answer without calling Claude (nothing to summarize)."""
    await emit({"type": "text", "delta": text})
    await emit({"type": "citations", "items": []})
    await emit({"type": "done"})


# --- Status -------------------------------------------------------------------------------


@router.get("/ai/status", response_model=AIStatusOut)
async def ai_status(_: CurrentUser) -> AIStatusOut:
    """Legacy, server-wide status (env key only). Prefer GET /workspaces/{id}/ai/status."""
    enabled = env_ai_enabled()
    return AIStatusOut(
        enabled=enabled, model=settings.ai_model, features=FEATURES if enabled else []
    )


# --- Ask ----------------------------------------------------------------------------------

_CITE_MARK_RE = re.compile(r"\s?\[\d+(?:\s*,\s*\d+)*\]")


async def _history(db: AsyncSession, conversation_id: uuid.UUID) -> list[dict]:
    turns = list(
        await db.scalars(
            select(AITurn)
            .where(AITurn.conversation_id == conversation_id)
            .order_by(AITurn.created_at.desc())
            .limit(HISTORY_TURNS)
        )
    )
    turns.reverse()
    while turns and turns[0].role != "user":
        turns.pop(0)
    out: list[dict] = []
    for t in turns:
        # Old citation numbers mean nothing in a new answer: drop them from the history.
        content = _CITE_MARK_RE.sub("", t.content) if t.role == "assistant" else t.content
        if content.strip():
            out.append({"role": t.role, "content": content})
    return out


@router.post("/workspaces/{workspace_id}/ai/ask", dependencies=[gate("ask")])
async def ask(
    workspace_id: uuid.UUID,
    data: AskIn,
    db: DB,
    user: CurrentUser,
    _: WorkspaceMembership,
) -> StreamingResponse:
    conversation_id = data.conversation_id
    if conversation_id is not None:
        conv = await db.get(AIConversation, conversation_id)
        if not conv or conv.user_id != user.id or conv.workspace_id != workspace_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    await _rate_limit(user, "ask", workspace_id)
    question = data.question.strip()

    async def run(emit: Emit) -> None:
        async with SessionLocal() as s:
            await _ask(s, emit, user, workspace_id, question, conversation_id)

    return stream_response(run)


async def _ask(
    db: AsyncSession,
    emit: Emit,
    user: User,
    workspace_id: uuid.UUID,
    question: str,
    conversation_id: uuid.UUID | None,
) -> None:
    workspace = await db.get(Workspace, workspace_id)
    history: list[dict] = []
    if conversation_id is None:
        title = " ".join(question.split())
        conv = AIConversation(
            user_id=user.id,
            workspace_id=workspace_id,
            title=title[:80] + ("…" if len(title) > 80 else ""),
        )
        db.add(conv)
        await db.flush()
    else:
        conv = await db.get(AIConversation, conversation_id)
        history = await _history(db, conv.id)
    db.add(AITurn(conversation_id=conv.id, role="user", content=question))
    conv.updated_at = _now()
    await db.commit()

    await emit({"type": "status", "text": "Thinking…"})
    citations = Citations()
    tools = build_retrieval_tools(db, user, workspace_id, citations)
    ws_name = workspace.name if workspace else "this"
    messages = [
        *history,
        {
            "role": "user",
            "content": _context(user, f"Workspace: {ws_name}.") + "\n\n" + question,
        },
    ]

    async def on_status(text: str) -> None:
        await emit({"type": "status", "text": text})

    async def on_text(delta: str) -> None:
        await emit({"type": "text", "delta": delta})

    result = await ai_tool_loop(
        prompts.ASK_SYSTEM,
        messages,
        tools,
        effort="medium",
        user_id=user.id,
        feature="ask",
        workspace_id=workspace_id,
        on_status=on_status,
        on_text=on_text,
    )
    answer = result.text.strip()
    if not answer:
        answer = "I couldn't put together an answer this time. Try rephrasing the question."
        await on_text(answer)
    items = citations.used_in(answer)
    await emit({"type": "citations", "items": items})
    db.add(AITurn(conversation_id=conv.id, role="assistant", content=answer, citations=items))
    conv.updated_at = _now()
    await db.commit()
    await emit({"type": "done", "conversation_id": str(conv.id), "usage": result.usage.as_dict()})


# --- Conversations ------------------------------------------------------------------------


@router.get(
    "/workspaces/{workspace_id}/ai/conversations",
    response_model=list[AIConversationOut],
    dependencies=[gate("ask")],
)
async def list_conversations(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser, _: WorkspaceMembership
) -> list[AIConversation]:
    return list(
        await db.scalars(
            select(AIConversation)
            .where(AIConversation.user_id == user.id, AIConversation.workspace_id == workspace_id)
            .order_by(AIConversation.updated_at.desc())
            .limit(100)
        )
    )


async def _own_conversation(db: AsyncSession, user: User, conversation_id: uuid.UUID):
    conv = await db.get(AIConversation, conversation_id)
    if not conv or conv.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    # Leaving a workspace hides its conversations too.
    member = await db.scalar(
        select(WorkspaceMember.id).where(
            WorkspaceMember.workspace_id == conv.workspace_id, WorkspaceMember.user_id == user.id
        )
    )
    if not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    return conv


@router.get(
    "/ai/conversations/{conversation_id}",
    response_model=AIConversationDetailOut,
)
async def get_conversation(
    conversation_id: uuid.UUID, db: DB, user: CurrentUser
) -> AIConversationDetailOut:
    conv = await _own_conversation(db, user, conversation_id)
    await ai_ws.require_ai(db, conv.workspace_id, user.id, "ask")
    turns = list(
        await db.scalars(
            select(AITurn).where(AITurn.conversation_id == conv.id).order_by(AITurn.created_at)
        )
    )
    return AIConversationDetailOut(
        id=conv.id,
        workspace_id=conv.workspace_id,
        title=conv.title,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        turns=[
            AITurnOut(
                id=t.id,
                role=t.role,
                content=t.content,
                citations=[CitationOut.model_validate(c) for c in (t.citations or [])],
                created_at=t.created_at,
            )
            for t in turns
        ],
    )


@router.delete(
    "/ai/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_conversation(conversation_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    conv = await _own_conversation(db, user, conversation_id)
    await db.execute(delete(AIConversation).where(AIConversation.id == conv.id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Summaries ----------------------------------------------------------------------------

_RANGE_TEXT = {
    "unread": "the person's unread messages",
    "24h": "the last 24 hours",
    "7d": "the last 7 days",
    "all": "the channel's history",
}


@router.post("/channels/{channel_id}/ai/summary")
async def summarize_channel(
    data: SummaryIn, channel: ChannelAccess, db: DB, user: CurrentUser
) -> StreamingResponse:
    await ai_ws.require_ai(db, channel.workspace_id, user.id, "channel_summary")
    await _rate_limit(user, "channel_summary", channel.workspace_id)
    channel_id, workspace_id, rng = channel.id, channel.workspace_id, data.range

    async def run(emit: Emit) -> None:
        async with SessionLocal() as s:
            ch = await s.get(Channel, channel_id)
            label = (await channel_labels(s, [ch], user.id))[ch.id]
            now = _now()
            since: datetime | None = None
            if rng == "unread":
                since = await last_read_at(s, channel_id, user.id) or now - timedelta(hours=24)
            elif rng == "24h":
                since = now - timedelta(hours=24)
            elif rng == "7d":
                since = now - timedelta(days=7)
            await emit({"type": "status", "text": f"Reading {label}…"})
            msgs = await channel_history_for(
                user, channel_id, since=since, limit=SUMMARY_MESSAGE_LIMIT, db=s
            )
            if rng == "unread":
                msgs_others = [m for m in msgs if m.author_id != user.id]
                if not msgs_others:
                    await _say(emit, prompts.NOTHING_FOUND["unread"])
                    return
            if not msgs:
                await _say(emit, prompts.NOTHING_FOUND[rng])
                return
            citations = Citations()
            rendered = await render_messages(s, msgs, citations, user.id, show_channel=False)
            capped = (
                f" Only the most recent {SUMMARY_MESSAGE_LIMIT} messages are included."
                if len(msgs) >= SUMMARY_MESSAGE_LIMIT
                else ""
            )
            prompt = (
                _context(user, f"Channel: {label}. Range: {_RANGE_TEXT[rng]}.{capped}")
                + f"\n\n<messages>\n{rendered}\n</messages>\n\n"
                + f"Summarize {_RANGE_TEXT[rng]} in {label}."
            )
            await emit({"type": "status", "text": f"Summarizing {len(msgs)} messages…"})
            await _stream_answer(
                emit, prompts.SUMMARY_SYSTEM, [{"role": "user", "content": prompt}], citations,
                user=user, feature="channel_summary", workspace_id=workspace_id,
            )
            await emit({"type": "done"})

    return stream_response(run)


async def _readable_message(db: AsyncSession, user: User, message_id: uuid.UUID):
    return await productivity.get_readable_message(db, user, message_id)


@router.post("/messages/{message_id}/ai/thread-summary")
async def summarize_thread(message_id: uuid.UUID, db: DB, user: CurrentUser) -> StreamingResponse:
    msg, _ = await _readable_message(db, user, message_id)
    await ai_ws.require_ai(db, msg.workspace_id, user.id, "thread_summary")
    await _rate_limit(user, "thread_summary", msg.workspace_id)
    workspace_id = msg.workspace_id

    async def run(emit: Emit) -> None:
        async with SessionLocal() as s:
            await emit({"type": "status", "text": "Reading the thread…"})
            try:
                thread = await get_thread_for(user, message_id, db=s)
            except NotAccessible:
                await _say(emit, "That thread is no longer available.")
                return
            citations = Citations()
            rendered = await render_messages(s, thread, citations, user.id)
            prompt = (
                _context(user, f"The thread has {len(thread) - 1} replies.")
                + f"\n\n<thread>\n{rendered}\n</thread>\n\nSummarize this thread."
            )
            await _stream_answer(
                emit, prompts.THREAD_SUMMARY_SYSTEM, [{"role": "user", "content": prompt}],
                citations, user=user, feature="thread_summary", workspace_id=workspace_id,
            )
            await emit({"type": "done"})

    return stream_response(run)


@router.post("/workspaces/{workspace_id}/ai/catch-up", dependencies=[gate("catch_up")])
async def catch_up(
    workspace_id: uuid.UUID, user: CurrentUser, _: WorkspaceMembership
) -> StreamingResponse:
    await _rate_limit(user, "catch_up", workspace_id)

    async def run(emit: Emit) -> None:
        async with SessionLocal() as s:
            await emit({"type": "status", "text": "Finding your unread messages…"})
            unread = await unread_channels_for(s, user, workspace_id, limit=15)
            if not unread:
                await _say(emit, "You're all caught up. Nothing is unread across your channels.")
                return
            await emit(
                {
                    "type": "status",
                    "text": f"Reading {len(unread)} channel{'s' if len(unread) != 1 else ''}…",
                }
            )
            citations = Citations()
            sections: list[str] = []
            for u in unread:
                try:
                    msgs = await channel_history_for(
                        user, u.channel.id, since=u.last_read_at, limit=CATCH_UP_PER_CHANNEL,
                        include_replies=False, db=s,
                    )
                except NotAccessible:
                    continue
                msgs = [m for m in msgs if m.author_id != user.id] or msgs
                if not msgs:
                    continue
                rendered = await render_messages(s, msgs, citations, user.id, show_channel=False)
                shown = f' showing_latest="{len(msgs)}"' if u.unread > len(msgs) else ""
                sections.append(
                    f'<channel name="{u.label}" unread="{u.unread}" '
                    f'mentions_you="{u.mentions}"{shown}>\n{rendered}\n</channel>'
                )
            if not sections:
                await _say(emit, "You're all caught up. Nothing is unread across your channels.")
                return
            prompt = (
                _context(user)
                + "\n\n<unread>\n"
                + "\n\n".join(sections)
                + "\n</unread>\n\nWrite my catch-up digest."
            )
            await emit({"type": "status", "text": "Writing your catch-up…"})
            await _stream_answer(
                emit, prompts.CATCH_UP_SYSTEM, [{"role": "user", "content": prompt}], citations,
                user=user, feature="catch_up", workspace_id=workspace_id,
            )
            await emit({"type": "done"})

    return stream_response(run)


# --- Composer, translation, tasks ---------------------------------------------------------

_TOKEN_RE = re.compile(r"<@([0-9a-fA-F-]{36})>|<!subteam\^([0-9a-fA-F-]{36})>")
_PLACEHOLDER_RE = re.compile(r"<@m\d+>|<!subteam\^g\d+>")


def mask_tokens(text: str) -> tuple[str, dict[str, str]]:
    """Swap user/group mention ids for short placeholders (<@m1>, <!subteam^g1>)."""
    mapping: dict[str, str] = {}
    by_token: dict[str, str] = {}

    def repl(m: re.Match) -> str:
        token = m.group(0)
        if token not in by_token:
            if m.group(1):
                placeholder = f"<@m{sum(k.startswith('<@m') for k in mapping) + 1}>"
            else:
                placeholder = f"<!subteam^g{sum(k.startswith('<!') for k in mapping) + 1}>"
            by_token[token] = placeholder
            mapping[placeholder] = token
        return by_token[token]

    return _TOKEN_RE.sub(repl, text), mapping


def unmask_tokens(text: str, mapping: dict[str, str]) -> str:
    """Restore placeholders; drop invented ones; keep any the model dropped (prepended)."""
    present = set(_PLACEHOLDER_RE.findall(text))
    out = _PLACEHOLDER_RE.sub(lambda m: mapping.get(m.group(0), ""), text)
    missing = [token for placeholder, token in mapping.items() if placeholder not in present]
    if missing:
        out = " ".join(missing) + " " + out
    return out.strip()


def _strip_wrapping(text: str) -> str:
    t = text.strip()
    if t.startswith("```") and t.endswith("```") and t.count("```") == 2:
        t = t[3:-3].split("\n", 1)[-1] if "\n" in t[3:-3] else t[3:-3]
    return t.strip()


class WorkspaceComposeIn(ComposeIn):
    # Which workspace's AI provider/settings to use (omit only for the legacy env-key path).
    workspace_id: uuid.UUID | None = None


@router.post("/ai/compose", response_model=ComposeOut)
async def compose(
    data: WorkspaceComposeIn,
    db: DB,
    user: CurrentUser,
    workspace_id: Annotated[uuid.UUID | None, Query()] = None,
) -> ComposeOut:
    """Rewrite a draft. Pass `workspace_id` (query or body) to use that workspace's AI
    settings; without it only the server's env key can serve the request (legacy)."""
    ws_id = workspace_id or data.workspace_id
    if ws_id is None:
        require_env_ai()
    return await _compose(db, user, data, ws_id)


@router.post("/workspaces/{workspace_id}/ai/compose", response_model=ComposeOut)
async def compose_in_workspace(
    workspace_id: uuid.UUID, data: ComposeIn, db: DB, user: CurrentUser
) -> ComposeOut:
    return await _compose(db, user, data, workspace_id)


async def _compose(
    db: AsyncSession, user: User, data: ComposeIn, workspace_id: uuid.UUID | None
) -> ComposeOut:
    if workspace_id is not None:
        await ai_ws.require_ai(db, workspace_id, user.id, "compose")
    if data.action == "translate" and not (data.target_language or "").strip():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "target_language is required to translate"
        )
    await _rate_limit(user, "compose", workspace_id)
    masked, mapping = mask_tokens(data.text)
    instruction = prompts.COMPOSE_ACTIONS[data.action].format(
        language=(data.target_language or "").strip()
    )
    try:
        result = await ai_text(
            prompts.COMPOSE_SYSTEM,
            [
                {
                    "role": "user",
                    "content": f"Action: {data.action}. {instruction}\n\n<draft>\n{masked}\n</draft>",
                }
            ],
            effort="low",
            max_tokens=8000,
            user_id=user.id,
            feature="compose",
            workspace_id=workspace_id,
        )
    except AIError as exc:
        raise _http_error(exc) from exc
    return ComposeOut(
        text=unmask_tokens(_strip_wrapping(result), mapping), truncated=result.truncated
    )


def _http_error(exc: AIError) -> HTTPException:
    if isinstance(exc, AIRateLimited):
        return HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "rate_limited",
            headers={"Retry-After": str(exc.retry_after)},
        )
    if exc.code == "refusal":
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, exc.message)
    if exc.code == "ai_not_configured":
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "ai_not_configured")
    return HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message)


@router.post("/messages/{message_id}/ai/translate", response_model=TranslateOut)
async def translate_message(
    message_id: uuid.UUID, data: TranslateIn, db: DB, user: CurrentUser
) -> TranslateOut:
    msg, _ = await _readable_message(db, user, message_id)
    if not msg.body.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "This message has no text")
    await ai_ws.require_ai(db, msg.workspace_id, user.id, "translate")
    await _rate_limit(user, "translate", msg.workspace_id)
    masked, mapping = mask_tokens(msg.body)
    try:
        out = await ai_json(
            prompts.TRANSLATE_SYSTEM,
            [
                {
                    "role": "user",
                    "content": (
                        f"Target language: {data.target_language.strip()}\n\n"
                        f"<message>\n{masked}\n</message>"
                    ),
                }
            ],
            LLMTranslation,
            effort="low",
            user_id=user.id,
            feature="translate",
            workspace_id=msg.workspace_id,
        )
    except AIError as exc:
        raise _http_error(exc) from exc
    return TranslateOut(
        text=unmask_tokens(out.text, mapping),
        detected_language=out.detected_language.strip() or "Unknown",
    )


@router.post("/messages/{message_id}/ai/tasks", response_model=TasksOut)
async def extract_tasks(message_id: uuid.UUID, db: DB, user: CurrentUser) -> TasksOut:
    msg, _ = await _readable_message(db, user, message_id)
    await ai_ws.require_ai(db, msg.workspace_id, user.id, "tasks")
    await _rate_limit(user, "tasks", msg.workspace_id)
    try:
        thread = await get_thread_for(user, message_id, db=db)
    except NotAccessible as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found") from exc
    citations = Citations()
    rendered = await render_messages(db, thread, citations, user.id)
    people_ids = sorted(
        {m.author_id for m in thread} | mentioned_ids(thread) | {user.id}, key=str
    )
    names = await user_names(db, set(people_ids))
    members = set(
        await db.scalars(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == msg.workspace_id,
                WorkspaceMember.user_id.in_(people_ids),
            )
        )
    )
    people = [uid for uid in people_ids if uid in members]
    roster = "\n".join(
        f"{i}. {names.get(uid, 'Unknown')} (<@{uid}>)" for i, uid in enumerate(people, 1)
    )
    prompt = (
        _context(user)
        + f"\n\n<people>\n{roster}\n</people>\n\n<conversation>\n{rendered}\n</conversation>"
        + "\n\nExtract the follow-up tasks."
    )
    try:
        result = await ai_json(
            prompts.TASKS_SYSTEM,
            [{"role": "user", "content": prompt}],
            LLMTaskList,
            effort="low",
            user_id=user.id,
            feature="tasks",
            workspace_id=msg.workspace_id,
        )
    except AIError as exc:
        raise _http_error(exc) from exc
    tasks: list[TaskOut] = []
    root_id = thread[0].id
    for t in result.tasks[:25]:
        title = " ".join(t.title.split())[:200]
        if not title:
            continue
        assignee = (
            people[t.assignee_ref - 1]
            if t.assignee_ref is not None and 1 <= t.assignee_ref <= len(people)
            else None
        )
        due: date | None = None
        if t.due_date:
            try:
                due = date.fromisoformat(t.due_date[:10])
            except ValueError:
                due = None
        source = citations.message(t.source_ref)
        tasks.append(
            TaskOut(
                title=title,
                assignee_id=assignee,
                due_date=due,
                source_message_id=source.id if source else root_id,
            )
        )
    return TasksOut(tasks=tasks)


# --- Workspace AI settings (admins) -------------------------------------------------------

Provider = Literal["anthropic", "gemini", "deepseek"]
_MODEL_RE = re.compile(r"^[A-Za-z0-9._:/@-]+$")
TEST_LIMIT_PER_WINDOW = 30


class AISettingsOut(BaseModel):
    provider: Provider | None
    model: str | None
    key_set: bool
    key_hint: str | None
    source: Literal["workspace", "env"] | None
    features: dict[str, bool]
    per_user_limit: int
    updated_at: datetime | None
    updated_by: uuid.UUID | None


class AISettingsIn(BaseModel):
    """Partial update. `api_key` is write-only: a value sets it, "" (or null) clears it.
    Switching `provider` without a new `api_key` clears the old provider's key and model."""

    provider: Provider | None = None
    model: str | None = Field(default=None, max_length=120)
    api_key: str | None = Field(default=None, max_length=500)
    features: dict[str, bool] | None = None
    per_user_limit: int | None = Field(default=None, ge=1, le=ai_ws.PER_USER_LIMIT_MAX)


class AITestIn(BaseModel):
    provider: Provider
    model: str | None = Field(default=None, max_length=120)
    # Omit to test the key already saved for this provider (or the env key for Anthropic).
    api_key: str | None = Field(default=None, max_length=500)


class AITestOut(BaseModel):
    ok: bool
    latency_ms: int
    models: list[str]
    suggested_model: str | None = None
    error: str | None = None


class UsageDayOut(BaseModel):
    date: date
    requests: int
    input_tokens: int
    output_tokens: int


class UsageFeatureOut(BaseModel):
    feature: str
    requests: int
    input_tokens: int
    output_tokens: int


class UsageUserOut(BaseModel):
    user_id: uuid.UUID | None
    full_name: str | None
    requests: int
    input_tokens: int
    output_tokens: int


class AIUsageOut(BaseModel):
    days: int
    by_day: list[UsageDayOut]
    by_feature: list[UsageFeatureOut]
    by_user: list[UsageUserOut]


class WorkspaceAIStatusOut(BaseModel):
    enabled: bool
    provider: Provider | None
    model: str | None
    features: dict[str, bool]
    # Owners/admins can open the AI settings.
    can_configure: bool
    # The use_ai policy allows the requesting member to use AI.
    can_use: bool
    agent_installed_channel_ids: list[uuid.UUID]
    agent_installed_everywhere: bool


def _settings_out(cfg: ai_ws.WorkspaceAIConfig | None) -> AISettingsOut:
    effective = ai_ws.provider_from(cfg)
    if cfg is not None and cfg.provider:
        provider: str | None = cfg.provider
        # Gemini has no fixed default: the admin picks from the live model list.
        model = cfg.model or (ai_ws.default_model(cfg.provider) if cfg.provider != "gemini" else None)
    else:
        provider = effective.provider if effective else None
        model = effective.model if effective else None
    return AISettingsOut(
        provider=provider,
        model=model,
        key_set=bool(cfg and cfg.key_set),
        key_hint=cfg.key_hint if cfg and cfg.key_set else None,
        source=effective.source if effective else None,
        features=ai_ws.features_of(cfg),
        per_user_limit=ai_ws.per_user_limit(cfg),
        updated_at=cfg.updated_at if cfg else None,
        updated_by=cfg.updated_by if cfg else None,
    )


async def _fresh_config(db: AsyncSession, workspace_id: uuid.UUID) -> ai_ws.WorkspaceAIConfig | None:
    ai_ws.invalidate(workspace_id)
    return await ai_ws.load_config(workspace_id, db)


@router.get(
    "/workspaces/{workspace_id}/ai/settings",
    response_model=AISettingsOut,
    dependencies=[Depends(require_workspace_admin)],
)
async def get_ai_settings(workspace_id: uuid.UUID, db: DB) -> AISettingsOut:
    return _settings_out(await _fresh_config(db, workspace_id))


@router.put(
    "/workspaces/{workspace_id}/ai/settings",
    response_model=AISettingsOut,
    dependencies=[Depends(require_workspace_admin)],
)
async def update_ai_settings(
    workspace_id: uuid.UUID, data: AISettingsIn, db: DB, user: CurrentUser
) -> AISettingsOut:
    fields = data.model_fields_set
    row = await db.get(WorkspaceAISettings, workspace_id, with_for_update=True)
    if row is None:
        row = WorkspaceAISettings(workspace_id=workspace_id, features={})
        db.add(row)
    changes: list[str] = []
    key_change: str | None = None

    def clear_key() -> None:
        nonlocal key_change
        if row.api_key_encrypted:
            key_change = "cleared"
        row.api_key_encrypted, row.key_hint = None, None

    if "provider" in fields and data.provider != row.provider:
        changes.append("provider")
        row.provider = data.provider
        if "api_key" not in fields:
            clear_key()  # a key belongs to one provider: never send it to another
        if "model" not in fields and row.model is not None:
            row.model = None
            changes.append("model")
        if data.provider is None:
            clear_key()
            row.model = None
    if "model" in fields:
        model = (data.model or "").strip() or None
        if model is not None and not _MODEL_RE.match(model):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid model id")
        if model is not None and row.provider is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a provider before a model"
            )
        if model != row.model:
            row.model = model
            changes.append("model")
    if "api_key" in fields:
        key = (data.api_key or "").strip()
        if not key:
            clear_key()
        else:
            if row.provider is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a provider before adding a key"
                )
            if len(key) < 8 or any(c.isspace() for c in key):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That doesn't look like an API key")
            row.api_key_encrypted, row.key_hint = encrypt_key(key), key_hint(key)
            key_change = "set"
    if key_change and "api_key" not in changes:
        changes.append("api_key")
    if "features" in fields and data.features is not None:
        unknown = set(data.features) - set(ai_ws.FEATURE_KEYS)
        if unknown:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown features: {', '.join(sorted(unknown))}"
            )
        merged = {**(row.features or {}), **data.features}
        if merged != (row.features or {}):
            row.features = merged
            changes.append("features")
    if "per_user_limit" in fields and data.per_user_limit != row.per_user_limit:
        row.per_user_limit = data.per_user_limit
        changes.append("per_user_limit")
    row.updated_by = user.id
    row.updated_at = _now()
    if changes:
        # Never a key (or any part of one) in the audit log.
        await ai_ws.audit(
            db, workspace_id, user.id, "ai.settings_updated",
            target_type="workspace", target_id=workspace_id,
            meta={
                "changes": changes,
                "provider": row.provider,
                "model": row.model,
                "key": key_change,
                "features": data.features if "features" in changes else None,
                "per_user_limit": row.per_user_limit if "per_user_limit" in changes else None,
            },
        )
    await db.commit()
    log.info("AI settings of workspace %s updated by %s: %s", workspace_id, user.id, changes)
    return _settings_out(await _fresh_config(db, workspace_id))


async def _test_rate_limit(workspace_id: uuid.UUID, user: User) -> None:
    from app.core.redis import redis

    window = max(1, settings.ai_rate_limit_window_seconds)
    key = f"rl:ai-test:{workspace_id}:{user.id}:{int(_now().timestamp()) // window}"
    async with redis.pipeline() as pipe:
        count, _ = await pipe.incr(key).expire(key, window).execute()
    if count > TEST_LIMIT_PER_WINDOW:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "rate_limited")


@router.post(
    "/workspaces/{workspace_id}/ai/test",
    response_model=AITestOut,
    response_model_exclude_none=True,
    dependencies=[Depends(require_workspace_admin)],
)
async def run_ai_test(
    workspace_id: uuid.UUID, data: AITestIn, db: DB, user: CurrentUser
) -> dict:
    """Check a provider key (typed, or the saved one) and list the models it can use."""
    key = (data.api_key or "").strip()
    if not key:
        cfg = await _fresh_config(db, workspace_id)
        if cfg is not None and cfg.provider == data.provider and cfg.key_set:
            from app.ai.keys import decrypt_key

            key = decrypt_key(cfg.api_key_encrypted) or ""
        elif data.provider == "anthropic" and settings.anthropic_api_key:
            key = settings.anthropic_api_key
    if not key:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "api_key is required")
    model = (data.model or "").strip() or None
    if model is not None and not _MODEL_RE.match(model):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid model id")
    await _test_rate_limit(workspace_id, user)
    return await providers.check_connection(data.provider, key, model)


@router.get(
    "/workspaces/{workspace_id}/ai/usage",
    response_model=AIUsageOut,
    dependencies=[Depends(require_workspace_admin)],
)
async def ai_usage(
    workspace_id: uuid.UUID, db: DB, days: Annotated[int, Query(ge=1, le=365)] = 30
) -> AIUsageOut:
    since = _now() - timedelta(days=days)
    where = (AIUsage.workspace_id == workspace_id, AIUsage.created_at >= since)
    input_sum = func.coalesce(
        func.sum(AIUsage.input_tokens + AIUsage.cache_read_tokens + AIUsage.cache_write_tokens), 0
    )
    output_sum = func.coalesce(func.sum(AIUsage.output_tokens), 0)
    day = cast(func.timezone("UTC", AIUsage.created_at), Date)
    by_day = (
        await db.execute(
            select(day, func.count(), input_sum, output_sum).where(*where).group_by(day).order_by(day)
        )
    ).all()
    by_feature_raw = (
        await db.execute(
            select(AIUsage.feature, func.count(), input_sum, output_sum)
            .where(*where)
            .group_by(AIUsage.feature)
        )
    ).all()
    grouped: dict[str, list[int]] = {}
    for feature, n, inp, out in by_feature_raw:
        acc = grouped.setdefault(ai_ws.FEATURE_TOGGLE.get(feature, feature), [0, 0, 0])
        acc[0] += n
        acc[1] += int(inp)
        acc[2] += int(out)
    by_user = (
        await db.execute(
            select(AIUsage.user_id, User.full_name, func.count(), input_sum, output_sum)
            .outerjoin(User, User.id == AIUsage.user_id)
            .where(*where)
            .group_by(AIUsage.user_id, User.full_name)
            .order_by(func.count().desc())
            .limit(100)
        )
    ).all()
    return AIUsageOut(
        days=days,
        by_day=[
            UsageDayOut(date=d, requests=n, input_tokens=int(i), output_tokens=int(o))
            for d, n, i, o in by_day
        ],
        by_feature=sorted(
            (
                UsageFeatureOut(feature=f, requests=v[0], input_tokens=v[1], output_tokens=v[2])
                for f, v in grouped.items()
            ),
            key=lambda x: -x.requests,
        ),
        by_user=[
            UsageUserOut(user_id=u, full_name=name, requests=n, input_tokens=int(i), output_tokens=int(o))
            for u, name, n, i, o in by_user
        ],
    )


@router.get("/workspaces/{workspace_id}/ai/status", response_model=WorkspaceAIStatusOut)
async def workspace_ai_status(
    workspace_id: uuid.UUID, db: DB, member: WorkspaceMembership
) -> WorkspaceAIStatusOut:
    cfg = await ai_ws.load_config(workspace_id, db)
    effective = ai_ws.provider_from(cfg)
    channel_ids, everywhere = await ai_ws.installs_of(db, workspace_id)
    policy = await ai_ws.policy_value(db, workspace_id, ai_ws.USE_AI_POLICY)
    return WorkspaceAIStatusOut(
        enabled=effective is not None,
        provider=effective.provider if effective else None,
        model=effective.model if effective else None,
        features=ai_ws.features_of(cfg),
        can_configure=ai_ws.is_admin_role(member.role),
        can_use=effective is not None and ai_ws.role_allowed(member.role, policy),
        agent_installed_channel_ids=channel_ids,
        agent_installed_everywhere=everywhere,
    )
