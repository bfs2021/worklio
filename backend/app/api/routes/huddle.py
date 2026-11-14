import uuid

from fastapi import APIRouter, Response, status

from app import calls
from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    WorkspaceMembership,
    ensure_not_archived,
    is_guest,
    readable_channel_ids,
)
from app.core.config import settings
from app.models import CallKind, Channel
from app.realtime import huddles
from app.schemas import HuddleJoinOut, HuddleOut

router = APIRouter(tags=["huddles"])


@router.post("/channels/{channel_id}/huddle/join", response_model=HuddleJoinOut)
async def join_huddle(channel: ChannelAccess, db: DB, user: CurrentUser) -> HuddleJoinOut:
    """A LiveKit token for the channel's room; also marks the user as a participant.

    Same as starting/joining an audio call with nobody rung (POST /channels/{id}/calls).
    """
    ensure_not_archived(channel)
    await calls.start_or_join(db, channel, user, CallKind.audio, set())
    return HuddleJoinOut(
        url=settings.livekit_public_url,
        token=huddles.livekit_token(channel.id, user.id, user.full_name),
        room=huddles.room_name(channel.id),
    )


@router.post("/channels/{channel_id}/huddle/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def huddle_heartbeat(channel: ChannelAccess, db: DB, user: CurrentUser) -> Response:
    """Call every ~20 s while connected; participants are dropped after 60 s of silence.

    410 means the call ended (e.g. it was declined or nobody answered): hang up.
    """
    await calls.heartbeat(db, channel, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/channels/{channel_id}/huddle/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_huddle(channel: ChannelAccess, db: DB, user: CurrentUser) -> Response:
    await db.commit()
    await huddles.leave(channel.id, user.id)
    await calls.sync_call(str(channel.id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/workspaces/{workspace_id}/huddles", response_model=list[HuddleOut])
async def list_huddles(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser, membership: WorkspaceMembership
) -> list[HuddleOut]:
    """Live huddles in channels the user can access."""
    states = await huddles.active_in_workspace(workspace_id)
    if not states:
        return []
    readable = set(
        await db.scalars(
            readable_channel_ids(workspace_id, user.id, is_guest(membership)).where(
                Channel.id.in_([uuid.UUID(s.channel_id) for s in states])
            )
        )
    )
    return [
        HuddleOut(
            channel_id=s.channel_id, participant_ids=s.participant_ids, started_at=s.started_at
        )
        for s in states
        if uuid.UUID(s.channel_id) in readable
    ]
