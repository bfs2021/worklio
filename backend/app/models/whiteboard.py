import uuid
from typing import ClassVar

from sqlalchemy import ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk


class Whiteboard(UUIDPk, Timestamped, Base):
    """Excalidraw scene attached to a channel (also used by that channel's calls); one per channel.

    `elements` is the opaque list of Excalidraw elements. `version` is bumped on every save and
    used for optimistic concurrency, like canvases.
    """

    __tablename__ = "whiteboards"
    __mapper_args__: ClassVar[dict] = {"eager_defaults": True}

    channel_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), unique=True
    )
    elements: Mapped[list[dict]] = mapped_column(JSONB, default=list, server_default="[]")
    version: Mapped[int] = mapped_column(default=0, server_default="0")
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
