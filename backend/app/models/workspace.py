import enum
import uuid

from sqlalchemy import Enum, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk


class WorkspaceRole(enum.StrEnum):
    owner = "owner"
    admin = "admin"
    member = "member"
    guest = "guest"


class Workspace(UUIDPk, Timestamped, Base):
    __tablename__ = "workspaces"

    name: Mapped[str] = mapped_column(String(120))
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    # Wave D1 admin console: profile, icon and who-may-do-what policies (see app.admin).
    description: Mapped[str | None] = mapped_column(Text)
    # Object-storage key of the workspace icon (clients get `icon_url`, see app.admin).
    icon_key: Mapped[str | None] = mapped_column(String(1024))
    # {policy name: "everyone" | "admins"}; missing keys fall back to app.admin.DEFAULT_POLICIES.
    policies: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # Public channels every new full member joins (besides #general).
    default_channel_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), default=list, server_default="{}"
    )


class WorkspaceMember(UUIDPk, Timestamped, Base):
    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[WorkspaceRole] = mapped_column(
        Enum(WorkspaceRole, name="workspace_role"), default=WorkspaceRole.member
    )
