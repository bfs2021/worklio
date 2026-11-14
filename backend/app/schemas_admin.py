"""Request/response models for workspace administration (Wave D1)."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models import WorkspaceRole
from app.schemas import DM_NAME_PREFIX

PolicyValue = Literal["everyone", "admins"]


class Policies(BaseModel):
    create_public_channels: PolicyValue = "everyone"
    create_private_channels: PolicyValue = "everyone"
    invite_members: PolicyValue = "admins"
    create_user_groups: PolicyValue = "everyone"
    start_huddles: PolicyValue = "everyone"
    use_ai: PolicyValue = "everyone"
    install_apps: PolicyValue = "everyone"
    archive_channels: PolicyValue = "everyone"


class PoliciesPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    create_public_channels: PolicyValue | None = None
    create_private_channels: PolicyValue | None = None
    invite_members: PolicyValue | None = None
    create_user_groups: PolicyValue | None = None
    start_huddles: PolicyValue | None = None
    use_ai: PolicyValue | None = None
    install_apps: PolicyValue | None = None
    archive_channels: PolicyValue | None = None


class WorkspaceSettingsOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    description: str | None
    icon_url: str | None
    owner_id: uuid.UUID
    policies: Policies
    default_channel_ids: list[uuid.UUID]
    # Convenience for the client: what the viewer may do under the current policies.
    viewer_role: WorkspaceRole
    viewer_can: dict[str, bool]


class WorkspaceSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    slug: str | None = Field(default=None, min_length=2, max_length=64, pattern=r"^[a-z0-9-]+$")
    description: str | None = Field(default=None, max_length=500)
    policies: PoliciesPatch | None = None
    default_channel_ids: list[uuid.UUID] | None = Field(default=None, max_length=20)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("Name can't be blank")
        return v


AdminStatus = Literal["active", "deactivated"]


class AdminMemberOut(BaseModel):
    user_id: uuid.UUID
    full_name: str
    email: str | None
    avatar_url: str | None = None
    role: WorkspaceRole
    status: AdminStatus
    joined_at: datetime
    deactivated_at: datetime | None = None
    last_active_at: datetime | None
    is_bot: bool


class MemberRolePatch(BaseModel):
    role: WorkspaceRole


class TransferOwnershipIn(BaseModel):
    user_id: uuid.UUID


class InviteLinkIn(BaseModel):
    role: Literal["member", "guest"] = "member"
    channel_ids: list[uuid.UUID] = Field(default=[], max_length=50)
    # Hours until the link stops working; null = never expires. Default: 7 days.
    expires_in_hours: int | None = Field(default=24 * 7, ge=1, le=24 * 90)
    max_uses: int | None = Field(default=None, ge=1, le=10_000)

    @model_validator(mode="after")
    def _guests_need_channels(self):
        if self.role == "guest" and not self.channel_ids:
            raise ValueError("Pick at least one channel for guests")
        self.channel_ids = list(dict.fromkeys(self.channel_ids))
        return self


class InviteLinkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    token: str
    role: Literal["member", "guest"]
    channel_ids: list[uuid.UUID]
    expires_at: datetime | None
    max_uses: int | None
    uses: int
    created_by: uuid.UUID | None
    created_at: datetime
    revoked: bool
    # Derived: false once revoked, expired or used up.
    valid: bool = True


InviteInvalidReason = Literal["revoked", "expired", "used_up"]


class InvitePreviewOut(BaseModel):
    workspace_name: str
    workspace_icon_url: str | None
    inviter_name: str | None
    role: Literal["member", "guest"]
    valid: bool
    reason: InviteInvalidReason | None = None


class InviteAcceptOut(BaseModel):
    workspace_id: uuid.UUID
    already_member: bool = False


class ChannelPatchIn(BaseModel):
    """PATCH /channels/{id}: any member may set the topic; managers/admins may rename."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[a-z0-9_-]+$")
    topic: str | None = Field(default=None, max_length=250)

    @model_validator(mode="after")
    def _check(self):
        if self.name is not None and self.name.startswith(DM_NAME_PREFIX):
            raise ValueError(f"Channel names can't start with '{DM_NAME_PREFIX}'")
        return self


class ChannelMemberRolePatch(BaseModel):
    role: Literal["member", "manager"]


class ChannelRolesOut(BaseModel):
    manager_ids: list[uuid.UUID]
    # Whether the viewer may rename/archive the channel and remove or promote people.
    can_manage: bool
    can_archive: bool


class AuditEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    actor_id: uuid.UUID | None
    actor_name: str | None = None
    action: str
    target_type: str | None
    target_id: str | None
    target_name: str | None = None
    meta: dict
    created_at: datetime


class AuditPageOut(BaseModel):
    items: list[AuditEventOut]
    next_cursor: str | None
