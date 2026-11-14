"""Lists v2 schemas: card priority/cover/custom fields, field definitions, subtasks, comments.

The v1 shapes in `app.schemas` (CardIn, CardPatch, CardOut, ColumnOut) stay the base; these
extend them so existing callers (e.g. the AI agent's create_board_card tool) keep working.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.schemas import CardIn, CardOut, CardPatch, Color, ColumnOut, Position

Priority = Literal["urgent", "high", "medium", "low", "none"]
PRIORITY_ORDER: tuple[str, ...] = ("urgent", "high", "medium", "low", "none")
FieldType = Literal["text", "number", "select", "multi_select", "person", "date", "checkbox", "url"]
SELECT_TYPES = frozenset({"select", "multi_select"})

MAX_FIELD_OPTIONS = 100
MAX_FIELD_VALUES = 50  # custom fields set on one PATCH

FieldName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
OptionLabel = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
OptionId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
SubtaskTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
CommentBody = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
# {field_id: value}; a null value clears that field on the card.
FieldValues = Annotated[dict[uuid.UUID, Any], Field(max_length=MAX_FIELD_VALUES)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Field definitions --------------------------------------------------------------------


class FieldOption(_Strict):
    id: OptionId | None = None  # generated when omitted
    label: OptionLabel
    color: Color | None = None


class FieldOptionOut(BaseModel):
    id: str
    label: str
    color: str | None = None


def _unique_options(options: list[FieldOption] | None) -> None:
    if not options:
        return
    ids = [o.id for o in options if o.id]
    if len(ids) != len(set(ids)):
        raise ValueError("option ids must be unique")


class FieldDefIn(_Strict):
    name: FieldName
    type: FieldType
    options: list[FieldOption] = Field(default=[], max_length=MAX_FIELD_OPTIONS)

    @model_validator(mode="after")
    def _check(self):
        if self.options and self.type not in SELECT_TYPES:
            raise ValueError("only select and multi_select fields have options")
        _unique_options(self.options)
        return self


class FieldDefPatch(_Strict):
    """Omitted keys are untouched. Changing `type` clears the field's values on every card."""

    name: FieldName | None = None
    type: FieldType | None = None
    options: list[FieldOption] | None = Field(default=None, max_length=MAX_FIELD_OPTIONS)
    position: Position | None = None

    @model_validator(mode="after")
    def _check(self):
        _unique_options(self.options)
        return self


class FieldDefOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: FieldType
    options: list[FieldOptionOut]
    position: float


# --- Subtasks ------------------------------------------------------------------------------


class SubtaskIn(_Strict):
    title: SubtaskTitle
    assignee_id: uuid.UUID | None = None


class SubtaskPatch(_Strict):
    title: SubtaskTitle | None = None
    done: bool | None = None
    assignee_id: uuid.UUID | None = None  # null unassigns
    position: Position | None = None


class SubtaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    done: bool
    assignee_id: uuid.UUID | None
    position: float


# --- Cards ---------------------------------------------------------------------------------


class CardInV2(CardIn):
    priority: Priority = "none"
    cover_color: Color | None = None
    fields: FieldValues = Field(default_factory=dict)


class CardPatchV2(CardPatch):
    """Adds priority, cover_color (null clears) and a partial `fields` merge (null clears one)."""

    priority: Priority | None = None
    cover_color: Color | None = None
    fields: FieldValues | None = None


class CardOutV2(CardOut):
    priority: Priority
    cover_color: str | None
    fields: dict[str, Any]
    subtasks: list[SubtaskOut] = Field(default_factory=list)
    comment_count: int = 0


# --- Comments ------------------------------------------------------------------------------


class CardCommentIn(_Strict):
    body: CommentBody


class CardCommentPatch(_Strict):
    body: CommentBody


class CardCommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    card_id: uuid.UUID
    author_id: uuid.UUID | None
    body: str
    created_at: datetime
    updated_at: datetime
    edited_at: datetime | None


# --- Columns / board -----------------------------------------------------------------------


class ColumnReorderIn(_Strict):
    column_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)


class BoardGroupOut(BaseModel):
    """One group of the table view: `key` is a column/user id, a priority, a label or "none"."""

    key: str
    card_ids: list[uuid.UUID]


BoardSort = Literal["position", "due", "priority", "created"]
BoardGroup = Literal["column", "assignee", "priority", "label"]
DueFilter = Literal["overdue", "week"]


class BoardOutV2(BaseModel):
    id: uuid.UUID
    channel_id: uuid.UUID
    columns: list[ColumnOut]
    fields: list[FieldDefOut]
    cards: list[CardOutV2]
    # Only set when the request asked for `group`; cards may then appear in several
    # label groups.
    groups: list[BoardGroupOut] | None = None


__all__ = [
    "PRIORITY_ORDER",
    "SELECT_TYPES",
    "BoardGroup",
    "BoardGroupOut",
    "BoardOutV2",
    "BoardSort",
    "CardCommentIn",
    "CardCommentOut",
    "CardCommentPatch",
    "CardInV2",
    "CardOutV2",
    "CardPatchV2",
    "ColumnReorderIn",
    "DueFilter",
    "FieldDefIn",
    "FieldDefOut",
    "FieldDefPatch",
    "FieldOption",
    "FieldType",
    "Priority",
    "SubtaskIn",
    "SubtaskOut",
    "SubtaskPatch",
]
