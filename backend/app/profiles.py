"""Profile serialisation shared by the auth, workspace and user routes."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, WorkspaceMember, WorkspaceRole
from app.realtime.hub import publish_to_workspace
from app.schemas import MemberOut, ProfileFields


def member_out(user: User, role: WorkspaceRole, *, hide_email: bool = False) -> MemberOut:
    profile = ProfileFields.model_validate(user).model_dump()
    return MemberOut(
        user_id=user.id,
        role=role,
        full_name=user.full_name,
        email=None if hide_email else user.email,
        **profile,
    )


async def broadcast_user_updated(db: AsyncSession, user: User) -> None:
    """Tell every workspace the user belongs to that their profile changed.

    The hub strips `email` before delivering the event to guests (see Hub._dispatch).
    """
    memberships: list[tuple[uuid.UUID, WorkspaceRole]] = list(
        (
            await db.execute(
                select(WorkspaceMember.workspace_id, WorkspaceMember.role).where(
                    WorkspaceMember.user_id == user.id
                )
            )
        ).all()
    )
    for workspace_id, role in memberships:
        payload = member_out(user, role).model_dump(mode="json")
        await publish_to_workspace(workspace_id, {"type": "user.updated", "user": payload})
