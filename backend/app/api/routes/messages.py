import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import and_, delete, func, literal_column, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import aliased

from app import messaging_extras as mx
from app import productivity
from app.ai import agent as ai_agent
from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    WorkspaceMembership,
    ensure_not_archived,
    is_channel_member,
    is_guest,
    readable_channel_ids,
    require_channel_access,
)
from app.api.routes.channels import add_members, notify_joined
from app.models import Attachment, Channel, ChannelKind, Message, MessageMention, MessageReaction
from app.realtime.hub import publish_to_channel
from app.schemas import (
    MAX_REACTION_KINDS_PER_MESSAGE,
    MessageEdit,
    MessageIn,
    MessageOut,
    ReactionIn,
    ReactionOut,
)
from app.services import serialize_message, serialize_messages, sync_mentions

router = APIRouter(tags=["messages"])

# A literal (not a bound parameter) so every plan matches the ix_messages_body_fts expression index.
_FTS_CONFIG = literal_column("'english'::regconfig")


def _event(kind: str, msg: MessageOut) -> dict:
    return {"type": kind, "message": msg.model_dump(mode="json")}


def _visible(q):
    """Hide deleted messages and replies whose thread parent was deleted."""
    parent = aliased(Message)
    return q.outerjoin(parent, parent.id == Message.parent_id).where(
        Message.deleted_at.is_(None), parent.deleted_at.is_(None)
    )


@router.get("/channels/{channel_id}/messages", response_model=list[MessageOut])
async def list_messages(
    channel: ChannelAccess,
    db: DB,
    user: CurrentUser,
    before: datetime | None = None,
    before_id: uuid.UUID | None = None,
    after_id: uuid.UUID | None = None,
    around_id: uuid.UUID | None = None,
    limit: int = Query(50, ge=1, le=200),
) -> list[MessageOut]:
    """A page of top-level messages, always returned newest-first.

    Paging uses a (created_at, id) cursor so messages sharing a timestamp are never skipped:
    - `before_id`: the page just older than that message (scrolling up).
    - `after_id`: the page just newer than it (scrolling down after a jump, or catching up after
      a reconnect).
    - `around_id`: that message with up to `limit // 2` messages on each side (jump to message).
    - `before` (a created_at) is the older timestamp-only cursor, kept for compatibility.
    """
    base = select(Message).where(
        Message.channel_id == channel.id,
        Message.parent_id.is_(None),
        Message.deleted_at.is_(None),
    )
    newest_first = (Message.created_at.desc(), Message.id.desc())
    oldest_first = (Message.created_at.asc(), Message.id.asc())

    async def cursor_of(message_id: uuid.UUID) -> tuple[datetime, uuid.UUID]:
        row = (
            await db.execute(
                select(Message.created_at, Message.id).where(
                    Message.id == message_id,
                    Message.channel_id == channel.id,
                    Message.parent_id.is_(None),
                )
            )
        ).first()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found in this channel")
        return row[0], row[1]

    def older_than(ts: datetime, mid: uuid.UUID, inclusive: bool = False):
        same = Message.id <= mid if inclusive else Message.id < mid
        return or_(Message.created_at < ts, and_(Message.created_at == ts, same))

    def newer_than(ts: datetime, mid: uuid.UUID):
        return or_(Message.created_at > ts, and_(Message.created_at == ts, Message.id > mid))

    if around_id:
        ts, mid = await cursor_of(around_id)
        half = max(1, limit // 2)
        older = list(
            await db.scalars(
                base.where(older_than(ts, mid, inclusive=True))
                .order_by(*newest_first)
                .limit(half + 1)
            )
        )
        newer = list(
            await db.scalars(base.where(newer_than(ts, mid)).order_by(*oldest_first).limit(half))
        )
        rows = list(reversed(newer)) + older
    elif after_id:
        ts, mid = await cursor_of(after_id)
        rows = list(
            await db.scalars(base.where(newer_than(ts, mid)).order_by(*oldest_first).limit(limit))
        )
        rows.reverse()
    elif before_id:
        ts, mid = await cursor_of(before_id)
        rows = list(
            await db.scalars(base.where(older_than(ts, mid)).order_by(*newest_first).limit(limit))
        )
    else:
        q = base.where(Message.created_at < before) if before else base
        rows = list(await db.scalars(q.order_by(*newest_first).limit(limit)))
    return await serialize_messages(db, rows, viewer_id=user.id)


@router.get("/messages/{message_id}/replies", response_model=list[MessageOut])
async def list_replies(
    message_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    after_id: uuid.UUID | None = None,
    limit: int = Query(200, ge=1, le=500),
) -> list[MessageOut]:
    """Replies oldest-first, `limit` at a time; pass the last reply's id as `after_id` for more."""
    parent, _ = await _get_message(db, user, message_id)
    q = select(Message).where(Message.parent_id == parent.id, Message.deleted_at.is_(None))
    if after_id:
        cur = (
            await db.execute(
                select(Message.created_at, Message.id).where(
                    Message.id == after_id, Message.parent_id == parent.id
                )
            )
        ).first()
        if cur is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Reply not found in this thread")
        q = q.where(
            or_(
                Message.created_at > cur[0], and_(Message.created_at == cur[0], Message.id > cur[1])
            )
        )
    rows = list(await db.scalars(q.order_by(Message.created_at, Message.id).limit(limit)))
    return await serialize_messages(db, rows, viewer_id=user.id)


@router.post(
    "/channels/{channel_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def post_message(
    data: MessageIn, channel: ChannelAccess, db: DB, user: CurrentUser
) -> MessageOut:
    return await create_message(db, channel, user, data)


async def create_message(
    db,
    channel: Channel,
    user,
    data: MessageIn,
    *,
    before_commit: Callable[[Message], Awaitable[None]] | None = None,
) -> MessageOut:
    """The one post path (HTTP posts, forwards, polls, scheduled sends).

    `before_commit` runs after the message row exists and before the commit, so extras
    (poll rows, forward origin, ...) land in the same transaction and in the broadcast.
    """
    ensure_not_archived(channel)
    if data.parent_id:
        parent = await db.get(Message, data.parent_id)
        if (
            not parent
            or parent.channel_id != channel.id
            or parent.parent_id is not None
            or parent.deleted_at is not None
        ):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid thread parent")
    # Posting in a public channel you haven't joined joins it (like Slack), so the author's
    # sockets get the channel's live events from now on. ChannelAccess already guarantees
    # this is a public channel and the user is not a guest.
    joined: set[uuid.UUID] = set()
    if channel.kind == ChannelKind.public and not await is_channel_member(db, channel.id, user.id):
        joined = await add_members(db, channel.id, {user.id})
    # 1. persist (Postgres is the source of truth) ...
    msg = Message(
        workspace_id=channel.workspace_id,
        channel_id=channel.id,
        author_id=user.id,
        parent_id=data.parent_id,
        body=data.body.strip(),
    )
    db.add(msg)
    await db.flush()
    await db.refresh(msg, ["created_at"])
    if data.attachment_ids:
        result = await db.execute(
            update(Attachment)
            .where(
                Attachment.id.in_(data.attachment_ids),
                Attachment.uploader_id == user.id,
                Attachment.workspace_id == channel.workspace_id,
                Attachment.message_id.is_(None),
            )
            .values(message_id=msg.id)
        )
        if result.rowcount != len(set(data.attachment_ids)):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid attachment")
    if before_commit is not None:
        await before_commit(msg)
    await sync_mentions(db, msg)
    needs_unfurl = await mx.sync_unfurl_urls(db, msg)
    await db.commit()
    await db.refresh(msg)
    if joined:
        await notify_joined(channel.id, joined)
    out = await serialize_message(db, msg)
    # 2. ... then fan out over Redis to every API process holding a socket for this channel.
    await publish_to_channel(channel.id, _event("message.created", out))
    if needs_unfurl:
        mx.schedule_unfurl(msg.id)
    # Activity (mentions, thread replies) + Threads unread fan-out. Never raises.
    await productivity.on_message_created(db, msg)
    # @worklio: mentioning the workspace bot (or DMing it) wakes the AI agent. Never raises.
    await ai_agent.on_message_created(db, msg, channel)
    return out


@router.patch("/messages/{message_id}", response_model=MessageOut)
async def edit_message(
    message_id: uuid.UUID, data: MessageEdit, db: DB, user: CurrentUser
) -> MessageOut:
    msg = await _get_own_message(db, user, message_id)
    body = data.body.strip()
    if not body:
        has_attachment = await db.scalar(
            select(Attachment.id).where(Attachment.message_id == msg.id).limit(1)
        )
        if not has_attachment:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Message needs text or an attachment"
            )
    old_body = msg.body
    msg.body = body
    msg.edited_at = datetime.now(UTC)
    mx.record_edit(db, msg, old_body)
    await sync_mentions(db, msg)
    needs_unfurl = await mx.sync_unfurl_urls(db, msg)
    await db.commit()
    await db.refresh(msg)
    out = await serialize_message(db, msg)
    await publish_to_channel(msg.channel_id, _event("message.updated", out))
    if needs_unfurl:
        mx.schedule_unfurl(msg.id)
    return out


@router.delete("/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_message(message_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
    msg = await _get_own_message(db, user, message_id)
    msg.deleted_at = datetime.now(UTC)
    await db.commit()
    await publish_to_channel(
        msg.channel_id,
        {
            "type": "message.deleted",
            "message_id": str(msg.id),
            "channel_id": str(msg.channel_id),
            "parent_id": str(msg.parent_id) if msg.parent_id else None,
        },
    )


@router.post("/messages/{message_id}/reactions", response_model=list[ReactionOut])
async def toggle_reaction(
    message_id: uuid.UUID, data: ReactionIn, db: DB, user: CurrentUser
) -> list[ReactionOut]:
    msg, channel = await _get_message(db, user, message_id)
    ensure_not_archived(channel)
    # Atomic toggle: delete if present, otherwise insert (ignoring a concurrent duplicate).
    removed = await db.scalar(
        delete(MessageReaction)
        .where(
            MessageReaction.message_id == msg.id,
            MessageReaction.user_id == user.id,
            MessageReaction.emoji == data.emoji,
        )
        .returning(MessageReaction.id)
    )
    if not removed:
        kinds = set(
            await db.scalars(
                select(MessageReaction.emoji).where(MessageReaction.message_id == msg.id).distinct()
            )
        )
        if data.emoji not in kinds and len(kinds) >= MAX_REACTION_KINDS_PER_MESSAGE:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Too many different reactions")
        await db.execute(
            pg_insert(MessageReaction)
            .values(id=uuid.uuid4(), message_id=msg.id, user_id=user.id, emoji=data.emoji)
            .on_conflict_do_nothing(index_elements=["message_id", "user_id", "emoji"])
        )
    await db.commit()
    out = await serialize_message(db, msg)
    await publish_to_channel(
        msg.channel_id,
        {
            "type": "reaction.updated",
            "message_id": str(msg.id),
            "channel_id": str(msg.channel_id),
            "parent_id": str(msg.parent_id) if msg.parent_id else None,
            "reactions": [r.model_dump(mode="json") for r in out.reactions],
        },
    )
    if not removed:
        await productivity.on_reaction_added(db, msg, user.id, data.emoji)
    return out.reactions


@router.get("/workspaces/{workspace_id}/search", response_model=list[MessageOut])
async def search_messages(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0, le=1000),
) -> list[MessageOut]:
    """Postgres full-text search over channels the user can read.

    Understands `from:@name|me|user_id`, `in:#channel|channel_id`,
    `has:link|file|image|pin|reaction`, `before:/after:/on:YYYY-MM-DD`, `is:thread`
    and "quoted phrases".
    """
    sq = mx.parse_search(q)
    readable = readable_channel_ids(workspace_id, user.id, is_guest(membership))
    stmt = _visible(select(Message)).where(
        Message.workspace_id == workspace_id,
        Message.channel_id.in_(readable),
    )
    stmt = await mx.apply_search_filters(db, stmt, sq, workspace_id, user.id)
    if sq.text:
        tsv = func.to_tsvector(_FTS_CONFIG, Message.body)
        query = func.websearch_to_tsquery(_FTS_CONFIG, sq.text)
        stmt = stmt.where(tsv.op("@@")(query)).order_by(
            func.ts_rank(tsv, query).desc(), Message.created_at.desc(), Message.id.desc()
        )
    elif sq.has_filters:
        stmt = stmt.order_by(Message.created_at.desc(), Message.id.desc())
    else:
        return []
    # `offset` pages through results ("Show more"); capped so deep scans stay cheap.
    rows = list(await db.scalars(stmt.offset(offset).limit(limit)))
    return await serialize_messages(db, rows, viewer_id=user.id)


@router.get("/workspaces/{workspace_id}/mentions", response_model=list[MessageOut])
async def list_mentions(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
    limit: int = Query(50, ge=1, le=100),
) -> list[MessageOut]:
    """Messages that @mention the current user (indexed via `message_mentions`)."""
    readable = readable_channel_ids(workspace_id, user.id, is_guest(membership))
    rows = list(
        await db.scalars(
            _visible(select(Message))
            .join(MessageMention, MessageMention.message_id == Message.id)
            .where(
                MessageMention.user_id == user.id,
                MessageMention.workspace_id == workspace_id,
                Message.channel_id.in_(readable),
            )
            .order_by(MessageMention.created_at.desc())
            .limit(limit)
        )
    )
    return await serialize_messages(db, rows, viewer_id=user.id)


async def _get_message(db, user, message_id: uuid.UUID) -> tuple[Message, Channel]:
    msg = await db.get(Message, message_id)
    if not msg or msg.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found")
    channel = await require_channel_access(msg.channel_id, db, user)  # tenant + channel check
    return msg, channel


async def _get_own_message(db, user, message_id: uuid.UUID) -> Message:
    msg, channel = await _get_message(db, user, message_id)
    if msg.kind == "system":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "System messages can't be changed")
    if msg.author_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only modify your own messages")
    ensure_not_archived(channel)
    return msg
