"""Threads inbox and Activity feed.

Realtime (user topic): thread.updated {root_id, channel_id, unread_count, following},
activity.new {item, notify}, activity.read {workspace_id, ids|all, unread_count}.
"""

import uuid

from fastapi import APIRouter, Query

from app import productivity as svc
from app.api.deps import DB, CurrentUser, WorkspaceMembership, is_guest, readable_channel_ids
from app.models import Message
from app.realtime.hub import notify_user
from app.schemas_productivity import (
    ActivityFilter,
    ActivityPage,
    ActivityReadIn,
    ActivityReadOut,
    Page,
    ThreadOut,
    ThreadStateOut,
)

router = APIRouter(tags=["productivity"])


# --- Threads ------------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/threads", response_model=Page[ThreadOut])
async def list_threads(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
    unread_only: bool = False,
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(20, ge=1, le=50),
) -> dict:
    """Threads the user follows, most recently active first."""
    readable = readable_channel_ids(workspace_id, user.id, is_guest(membership))
    items, next_cursor = await svc.list_threads(
        db, workspace_id, user.id, readable, unread_only=unread_only, cursor=cursor, limit=limit
    )
    return {"items": items, "next_cursor": next_cursor}


async def _root(db, user, message_id: uuid.UUID) -> Message:
    """The thread root for a message id (a reply resolves to its root)."""
    msg, _ = await svc.get_readable_message(db, user, message_id)
    if msg.parent_id:
        msg, _ = await svc.get_readable_message(db, user, msg.parent_id)
    return msg


async def _thread_state(db, user, root: Message) -> ThreadStateOut:
    return ThreadStateOut(
        root_id=root.id,
        channel_id=root.channel_id,
        following=await svc.is_following(db, user.id, root),
        unread_count=await svc.thread_unread_count(db, user.id, root),
    )


@router.post("/messages/{message_id}/follow", response_model=ThreadStateOut)
async def follow_thread(message_id: uuid.UUID, db: DB, user: CurrentUser) -> ThreadStateOut:
    root = await _root(db, user, message_id)
    await svc.set_thread_state(db, user.id, root, following=True)
    await db.commit()
    await svc.publish_thread_state(db, user.id, root)
    return await _thread_state(db, user, root)


@router.delete("/messages/{message_id}/follow", response_model=ThreadStateOut)
async def unfollow_thread(message_id: uuid.UUID, db: DB, user: CurrentUser) -> ThreadStateOut:
    root = await _root(db, user, message_id)
    await svc.set_thread_state(db, user.id, root, following=False)
    await db.commit()
    await svc.publish_thread_state(db, user.id, root)
    return await _thread_state(db, user, root)


@router.get("/messages/{message_id}/thread-state", response_model=ThreadStateOut)
async def thread_state(message_id: uuid.UUID, db: DB, user: CurrentUser) -> ThreadStateOut:
    return await _thread_state(db, user, await _root(db, user, message_id))


@router.post("/messages/{message_id}/thread-read", response_model=ThreadStateOut)
async def mark_thread_read(message_id: uuid.UUID, db: DB, user: CurrentUser) -> ThreadStateOut:
    root = await _root(db, user, message_id)
    await svc.set_thread_state(db, user.id, root, read=True)
    await db.commit()
    await svc.publish_thread_state(db, user.id, root)
    return await _thread_state(db, user, root)


# --- Activity -----------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/activity", response_model=ActivityPage)
async def list_activity(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
    type: ActivityFilter = "all",
    unread_only: bool = False,
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(30, ge=1, le=100),
) -> dict:
    """Mentions, reactions to your messages, replies in threads you follow, channel invites,
    missed calls, reminders and huddle starts, newest first. `unread_count` is for the chosen `type`."""
    readable = readable_channel_ids(workspace_id, user.id, is_guest(membership))
    items, next_cursor, unread = await svc.list_activity(
        db,
        workspace_id,
        user.id,
        readable,
        kind=type,
        unread_only=unread_only,
        cursor=cursor,
        limit=limit,
    )
    return {"items": items, "next_cursor": next_cursor, "unread_count": unread}


@router.post("/workspaces/{workspace_id}/activity/read", response_model=ActivityReadOut)
async def mark_activity_read(
    workspace_id: uuid.UUID,
    data: ActivityReadIn,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
) -> ActivityReadOut:
    await svc.mark_activity_read(db, workspace_id, user.id, ids=data.ids, all_items=data.all)
    await db.commit()
    readable = readable_channel_ids(workspace_id, user.id, is_guest(membership))
    unread = await svc.activity_unread_count(db, workspace_id, user.id, readable)
    event: dict = {"type": "activity.read", "workspace_id": str(workspace_id), "unread_count": unread}
    if data.all:
        event["all"] = True
    else:
        event["ids"] = [str(i) for i in data.ids or []]
    await notify_user(user.id, event)
    return ActivityReadOut(unread_count=unread)

