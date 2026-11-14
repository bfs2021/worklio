"""Live call captions and the AI call summary.

Captions: each participant's browser transcribes its own microphone and posts segments
(`POST /calls/{id}/captions`). Every segment is relayed to the call's channel as
`call.caption` so everyone sees live subtitles; *final* segments are also stored in
`call_transcript_segments`, which feeds the transcript view and the AI call summary.

AI call summary: when a call ends with enough material (>= MIN_SEGMENTS_FOR_SUMMARY final
segments, or non-empty notes) and AI is enabled, a Celery task asks Claude for
{summary, decisions[], action_items[]} and posts it as a system thread reply under the call
card (meta {type: "call_ai_summary", call_id, action_items}). Regenerating replaces it.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import calls
from app.models import Call, CallTranscriptSegment, Message, User, WorkspaceMember
from app.realtime.hub import allow_per_second, publish_to_channel
from app.services import serialize_message

log = logging.getLogger(__name__)

MAX_CAPTION_CHARS = 2000
# Interim + final frames per user per call per second (speech recognisers emit many interims).
CAPTIONS_PER_SECOND = 8
# Hard cap on stored segments per call (a very long call keeps its first ~10k utterances).
MAX_SEGMENTS_PER_CALL = 10_000
MIN_SEGMENTS_FOR_SUMMARY = 3
# How much transcript is sent to the model (characters, newest material wins if over).
MAX_TRANSCRIPT_CHARS = 400_000
SUMMARY_META_TYPE = "call_ai_summary"


def _now() -> datetime:
    return datetime.now(UTC)


# --- Captions --------------------------------------------------------------------------------


def is_participant(call: Call, user_id: uuid.UUID) -> bool:
    return calls.is_live(call) and user_id in call.joined_ids


def _clamp_started_at(call: Call, started_at: datetime | None) -> datetime:
    """Client clocks drift: keep the timestamp within the call's lifetime and not in the future."""
    now = _now()
    if started_at is None:
        return now
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=UTC)
    lower = call.started_at - timedelta(seconds=5)
    return min(max(started_at, lower), now)


async def post_caption(
    db: AsyncSession, call: Call, user: User, text: str, final: bool, started_at: datetime | None
) -> dict:
    """Relay one caption frame to the call's channel (and store it when final)."""
    if not is_participant(call, user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only people in the call can send captions")
    if not await allow_per_second("caption", user.id, str(call.id), CAPTIONS_PER_SECOND):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many captions, slow down")
    text = " ".join(text.split())[:MAX_CAPTION_CHARS]
    ts = _clamp_started_at(call, started_at)
    event = {
        "type": "call.caption",
        "call_id": str(call.id),
        "user_id": str(user.id),
        "text": text,
        "final": final,
        "ts": ts.isoformat(),
    }
    if final and text:
        count = await db.scalar(
            select(func.count()).where(CallTranscriptSegment.call_id == call.id)
        )
        if count < MAX_SEGMENTS_PER_CALL:
            db.add(CallTranscriptSegment(call_id=call.id, user_id=user.id, text=text, started_at=ts))
            await db.commit()
    await publish_to_channel(call.channel_id, event)
    return event


async def transcript(db: AsyncSession, call_id: uuid.UUID) -> list[CallTranscriptSegment]:
    return list(
        await db.scalars(
            select(CallTranscriptSegment)
            .where(CallTranscriptSegment.call_id == call_id)
            .order_by(CallTranscriptSegment.started_at, CallTranscriptSegment.created_at)
        )
    )


async def delete_transcript(db: AsyncSession, call_id: uuid.UUID) -> None:
    await db.execute(delete(CallTranscriptSegment).where(CallTranscriptSegment.call_id == call_id))
    await db.commit()


def segment_out(seg: CallTranscriptSegment) -> dict:
    return {"user_id": str(seg.user_id), "text": seg.text, "ts": seg.started_at.isoformat()}


# --- AI call summary -------------------------------------------------------------------------


class ActionItem(BaseModel):
    title: str = Field(description="What needs doing, imperative, under 120 characters.")
    assignee_id: str | None = Field(
        default=None,
        description="user_id of the person who owns it, only if clearly stated; else null.",
    )


class CallSummary(BaseModel):
    summary: str = Field(description="2-5 sentence overview of the call, in markdown.")
    decisions: list[str] = Field(description="Decisions that were made. Empty if none.")
    action_items: list[ActionItem] = Field(description="Follow-ups. Empty if none.")


SUMMARY_SYSTEM = """You are Worklio AI, the assistant built into the Worklio team chat app.
You summarise a finished audio/video call for the people who were in it and teammates who
missed it. You get the call transcript (one line per utterance: [time] Name (user_id): text)
and/or the shared call notes.

Rules:
- Only use what is in the transcript and notes. Never invent decisions, owners or dates.
- Transcripts come from live speech recognition and contain errors; interpret charitably.
- The summary is 2-5 sentences, plain and specific. Decisions are short statements.
- Action items: one per concrete follow-up. Set assignee_id to the speaker's user_id only
  when someone clearly took or was given the task; otherwise null.
- Write in the language most of the call was held in."""


async def has_summary_material(db: AsyncSession, call: Call) -> bool:
    if calls.notes_to_text(call.notes or {}):
        return True
    count = await db.scalar(
        select(func.count()).where(CallTranscriptSegment.call_id == call.id)
    )
    return (count or 0) >= MIN_SEGMENTS_FOR_SUMMARY


async def _names(db: AsyncSession, user_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not user_ids:
        return {}
    rows = await db.execute(select(User.id, User.full_name).where(User.id.in_(user_ids)))
    return dict(rows.all())


async def build_summary_prompt(db: AsyncSession, call: Call) -> str:
    segments = await transcript(db, call.id)
    names = await _names(db, {s.user_id for s in segments} | set(call.joined_ids))
    lines = []
    for s in segments:
        offset = max(0, int((s.started_at - call.started_at).total_seconds()))
        stamp = f"{offset // 3600:02d}:{offset % 3600 // 60:02d}:{offset % 60:02d}"
        lines.append(f"[{stamp}] {names.get(s.user_id, 'Someone')} ({s.user_id}): {s.text}")
    text = "\n".join(lines)
    if len(text) > MAX_TRANSCRIPT_CHARS:
        text = "[... earlier part of the call omitted ...]\n" + text[-MAX_TRANSCRIPT_CHARS:]
    people = "\n".join(f"- {names.get(u, 'Someone')} (user_id {u})" for u in call.joined_ids)
    notes = calls.notes_to_text(call.notes or {})
    parts = [f"<participants>\n{people or '(unknown)'}\n</participants>"]
    if text:
        parts.append(f"<transcript>\n{text}\n</transcript>")
    if notes:
        parts.append(f"<notes>\n{notes}\n</notes>")
    parts.append("Summarise this call.")
    return "\n\n".join(parts)


async def _valid_assignees(db: AsyncSession, call: Call, ids: set[str]) -> set[uuid.UUID]:
    parsed = set()
    for raw in ids:
        try:
            parsed.add(uuid.UUID(raw))
        except (ValueError, TypeError):
            continue
    if not parsed:
        return set()
    return set(
        await db.scalars(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == call.workspace_id,
                WorkspaceMember.user_id.in_(parsed),
            )
        )
    )


def summary_body(result: dict) -> str:
    """Markdown body of the summary reply (the structured data also lives in meta)."""
    out = ["**✨ AI call summary**", "", result["summary"].strip()]
    if result["decisions"]:
        out += ["", "**Decisions**", *(f"- {d}" for d in result["decisions"])]
    if result["action_items"]:
        out += ["", "**Action items**"]
        for item in result["action_items"]:
            who = f" <@{item['assignee_id']}>" if item.get("assignee_id") else ""
            out.append(f"- [ ]{who} {item['title']}")
    out += ["", "_Generated by Worklio AI from the call transcript and notes. AI can make mistakes._"]
    return "\n".join(out)


async def generate_summary(db: AsyncSession, call: Call, *, requested_by: uuid.UUID | None) -> dict:
    """Ask Claude for the structured summary. Raises the client's AI* errors."""
    from app.ai import client as ai

    prompt = await build_summary_prompt(db, call)
    parsed = await ai.ai_json(
        SUMMARY_SYSTEM,
        [{"role": "user", "content": prompt}],
        CallSummary,
        effort="medium",
        user_id=requested_by,
        feature="call_summary",
        workspace_id=call.workspace_id,
    )
    data = parsed.model_dump() if isinstance(parsed, BaseModel) else dict(parsed)
    valid = {
        str(u)
        for u in await _valid_assignees(
            db, call, {i.get("assignee_id") for i in data["action_items"] if i.get("assignee_id")}
        )
    }
    return {
        "summary": str(data["summary"]).strip(),
        "decisions": [str(d).strip() for d in data["decisions"] if str(d).strip()],
        "action_items": [
            {
                "title": str(i["title"]).strip(),
                # Only real workspace members, normalised to the canonical uuid string.
                "assignee_id": _canonical(i.get("assignee_id"), valid),
            }
            for i in data["action_items"]
            if str(i.get("title", "")).strip()
        ],
    }


def _canonical(raw: str | None, valid: set[str]) -> str | None:
    try:
        value = str(uuid.UUID(raw)) if raw else None
    except (ValueError, TypeError):
        return None
    return value if value in valid else None


async def post_summary(db: AsyncSession, call: Call, result: dict) -> Message | None:
    """Create or replace the summary thread reply under the call card, then broadcast it."""
    if not call.message_id:
        return None
    meta = {
        "type": SUMMARY_META_TYPE,
        "call_id": str(call.id),
        "summary": result["summary"],
        "decisions": result["decisions"],
        "action_items": result["action_items"],
    }
    body = summary_body(result)
    existing = await db.scalar(
        select(Message).where(
            Message.parent_id == call.message_id,
            Message.kind == "system",
            Message.deleted_at.is_(None),
            Message.meta["type"].astext == SUMMARY_META_TYPE,
        )
    )
    if existing:
        existing.body, existing.meta, existing.edited_at = body, meta, _now()
        msg, kind = existing, "message.updated"
    else:
        msg = Message(
            workspace_id=call.workspace_id,
            channel_id=call.channel_id,
            author_id=call.started_by,
            parent_id=call.message_id,
            body=body,
            kind="system",
            meta=meta,
        )
        db.add(msg)
        kind = "message.created"
    await db.commit()
    await db.refresh(msg)
    out = await serialize_message(db, msg)
    await publish_to_channel(call.channel_id, {"type": kind, "message": out.model_dump(mode="json")})
    return msg


async def summarize_call(
    db: AsyncSession, call_id: uuid.UUID, *, requested_by: uuid.UUID | None = None, force: bool = False
) -> dict | None:
    """Generate + post the summary. None when there is nothing to summarise (and not forced)."""
    call = await db.get(Call, call_id)
    if not call or calls.is_live(call):
        return None
    if not force and not await has_summary_material(db, call):
        return None
    result = await generate_summary(db, call, requested_by=requested_by)
    await post_summary(db, call, result)
    return result


# --- Call-end hook ---------------------------------------------------------------------------

_background: set[asyncio.Task] = set()


async def summaries_enabled(workspace_id: uuid.UUID) -> bool:
    """AI configured for the workspace and its `captions_summary` toggle on."""
    from app.ai import workspace as ai_ws

    cfg = await ai_ws.load_config(workspace_id)
    return ai_ws.provider_from(cfg) is not None and ai_ws.feature_on(cfg, "call_summary")


def _send_summary_task(call_id: uuid.UUID) -> None:
    from app.workers.celery_app import celery_app

    # A short delay lets the last caption segments land before the transcript is read.
    celery_app.send_task(
        "app.workers.ai_tasks.summarize_call", args=[str(call_id)], countdown=5
    )


def on_call_ended(call: Call) -> None:
    """Called by app.calls after a call ended (committed). Fire-and-forget; never raises."""
    if call.status != "ended":
        return
    call_id, workspace_id = call.id, call.workspace_id

    async def _go() -> None:
        try:
            if not await summaries_enabled(workspace_id):
                return
            await asyncio.to_thread(_send_summary_task, call_id)
        except Exception:
            log.warning("Could not enqueue AI summary for call %s", call_id, exc_info=True)

    try:
        task = asyncio.get_running_loop().create_task(_go())
    except RuntimeError:
        return
    _background.add(task)
    task.add_done_callback(_background.discard)
