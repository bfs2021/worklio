"""Later (saved messages + to-dos) and reminders.

Realtime (user topic): later.updated {item}, later.deleted {id, message_id},
reminder.updated {reminder}, reminder.deleted {id}; delivery sends reminder.due {reminder}
(see app.productivity.deliver_due_reminders).
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError

from app import productivity as svc
from app.api.deps import DB, CurrentUser, WorkspaceMembership, get_workspace_membership
from app.models import Channel, Message, Reminder, SavedItem
from app.realtime.hub import notify_user
from app.schemas_productivity import (
    ReminderIn,
    ReminderOut,
    ReminderPatch,
    SavedItemIn,
    SavedItemOut,
    SavedItemPatch,
    SavedStatus,
)
from app.services import serialize_messages

router = APIRouter(tags=["productivity"])

MAX_SAVED_ITEMS = 5000
MAX_PENDING_REMINDERS = 500


def _now() -> datetime:
    return datetime.now(UTC)


async def _serialize_items(db, user, items: list[SavedItem]) -> list[SavedItemOut]:
    """Items with their messages; a message the user can no longer read comes back as null."""
    message_ids = {i.message_id for i in items if i.message_id}
    readable_ids: set[uuid.UUID] = set()
    channel_by_msg: dict[uuid.UUID, uuid.UUID] = {}
    messages: list[Message] = []
    if message_ids:
        rows = list(await db.scalars(select(Message).where(Message.id.in_(message_ids))))
        readable_channels: set[uuid.UUID] = set()
        for workspace_id in {m.workspace_id for m in rows}:
            readable = await svc.readable_for(db, workspace_id, user.id)
            if readable is not None:
                readable_channels |= set(
                    await db.scalars(
                        readable.where(Channel.id.in_({m.channel_id for m in rows}))
                    )
                )
        for m in rows:
            channel_by_msg[m.id] = m.channel_id
            if m.deleted_at is None and m.channel_id in readable_channels:
                readable_ids.add(m.id)
                messages.append(m)
    by_id = {m.id: m for m in await serialize_messages(db, messages, viewer_id=user.id)}
    out = []
    for i in items:
        item = SavedItemOut.model_validate(i)
        item.message = by_id.get(i.message_id) if i.message_id in readable_ids else None
        item.channel_id = channel_by_msg.get(i.message_id) if i.message_id else None
        out.append(item)
    return out


async def _item_out(db, user, item: SavedItem) -> SavedItemOut:
    return (await _serialize_items(db, user, [item]))[0]


async def _own_item(db, user, item_id: uuid.UUID) -> SavedItem:
    item = await db.get(SavedItem, item_id)
    if (
        not item
        or item.user_id != user.id
        or not await get_workspace_membership(db, item.workspace_id, user.id)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found")
    return item


async def _sync_item_reminder(db, item: SavedItem) -> Reminder | None:
    """Keep the item's reminder in line with its remind_at (only while in progress)."""
    reminder = await db.scalar(select(Reminder).where(Reminder.saved_item_id == item.id))
    wanted = item.remind_at if item.status == "in_progress" else None
    if wanted is None:
        if reminder and reminder.status == "pending":
            reminder.status = "cancelled"
            return reminder
        return None
    text = item.title
    if not text and item.message_id:
        msg = await db.get(Message, item.message_id)
        text = " ".join((msg.body if msg else "").split())[:120]
    text = text or "Saved item"
    if reminder is None:
        reminder = Reminder(
            workspace_id=item.workspace_id,
            user_id=item.user_id,
            text=text[:500],
            remind_at=wanted,
            message_id=item.message_id,
            saved_item_id=item.id,
            status="pending",
        )
        db.add(reminder)
        return reminder
    if reminder.remind_at != wanted or reminder.status == "cancelled":
        reminder.remind_at, reminder.status, reminder.sent_at = wanted, "pending", None
    reminder.text = text[:500]
    return reminder


async def _publish_item(db, user, item: SavedItem) -> SavedItemOut:
    out = await _item_out(db, user, item)
    await notify_user(user.id, {"type": "later.updated", "item": out.model_dump(mode="json")})
    return out


# --- Later --------------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/later", response_model=list[SavedItemOut])
async def list_later(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    _: WorkspaceMembership,
    status_: Annotated[SavedStatus, Query(alias="status")] = "in_progress",
    limit: int = Query(200, ge=1, le=500),
) -> list[SavedItemOut]:
    q = select(SavedItem).where(
        SavedItem.user_id == user.id,
        SavedItem.workspace_id == workspace_id,
        SavedItem.status == status_,
    )
    if status_ == "in_progress":
        # Overdue/soonest first, undated after them, newest saves first within each group.
        q = q.order_by(
            case((SavedItem.due_at.is_(None), 1), else_=0),
            SavedItem.due_at,
            SavedItem.created_at.desc(),
        )
    elif status_ == "completed":
        q = q.order_by(SavedItem.completed_at.desc().nulls_last(), SavedItem.created_at.desc())
    else:
        q = q.order_by(SavedItem.updated_at.desc())
    items = list(await db.scalars(q.limit(limit)))
    return await _serialize_items(db, user, items)


@router.post(
    "/workspaces/{workspace_id}/later",
    response_model=SavedItemOut,
    status_code=status.HTTP_201_CREATED,
    responses={200: {"description": "The message was already saved; the existing item"}},
)
async def create_later(
    workspace_id: uuid.UUID,
    data: SavedItemIn,
    db: DB,
    user: CurrentUser,
    _: WorkspaceMembership,
    response: Response,
) -> SavedItemOut:
    if data.message_id is None and data.title is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Give a message_id or a title for the to-do"
        )
    if data.message_id is not None:
        await svc.get_readable_message(db, user, data.message_id, workspace_id)
        existing = await db.scalar(
            select(SavedItem).where(
                SavedItem.user_id == user.id, SavedItem.message_id == data.message_id
            )
        )
        if existing:
            if existing.status != "in_progress":
                existing.status, existing.completed_at = "in_progress", None
                await _sync_item_reminder(db, existing)
                await db.commit()
                await db.refresh(existing)
                await _publish_item(db, user, existing)
            response.status_code = status.HTTP_200_OK
            return await _item_out(db, user, existing)
    count = await db.scalar(
        select(func.count()).where(
            SavedItem.user_id == user.id, SavedItem.workspace_id == workspace_id
        )
    )
    if count >= MAX_SAVED_ITEMS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Too many saved items; clear some first")
    item = SavedItem(
        workspace_id=workspace_id,
        user_id=user.id,
        kind="message" if data.message_id else "todo",
        message_id=data.message_id,
        title=data.title,
        notes=data.notes,
        status="in_progress",
        due_at=data.due_at,
        remind_at=data.remind_at,
    )
    db.add(item)
    try:
        await db.flush()
    except IntegrityError:  # the same message saved concurrently
        await db.rollback()
        existing = await db.scalar(
            select(SavedItem).where(
                SavedItem.user_id == user.id, SavedItem.message_id == data.message_id
            )
        )
        if not existing:
            raise
        response.status_code = status.HTTP_200_OK
        return await _item_out(db, user, existing)
    await _sync_item_reminder(db, item)
    await db.commit()
    await db.refresh(item)
    return await _publish_item(db, user, item)


@router.patch("/later/{item_id}", response_model=SavedItemOut)
async def update_later(
    item_id: uuid.UUID, data: SavedItemPatch, db: DB, user: CurrentUser
) -> SavedItemOut:
    item = await _own_item(db, user, item_id)
    changes = data.model_dump(exclude_unset=True)
    if "title" in changes:
        if changes["title"] is None and item.kind == "todo":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A to-do needs a title")
        item.title = changes["title"]
    if "notes" in changes:
        item.notes = changes["notes"]
    if "due_at" in changes:
        item.due_at = changes["due_at"]
    if "remind_at" in changes:
        item.remind_at = changes["remind_at"]
    if changes.get("status") and changes["status"] != item.status:
        item.status = changes["status"]
        item.completed_at = _now() if item.status == "completed" else None
    await _sync_item_reminder(db, item)
    await db.commit()
    await db.refresh(item)
    return await _publish_item(db, user, item)


@router.delete("/later/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_later(item_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
    item = await _own_item(db, user, item_id)
    message_id = item.message_id
    await db.delete(item)  # its reminder goes with it (ON DELETE CASCADE)
    await db.commit()
    await notify_user(
        user.id,
        {
            "type": "later.deleted",
            "id": str(item_id),
            "message_id": str(message_id) if message_id else None,
        },
    )


# --- Reminders ----------------------------------------------------------------------------


async def _own_reminder(db, user, reminder_id: uuid.UUID) -> Reminder:
    reminder = await db.get(Reminder, reminder_id)
    if (
        not reminder
        or reminder.user_id != user.id
        or not await get_workspace_membership(db, reminder.workspace_id, user.id)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reminder not found")
    return reminder


async def _publish_reminder(user, reminder: Reminder) -> ReminderOut:
    out = svc.reminder_out(reminder)
    await notify_user(user.id, {"type": "reminder.updated", "reminder": out.model_dump(mode="json")})
    return out


@router.post(
    "/workspaces/{workspace_id}/reminders",
    response_model=ReminderOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_reminder(
    workspace_id: uuid.UUID, data: ReminderIn, db: DB, user: CurrentUser, _: WorkspaceMembership
) -> ReminderOut:
    if data.message_id is not None:
        await svc.get_readable_message(db, user, data.message_id, workspace_id)
    pending = await db.scalar(
        select(func.count()).where(
            Reminder.user_id == user.id,
            Reminder.workspace_id == workspace_id,
            Reminder.status == "pending",
        )
    )
    if pending >= MAX_PENDING_REMINDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Too many pending reminders")
    reminder = Reminder(
        workspace_id=workspace_id,
        user_id=user.id,
        text=data.text,
        remind_at=data.remind_at,
        message_id=data.message_id,
        status="pending",
    )
    db.add(reminder)
    await db.commit()
    await db.refresh(reminder)
    return await _publish_reminder(user, reminder)


@router.get("/workspaces/{workspace_id}/reminders", response_model=list[ReminderOut])
async def list_reminders(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    _: WorkspaceMembership,
    status_: Literal["pending", "sent", "cancelled"] = Query("pending", alias="status"),
    limit: int = Query(200, ge=1, le=500),
) -> list[Reminder]:
    order = Reminder.remind_at if status_ == "pending" else Reminder.remind_at.desc()
    return list(
        await db.scalars(
            select(Reminder)
            .where(
                Reminder.user_id == user.id,
                Reminder.workspace_id == workspace_id,
                Reminder.status == status_,
            )
            .order_by(order, Reminder.id)
            .limit(limit)
        )
    )


@router.patch("/reminders/{reminder_id}", response_model=ReminderOut)
async def update_reminder(
    reminder_id: uuid.UUID, data: ReminderPatch, db: DB, user: CurrentUser
) -> ReminderOut:
    """Edit or snooze: a new remind_at makes a sent/cancelled reminder pending again."""
    reminder = await _own_reminder(db, user, reminder_id)
    if data.text is not None:
        reminder.text = data.text
    if data.remind_at is not None:
        reminder.remind_at, reminder.status, reminder.sent_at = data.remind_at, "pending", None
        if reminder.saved_item_id:
            item = await db.get(SavedItem, reminder.saved_item_id)
            if item:
                item.remind_at = data.remind_at
    await db.commit()
    await db.refresh(reminder)
    return await _publish_reminder(user, reminder)


@router.delete("/reminders/{reminder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reminder(reminder_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
    reminder = await _own_reminder(db, user, reminder_id)
    if reminder.saved_item_id:
        item = await db.get(SavedItem, reminder.saved_item_id)
        if item:
            item.remind_at = None
    await db.delete(reminder)
    await db.commit()
    await notify_user(user.id, {"type": "reminder.deleted", "id": str(reminder_id)})
