"""Request/response schemas for Wave A2 messaging extras.

The nested MessageOut pieces (PollOut, UnfurlOut, ForwardedFromOut) live in app.schemas next
to MessageOut; everything else is here.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from app.schemas import NonBlankStr, _validate_emoji

MAX_FORWARD_TARGETS = 10
MAX_SCHEDULE_DAYS = 120
MAX_POLL_OPTIONS = 10
MAX_GROUP_MEMBERS = 500
RESERVED_GROUP_HANDLES = frozenset({"here", "channel", "everyone", "all", "admin", "admins"})


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _http_url(value: str) -> str:
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError("Only http(s) links are allowed")
    return value


def _optional_emoji(value: str | None) -> str | None:
    value = (value or "").strip()
    if not value:
        return None
    if len(value) > 2 and value[0] == value[-1] == ":":
        value = value[1:-1]
    return _validate_emoji(value)


HttpUrl = Annotated[str, StringConstraints(min_length=1, max_length=2048), AfterValidator(_http_url)]
BookmarkTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
OptionalEmoji = Annotated[
    Annotated[str, StringConstraints(max_length=34)] | None, AfterValidator(_optional_emoji)
]


# --- Bookmarks ---
class BookmarkIn(BaseModel):
    title: BookmarkTitle
    url: HttpUrl
    emoji: OptionalEmoji = None


class BookmarkPatch(BaseModel):
    title: BookmarkTitle | None = None
    url: HttpUrl | None = None
    emoji: OptionalEmoji = None
    position: float | None = Field(default=None, allow_inf_nan=False)


class BookmarkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    channel_id: uuid.UUID
    title: str
    url: str
    emoji: str | None
    position: float
    created_by: uuid.UUID | None


# --- Forward ---
class ForwardIn(BaseModel):
    channel_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_FORWARD_TARGETS)
    comment: str | None = Field(default=None, max_length=40_000)

    @model_validator(mode="after")
    def _dedupe(self):
        self.channel_ids = list(dict.fromkeys(self.channel_ids))
        self.comment = (self.comment or "").strip() or None
        return self


# --- Scheduled send ---
def _check_send_at(value: datetime) -> datetime:
    value = _utc(value)
    now = datetime.now(UTC)
    if value <= now:
        raise ValueError("send_at must be in the future")
    if value > now + timedelta(days=MAX_SCHEDULE_DAYS):
        raise ValueError(f"send_at can be at most {MAX_SCHEDULE_DAYS} days ahead")
    return value


SendAt = Annotated[datetime, AfterValidator(_check_send_at)]


class ScheduledIn(BaseModel):
    body: str = Field(default="", max_length=40_000)
    parent_id: uuid.UUID | None = None
    attachment_ids: list[uuid.UUID] = Field(default=[], max_length=10)
    send_at: SendAt

    @model_validator(mode="after")
    def _not_empty(self):
        self.body = self.body.strip()
        self.attachment_ids = list(dict.fromkeys(self.attachment_ids))
        if not self.body and not self.attachment_ids:
            raise ValueError("Message needs text or an attachment")
        return self


class ScheduledPatch(BaseModel):
    body: str | None = Field(default=None, max_length=40_000)
    send_at: SendAt | None = None


class ScheduledOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    channel_id: uuid.UUID
    parent_id: uuid.UUID | None
    body: str
    attachment_ids: list[uuid.UUID]
    send_at: datetime
    status: Literal["pending", "sent", "failed", "cancelled"]
    error: str | None = None
    sent_message_id: uuid.UUID | None = None
    created_at: datetime


# --- Polls ---
PollText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=140)]


class PollIn(BaseModel):
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
    options: list[PollText] = Field(min_length=2, max_length=MAX_POLL_OPTIONS)
    multiple: bool = False
    anonymous: bool = False
    parent_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _unique(self):
        if len({o.casefold() for o in self.options}) != len(self.options):
            raise ValueError("Poll options must be different")
        return self


class PollVoteIn(BaseModel):
    option_ids: list[uuid.UUID] = Field(default=[], max_length=MAX_POLL_OPTIONS)


# --- Edit history / read state ---
class MessageEditOut(BaseModel):
    body: str
    edited_at: datetime


class ReadStateOut(BaseModel):
    user_id: uuid.UUID
    last_read_at: datetime


# --- User groups ---
def _normalize_handle(value):
    return value.strip().lstrip("@").lower() if isinstance(value, str) else value


GroupHandle = Annotated[
    str, BeforeValidator(_normalize_handle), StringConstraints(pattern=r"^[a-z0-9-]{1,40}$")
]


def _check_handle(value: str) -> str:
    if value in RESERVED_GROUP_HANDLES:
        raise ValueError(f"@{value} is reserved")
    return value


class UserGroupIn(BaseModel):
    handle: Annotated[GroupHandle, AfterValidator(_check_handle)]
    name: NonBlankStr = Field(max_length=80)
    member_ids: list[uuid.UUID] = Field(default=[], max_length=MAX_GROUP_MEMBERS)


class UserGroupPatch(BaseModel):
    handle: Annotated[GroupHandle, AfterValidator(_check_handle)] | None = None
    name: NonBlankStr | None = Field(default=None, max_length=80)
    member_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_GROUP_MEMBERS)


class UserGroupOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    handle: str
    name: str
    member_ids: list[uuid.UUID]
    created_by: uuid.UUID | None
    created_at: datetime
