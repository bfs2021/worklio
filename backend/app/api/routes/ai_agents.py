"""The @worklio agent's bot user, live call captions and the AI call summary.

Realtime events:
    channel topic: call.caption {call_id, user_id, text, final, ts}
                   typing {channel_id, user_id: <bot>, parent_id} while the agent works
                   message.created / message.updated (agent answers, call summary replies,
                   install / not-installed system messages)
                   ai.agent_installed {channel_id, installed: bool} after an install change

Agent installs (like a Slack app):
    POST/DELETE /channels/{id}/apps/worklio                   (install_apps policy + channel member)
    POST/DELETE /workspaces/{id}/apps/worklio/install-everywhere   (owners/admins; public channels)
"""

import contextlib
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app import calls
from app.ai import agent, captions
from app.ai import client as ai
from app.ai import workspace as ai_ws
from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    WorkspaceMembership,
    is_channel_member,
    require_workspace_admin,
)
from app.models import Channel, ChannelKind, ChannelMember
from app.models.ai_settings import AIAgentInstall

router = APIRouter(tags=["ai"])


async def _require_ai(workspace_id: uuid.UUID) -> None:
    if not await ai.ai_enabled(workspace_id):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "ai_not_configured")


class BotOut(BaseModel):
    user_id: uuid.UUID


@router.get("/workspaces/{workspace_id}/ai/bot", response_model=BotOut)
async def get_bot(workspace_id: uuid.UUID, db: DB, _: WorkspaceMembership) -> BotOut:
    """The workspace's "Worklio" bot user (created on first use). Mention it as <@user_id>."""
    await _require_ai(workspace_id)
    bot = await agent.get_or_create_bot(db, workspace_id)
    return BotOut(user_id=bot.id)


# --- Live captions ---------------------------------------------------------------------------


class CaptionIn(BaseModel):
    text: str = Field(max_length=captions.MAX_CAPTION_CHARS)
    # Interim results replace each other on screen; final ones are stored in the transcript.
    final: bool = False
    # When the speaker started this segment (client clock; clamped server-side).
    started_at: datetime | None = None


class CaptionOut(BaseModel):
    type: str
    call_id: uuid.UUID
    user_id: uuid.UUID
    text: str
    final: bool
    ts: datetime


class TranscriptSegmentOut(BaseModel):
    user_id: uuid.UUID
    text: str
    ts: datetime


@router.post("/calls/{call_id}/captions", response_model=CaptionOut, status_code=status.HTTP_202_ACCEPTED)
async def post_caption(call_id: uuid.UUID, data: CaptionIn, db: DB, user: CurrentUser) -> dict:
    """Relay a caption segment to everyone in the call's channel (participants of a live call only)."""
    call, _ = await calls.get_call_for(db, call_id, user)
    return await captions.post_caption(db, call, user, data.text, data.final, data.started_at)


@router.get("/calls/{call_id}/transcript", response_model=list[TranscriptSegmentOut])
async def get_transcript(call_id: uuid.UUID, db: DB, user: CurrentUser) -> list[dict]:
    call, _ = await calls.get_call_for(db, call_id, user)
    if not await calls.can_use_notes(db, call, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only channel members can read the transcript")
    return [captions.segment_out(s) for s in await captions.transcript(db, call.id)]


# --- AI call summary -------------------------------------------------------------------------


class ActionItemOut(BaseModel):
    title: str
    assignee_id: uuid.UUID | None = None


class CallSummaryOut(BaseModel):
    summary: str
    decisions: list[str]
    action_items: list[ActionItemOut]


@router.post(
    "/calls/{call_id}/ai/summary",
    response_model=CallSummaryOut,
    responses={409: {"description": "The call is still live"}, 422: {"description": "Nothing to summarise"}},
)
async def regenerate_summary(call_id: uuid.UUID, db: DB, user: CurrentUser) -> dict:
    """(Re)generate the AI summary of an ended call and post/replace it under the call card."""
    call, _ = await calls.get_call_for(db, call_id, user)
    await ai_ws.require_ai(db, call.workspace_id, user.id, "call_summary")
    if not await calls.can_use_notes(db, call, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only channel members can summarise this call")
    if calls.is_live(call):
        raise HTTPException(status.HTTP_409_CONFLICT, "The call is still going")
    if not await captions.has_summary_material(db, call):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Nothing to summarise: turn on captions or take notes during the call",
        )
    try:
        await ai.enforce_rate_limit(user.id, "call_summary", workspace_id=call.workspace_id)
        result = await captions.summarize_call(db, call.id, requested_by=user.id, force=True)
    except ai.AINotConfigured:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "ai_not_configured") from None
    except ai.AIRateLimited:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "rate_limited") from None
    except ai.AIRefused:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Worklio AI declined to summarise this call"
        ) from None
    if result is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Nothing to summarise")
    return result


@router.delete("/calls/{call_id}/transcript", status_code=status.HTTP_204_NO_CONTENT)
async def delete_transcript(call_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    """Anyone who was in the call can wipe its stored transcript."""
    call, _ = await calls.get_call_for(db, call_id, user)
    if user.id not in call.joined_ids:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only people who were in the call can do that")
    await captions.delete_transcript(db, call.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Agent installs ----------------------------------------------------------------------------


class InstallOut(BaseModel):
    channel_id: uuid.UUID | None
    installed: bool
    # The everywhere install still covers this (public) channel after a per-channel removal.
    covered_by_everywhere: bool = False
    installed_by: uuid.UUID | None = None
    created_at: datetime | None = None
    bot_user_id: uuid.UUID | None = None


async def _everywhere(db, workspace_id: uuid.UUID) -> AIAgentInstall | None:
    return await db.scalar(
        select(AIAgentInstall).where(
            AIAgentInstall.workspace_id == workspace_id, AIAgentInstall.channel_id.is_(None)
        )
    )


async def _installable_channel(db, channel: Channel, user) -> None:
    if channel.kind == ChannelKind.dm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Worklio AI always works in DMs with it")
    if channel.is_archived:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This channel is archived")
    if not await is_channel_member(db, channel.id, user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the channel to manage its apps")
    await ai_ws.require_policy(db, channel.workspace_id, user.id, ai_ws.INSTALL_APPS_POLICY)


async def _publish_install(channel_id: uuid.UUID, installed: bool) -> None:
    from app.realtime.hub import publish_to_channel

    with contextlib.suppress(Exception):  # realtime is best-effort
        await publish_to_channel(
            channel_id,
            {"type": "ai.agent_installed", "channel_id": str(channel_id), "installed": installed},
        )


@router.post("/channels/{channel_id}/apps/worklio", response_model=InstallOut)
async def install_in_channel(channel: ChannelAccess, db: DB, user: CurrentUser) -> InstallOut:
    """Add Worklio AI to a channel: the bot joins it and the channel gets a system message."""
    await _installable_channel(db, channel, user)
    channel_id, workspace_id = channel.id, channel.workspace_id
    inserted = await db.scalar(
        pg_insert(AIAgentInstall)
        .values(id=uuid.uuid4(), workspace_id=workspace_id, channel_id=channel_id, installed_by=user.id)
        .on_conflict_do_nothing(
            index_elements=["workspace_id", "channel_id"],
            index_where=AIAgentInstall.channel_id.isnot(None),
        )
        .returning(AIAgentInstall.id)
    )
    bot = await agent.get_or_create_bot(db, workspace_id)  # commits the install too
    install = await db.scalar(
        select(AIAgentInstall).where(
            AIAgentInstall.workspace_id == workspace_id, AIAgentInstall.channel_id == channel_id
        )
    )
    if inserted is not None:
        from app.api.routes.channels import add_members, notify_joined

        joined = await add_members(db, channel_id, {bot.id})
        await ai_ws.audit(
            db, workspace_id, user.id, "app.installed",
            target_type="channel", target_id=channel_id, meta={"app": "worklio_ai"},
        )
        await db.commit()
        if joined:
            await notify_joined(channel_id, joined)
        ch = await db.get(Channel, channel_id)
        await agent.post_system_message(
            db, ch, user.id, f"{user.full_name} added Worklio AI to this channel",
            {"type": "ai_agent_installed", "bot_user_id": str(bot.id), "installed_by": str(user.id)},
        )
        await _publish_install(channel_id, True)
    return InstallOut(
        channel_id=channel_id,
        installed=True,
        installed_by=install.installed_by if install else user.id,
        created_at=install.created_at if install else None,
        bot_user_id=bot.id,
    )


@router.delete("/channels/{channel_id}/apps/worklio", response_model=InstallOut)
async def uninstall_from_channel(channel: ChannelAccess, db: DB, user: CurrentUser) -> InstallOut:
    """Remove Worklio AI from a channel (the bot leaves it)."""
    await _installable_channel(db, channel, user)
    channel_id, workspace_id = channel.id, channel.workspace_id
    removed = await db.scalar(
        delete(AIAgentInstall)
        .where(AIAgentInstall.workspace_id == workspace_id, AIAgentInstall.channel_id == channel_id)
        .returning(AIAgentInstall.id)
    )
    everywhere = channel.kind == ChannelKind.public and await _everywhere(db, workspace_id) is not None
    bot_id = await agent.bot_id_for(db, workspace_id)
    if removed is not None:
        if bot_id is not None and not everywhere:
            await db.execute(
                delete(ChannelMember).where(
                    ChannelMember.channel_id == channel_id, ChannelMember.user_id == bot_id
                )
            )
        await ai_ws.audit(
            db, workspace_id, user.id, "app.uninstalled",
            target_type="channel", target_id=channel_id, meta={"app": "worklio_ai"},
        )
        await db.commit()
        ch = await db.get(Channel, channel_id)
        await agent.post_system_message(
            db, ch, user.id, f"{user.full_name} removed Worklio AI from this channel",
            {"type": "ai_agent_uninstalled", "removed_by": str(user.id)},
        )
        if bot_id is not None and not everywhere:
            from app.realtime.hub import notify_user, publish_to_channel

            with contextlib.suppress(Exception):
                await notify_user(bot_id, {"type": "channel.left", "channel_id": str(channel_id)})
                await publish_to_channel(
                    channel_id,
                    {"type": "channel.member_left", "channel_id": str(channel_id), "user_id": str(bot_id)},
                )
        await _publish_install(channel_id, everywhere)
    else:
        await db.commit()
    return InstallOut(
        channel_id=channel_id, installed=everywhere, covered_by_everywhere=everywhere, bot_user_id=bot_id
    )


@router.post(
    "/workspaces/{workspace_id}/apps/worklio/install-everywhere",
    response_model=InstallOut,
    dependencies=[Depends(require_workspace_admin)],
)
async def install_everywhere(workspace_id: uuid.UUID, db: DB, user: CurrentUser) -> InstallOut:
    """Make the agent available in every public channel (private channels still opt in)."""
    inserted = await db.scalar(
        pg_insert(AIAgentInstall)
        .values(id=uuid.uuid4(), workspace_id=workspace_id, channel_id=None, installed_by=user.id)
        .on_conflict_do_nothing(
            index_elements=["workspace_id"], index_where=AIAgentInstall.channel_id.is_(None)
        )
        .returning(AIAgentInstall.id)
    )
    if inserted is not None:
        await ai_ws.audit(
            db, workspace_id, user.id, "app.installed",
            target_type="workspace", target_id=workspace_id,
            meta={"app": "worklio_ai", "scope": "all_public_channels"},
        )
    bot = await agent.get_or_create_bot(db, workspace_id)  # commits
    install = await _everywhere(db, workspace_id)
    return InstallOut(
        channel_id=None,
        installed=True,
        installed_by=install.installed_by if install else user.id,
        created_at=install.created_at if install else None,
        bot_user_id=bot.id,
    )


@router.delete(
    "/workspaces/{workspace_id}/apps/worklio/install-everywhere",
    response_model=InstallOut,
    dependencies=[Depends(require_workspace_admin)],
)
async def uninstall_everywhere(workspace_id: uuid.UUID, db: DB, user: CurrentUser) -> InstallOut:
    """Stop the everywhere install (channels it was added to individually keep it)."""
    removed = await db.scalar(
        delete(AIAgentInstall)
        .where(AIAgentInstall.workspace_id == workspace_id, AIAgentInstall.channel_id.is_(None))
        .returning(AIAgentInstall.id)
    )
    if removed is not None:
        await ai_ws.audit(
            db, workspace_id, user.id, "app.uninstalled",
            target_type="workspace", target_id=workspace_id,
            meta={"app": "worklio_ai", "scope": "all_public_channels"},
        )
    await db.commit()
    return InstallOut(channel_id=None, installed=False, bot_user_id=await agent.bot_id_for(db, workspace_id))
