"""Canvases: collaborative rich documents (Yjs), standalone or one per channel, with comments.

Access is "workspace" (every full member), "private" (creator + member list) or "channel"
(whoever can read the channel); see app.canvas_collab. The document body is a Yjs doc edited
over the WebSocket (canvas.join / canvas.update / canvas.awareness) and served whole by
GET /canvases/{id}/state.

Legacy: GET/PUT /channels/{id}/canvas still serve and save the pre-Yjs TipTap JSON with
optimistic concurrency (a PUT carries `base_version`; a stale one gets 409 with the current
canvas). That JSON is returned as `legacy_content` while the Yjs doc is still empty, so the
first collaborative client can seed the doc from it.
"""

import json
import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import canvas_collab
from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    FullMembership,
    WorkspaceMembership,
    ensure_not_archived,
    is_guest,
    require_channel_access,
)
from app.core.config import settings
from app.models import (
    Canvas,
    CanvasComment,
    CanvasMember,
    Channel,
    User,
    WorkspaceMember,
    WorkspaceRole,
)
from app.models.canvas import EMPTY_DOC, CanvasAccess
from app.realtime.hub import (
    notify_user,
    publish_to_canvas,
    publish_to_channel,
    publish_to_workspace,
)
from app.schemas import CanvasIn

router = APIRouter(tags=["canvas"])

MAX_CANVAS_MEMBERS = 500
MAX_COMMENT_CHARS = 10_000
MAX_QUOTE_CHARS = 2_000
MAX_LIST_RESULTS = 500
_ANCHOR_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ADMIN_ROLES = (WorkspaceRole.owner, WorkspaceRole.admin)


def too_large_message() -> str:
    return f"Canvas too large (max {settings.max_canvas_bytes / (1024 * 1024):g} MB)"


# --- Schemas ---------------------------------------------------------------------------------

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
AccessName = Literal["workspace", "private", "channel"]


def _clean_emoji(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if len(value) > 64:
        raise ValueError("emoji is too long")
    return value or None


class CanvasCreate(BaseModel):
    title: Title = "Untitled"
    emoji: str | None = None
    access: AccessName = "workspace"
    member_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_CANVAS_MEMBERS)
    channel_id: uuid.UUID | None = None

    _emoji = field_validator("emoji")(_clean_emoji)


class CanvasPatch(BaseModel):
    title: Title | None = None
    emoji: str | None = None
    access: AccessName | None = None
    member_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_CANVAS_MEMBERS)

    _emoji = field_validator("emoji")(_clean_emoji)


class CanvasOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    channel_id: uuid.UUID | None
    title: str
    emoji: str | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    updated_by: uuid.UUID | None
    access: AccessName
    member_ids: list[uuid.UUID]
    is_channel_canvas: bool


class CanvasDetailOut(CanvasOut):
    # Pre-Yjs TipTap JSON to seed the Yjs doc with, while that doc is still empty.
    legacy_content: dict | None


class ChannelCanvasOut(CanvasOut):
    # Legacy fields for GET/PUT /channels/{id}/canvas (pre-Yjs clients).
    content: dict
    version: int


class CanvasStateOut(BaseModel):
    state: str  # base64 Yjs update encoding the whole doc ("" while nothing was written)
    state_vector: str  # base64 Yjs state vector of that doc


class CommentCreate(BaseModel):
    body: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_COMMENT_CHARS)
    ]
    anchor_id: str | None = None
    quote: Annotated[str, StringConstraints(max_length=MAX_QUOTE_CHARS)] | None = None
    thread_id: uuid.UUID | None = None

    @field_validator("anchor_id")
    @classmethod
    def _anchor(cls, value: str | None) -> str | None:
        if value is not None and not _ANCHOR_RE.match(value):
            raise ValueError("anchor_id must be 1-64 letters, digits, '-' or '_'")
        return value


class CommentPatch(BaseModel):
    body: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_COMMENT_CHARS),
        ]
        | None
    ) = None
    resolved: bool | None = None


class CommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    canvas_id: uuid.UUID
    thread_id: uuid.UUID
    anchor_id: str | None
    body: str
    author_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    resolved: bool
    quote: str | None


# --- Helpers ---------------------------------------------------------------------------------


async def _member_ids(
    db: AsyncSession, canvas_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    out: dict[uuid.UUID, list[uuid.UUID]] = {cid: [] for cid in canvas_ids}
    if canvas_ids:
        rows = await db.execute(
            select(CanvasMember.canvas_id, CanvasMember.user_id)
            .where(CanvasMember.canvas_id.in_(canvas_ids))
            .order_by(CanvasMember.user_id)
        )
        for cid, uid in rows:
            out[cid].append(uid)
    return out


def _fields(canvas: Canvas, members: list[uuid.UUID]) -> dict:
    return {
        "id": canvas.id,
        "workspace_id": canvas.workspace_id,
        "channel_id": canvas.channel_id,
        "title": canvas.title,
        "emoji": canvas.emoji,
        "created_by": canvas.created_by,
        "created_at": canvas.created_at,
        "updated_at": canvas.updated_at,
        "updated_by": canvas.updated_by,
        "access": canvas.access,
        "member_ids": members if canvas.access == CanvasAccess.private.value else [],
        "is_channel_canvas": canvas.is_channel_canvas,
    }


async def canvas_out(db: AsyncSession, canvas: Canvas) -> dict:
    members = (await _member_ids(db, [canvas.id]))[canvas.id]
    return CanvasOut(**_fields(canvas, members)).model_dump(mode="json")


async def channel_canvas_out(db: AsyncSession, canvas: Canvas) -> dict:
    return ChannelCanvasOut(
        **_fields(canvas, []), content=canvas.content, version=canvas.version
    ).model_dump(mode="json")


def _has_legacy_content(canvas: Canvas) -> bool:
    content = canvas.content or {}
    return bool(content.get("content")) and canvas.ydoc_size == 0


async def load_canvas(
    canvas_id: uuid.UUID, db: DB, user: CurrentUser
) -> tuple[Canvas, WorkspaceMember]:
    """The canvas and the caller's workspace membership; 404 unless they may open it."""
    canvas = await db.get(Canvas, canvas_id)
    member = await canvas_collab.membership_for(db, canvas, user.id) if canvas else None
    if canvas is None or member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Canvas not found")
    return canvas, member


CanvasAccessDep = Annotated[tuple[Canvas, WorkspaceMember], Depends(load_canvas)]


async def ensure_writable(db: AsyncSession, canvas: Canvas) -> None:
    if await canvas_collab.is_read_only(db, canvas):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This channel is archived")


def _is_admin(member: WorkspaceMember) -> bool:
    return member.role in ADMIN_ROLES


async def _check_members(
    db: AsyncSession, workspace_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    wanted = list(dict.fromkeys(user_ids))
    if not wanted:
        return []
    found = set(
        await db.scalars(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id.in_(wanted)
            )
        )
    )
    if len(found) != len(wanted):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Every member must belong to the workspace"
        )
    return wanted


async def _set_members(db: AsyncSession, canvas_id: uuid.UUID, user_ids: list[uuid.UUID]) -> None:
    await db.execute(delete(CanvasMember).where(CanvasMember.canvas_id == canvas_id))
    if user_ids:
        await db.execute(
            pg_insert(CanvasMember).values(
                [{"canvas_id": canvas_id, "user_id": u} for u in user_ids]
            )
        )


async def _announce_list_change(workspace_id: uuid.UUID) -> None:
    # No titles or ids of canvases the receiver may not see: clients just refetch their list.
    await publish_to_workspace(
        workspace_id, {"type": "canvases.changed", "workspace_id": str(workspace_id)}
    )


async def get_or_create_channel_canvas(
    db: AsyncSession, channel: Channel, user_id: uuid.UUID | None
) -> Canvas:
    await db.execute(
        pg_insert(Canvas)
        .values(
            id=uuid.uuid4(),
            workspace_id=channel.workspace_id,
            channel_id=channel.id,
            is_channel_canvas=True,
            access=CanvasAccess.channel.value,
            title="Canvas",
            content=EMPTY_DOC,
            version=0,
            created_by=user_id,
            ydoc_size=0,
        )
        .on_conflict_do_nothing(
            index_elements=["channel_id"], index_where=text("is_channel_canvas")
        )
    )
    await db.commit()
    return await db.scalar(
        select(Canvas).where(Canvas.channel_id == channel.id, Canvas.is_channel_canvas.is_(True))
    )


# --- Canvases --------------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/canvases", response_model=list[CanvasOut])
async def list_canvases(
    workspace_id: uuid.UUID,
    member: WorkspaceMembership,
    db: DB,
    q: Annotated[str | None, Query(max_length=200)] = None,
):
    """Canvases I can open, most recently edited first; `q` filters by title."""
    stmt = select(Canvas).where(
        canvas_collab.accessible_filter(workspace_id, member.user_id, is_guest(member))
    )
    if q and q.strip():
        stmt = stmt.where(Canvas.title.icontains(q.strip(), autoescape=True))
    canvases = list(
        await db.scalars(stmt.order_by(Canvas.updated_at.desc(), Canvas.id).limit(MAX_LIST_RESULTS))
    )
    members = await _member_ids(db, [c.id for c in canvases])
    return [CanvasOut(**_fields(c, members[c.id])) for c in canvases]


@router.post(
    "/workspaces/{workspace_id}/canvases",
    response_model=CanvasOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_canvas(
    workspace_id: uuid.UUID, data: CanvasCreate, member: FullMembership, db: DB, user: CurrentUser
):
    channel = None
    if data.channel_id is not None:
        channel = await require_channel_access(data.channel_id, db, user)
        if channel.workspace_id != workspace_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Channel not found")
        ensure_not_archived(channel)
    if data.access == CanvasAccess.channel.value and channel is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, 'access "channel" needs a channel_id'
        )
    members: list[uuid.UUID] = []
    if data.access == CanvasAccess.private.value:
        members = [
            u for u in await _check_members(db, workspace_id, data.member_ids) if u != user.id
        ]
    canvas = Canvas(
        workspace_id=workspace_id,
        channel_id=channel.id if channel else None,
        is_channel_canvas=False,
        access=data.access,
        title=data.title,
        emoji=data.emoji,
        created_by=user.id,
        updated_by=user.id,
        content=dict(EMPTY_DOC),
        version=0,
        ydoc_size=0,
    )
    db.add(canvas)
    await db.flush()
    await _set_members(db, canvas.id, members)
    await db.commit()
    await db.refresh(canvas)
    await _announce_list_change(workspace_id)
    return CanvasOut(**_fields(canvas, sorted(members)))


@router.get("/canvases/{canvas_id}", response_model=CanvasDetailOut)
async def get_canvas(found: CanvasAccessDep, db: DB):
    canvas, _ = found
    out = await canvas_out(db, canvas)
    return {**out, "legacy_content": canvas.content if _has_legacy_content(canvas) else None}


@router.patch("/canvases/{canvas_id}", response_model=CanvasOut)
async def update_canvas(data: CanvasPatch, found: CanvasAccessDep, db: DB, user: CurrentUser):
    canvas, member = found
    await ensure_writable(db, canvas)
    sent = data.model_fields_set
    changes_access = "access" in sent or "member_ids" in sent
    if changes_access:
        if canvas.is_channel_canvas:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "A channel's canvas always follows the channel"
            )
        if canvas.created_by != user.id and not _is_admin(member):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Only the creator or an admin can change sharing"
            )
    if "title" in sent and data.title is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "title can't be empty")
    if "access" in sent and data.access is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "access can't be null")

    old_members = set((await _member_ids(db, [canvas.id]))[canvas.id])
    old_access = canvas.access
    new_access = data.access if data.access is not None else canvas.access
    if new_access == CanvasAccess.channel.value and canvas.channel_id is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, 'access "channel" needs a canvas with a channel'
        )
    values: dict = {}
    if data.title is not None:
        values["title"] = data.title
    if "emoji" in sent:
        values["emoji"] = data.emoji
    if "access" in sent:
        values["access"] = new_access
    new_members = old_members
    if new_access != CanvasAccess.private.value:
        new_members = set()
    elif data.member_ids is not None:
        new_members = set(await _check_members(db, canvas.workspace_id, data.member_ids))
        new_members.discard(canvas.created_by)
    if values:
        values["updated_at"] = func.now()
        values["updated_by"] = user.id
        await db.execute(update(Canvas).where(Canvas.id == canvas.id).values(**values))
    if new_members != old_members:
        await _set_members(db, canvas.id, sorted(new_members))
    await db.commit()
    await db.refresh(canvas)
    out = await canvas_out(db, canvas)

    await publish_to_canvas(
        canvas.id, {"type": "canvas.updated", "canvas_id": str(canvas.id), "canvas": out}
    )
    if canvas.is_channel_canvas and "title" in values:
        await publish_to_channel(
            canvas.channel_id,
            {
                "type": "canvas.updated",
                "channel_id": str(canvas.channel_id),
                "canvas": await channel_canvas_out(db, canvas),
            },
        )
    if new_access != old_access:
        # Everyone re-joins, which re-checks access against the new rule.
        await publish_to_canvas(
            canvas.id, {"type": "canvas.access_changed", "canvas_id": str(canvas.id)}
        )
    else:
        for removed in old_members - new_members:
            await notify_user(
                removed, {"type": "canvas.access_revoked", "canvas_id": str(canvas.id)}
            )
    await _announce_list_change(canvas.workspace_id)
    return out


@router.delete("/canvases/{canvas_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_canvas(found: CanvasAccessDep, db: DB, user: CurrentUser) -> Response:
    canvas, member = found
    if canvas.is_channel_canvas:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A channel's canvas can't be deleted")
    if canvas.created_by != user.id and not _is_admin(member):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the creator or an admin can delete it")
    canvas_id, workspace_id = canvas.id, canvas.workspace_id
    await db.execute(delete(Canvas).where(Canvas.id == canvas_id))
    await db.commit()
    await canvas_collab.drop_pending(str(canvas_id))
    await publish_to_canvas(canvas_id, {"type": "canvas.deleted", "canvas_id": str(canvas_id)})
    await _announce_list_change(workspace_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/canvases/{canvas_id}/state", response_model=CanvasStateOut)
async def get_canvas_state(found: CanvasAccessDep, db: DB):
    """The whole Yjs doc (stored state merged with updates not flushed yet)."""
    canvas, _ = found
    state, vector = await canvas_collab.read_state(db, canvas.id)
    return CanvasStateOut(
        state=canvas_collab.b64encode(state) if state else "",
        state_vector=canvas_collab.b64encode(vector),
    )


# --- Channel canvas (legacy JSON API kept for pre-Yjs clients) --------------------------------


@router.get("/channels/{channel_id}/canvas", response_model=ChannelCanvasOut)
async def get_channel_canvas(channel: ChannelAccess, db: DB, user: CurrentUser):
    canvas = await get_or_create_channel_canvas(db, channel, user.id)
    return await channel_canvas_out(db, canvas)


@router.put(
    "/channels/{channel_id}/canvas",
    response_model=ChannelCanvasOut,
    responses={409: {"description": "Changed since base_version; body has the current canvas"}},
)
async def save_channel_canvas(data: CanvasIn, channel: ChannelAccess, db: DB, user: CurrentUser):
    ensure_not_archived(channel)
    size = len(json.dumps(data.content, separators=(",", ":"), ensure_ascii=False).encode())
    if size > settings.max_canvas_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, too_large_message())
    current = await get_or_create_channel_canvas(db, channel, user.id)
    if data.title == current.title and data.content == current.content:
        # Nothing changed: don't bump the version or notify viewers (avoids false conflicts).
        return await channel_canvas_out(db, current)
    # Compare-and-swap on the version, so two concurrent saves can't both win.
    saved_id = await db.scalar(
        update(Canvas)
        .where(Canvas.id == current.id, Canvas.version == data.base_version)
        .values(
            title=data.title,
            content=data.content,
            version=Canvas.version + 1,
            updated_by=user.id,
            updated_at=func.now(),
        )
        .returning(Canvas.id)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    await db.refresh(current)
    out = await channel_canvas_out(db, current)
    if not saved_id:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"detail": "Canvas changed", "canvas": out},
        )
    await publish_to_channel(
        channel.id, {"type": "canvas.updated", "channel_id": str(channel.id), "canvas": out}
    )
    return out


# --- Comments --------------------------------------------------------------------------------


async def _comments_changed(canvas_id: uuid.UUID) -> None:
    await publish_to_canvas(
        canvas_id, {"type": "canvas.comments.updated", "canvas_id": str(canvas_id)}
    )


async def _load_comment(
    comment_id: uuid.UUID, db: AsyncSession, user: User
) -> tuple[CanvasComment, Canvas, WorkspaceMember]:
    comment = await db.get(CanvasComment, comment_id)
    if comment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    try:
        canvas, member = await load_canvas(comment.canvas_id, db, user)
    except HTTPException:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found") from None
    return comment, canvas, member


@router.get("/canvases/{canvas_id}/comments", response_model=list[CommentOut])
async def list_comments(found: CanvasAccessDep, db: DB):
    canvas, _ = found
    return list(
        await db.scalars(
            select(CanvasComment)
            .where(CanvasComment.canvas_id == canvas.id)
            .order_by(CanvasComment.created_at, CanvasComment.id)
        )
    )


@router.post(
    "/canvases/{canvas_id}/comments",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(data: CommentCreate, found: CanvasAccessDep, db: DB, user: CurrentUser):
    canvas, _ = found
    await ensure_writable(db, canvas)
    comment_id = uuid.uuid4()
    anchor_id, quote, thread_id = data.anchor_id, data.quote, comment_id
    if data.thread_id is not None:
        root = await db.get(CanvasComment, data.thread_id)
        if root is None or root.canvas_id != canvas.id or root.thread_id != root.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
        # Replies live on the root's anchor; replying reopens a resolved thread.
        thread_id, anchor_id, quote = root.id, root.anchor_id, None
        if root.resolved:
            await db.execute(
                update(CanvasComment)
                .where(CanvasComment.thread_id == root.id)
                .values(resolved=False)
            )
    comment = CanvasComment(
        id=comment_id,
        canvas_id=canvas.id,
        thread_id=thread_id,
        anchor_id=anchor_id,
        body=data.body,
        quote=quote or None,
        author_id=user.id,
        resolved=False,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    await _comments_changed(canvas.id)
    return comment


@router.patch("/canvas-comments/{comment_id}", response_model=CommentOut)
async def update_comment(comment_id: uuid.UUID, data: CommentPatch, db: DB, user: CurrentUser):
    comment, canvas, _ = await _load_comment(comment_id, db, user)
    await ensure_writable(db, canvas)
    sent = data.model_fields_set
    if "body" in sent:
        if data.body is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "body can't be empty")
        if comment.author_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author can edit a comment")
        comment.body = data.body
    if "resolved" in sent:
        if data.resolved is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "resolved can't be null")
        # Resolving is a thread-level state: every comment of the thread follows the root.
        await db.execute(
            update(CanvasComment)
            .where(CanvasComment.thread_id == comment.thread_id)
            .values(resolved=data.resolved)
            .execution_options(synchronize_session=False)
        )
    await db.commit()
    await db.refresh(comment)
    await _comments_changed(canvas.id)
    return comment


@router.delete("/canvas-comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(comment_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    comment, canvas, member = await _load_comment(comment_id, db, user)
    if comment.author_id != user.id and not _is_admin(member):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author or an admin can delete it")
    if comment.thread_id == comment.id:
        # Deleting a thread's root removes the whole thread.
        await db.execute(delete(CanvasComment).where(CanvasComment.thread_id == comment.id))
    else:
        await db.execute(delete(CanvasComment).where(CanvasComment.id == comment.id))
    await db.commit()
    await _comments_changed(canvas.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
