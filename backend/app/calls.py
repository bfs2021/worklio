"""Call lifecycle: ringing, accept/decline/cancel, ring timeouts, ending, the call card and notes.

A call wraps the channel's LiveKit room ("huddle-<channel_id>"). Who is in the room right now
comes from the huddle registry (app.realtime.huddles), which calls `sync_call` whenever its
participant set changes; that is where calls pick up joiners and end once the room empties.

Every mutation locks the call row (SELECT ... FOR UPDATE), records what changed in a
`Changes`, commits, and only then publishes realtime events (`_flush`), so clients never
hear about state that could still roll back.

Ring timeouts are enforced three ways so a missing worker can't leave phones ringing:
a Celery task scheduled with a countdown, an in-process sweeper (`run_sweeper`), and lazy
expiry whenever a call or invite is read.
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import admin
from app.api.deps import (
    get_workspace_membership,
    is_channel_member,
    is_guest,
    require_channel_access,
)
from app.core.db import SessionLocal
from app.core.redis import redis
from app.models import (
    Call,
    CallInvite,
    CallKind,
    CallStatus,
    Channel,
    ChannelKind,
    ChannelMember,
    InviteStatus,
    Message,
    User,
)
from app.models.call import LIVE_CALL_STATUSES
from app.realtime import huddles
from app.realtime.hub import notify_user, publish_to_channel
from app.schemas import CallInviteOut, CallOut
from app.services import serialize_message

log = logging.getLogger(__name__)

RING_TIMEOUT_SECONDS = 40
# A heartbeat for a call that ended this recently (missed/declined/cancelled) gets 410
# instead of silently starting a new call.
RECENT_END_SECONDS = 120
# A live call whose room has been empty this long after starting is ended by the sweeper.
EMPTY_ROOM_GRACE_SECONDS = 20
SWEEP_INTERVAL_SECONDS = 5
SWEEP_LOCK_KEY = "calls:sweep-lock"
MAX_NOTES_MESSAGE_CHARS = 40_000

_LIVE = [s.value for s in LIVE_CALL_STATUSES]


def _now() -> datetime:
    return datetime.now(UTC)


def is_live(call: Call) -> bool:
    return call.status in _LIVE


# --- Change tracking ----------------------------------------------------------------------


@dataclass
class Changes:
    """Side effects of one locked mutation, published by `_flush` after commit."""

    card_created: bool = False
    card_updated: bool = False
    ring: list[tuple[uuid.UUID, uuid.UUID]] = field(default_factory=list)  # (callee, caller)
    stopped: list[tuple[uuid.UUID, str]] = field(default_factory=list)  # (callee, reason)
    # (invitee, status, invited_by)
    invite_updates: list[tuple[uuid.UUID, str, uuid.UUID]] = field(default_factory=list)
    clear_room: list[uuid.UUID] = field(default_factory=list)
    messages_created: list[uuid.UUID] = field(default_factory=list)
    messages_updated: list[uuid.UUID] = field(default_factory=list)
    messages_deleted: list[Message] = field(default_factory=list)
    to_schedule: list[uuid.UUID] = field(default_factory=list)  # calls needing a ring timeout
    # A new channel huddle: tell members (huddle.started) and record activity items.
    huddle_started: bool = False
    huddle_invited: set[uuid.UUID] = field(default_factory=set)
    # The call ended: members drop their "huddle started" banners (huddle.ended).
    ended: bool = False


def _invite_changed(ch: Changes, inv: CallInvite, new_status: InviteStatus, reason: str) -> None:
    was_ringing = inv.status == InviteStatus.ringing
    inv.status = new_status
    if was_ringing:
        ch.stopped.append((inv.user_id, reason))
    ch.invite_updates.append((inv.user_id, new_status.value, inv.invited_by))


# --- Queries ------------------------------------------------------------------------------


async def live_call(db: AsyncSession, channel_id: uuid.UUID, *, lock: bool = False) -> Call | None:
    q = select(Call).where(Call.channel_id == channel_id, Call.status.in_(_LIVE))
    if lock:
        q = q.with_for_update()
    return await db.scalar(q)


async def _lock(db: AsyncSession, call_id: uuid.UUID) -> Call | None:
    return await db.scalar(
        select(Call).where(Call.id == call_id).with_for_update().execution_options(
            populate_existing=True
        )
    )


async def _invites(db: AsyncSession, call_id: uuid.UUID) -> list[CallInvite]:
    return list(
        await db.scalars(
            select(CallInvite)
            .where(CallInvite.call_id == call_id)
            .order_by(CallInvite.created_at, CallInvite.user_id)
            .execution_options(populate_existing=True)
        )
    )


async def serialize_call(db: AsyncSession, call: Call) -> CallOut:
    invites = await _invites(db, call.id)
    participants = await huddles.participant_ids(call.channel_id) if is_live(call) else []
    return CallOut(
        id=call.id,
        workspace_id=call.workspace_id,
        channel_id=call.channel_id,
        kind=call.kind,
        status=call.status,
        started_by=call.started_by,
        started_at=call.started_at,
        ended_at=call.ended_at,
        participant_ids=[uuid.UUID(p) for p in participants],
        joined_ids=list(call.joined_ids),
        invites=[
            CallInviteOut(user_id=i.user_id, status=i.status, invited_by=i.invited_by)
            for i in invites
        ],
        message_id=call.message_id,
    )


def duration_s(call: Call) -> int | None:
    if call.status != CallStatus.ended or not call.ended_at:
        return None
    start = call.answered_at or call.started_at
    return max(0, int((call.ended_at - start).total_seconds()))


def card_meta(call: Call) -> dict:
    return {
        "type": "call",
        "call_id": str(call.id),
        "kind": call.kind,
        "status": call.status,
        "started_by": str(call.started_by),
        "started_at": call.started_at.isoformat(),
        "ended_at": call.ended_at.isoformat() if call.ended_at else None,
        "joined_ids": [str(u) for u in call.joined_ids],
        "duration_s": duration_s(call),
    }


async def _sync_card(db: AsyncSession, call: Call, ch: Changes) -> None:
    if not call.message_id:
        return
    msg = await db.get(Message, call.message_id)
    meta = card_meta(call)
    if msg and msg.meta != meta:
        msg.meta = meta
        ch.card_updated = True


async def can_access_channel(db: AsyncSession, channel: Channel, user_id: uuid.UUID) -> bool:
    """Same rule as deps.require_channel_access, for someone other than the current user."""
    member = await get_workspace_membership(db, channel.workspace_id, user_id)
    if not member:
        return False
    if channel.kind == ChannelKind.public and not is_guest(member):
        return True
    return await is_channel_member(db, channel.id, user_id)


async def _validate_invitees(
    db: AsyncSession, channel: Channel, user_ids: set[uuid.UUID]
) -> None:
    for uid in user_ids:
        user = await db.get(User, uid)
        if not user or not user.is_active or not await can_access_channel(db, channel, uid):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Everyone you call must be able to see this channel"
            )


async def is_self_dm(db: AsyncSession, channel: Channel, user_id: uuid.UUID) -> bool:
    """A DM whose only member is `user_id` (the "you" conversation)."""
    if channel.kind != ChannelKind.dm:
        return False
    other = await db.scalar(
        select(ChannelMember.id)
        .where(ChannelMember.channel_id == channel.id, ChannelMember.user_id != user_id)
        .limit(1)
    )
    return other is None


async def default_invitees(db: AsyncSession, channel: Channel, user_id: uuid.UUID) -> set[uuid.UUID]:
    """DMs ring every other member; channels start a quiet huddle."""
    if channel.kind != ChannelKind.dm:
        return set()
    members = await db.scalars(
        select(ChannelMember.user_id).where(ChannelMember.channel_id == channel.id)
    )
    return set(members) - {user_id}


# --- State transitions (inside a locked transaction) ---------------------------------------


def _mark_joined(call: Call, user_id: uuid.UUID, invites: list[CallInvite], ch: Changes) -> None:
    if user_id not in call.joined_ids:
        call.joined_ids = [*call.joined_ids, user_id]
    for inv in invites:
        if inv.user_id == user_id and inv.status != InviteStatus.accepted:
            _invite_changed(ch, inv, InviteStatus.accepted, "accepted")
    if user_id != call.started_by and call.status == CallStatus.ringing:
        call.status = CallStatus.active
    if user_id != call.started_by and call.answered_at is None:
        call.answered_at = _now()


async def _invite(
    db: AsyncSession,
    call: Call,
    inviter_id: uuid.UUID,
    user_ids: set[uuid.UUID],
    invites: list[CallInvite],
    ch: Changes,
) -> None:
    in_room = {uuid.UUID(p) for p in await huddles.participant_ids(call.channel_id)}
    by_user = {i.user_id: i for i in invites}
    expires = _now() + timedelta(seconds=RING_TIMEOUT_SECONDS)
    for uid in sorted(user_ids - {inviter_id} - in_room):
        inv = by_user.get(uid)
        if inv and inv.status == InviteStatus.ringing:
            continue
        if inv is None:
            inv = CallInvite(call_id=call.id, user_id=uid)
            db.add(inv)
            invites.append(inv)
        inv.status, inv.invited_by, inv.expires_at = InviteStatus.ringing, inviter_id, expires
        ch.ring.append((uid, inviter_id))
        ch.invite_updates.append((uid, InviteStatus.ringing.value, inviter_id))
    if ch.ring and call.id not in ch.to_schedule:
        ch.to_schedule.append(call.id)


def _final_status(call: Call, invites: list[CallInvite]) -> CallStatus:
    if set(call.joined_ids) - {call.started_by} or not invites:
        return CallStatus.ended
    statuses = {i.status for i in invites}
    if InviteStatus.ringing in statuses or statuses <= {InviteStatus.cancelled}:
        return CallStatus.cancelled
    if statuses == {InviteStatus.declined}:
        return CallStatus.declined
    return CallStatus.missed


async def _end(
    db: AsyncSession,
    call: Call,
    final: CallStatus,
    invites: list[CallInvite],
    ch: Changes,
    *,
    clear_room: bool,
) -> None:
    for inv in invites:
        if inv.status == InviteStatus.ringing:
            _invite_changed(ch, inv, InviteStatus.cancelled, "cancelled")
    call.status = final
    call.ended_at = _now()
    ch.ended = True
    if clear_room:
        ch.clear_room = list(call.joined_ids)
    await _sync_notes_message(db, call, ch)


async def _maybe_end_unanswered(
    db: AsyncSession, call: Call, channel_kind: ChannelKind, invites: list[CallInvite], ch: Changes
) -> None:
    """A DM call nobody answered ends once no invite is still ringing (all declined/missed)."""
    if (
        is_live(call)
        and channel_kind == ChannelKind.dm
        and not set(call.joined_ids) - {call.started_by}
        and invites
        and all(i.status != InviteStatus.ringing for i in invites)
        and not any(i.status == InviteStatus.accepted for i in invites)
    ):
        await _end(db, call, _final_status(call, invites), invites, ch, clear_room=True)


async def _expire_due(
    db: AsyncSession, call: Call, invites: list[CallInvite], ch: Changes
) -> None:
    now = _now()
    for inv in invites:
        if inv.status == InviteStatus.ringing and inv.expires_at <= now:
            _invite_changed(ch, inv, InviteStatus.missed, "missed")
    channel = await db.get(Channel, call.channel_id)
    await _maybe_end_unanswered(db, call, channel.kind, invites, ch)


# --- Notes ------------------------------------------------------------------------------


def _inline_text(node: dict) -> str:
    match node.get("type"):
        case "text":
            return str(node.get("text", ""))
        case "hardBreak":
            return "\n"
        case "mention":
            attrs = node.get("attrs") or {}
            try:
                return f"<@{uuid.UUID(str(attrs.get('id')))}>"
            except ValueError:
                return f"@{attrs.get('label') or attrs.get('id') or ''}"
        case _:
            return "".join(_inline_text(c) for c in node.get("content") or [])


def _blocks(nodes: list, indent: str = "") -> list[str]:
    lines: list[str] = []
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        kind, content = node.get("type"), node.get("content") or []
        attrs = node.get("attrs") or {}
        if kind == "heading":
            level = attrs.get("level", 1)
            level = level if isinstance(level, int) and 1 <= level <= 6 else 1
            lines.append(f"{indent}{'#' * level} {_inline_text(node)}")
        elif kind in ("bulletList", "orderedList", "taskList"):
            for n, item in enumerate(content, start=1):
                if not isinstance(item, dict):
                    continue
                if kind == "taskList":
                    box = "x" if (item.get("attrs") or {}).get("checked") else " "
                    marker = f"- [{box}] "
                else:
                    marker = "- " if kind == "bulletList" else f"{n}. "
                children = item.get("content") or []
                first = children[0] if children else {}
                rest = children[1:]
                text = _inline_text(first) if first.get("type") == "paragraph" else ""
                if first and first.get("type") != "paragraph":
                    rest = children
                lines.append(f"{indent}{marker}{text}")
                lines.extend(_blocks(rest, indent + "  "))
        elif kind == "blockquote":
            lines.extend(f"{indent}> {line.strip()}" for line in _blocks(content))
        elif kind == "codeBlock":
            lines.extend([f"{indent}```", *(_inline_text(node).splitlines()), f"{indent}```"])
        elif kind == "horizontalRule":
            lines.append(f"{indent}---")
        elif kind == "paragraph":
            lines.append(f"{indent}{_inline_text(node)}")
        else:
            lines.extend(_blocks(content, indent) if content else [])
    return lines


def notes_to_text(doc: dict) -> str:
    """Plain-text/markdown rendering of a TipTap document (headings, bullets, task items)."""
    lines = _blocks((doc.get("content") or []) if isinstance(doc, dict) else [])
    # Collapse runs of blank lines and trim.
    out: list[str] = []
    for line in lines:
        line = line.rstrip()
        if not line and (not out or not out[-1]):
            continue
        out.append(line)
    return "\n".join(out).strip()[:MAX_NOTES_MESSAGE_CHARS]


async def _sync_notes_message(db: AsyncSession, call: Call, ch: Changes) -> None:
    """Once a call has ended, keep its notes thread reply in step with the notes."""
    if is_live(call) or not call.message_id:
        return
    text = notes_to_text(call.notes)
    msg = await db.get(Message, call.notes_message_id) if call.notes_message_id else None
    if msg and msg.deleted_at is None:
        if not text:
            msg.deleted_at = _now()
            call.notes_message_id = None
            ch.messages_deleted.append(msg)
        elif msg.body != text:
            msg.body = text
            ch.messages_updated.append(msg.id)
        return
    if not text:
        return
    msg = Message(
        workspace_id=call.workspace_id,
        channel_id=call.channel_id,
        author_id=call.notes_updated_by or call.started_by,
        parent_id=call.message_id,
        body=text,
        kind="system",
        meta={"type": "call_notes", "call_id": str(call.id)},
    )
    db.add(msg)
    await db.flush()
    call.notes_message_id = msg.id
    ch.messages_created.append(msg.id)


# --- Publishing -----------------------------------------------------------------------------


def _message_event(kind: str, out) -> dict:
    return {"type": kind, "message": out.model_dump(mode="json")}


async def _flush(db: AsyncSession, call: Call, ch: Changes) -> CallOut:
    """Publish everything a committed mutation changed. Returns the fresh CallOut."""
    if ch.clear_room:
        await huddles.remove(call.channel_id, ch.clear_room)
    out = await serialize_call(db, call)
    data = out.model_dump(mode="json")
    cid = str(call.id)
    if ch.card_created and call.message_id:
        msg = await db.get(Message, call.message_id)
        await publish_to_channel(
            call.channel_id, _message_event("message.created", await serialize_message(db, msg))
        )
    elif ch.card_updated and call.message_id:
        msg = await db.get(Message, call.message_id)
        await publish_to_channel(
            call.channel_id, _message_event("message.updated", await serialize_message(db, msg))
        )
    for callee, caller in ch.ring:
        await notify_user(callee, {"type": "call.ringing", "call": data, "caller_id": str(caller)})
    for callee, reason in ch.stopped:
        await notify_user(callee, {"type": "call.ring_stopped", "call_id": cid, "reason": reason})
    for invitee, inv_status, invited_by in ch.invite_updates:
        event = {
            "type": "call.invite_updated",
            "call_id": cid,
            "user_id": str(invitee),
            "status": inv_status,
        }
        for target in dict.fromkeys([call.started_by, invited_by]):
            await notify_user(target, event)
        if inv_status == InviteStatus.missed.value:
            from app import productivity  # lazy: productivity imports services/models

            await productivity.notify_call_missed(db, call.id, invitee)
    for mid in ch.messages_created:
        msg = await db.get(Message, mid)
        await publish_to_channel(
            call.channel_id, _message_event("message.created", await serialize_message(db, msg))
        )
    for mid in ch.messages_updated:
        msg = await db.get(Message, mid)
        await publish_to_channel(
            call.channel_id, _message_event("message.updated", await serialize_message(db, msg))
        )
    for msg in ch.messages_deleted:
        await publish_to_channel(
            call.channel_id,
            {
                "type": "message.deleted",
                "message_id": str(msg.id),
                "channel_id": str(msg.channel_id),
                "parent_id": str(msg.parent_id) if msg.parent_id else None,
            },
        )
    await publish_to_channel(call.channel_id, {"type": "call.updated", "call": data})
    for call_id in ch.to_schedule:
        schedule_ring_timeout(call_id)
    await _publish_huddle_lifecycle(db, call, ch, data)
    if ch.ended and not is_live(call):
        from app.ai import captions  # lazy: captions imports this module

        captions.on_call_ended(call)  # AI call summary (fire-and-forget, never raises)
    return out


async def _publish_huddle_lifecycle(db: AsyncSession, call: Call, ch: Changes, data: dict) -> None:
    """huddle.started / huddle.ended for channel (non-DM) calls; DMs keep plain ringing."""
    if not (ch.huddle_started or ch.ended):
        return
    channel = await db.get(Channel, call.channel_id)
    if not channel or channel.kind == ChannelKind.dm:
        return
    from app import productivity  # lazy: productivity imports services/models

    cid, chid, starter = str(call.id), str(call.channel_id), str(call.started_by)
    # A call that ended before we published its start never announces itself; the end
    # path below still clears any banner.
    if ch.huddle_started and is_live(call):
        audience = await productivity.notify_huddle_started(call, channel, ch.huddle_invited)
        for uid, notify in audience:
            await notify_user(
                uid,
                {
                    "type": "huddle.started",
                    "call": data,
                    "channel_id": chid,
                    "starter_id": starter,
                    "invited": uid in ch.huddle_invited,
                    "notify": notify,
                },
            )
    if ch.ended and not is_live(call):
        for uid in await productivity.huddle_end_audience(db, channel):
            await notify_user(uid, {"type": "huddle.ended", "call_id": cid, "channel_id": chid})


async def _commit_and_flush(db: AsyncSession, call: Call, ch: Changes) -> CallOut:
    await _sync_card(db, call, ch)
    await db.commit()
    return await _flush(db, call, ch)


# --- Ring timeout scheduling --------------------------------------------------------------

_background: set[asyncio.Task] = set()


def _send_ring_task(call_id: uuid.UUID) -> None:
    from app.workers.celery_app import celery_app

    celery_app.send_task(
        "app.workers.tasks.expire_call_invites",
        args=[str(call_id)],
        countdown=RING_TIMEOUT_SECONDS + 1,
    )


def schedule_ring_timeout(call_id: uuid.UUID) -> None:
    """Fire-and-forget: enqueue the Celery ring-timeout task without blocking the request."""

    async def _go() -> None:
        try:
            await asyncio.to_thread(_send_ring_task, call_id)
        except Exception:
            # The sweeper and lazy expiry still end the ringing.
            log.warning("Could not schedule ring timeout for call %s", call_id, exc_info=True)

    task = asyncio.get_running_loop().create_task(_go())
    _background.add(task)
    task.add_done_callback(_background.discard)


# --- Public operations ----------------------------------------------------------------------


async def get_call_for(db: AsyncSession, call_id: uuid.UUID, user: User) -> tuple[Call, Channel]:
    """The call (after lazy ring expiry) if the user can access its channel, else 404."""
    call = await db.get(Call, call_id)
    if not call:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Call not found")
    channel = await require_channel_access(call.channel_id, db, user)
    await expire_call(call.id, db=db)
    await db.refresh(call)
    return call, channel


async def start_or_join(
    db: AsyncSession,
    channel: Channel,
    user: User,
    kind: CallKind | str,
    invitee_ids: set[uuid.UUID],
) -> Call:
    """Start a call in the channel, or join (and ring more people into) the live one.

    Starting a new huddle in a channel (not a DM) needs the `start_huddles` policy; joining a
    live one never does.
    """
    invitee_ids = set(invitee_ids) - {user.id}
    await _validate_invitees(db, channel, invitee_ids)
    may_start = True
    if channel.kind != ChannelKind.dm:
        member = await get_workspace_membership(db, channel.workspace_id, user.id)
        may_start = bool(member) and await admin.policy_allows(db, member, "start_huddles")
    for _ in range(3):
        call = await live_call(db, channel.id, lock=True)
        ch = Changes()
        if call:
            invites = await _invites(db, call.id)
            await _expire_due(db, call, invites, ch)
        if call and is_live(call):
            _mark_joined(call, user.id, invites, ch)
            await _invite(db, call, user.id, invitee_ids, invites, ch)
        else:
            if call:  # its last invite just expired: settle that first, then start fresh
                await _commit_and_flush(db, call, ch)
                continue
            if not may_start:
                await db.rollback()
                raise HTTPException(status.HTTP_403_FORBIDDEN, "policy:start_huddles")
            now = _now()
            call = Call(
                id=uuid.uuid4(),
                workspace_id=channel.workspace_id,
                channel_id=channel.id,
                kind=CallKind(kind).value,
                status=(
                    CallStatus.ringing
                    if channel.kind == ChannelKind.dm and invitee_ids
                    else CallStatus.active
                ),
                started_by=user.id,
                started_at=now,
                joined_ids=[user.id],
            )
            card = Message(
                workspace_id=channel.workspace_id,
                channel_id=channel.id,
                author_id=user.id,
                body="",
                kind="system",
                meta=card_meta(call),
            )
            db.add(card)
            try:
                await db.flush()
                call.message_id = card.id
                db.add(call)
                await db.flush()
            except IntegrityError:  # someone started a call here at the same moment
                await db.rollback()
                await db.refresh(channel)
                await db.refresh(user)
                continue
            ch.card_created = True
            if channel.kind != ChannelKind.dm:
                ch.huddle_started = True
                ch.huddle_invited = set(invitee_ids)
            invites = []
            await _invite(db, call, user.id, invitee_ids, invites, ch)
        await _sync_card(db, call, ch)
        await db.commit()
        await huddles.join(
            channel.id, channel.workspace_id, channel.kind == ChannelKind.public, user.id
        )
        await db.refresh(call)  # the registry listener may have updated it meanwhile
        await _flush(db, call, ch)
        if is_live(call):
            return call
        # It ended between our commit and joining the room; start a new one.
    raise HTTPException(status.HTTP_409_CONFLICT, "Could not start the call, please retry")


async def accept(db: AsyncSession, call_id: uuid.UUID, user: User) -> tuple[Call, Channel]:
    call, channel = await get_call_for(db, call_id, user)
    call = await _lock(db, call.id)
    invites = await _invites(db, call.id)
    if not any(i.user_id == user.id for i in invites):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "You weren't invited to this call")
    if not is_live(call):
        await db.commit()  # release the row lock
        raise HTTPException(status.HTTP_409_CONFLICT, "Call has ended")
    ch = Changes()
    _mark_joined(call, user.id, invites, ch)
    await _sync_card(db, call, ch)
    await db.commit()
    await huddles.join(
        channel.id, channel.workspace_id, channel.kind == ChannelKind.public, user.id
    )
    await db.refresh(call)
    await _flush(db, call, ch)
    return call, channel


async def decline(db: AsyncSession, call_id: uuid.UUID, user: User) -> None:
    call, channel = await get_call_for(db, call_id, user)
    call = await _lock(db, call.id)
    invites = await _invites(db, call.id)
    mine = next((i for i in invites if i.user_id == user.id), None)
    if not mine:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "You weren't invited to this call")
    if mine.status != InviteStatus.ringing or not is_live(call):
        await db.commit()
        return
    ch = Changes()
    _invite_changed(ch, mine, InviteStatus.declined, "declined")
    await _maybe_end_unanswered(db, call, channel.kind, invites, ch)
    await _commit_and_flush(db, call, ch)


async def cancel(db: AsyncSession, call_id: uuid.UUID, user: User) -> None:
    call, _ = await get_call_for(db, call_id, user)
    call = await _lock(db, call.id)
    if user.id not in call.joined_ids:
        await db.commit()  # release the row lock
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only people in the call can cancel it")
    if not is_live(call):
        await db.commit()
        return
    invites = await _invites(db, call.id)
    ch = Changes()
    for inv in invites:
        if inv.status == InviteStatus.ringing:
            _invite_changed(ch, inv, InviteStatus.cancelled, "cancelled")
    if len(set(call.joined_ids)) <= 1:
        await _end(db, call, CallStatus.cancelled, invites, ch, clear_room=True)
    await _commit_and_flush(db, call, ch)


async def invite_more(
    db: AsyncSession, call_id: uuid.UUID, user: User, user_ids: set[uuid.UUID]
) -> CallOut:
    call, channel = await get_call_for(db, call_id, user)
    await _validate_invitees(db, channel, set(user_ids) - {user.id})
    call = await _lock(db, call.id)
    if not is_live(call):
        await db.commit()  # release the row lock
        raise HTTPException(status.HTTP_409_CONFLICT, "Call has ended")
    if user.id not in call.joined_ids:
        await db.commit()  # release the row lock
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the call to invite people")
    invites = await _invites(db, call.id)
    ch = Changes()
    await _invite(db, call, user.id, set(user_ids), invites, ch)
    return await _commit_and_flush(db, call, ch)


async def leave(db: AsyncSession, call_id: uuid.UUID, user: User) -> None:
    call, _ = await get_call_for(db, call_id, user)
    if not is_live(call):
        return
    await db.commit()  # release the read snapshot before the registry runs our listener
    await huddles.leave(call.channel_id, user.id)
    await sync_call(str(call.channel_id))


async def heartbeat(db: AsyncSession, channel: Channel, user: User) -> None:
    """Keep the user in the live call; a lapsed user rejoins (or restarts) the call.

    410 when the user's call in this channel just ended without being answered (the
    client should hang up) rather than quietly starting a new call.
    """
    public = channel.kind == ChannelKind.public
    if await live_call(db, channel.id):
        await db.commit()
        await huddles.heartbeat(channel.id, channel.workspace_id, public, user.id)
        return
    recent = await db.scalar(
        select(Call)
        .where(
            Call.channel_id == channel.id,
            Call.ended_at > _now() - timedelta(seconds=RECENT_END_SECONDS),
        )
        .order_by(Call.ended_at.desc())
        .limit(1)
    )
    if recent and recent.status != CallStatus.ended and user.id in recent.joined_ids:
        raise HTTPException(status.HTTP_410_GONE, "Call has ended")
    await start_or_join(db, channel, user, CallKind.audio, set())


async def ringing_for(db: AsyncSession, user: User) -> list[tuple[CallOut, uuid.UUID]]:
    """Invites still ringing for the user (after lazy expiry), in channels they can access."""
    call_ids = list(
        await db.scalars(
            select(CallInvite.call_id).where(
                CallInvite.user_id == user.id, CallInvite.status == InviteStatus.ringing
            )
        )
    )
    out = []
    for call_id in call_ids:
        await expire_call(call_id, db=db)
        call = await db.get(Call, call_id, populate_existing=True)
        inv = await db.scalar(
            select(CallInvite)
            .where(CallInvite.call_id == call_id, CallInvite.user_id == user.id)
            .execution_options(populate_existing=True)
        )
        if not call or not is_live(call) or not inv or inv.status != InviteStatus.ringing:
            continue
        channel = await db.get(Channel, call.channel_id)
        if not channel or not await can_access_channel(db, channel, user.id):
            continue
        out.append((await serialize_call(db, call), inv.invited_by))
    return out


async def save_notes(
    db: AsyncSession, call_id: uuid.UUID, user: User, content: dict, base_version: int
) -> tuple[Call, bool]:
    """Returns (call, saved). saved=False means a version conflict (call holds the current notes)."""
    call = await _lock(db, call_id)
    if content == call.notes:
        await db.commit()
        return call, True
    if base_version != call.notes_version:
        await db.commit()
        return call, False
    call.notes = content
    call.notes_version = call.notes_version + 1
    call.notes_updated_by = user.id
    call.notes_updated_at = _now()
    ch = Changes()
    await _sync_notes_message(db, call, ch)
    await db.commit()
    await publish_to_channel(
        call.channel_id,
        {"type": "call.notes_updated", "call_id": str(call.id), "notes": notes_out(call)},
    )
    for mid in ch.messages_created:
        msg = await db.get(Message, mid)
        await publish_to_channel(
            call.channel_id, _message_event("message.created", await serialize_message(db, msg))
        )
    for mid in ch.messages_updated:
        msg = await db.get(Message, mid)
        await publish_to_channel(
            call.channel_id, _message_event("message.updated", await serialize_message(db, msg))
        )
    for msg in ch.messages_deleted:
        await publish_to_channel(
            call.channel_id,
            {
                "type": "message.deleted",
                "message_id": str(msg.id),
                "channel_id": str(msg.channel_id),
                "parent_id": str(msg.parent_id) if msg.parent_id else None,
            },
        )
    return call, True


def notes_out(call: Call) -> dict:
    return {
        "call_id": str(call.id),
        "content": call.notes,
        "version": call.notes_version,
        "updated_by": str(call.notes_updated_by) if call.notes_updated_by else None,
        "updated_at": call.notes_updated_at.isoformat() if call.notes_updated_at else None,
    }


async def can_use_notes(db: AsyncSession, call: Call, user: User) -> bool:
    return user.id in call.joined_ids or await is_channel_member(db, call.channel_id, user.id)


# --- Registry sync, expiry, sweeping ----------------------------------------------------------


async def sync_call(channel_id: str, *, db: AsyncSession | None = None) -> None:
    """Bring the channel's live call in line with who is actually in the room.

    Registered as a huddle-registry listener; also safe to call any time (idempotent).
    """
    if db is None:
        async with SessionLocal() as session:
            await sync_call(channel_id, db=session)
        return
    call = await live_call(db, uuid.UUID(channel_id), lock=True)
    if not call:
        await db.commit()
        return
    participants = [uuid.UUID(p) for p in await huddles.participant_ids(channel_id)]
    invites = await _invites(db, call.id)
    ch = Changes()
    for uid in participants:
        _mark_joined(call, uid, invites, ch)
    if not participants:
        await _end(db, call, _final_status(call, invites), invites, ch, clear_room=False)
    await _commit_and_flush(db, call, ch)


async def expire_call(call_id: uuid.UUID, *, db: AsyncSession | None = None) -> None:
    """Turn the call's overdue ringing invites into "missed" (ending an unanswered DM call)."""
    if db is None:
        async with SessionLocal() as session:
            await expire_call(call_id, db=session)
        return
    due = await db.scalar(
        select(CallInvite.id).where(
            CallInvite.call_id == call_id,
            CallInvite.status == InviteStatus.ringing,
            CallInvite.expires_at <= _now(),
        ).limit(1)
    )
    if not due:
        return
    call = await _lock(db, call_id)
    if not call:
        await db.commit()
        return
    invites = await _invites(db, call.id)
    ch = Changes()
    await _expire_due(db, call, invites, ch)
    if not ch.invite_updates:
        await db.commit()
        return
    await _commit_and_flush(db, call, ch)


async def sweep() -> None:
    """Expire overdue invites and end live calls whose room has been empty for a while."""
    async with SessionLocal() as db:
        due = list(
            await db.scalars(
                select(CallInvite.call_id)
                .where(
                    CallInvite.status == InviteStatus.ringing, CallInvite.expires_at <= _now()
                )
                .distinct()
            )
        )
        stale_before = _now() - timedelta(seconds=EMPTY_ROOM_GRACE_SECONDS)
        live = list(
            await db.execute(
                select(Call.channel_id).where(
                    Call.status.in_(_LIVE), Call.started_at < stale_before
                )
            )
        )
    for call_id in due:
        await expire_call(call_id)
    for (channel_id,) in live:
        if not await huddles.participant_ids(channel_id):
            await sync_call(str(channel_id))


async def run_sweeper() -> None:
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
        try:
            if await redis.set(SWEEP_LOCK_KEY, "1", nx=True, ex=SWEEP_INTERVAL_SECONDS - 1):
                await sweep()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Call sweep failed")


async def _on_room_change(channel_id: str) -> None:
    await sync_call(channel_id)


huddles.add_listener(_on_room_change)

__all__ = [
    "RING_TIMEOUT_SECONDS",
    "accept",
    "cancel",
    "decline",
    "default_invitees",
    "expire_call",
    "heartbeat",
    "invite_more",
    "leave",
    "notes_to_text",
    "ringing_for",
    "start_or_join",
    "sweep",
    "sync_call",
]
