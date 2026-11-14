import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk


class ChannelKind(enum.StrEnum):
    public = "public"
    private = "private"
    dm = "dm"  # direct / group direct message


class Channel(UUIDPk, Timestamped, Base):
    __tablename__ = "channels"
    __table_args__ = (UniqueConstraint("workspace_id", "name"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(80))
    topic: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[ChannelKind] = mapped_column(
        Enum(ChannelKind, name="channel_kind"), default=ChannelKind.public
    )
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    is_archived: Mapped[bool] = mapped_column(default=False)


class ChannelMember(UUIDPk, Timestamped, Base):
    __tablename__ = "channel_members"
    # The unique constraint's leading column also serves lookups by channel_id.
    __table_args__ = (UniqueConstraint("channel_id", "user_id"),)

    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # "member" | "manager". Managers (and workspace admins) can rename, archive and remove people.
    role: Mapped[str] = mapped_column(String(16), default="member", server_default="member")
    # Everything created after this is unread for the member.
    last_read_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
