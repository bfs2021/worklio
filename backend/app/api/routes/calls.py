"""Audio/video calls (ringing, accept/decline/cancel, invites) and their shared notes.

See app.calls for the lifecycle rules. Realtime events:
    channel topic: call.updated {call}, call.notes_updated {call_id, notes},
                   message.created / message.updated (call card and notes reply)
    user topic:    call.ringing {call, caller_id}, call.ring_stopped {call_id, reason},
                   call.invite_updated {call_id, user_id, status} (to the caller / inviter)
"""

import json
import uuid

from fastapi import APIRouter, HTTPException, Response, status
from fastapi.responses import JSONResponse

from app import calls
from app.api.deps import DB, ChannelAccess, CurrentUser, ensure_not_archived
from app.core.config import settings
from app.models import Call, Channel
from app.realtime import huddles
from app.schemas import (
    CallIn,
    CallInviteIn,
    CallJoinOut,
    CallNotesIn,
    CallNotesOut,
    CallOut,
    HuddleJoinOut,
    RingingCallOut,
)

router = APIRouter(tags=["calls"])


def too_large_message() -> str:
    return f"Notes too large (max {settings.max_canvas_bytes / (1024 * 1024):g} MB)"


def _join_info(channel: Channel, user) -> HuddleJoinOut:
    return HuddleJoinOut(
        url=settings.livekit_public_url,
        token=huddles.livekit_token(channel.id, user.id, user.full_name),
        room=huddles.room_name(channel.id),
    )


@router.post("/channels/{channel_id}/calls", response_model=CallJoinOut)
async def start_call(data: CallIn, channel: ChannelAccess, db: DB, user: CurrentUser) -> CallJoinOut:
    """Start an audio/video call (or join the channel's live one) and ring `invitee_ids`.

    Without `invitee_ids`, a DM rings every other member and a channel starts a quiet huddle.
    A DM with yourself (no other members) can't be called (400).
    """
    ensure_not_archived(channel)
    if await calls.is_self_dm(db, channel, user.id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't call yourself")
    invitees = set(data.invitee_ids or [])
    if not invitees:
        invitees = await calls.default_invitees(db, channel, user.id)
    call = await calls.start_or_join(db, channel, user, data.kind, invitees)
    return CallJoinOut(call=await calls.serialize_call(db, call), join=_join_info(channel, user))


@router.get("/calls/{call_id}", response_model=CallOut)
async def get_call(call_id: uuid.UUID, db: DB, user: CurrentUser) -> CallOut:
    call, _ = await calls.get_call_for(db, call_id, user)
    return await calls.serialize_call(db, call)


@router.get("/me/calls/ringing", response_model=list[RingingCallOut])
async def my_ringing_calls(db: DB, user: CurrentUser) -> list[RingingCallOut]:
    """Calls ringing for the current user right now (for showing the incoming-call UI on load)."""
    return [
        RingingCallOut(call=call, caller_id=caller)
        for call, caller in await calls.ringing_for(db, user)
    ]


@router.post("/calls/{call_id}/accept", response_model=CallJoinOut)
async def accept_call(call_id: uuid.UUID, db: DB, user: CurrentUser) -> CallJoinOut:
    call, channel = await calls.accept(db, call_id, user)
    return CallJoinOut(call=await calls.serialize_call(db, call), join=_join_info(channel, user))


@router.post("/calls/{call_id}/decline", status_code=status.HTTP_204_NO_CONTENT)
async def decline_call(call_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    await calls.decline(db, call_id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/calls/{call_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_call(call_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    """Stop ringing everyone; ends the call too if nobody else ever joined."""
    await calls.cancel(db, call_id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/calls/{call_id}/invite", response_model=CallOut)
async def invite_to_call(
    call_id: uuid.UUID, data: CallInviteIn, db: DB, user: CurrentUser
) -> CallOut:
    _, channel = await calls.get_call_for(db, call_id, user)
    ensure_not_archived(channel)
    return await calls.invite_more(db, call_id, user, set(data.user_ids))


@router.post("/calls/{call_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_call(call_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    await calls.leave(db, call_id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _notes_call(db, call_id: uuid.UUID, user) -> tuple[Call, Channel]:
    call, channel = await calls.get_call_for(db, call_id, user)
    if not await calls.can_use_notes(db, call, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only channel members can use call notes")
    return call, channel


@router.get("/calls/{call_id}/notes", response_model=CallNotesOut)
async def get_notes(call_id: uuid.UUID, db: DB, user: CurrentUser) -> dict:
    call, _ = await _notes_call(db, call_id, user)
    return calls.notes_out(call)


@router.put(
    "/calls/{call_id}/notes",
    response_model=CallNotesOut,
    responses={409: {"description": "Changed since base_version; body has the current notes"}},
)
async def save_notes(call_id: uuid.UUID, data: CallNotesIn, db: DB, user: CurrentUser):
    call, channel = await _notes_call(db, call_id, user)
    ensure_not_archived(channel)
    size = len(json.dumps(data.content, separators=(",", ":"), ensure_ascii=False).encode())
    if size > settings.max_canvas_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, too_large_message())
    await db.commit()  # end the read transaction before taking the row lock
    call, saved = await calls.save_notes(db, call.id, user, data.content, data.base_version)
    out = calls.notes_out(call)
    if not saved:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT, content={"detail": "Notes changed", "notes": out}
        )
    return out
