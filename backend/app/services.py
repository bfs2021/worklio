"""Query helpers shared by routes and realtime events."""

import asyncio
import re
import uuid
from collections import defaultdict

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import messaging_extras
from app.core import storage
from app.models import (
    Attachment,
    Message,
    MessageMention,
    MessageReaction,
    SavedItem,
    WorkspaceMember,
)
from app.schemas import AttachmentOut, MessageOut, ReactionOut


def attachment_out(a: Attachment, url: str) -> AttachmentOut:
    return AttachmentOut(
        id=a.id,
        filename=a.filename,
        content_type=a.content_type,
        size=a.size,
        url=url,
        kind=a.kind,
        duration_ms=a.duration_ms,
        waveform=a.waveform,
    )


async def serialize_messages(
    db: AsyncSession, messages: list[Message], *, viewer_id: uuid.UUID | None = None
) -> list[MessageOut]:
    """Turn messages into API objects with reply counts, reactions and attachments (4 queries total).

    Pass `viewer_id` only for responses to one user (never for broadcasts): it fills the
    per-viewer fields such as `saved`.
    """
    if not messages:
        return []
    ids = [m.id for m in messages]

    replies = {
        pid: (count, last)
        for pid, count, last in await db.execute(
            select(Message.parent_id, func.count(), func.max(Message.created_at))
            .where(Message.parent_id.in_(ids), Message.deleted_at.is_(None))
            .group_by(Message.parent_id)
        )
    }

    repliers: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for pid, uid in await db.execute(
        select(Message.parent_id, Message.author_id)
        .where(Message.parent_id.in_(ids), Message.deleted_at.is_(None))
        .group_by(Message.parent_id, Message.author_id)
        .order_by(Message.parent_id, func.max(Message.created_at).desc())
    ):
        repliers[pid].append(uid)

    reactions: dict[uuid.UUID, dict[str, list[uuid.UUID]]] = defaultdict(lambda: defaultdict(list))
    for r in await db.scalars(
        select(MessageReaction)
        .where(MessageReaction.message_id.in_(ids))
        .order_by(MessageReaction.created_at)
    ):
        reactions[r.message_id][r.emoji].append(r.user_id)

    attachments: dict[uuid.UUID, list[Attachment]] = defaultdict(list)
    for a in await db.scalars(
        select(Attachment).where(Attachment.message_id.in_(ids)).order_by(Attachment.created_at)
    ):
        attachments[a.message_id].append(a)
    flat = [a for group in attachments.values() for a in group]
    signed = await asyncio.gather(
        *(asyncio.to_thread(storage.presigned_get, a.storage_key, a.filename, a.content_type)
            for a in flat)
    )
    url_by_id = {a.id: url for a, url in zip(flat, signed, strict=True)}

    saved: set[uuid.UUID] = set()
    if viewer_id is not None:
        saved = set(
            await db.scalars(
                select(SavedItem.message_id).where(
                    SavedItem.user_id == viewer_id, SavedItem.message_id.in_(ids)
                )
            )
        )

    out = []
    for m in messages:
        count, last = replies.get(m.id, (0, None))
        item = MessageOut.model_validate(m)
        item.reply_count, item.last_reply_at = count, last
        item.reply_user_ids = repliers[m.id][:5]
        item.reactions = [ReactionOut(emoji=e, user_ids=u) for e, u in reactions[m.id].items()]
        item.attachments = [
            attachment_out(a, url_by_id[a.id]) for a in attachments[m.id]
        ]
        item.saved = m.id in saved
        out.append(item)
    # Pins, forwards, polls, link previews, edit counts (Wave A2).
    await messaging_extras.enrich(db, out, viewer_id)
    return out


async def serialize_message(db: AsyncSession, message: Message) -> MessageOut:
    return (await serialize_messages(db, [message]))[0]


_MENTION_RE = re.compile(r"<@([0-9a-fA-F-]{36})>")


def mentioned_user_ids(body: str) -> set[uuid.UUID]:
    out = set()
    for raw in _MENTION_RE.findall(body):
        try:
            out.add(uuid.UUID(raw))
        except ValueError:
            continue
    return out


async def sync_mentions(db: AsyncSession, message: Message) -> None:
    """Rewrite the message's rows in `message_mentions` to match its body (call before commit)."""
    await db.execute(delete(MessageMention).where(MessageMention.message_id == message.id))
    if message.kind == "system":  # system messages never notify anyone
        return
    # Plus @here / @channel / @everyone / @group expansions (Wave A2).
    ids = (
        mentioned_user_ids(message.body)
        | await messaging_extras.expand_special_mentions(db, message)
    ) - {message.author_id}
    if not ids:
        return
    # Only real members of this workspace can be mentioned.
    members = set(
        await db.scalars(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == message.workspace_id,
                WorkspaceMember.user_id.in_(ids),
            )
        )
    )
    db.add_all(
        MessageMention(
            message_id=message.id,
            user_id=uid,
            workspace_id=message.workspace_id,
            created_at=message.created_at,
        )
        for uid in members
    )
