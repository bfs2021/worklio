"""Per-channel preferences (mute, notify level, star, section) and custom sidebar sections.

Realtime (user topic): channel_prefs.updated {pref}, sidebar_sections.updated {sections}.
"""

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    WorkspaceMembership,
    get_workspace_membership,
)
from app.models import ChannelPref, SidebarSection
from app.realtime.hub import notify_user
from app.schemas_productivity import (
    ChannelPrefOut,
    ChannelPrefPatch,
    SectionIn,
    SectionOut,
    SectionPatch,
)

router = APIRouter(tags=["productivity"])

MAX_SECTIONS = 50


# --- Channel prefs ------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/channel-prefs", response_model=list[ChannelPrefOut])
async def list_channel_prefs(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser, _: WorkspaceMembership
) -> list[ChannelPref]:
    """Only channels with non-default settings are listed; others are all/unmuted/unstarred."""
    return list(
        await db.scalars(
            select(ChannelPref)
            .where(ChannelPref.user_id == user.id, ChannelPref.workspace_id == workspace_id)
            .order_by(ChannelPref.created_at)
        )
    )


@router.patch("/channels/{channel_id}/prefs", response_model=ChannelPrefOut)
async def update_channel_prefs(
    data: ChannelPrefPatch, channel: ChannelAccess, db: DB, user: CurrentUser
) -> ChannelPref:
    changes = data.model_dump(exclude_unset=True)
    for key in ("muted", "notify", "starred"):
        if key in changes and changes[key] is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{key} can't be null")
    if changes.get("section_id") is not None:
        section = await db.get(SidebarSection, changes["section_id"])
        if (
            not section
            or section.user_id != user.id
            or section.workspace_id != channel.workspace_id
        ):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown sidebar section")
    values = {
        "id": uuid.uuid4(),
        "user_id": user.id,
        "workspace_id": channel.workspace_id,
        "channel_id": channel.id,
        **changes,
    }
    pref = await db.scalar(
        pg_insert(ChannelPref)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["user_id", "channel_id"],
            set_={**changes, "updated_at": func.now()} if changes else {"updated_at": func.now()},
        )
        .returning(ChannelPref)
        .execution_options(populate_existing=True)
    )
    await db.commit()
    out = ChannelPrefOut.model_validate(pref)
    await notify_user(user.id, {"type": "channel_prefs.updated", "pref": out.model_dump(mode="json")})
    return pref


# --- Sidebar sections ---------------------------------------------------------------------


async def _sections(db, workspace_id: uuid.UUID, user_id: uuid.UUID) -> list[SidebarSection]:
    return list(
        await db.scalars(
            select(SidebarSection)
            .where(SidebarSection.user_id == user_id, SidebarSection.workspace_id == workspace_id)
            .order_by(SidebarSection.position, SidebarSection.created_at)
        )
    )


async def _publish_sections(db, workspace_id: uuid.UUID, user_id: uuid.UUID) -> None:
    sections = [
        SectionOut.model_validate(s).model_dump(mode="json")
        for s in await _sections(db, workspace_id, user_id)
    ]
    await notify_user(
        user_id,
        {"type": "sidebar_sections.updated", "workspace_id": str(workspace_id), "sections": sections},
    )


async def _own_section(db, user, section_id: uuid.UUID) -> SidebarSection:
    section = await db.get(SidebarSection, section_id)
    if (
        not section
        or section.user_id != user.id
        or not await get_workspace_membership(db, section.workspace_id, user.id)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Section not found")
    return section


@router.get("/workspaces/{workspace_id}/sidebar-sections", response_model=list[SectionOut])
async def list_sections(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser, _: WorkspaceMembership
) -> list[SidebarSection]:
    return await _sections(db, workspace_id, user.id)


@router.post(
    "/workspaces/{workspace_id}/sidebar-sections",
    response_model=SectionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_section(
    workspace_id: uuid.UUID, data: SectionIn, db: DB, user: CurrentUser, _: WorkspaceMembership
) -> SidebarSection:
    existing = await _sections(db, workspace_id, user.id)
    if len(existing) >= MAX_SECTIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"At most {MAX_SECTIONS} sections")
    section = SidebarSection(
        workspace_id=workspace_id,
        user_id=user.id,
        name=data.name,
        position=(max((s.position for s in existing), default=0.0) + 1.0),
        collapsed=False,
    )
    db.add(section)
    await db.commit()
    await db.refresh(section)
    await _publish_sections(db, workspace_id, user.id)
    return section


@router.patch("/sidebar-sections/{section_id}", response_model=SectionOut)
async def update_section(
    section_id: uuid.UUID, data: SectionPatch, db: DB, user: CurrentUser
) -> SidebarSection:
    section = await _own_section(db, user, section_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        if value is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{key} can't be null")
        setattr(section, key, value)
    await db.commit()
    await db.refresh(section)
    await _publish_sections(db, section.workspace_id, user.id)
    return section


@router.delete("/sidebar-sections/{section_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_section(section_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
    """Channels in the section fall back to the default sections (section_id -> NULL)."""
    section = await _own_section(db, user, section_id)
    workspace_id = section.workspace_id
    await db.delete(section)
    await db.commit()
    await _publish_sections(db, workspace_id, user.id)
