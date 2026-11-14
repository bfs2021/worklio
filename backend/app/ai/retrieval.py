"""Permission-aware retrieval for Worklio AI.

Every message the AI sees comes through here, and every path reuses the checks the rest of
the API uses: workspace search goes through the existing search route function (readable
channels only), threads through `productivity.get_readable_message`, channel history through
`deps.require_channel_access`. A user can therefore never get an answer built from a channel
they could not open themselves.

Functions take an optional `db`; without one they open a short-lived NullPool session (safe
from Celery tasks that run their own event loop).
"""

from __future__ import annotations

import asyncio
import re
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app import productivity
from app.ai.client import ToolError, ToolSpec
from app.api.deps import (
    get_workspace_membership,
    is_guest,
    readable_channel_ids,
    require_channel_access,
)
from app.core.config import settings
from app.models import Channel, ChannelKind, ChannelMember, Message, MessageMention, User
from app.schemas import MessageOut
from app.services import serialize_messages

MAX_BODY_CHARS = 2000
SNIPPET_CHARS = 220
_MENTION_RE = re.compile(r"<@([0-9a-fA-F-]{36})>")
_UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


class NotAccessible(LookupError):
    """The thing doesn't exist or the user can't read it (deliberately indistinguishable)."""


@asynccontextmanager
async def _session(db: AsyncSession | None) -> AsyncIterator[AsyncSession]:
    if db is not None:
        yield db
        return
    engine = create_async_engine(settings.database_url, poolclass=NullPool)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            yield session
    finally:
        await engine.dispose()


def _as_uuid(value: str | None) -> uuid.UUID | None:
    if not value:
        return None
    m = _UUID_RE.search(value)
    if not m:
        return None
    try:
        return uuid.UUID(m.group(0))
    except ValueError:
        return None


def parse_day(value: str | None) -> date | None:
    """YYYY-MM-DD or an ISO datetime -> date; None when absent or unparseable."""
    if not value:
        return None
    value = value.strip()
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def parse_moment(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.strip())
    except ValueError:
        d = parse_day(value)
        if d is None:
            return None
        dt = datetime(d.year, d.month, d.day)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


# --- Channels -------------------------------------------------------------------------------


async def resolve_channel(
    db: AsyncSession, user: User, workspace_id: uuid.UUID, ref: str
) -> Channel:
    """'#name', 'name' or a channel id -> a channel the user can read (else NotAccessible)."""
    ref = (ref or "").strip()
    channel_id = _as_uuid(ref)
    if channel_id is None:
        name = ref.lstrip("#").strip().lower()
        if not name:
            raise NotAccessible("No channel given")
        channel_id = await db.scalar(
            select(Channel.id).where(
                Channel.workspace_id == workspace_id,
                Channel.name == name,
                Channel.kind != ChannelKind.dm,
            )
        )
        if channel_id is None:
            raise NotAccessible(f"No channel named #{name} that you can read")
    try:
        channel = await require_channel_access(channel_id, db, user)
    except HTTPException as exc:
        raise NotAccessible("Channel not found") from exc
    if channel.workspace_id != workspace_id:
        raise NotAccessible("Channel not found")
    return channel


@dataclass
class ChannelInfo:
    id: uuid.UUID
    name: str
    label: str
    kind: str
    topic: str | None
    is_member: bool
    is_archived: bool


async def channel_labels(
    db: AsyncSession, channels: list[Channel], viewer_id: uuid.UUID
) -> dict[uuid.UUID, str]:
    """'#general' for channels, 'DM with Bob, Carol' for direct messages."""
    labels = {c.id: f"#{c.name}" for c in channels if c.kind != ChannelKind.dm}
    dm_ids = [c.id for c in channels if c.kind == ChannelKind.dm]
    if dm_ids:
        rows = await db.execute(
            select(ChannelMember.channel_id, User.full_name, User.id)
            .join(User, User.id == ChannelMember.user_id)
            .where(ChannelMember.channel_id.in_(dm_ids))
            .order_by(User.full_name)
        )
        names: dict[uuid.UUID, list[str]] = {cid: [] for cid in dm_ids}
        for cid, name, uid in rows:
            if uid != viewer_id:
                names[cid].append(name)
        for cid in dm_ids:
            labels[cid] = "DM with " + (", ".join(names[cid]) or "yourself")
    return labels


async def list_channels_for(
    user: User, workspace_id: uuid.UUID, *, db: AsyncSession | None = None
) -> list[ChannelInfo]:
    """Channels and DMs the user can read in the workspace."""
    async with _session(db) as s:
        member = await get_workspace_membership(s, workspace_id, user.id)
        if member is None:
            return []
        readable = readable_channel_ids(workspace_id, user.id, is_guest(member))
        channels = list(
            await s.scalars(
                select(Channel).where(Channel.id.in_(readable)).order_by(Channel.kind, Channel.name)
            )
        )
        mine = set(
            await s.scalars(
                select(ChannelMember.channel_id).where(ChannelMember.user_id == user.id)
            )
        )
        labels = await channel_labels(s, channels, user.id)
        return [
            ChannelInfo(
                id=c.id,
                name=c.name,
                label=labels[c.id],
                kind=c.kind.value,
                topic=c.topic,
                is_member=c.id in mine,
                is_archived=c.is_archived,
            )
            for c in channels
        ]


# --- Messages -------------------------------------------------------------------------------


async def search_messages_for(
    user: User,
    workspace_id: uuid.UUID,
    query: str,
    *,
    in_channel: str | None = None,
    from_user: str | None = None,
    after: str | None = None,
    before: str | None = None,
    limit: int = 20,
    db: AsyncSession | None = None,
) -> list[MessageOut]:
    """Full-text search through the existing permission-aware search (GET /search).

    `after` is inclusive (messages on or after that day), `before` exclusive.
    """
    from app.api.routes.messages import search_messages

    async with _session(db) as s:
        membership = await get_workspace_membership(s, workspace_id, user.id)
        if membership is None:
            return []
        parts = [(query or "").strip()]
        if in_channel:
            channel = await resolve_channel(s, user, workspace_id, in_channel)
            parts.append(f"in:{channel.id}")
        if from_user:
            who = from_user.strip()
            if who.lower() in ("me", "@me"):
                parts.append("from:me")
            elif uid := _as_uuid(who):
                parts.append(f"from:{uid}")
            elif who.lstrip("@"):
                parts.append("from:" + who.lstrip("@").replace(" ", ""))
        if d := parse_day(after):
            parts.append(f"after:{(d - timedelta(days=1)).isoformat()}")
        if d := parse_day(before):
            parts.append(f"before:{d.isoformat()}")
        q = " ".join(p for p in parts if p)
        if not q:
            return []
        return await search_messages(
            workspace_id=workspace_id,
            db=s,
            user=user,
            membership=membership,
            q=q[:500],
            limit=max(1, min(int(limit or 20), 50)),
            offset=0,  # called as a plain function: pass every Query param explicitly
        )


async def get_thread_for(
    user: User, message_id: uuid.UUID, *, db: AsyncSession | None = None
) -> list[MessageOut]:
    """Root message followed by its replies (oldest first). Any message of the thread works."""
    async with _session(db) as s:
        try:
            msg, _ = await productivity.get_readable_message(s, user, message_id)
        except HTTPException as exc:
            raise NotAccessible("Message not found") from exc
        root = msg
        if msg.parent_id is not None:
            root = await s.get(Message, msg.parent_id)
            if root is None or root.deleted_at is not None:
                raise NotAccessible("Message not found")
        replies = list(
            await s.scalars(
                select(Message)
                .where(Message.parent_id == root.id, Message.deleted_at.is_(None))
                .order_by(Message.created_at)
                .limit(500)
            )
        )
        return await serialize_messages(s, [root, *replies], viewer_id=user.id)


async def channel_history_for(
    user: User,
    channel_id: uuid.UUID,
    *,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 100,
    include_replies: bool = True,
    db: AsyncSession | None = None,
) -> list[MessageOut]:
    """The most recent `limit` messages of a readable channel in [since, until), oldest first."""
    async with _session(db) as s:
        try:
            await require_channel_access(channel_id, s, user)
        except HTTPException as exc:
            raise NotAccessible("Channel not found") from exc
        q = select(Message).where(
            Message.channel_id == channel_id, *productivity.visible_message(Message)
        )
        if not include_replies:
            q = q.where(Message.parent_id.is_(None))
        if since is not None:
            q = q.where(Message.created_at >= since)
        if until is not None:
            q = q.where(Message.created_at < until)
        rows = list(
            await s.scalars(q.order_by(Message.created_at.desc()).limit(max(1, min(limit, 1000))))
        )
        rows.reverse()
        return await serialize_messages(s, rows, viewer_id=user.id)


@dataclass
class UnreadChannel:
    channel: Channel
    label: str
    unread: int
    mentions: int
    last_read_at: datetime


async def unread_channels_for(
    db: AsyncSession, user: User, workspace_id: uuid.UUID, *, limit: int = 15
) -> list[UnreadChannel]:
    """Channels with unread messages, most important first (mentions, DMs, volume)."""
    member = await get_workspace_membership(db, workspace_id, user.id)
    if member is None:
        return []
    readable = readable_channel_ids(workspace_id, user.id, is_guest(member))
    mention = and_(MessageMention.message_id == Message.id, MessageMention.user_id == user.id)
    rows = (
        await db.execute(
            select(
                Channel,
                ChannelMember.last_read_at,
                func.count(func.distinct(Message.id)).label("unread"),
                func.count(func.distinct(MessageMention.id)).label("mentions"),
            )
            .join(ChannelMember, ChannelMember.channel_id == Channel.id)
            .join(Message, Message.channel_id == Channel.id)
            .outerjoin(MessageMention, mention)
            .where(
                Channel.workspace_id == workspace_id,
                Channel.id.in_(readable),
                Channel.is_archived.is_(False),
                ChannelMember.user_id == user.id,
                *productivity.unread_message_filter(user.id),
            )
            .group_by(Channel.id, ChannelMember.last_read_at)
        )
    ).all()
    rows.sort(
        key=lambda r: (r.mentions > 0, r[0].kind == ChannelKind.dm, r.unread), reverse=True
    )
    rows = rows[:limit]
    labels = await channel_labels(db, [r[0] for r in rows], user.id)
    return [
        UnreadChannel(r[0], labels[r[0].id], r.unread, r.mentions, r.last_read_at) for r in rows
    ]


async def last_read_at(db: AsyncSession, channel_id: uuid.UUID, user_id: uuid.UUID):
    return await db.scalar(
        select(ChannelMember.last_read_at).where(
            ChannelMember.channel_id == channel_id, ChannelMember.user_id == user_id
        )
    )


# --- Rendering for the model + citations ---------------------------------------------------


async def user_names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    return {
        uid: name
        for uid, name in await db.execute(
            select(User.id, User.full_name).where(User.id.in_(ids))
        )
    }


def mentioned_ids(messages: list[MessageOut]) -> set[uuid.UUID]:
    out: set[uuid.UUID] = set()
    for m in messages:
        for raw in _MENTION_RE.findall(m.body or ""):
            if uid := _as_uuid(raw):
                out.add(uid)
    return out


def humanize_mentions(body: str, names: dict[uuid.UUID, str]) -> str:
    def repl(m: re.Match) -> str:
        uid = _as_uuid(m.group(1))
        return f"@{names[uid]}" if uid in names else "@someone"

    return _MENTION_RE.sub(repl, body)


def _system_text(m: MessageOut) -> str:
    meta = m.meta or {}
    kind = meta.get("type", "event")
    if m.body:
        return f"(system: {kind}) {m.body}"
    return f"(system: {kind})"


class Citations:
    """Numbers each message shown to the model ([1], [2], …) and maps them back."""

    _REF_RE = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")

    def __init__(self) -> None:
        self._n_by_id: dict[uuid.UUID, int] = {}
        self._items: dict[int, dict] = {}
        self._messages: dict[int, MessageOut] = {}

    def add(self, m: MessageOut, channel_label: str, names: dict[uuid.UUID, str]) -> int:
        if m.id in self._n_by_id:
            return self._n_by_id[m.id]
        n = len(self._items) + 1
        body = humanize_mentions(m.body or "", names).strip()
        if m.kind == "system":
            body = _system_text(m)
        snippet = " ".join(body.split())
        if len(snippet) > SNIPPET_CHARS:
            snippet = snippet[: SNIPPET_CHARS - 1].rstrip() + "…"
        self._n_by_id[m.id] = n
        self._messages[n] = m
        self._items[n] = {
            "n": n,
            "message_id": str(m.id),
            "channel_id": str(m.channel_id),
            "parent_id": str(m.parent_id) if m.parent_id else None,
            "author_id": str(m.author_id),
            "snippet": snippet,
            "created_at": m.created_at.isoformat(),
            "channel_name": channel_label,
            "author_name": names.get(m.author_id),
        }
        return n

    def message(self, n: int) -> MessageOut | None:
        return self._messages.get(n)

    def lookup(self, ref: str) -> uuid.UUID | None:
        """A model-supplied reference: '3', '[3]' or a message id."""
        ref = (ref or "").strip()
        if uid := _as_uuid(ref):
            return uid
        digits = ref.strip("[]# ")
        if digits.isdigit() and (m := self._messages.get(int(digits))):
            return m.id
        return None

    def cited_numbers(self, text: str) -> list[int]:
        seen: list[int] = []
        for group in self._REF_RE.findall(text or ""):
            for part in group.split(","):
                n = int(part.strip())
                if n in self._items and n not in seen:
                    seen.append(n)
        return sorted(seen)

    def used_in(self, text: str) -> list[dict]:
        return [self._items[n] for n in self.cited_numbers(text)]

    def all(self) -> list[dict]:
        return [self._items[n] for n in sorted(self._items)]


async def render_messages(
    db: AsyncSession,
    messages: list[MessageOut],
    citations: Citations,
    viewer_id: uuid.UUID,
    *,
    show_channel: bool = True,
) -> str:
    """Messages as numbered, compact text for the model, plus a legend of mentioned people."""
    if not messages:
        return "No messages."
    channel_ids = {m.channel_id for m in messages}
    channels = list(await db.scalars(select(Channel).where(Channel.id.in_(channel_ids))))
    labels = await channel_labels(db, channels, viewer_id)
    people = {m.author_id for m in messages} | mentioned_ids(messages)
    names = await user_names(db, people)
    lines: list[str] = []
    for m in messages:
        label = labels.get(m.channel_id, "#unknown")
        n = citations.add(m, label, names)
        head = [f"[{n}]"]
        if show_channel:
            head.append(label)
        head.append(f"{names.get(m.author_id, 'Unknown')} (<@{m.author_id}>)")
        head.append(m.created_at.strftime("%Y-%m-%d %H:%M UTC"))
        if m.parent_id:
            head.append("thread reply")
        if m.reply_count:
            head.append(f"{m.reply_count} repl{'y' if m.reply_count == 1 else 'ies'}")
        if m.attachments:
            head.append("files: " + ", ".join(a.filename for a in m.attachments[:5]))
        if m.reactions:
            head.append(" ".join(f"{r.emoji}×{len(r.user_ids)}" for r in m.reactions[:6]))
        body = _system_text(m) if m.kind == "system" else (m.body or "")
        if len(body) > MAX_BODY_CHARS:
            body = body[:MAX_BODY_CHARS] + " …(truncated)"
        lines.append(" · ".join(head) + "\n" + body.strip())
    legend = [f"<@{uid}> = {name}" for uid, name in names.items()]
    return "\n\n".join(lines) + "\n\nPeople: " + "; ".join(legend)


def format_channels(channels: list[ChannelInfo]) -> str:
    if not channels:
        return "No channels."
    out = []
    for c in channels:
        flags = [c.kind]
        flags.append("member" if c.is_member else "not a member")
        if c.is_archived:
            flags.append("archived")
        line = f"{c.label} (id {c.id}; {', '.join(flags)})"
        if c.topic:
            line += f" - {c.topic[:160]}"
        out.append(line)
    return "\n".join(out)


def mention_ids_in(text: str) -> set[uuid.UUID]:
    return {uid for raw in _MENTION_RE.findall(text or "") if (uid := _as_uuid(raw))}


__all__ = [
    "ChannelInfo",
    "Citations",
    "NotAccessible",
    "UnreadChannel",
    "build_retrieval_tools",
    "channel_history_for",
    "channel_labels",
    "format_channels",
    "get_thread_for",
    "last_read_at",
    "list_channels_for",
    "mention_ids_in",
    "parse_day",
    "parse_moment",
    "render_messages",
    "resolve_channel",
    "search_messages_for",
    "unread_channels_for",
    "user_names",
]


# --- Tools for Claude (Ask, and reusable by the @worklio agent) ----------------------------


def build_retrieval_tools(
    db: AsyncSession,
    user: User,
    workspace_id: uuid.UUID,
    citations: Citations,
    *,
    lock: asyncio.Lock | None = None,
) -> list[ToolSpec]:
    """search_messages, get_thread, read_channel and list_channels, all run as `user`.

    Results are numbered through `citations` so answers can cite [n]. Tool calls of one turn
    run in parallel; `lock` serializes their use of the shared session.
    """
    lock = lock or asyncio.Lock()

    async def search(args: dict) -> str:
        query = str(args.get("query") or "").strip()
        async with lock:
            try:
                results = await search_messages_for(
                    user,
                    workspace_id,
                    query,
                    in_channel=args.get("in_channel") or None,
                    from_user=args.get("from_user") or None,
                    after=args.get("after") or None,
                    before=args.get("before") or None,
                    limit=_clamp(args.get("limit"), 15, 1, 30),
                    db=db,
                )
            except NotAccessible as exc:
                raise ToolError(f"{exc}. Use list_channels to see the channels you can read.")
            if not results:
                return "No messages matched. Try fewer, different or more distinctive keywords."
            return await render_messages(db, results, citations, user.id)

    async def thread(args: dict) -> str:
        ref = str(args.get("message_id") or "")
        message_id = citations.lookup(ref)
        if message_id is None:
            raise ToolError("Pass the [n] number or the id of a message you were shown.")
        async with lock:
            try:
                messages = await get_thread_for(user, message_id, db=db)
            except NotAccessible as exc:
                raise ToolError("That message doesn't exist or isn't readable.") from exc
            return await render_messages(db, messages, citations, user.id)

    async def read_channel(args: dict) -> str:
        async with lock:
            try:
                channel = await resolve_channel(db, user, workspace_id, str(args.get("channel")))
                messages = await channel_history_for(
                    user,
                    channel.id,
                    since=parse_moment(args.get("since")),
                    limit=_clamp(args.get("limit"), 50, 1, 100),
                    include_replies=False,
                    db=db,
                )
            except NotAccessible as exc:
                raise ToolError(
                    f"{exc}. Use list_channels to see the channels you can read."
                ) from exc
            if not messages:
                return "No messages in that channel for this period."
            return await render_messages(db, messages, citations, user.id, show_channel=False)

    async def channels(_: dict) -> str:
        async with lock:
            return format_channels(await list_channels_for(user, workspace_id, db=db))

    return [
        ToolSpec(
            name="search_messages",
            description=(
                "Full-text search over messages in channels and DMs the user can read. "
                "Keyword search: pass 1-4 distinctive words, combine alternatives with 'or', "
                "quote exact phrases. Returns numbered messages ([n]) newest-relevance first, "
                "with channel, author, time and reply count."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keywords. May be empty when filters are given.",
                    },
                    "in_channel": {
                        "type": "string",
                        "description": "Limit to one channel: '#name' or a channel id.",
                    },
                    "from_user": {
                        "type": "string",
                        "description": "Only messages by this person: 'me', a name or a user id.",
                    },
                    "after": {
                        "type": "string",
                        "description": "Only messages on or after this day (YYYY-MM-DD).",
                    },
                    "before": {
                        "type": "string",
                        "description": "Only messages before this day (YYYY-MM-DD).",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 30},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            handler=search,
            status=lambda a: f"Searching messages for “{str(a.get('query') or '').strip()}”…"
            if str(a.get("query") or "").strip()
            else "Searching messages…",
        ),
        ToolSpec(
            name="get_thread",
            description=(
                "Read a whole thread: the first message and all replies. Pass the [n] number "
                "of any message you were shown (or its id)."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "message_id": {
                        "type": "string",
                        "description": "The [n] number (e.g. '3') or message id.",
                    }
                },
                "required": ["message_id"],
                "additionalProperties": False,
            },
            handler=thread,
            status="Reading the thread…",
        ),
        ToolSpec(
            name="read_channel",
            description=(
                "Read the most recent top-level messages of one channel or DM, oldest first."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "channel": {
                        "type": "string",
                        "description": "'#name' or a channel id (DMs: use the id from list_channels).",
                    },
                    "since": {
                        "type": "string",
                        "description": "Only messages from this day/time on (ISO 8601).",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                "required": ["channel"],
                "additionalProperties": False,
            },
            handler=read_channel,
            status=lambda a: f"Reading {a.get('channel') or 'the channel'!s}…",
        ),
        ToolSpec(
            name="list_channels",
            description="List the channels and DMs the user can read, with ids and topics.",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            handler=channels,
            status="Looking through channels…",
        ),
    ]


def _clamp(value, default: int, low: int, high: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(n, high))
