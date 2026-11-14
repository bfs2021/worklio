"""Kanban board per channel ("Lists v2").

Ordering is fractional: a column, card or subtask keeps a float `position`, new items go at the
end (max + 1) and a move sets a value between the neighbours. When two neighbours get too
close for float precision the list is renumbered 1..n. Columns can also be reordered in one
call (`POST /board/columns/reorder`).

Cards carry a priority, an optional cover colour, subtasks, comments and values for the
board's custom fields (`board_fields`; each value is validated against its field's type).

Every change publishes the whole (unfiltered) board to the channel as `board.updated`; card
comment changes also publish `board.comments.updated` with the card id. Mentions (`<@id>`) in
card comments create a `card_mention` activity event for each mentioned user who can read the
channel.
"""

import itertools
import logging
import math
import re
import uuid
from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import case, delete, func, nulls_last, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    ensure_not_archived,
    get_workspace_membership,
    require_channel_access,
)
from app.models import (
    ActivityEvent,
    Board,
    BoardCard,
    BoardColumn,
    Channel,
    User,
    WorkspaceMember,
    WorkspaceRole,
)
from app.models.board import BoardCardComment, BoardField, BoardSubtask
from app.realtime.hub import notify_user, publish_to_channel
from app.schemas import ColumnIn, ColumnOut, ColumnPatch
from app.schemas_board import (
    PRIORITY_ORDER,
    SELECT_TYPES,
    BoardGroup,
    BoardGroupOut,
    BoardOutV2,
    BoardSort,
    CardCommentIn,
    CardCommentOut,
    CardCommentPatch,
    CardInV2,
    CardOutV2,
    CardPatchV2,
    ColumnReorderIn,
    DueFilter,
    FieldDefIn,
    FieldDefOut,
    FieldDefPatch,
    FieldOption,
    Priority,
    SubtaskIn,
    SubtaskOut,
    SubtaskPatch,
)
from app.services import mentioned_user_ids

log = logging.getLogger(__name__)
router = APIRouter(tags=["board"])

DEFAULT_COLUMNS = ("To do", "In progress", "Done")
MAX_COLUMNS = 20
MAX_CARDS = 1000
MAX_FIELDS = 30
MAX_SUBTASKS = 100
MAX_COMMENTS = 2000
MAX_MENTION_FANOUT = 50
MAX_TEXT_VALUE = 2000
MAX_NUMBER_VALUE = 1e15
# Neighbours closer than this get renumbered (floats run out of room after ~50 halvings).
MIN_GAP = 1e-6
CARD_MENTION = "card_mention"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


# --- Loading & access --------------------------------------------------------------------


async def get_or_create_board(db: AsyncSession, channel: Channel) -> Board:
    # Insert-if-missing in one statement so two first visitors don't both create a board.
    created_id = await db.scalar(
        pg_insert(Board)
        .values(id=uuid.uuid4(), channel_id=channel.id)
        .on_conflict_do_nothing(index_elements=["channel_id"])
        .returning(Board.id)
    )
    if created_id:
        db.add_all(
            BoardColumn(board_id=created_id, name=name, position=float(i + 1))
            for i, name in enumerate(DEFAULT_COLUMNS)
        )
        await db.commit()
    return await db.scalar(select(Board).where(Board.channel_id == channel.id))


async def _board_for(
    db: AsyncSession, board_id: uuid.UUID, user: User, *, write: bool = True
) -> Board:
    """The board, if the user can access its channel (404 otherwise); writes also need the
    channel not to be archived."""
    board = await db.get(Board, board_id)
    if not board:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Board not found")
    channel = await require_channel_access(board.channel_id, db, user)
    if write:
        ensure_not_archived(channel)
    return board


async def _scoped(db: AsyncSession, board_id: uuid.UUID, user: User, what: str, write: bool) -> Board:
    """`_board_for`, reporting a missing/inaccessible board as the child object missing."""
    try:
        return await _board_for(db, board_id, user, write=write)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found") from None
        raise


async def _load_column(db: AsyncSession, column_id: uuid.UUID, user: User) -> tuple[BoardColumn, Board]:
    column = await db.get(BoardColumn, column_id)
    if not column:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Column not found")
    return column, await _scoped(db, column.board_id, user, "Column", True)


async def _load_card(
    db: AsyncSession, card_id: uuid.UUID, user: User, *, write: bool = True
) -> tuple[BoardCard, Board]:
    card = await db.get(BoardCard, card_id)
    if not card:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
    return card, await _scoped(db, card.board_id, user, "Card", write)


async def _load_field(db: AsyncSession, field_id: uuid.UUID, user: User) -> tuple[BoardField, Board]:
    field = await db.get(BoardField, field_id)
    if not field:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Field not found")
    return field, await _scoped(db, field.board_id, user, "Field", True)


async def _load_subtask(
    db: AsyncSession, subtask_id: uuid.UUID, user: User
) -> tuple[BoardSubtask, BoardCard, Board]:
    subtask = await db.get(BoardSubtask, subtask_id)
    card = await db.get(BoardCard, subtask.card_id) if subtask else None
    if not subtask or not card:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subtask not found")
    return subtask, card, await _scoped(db, card.board_id, user, "Subtask", True)


async def _load_comment(
    db: AsyncSession, comment_id: uuid.UUID, user: User
) -> tuple[BoardCardComment, BoardCard, Board]:
    comment = await db.get(BoardCardComment, comment_id)
    card = await db.get(BoardCard, comment.card_id) if comment else None
    if not comment or not card:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    return comment, card, await _scoped(db, card.board_id, user, "Comment", True)


async def _lock_board(db: AsyncSession, board: Board) -> None:
    """Serialize count-capped inserts and whole-board reorders on one board."""
    await db.execute(select(Board.id).where(Board.id == board.id).with_for_update())


async def _column_in_board(db: AsyncSession, board: Board, column_id: uuid.UUID) -> BoardColumn:
    column = await db.get(BoardColumn, column_id)
    if not column or column.board_id != board.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Column is not on this board")
    return column


async def _is_workspace_member(db: AsyncSession, board: Board, user_id: uuid.UUID) -> bool:
    channel = await db.get(Channel, board.channel_id)
    return bool(
        await db.scalar(
            select(WorkspaceMember.id).where(
                WorkspaceMember.workspace_id == channel.workspace_id,
                WorkspaceMember.user_id == user_id,
            )
        )
    )


async def _assert_assignee(db: AsyncSession, board: Board, user_id: uuid.UUID | None) -> None:
    if user_id is not None and not await _is_workspace_member(db, board, user_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assignee must be a workspace member")


async def _next_position(db: AsyncSession, column, *where) -> float:
    top = await db.scalar(select(func.max(column)).where(*where))
    return (top or 0.0) + 1.0


async def _renumber_if_crowded(db: AsyncSession, items: list) -> None:
    """Spread positions back out to 1..n when any neighbours got too close."""
    positions = [i.position for i in items]
    if any(b - a < MIN_GAP for a, b in itertools.pairwise(positions)):
        for n, item in enumerate(items, start=1):
            item.position = float(n)
        await db.flush()


# --- Serialization -----------------------------------------------------------------------


def _field_out(field: BoardField) -> FieldDefOut:
    return FieldDefOut.model_validate(field)


async def _subtasks_by_card(db: AsyncSession, *where) -> dict[uuid.UUID, list[SubtaskOut]]:
    rows = await db.scalars(
        select(BoardSubtask)
        .join(BoardCard, BoardCard.id == BoardSubtask.card_id)
        .where(*where)
        .order_by(BoardSubtask.position, BoardSubtask.created_at)
    )
    out: dict[uuid.UUID, list[SubtaskOut]] = {}
    for s in rows:
        out.setdefault(s.card_id, []).append(SubtaskOut.model_validate(s))
    return out


async def _comment_counts(db: AsyncSession, *where) -> dict[uuid.UUID, int]:
    rows = await db.execute(
        select(BoardCardComment.card_id, func.count())
        .join(BoardCard, BoardCard.id == BoardCardComment.card_id)
        .where(*where)
        .group_by(BoardCardComment.card_id)
    )
    return {card_id: n for card_id, n in rows.all()}


def _card_out(card: BoardCard, subtasks: list[SubtaskOut], comment_count: int) -> CardOutV2:
    return CardOutV2.model_validate(card).model_copy(
        update={"subtasks": subtasks, "comment_count": comment_count}
    )


async def card_out(db: AsyncSession, card: BoardCard) -> CardOutV2:
    where = BoardCard.id == card.id
    subtasks = (await _subtasks_by_card(db, where)).get(card.id, [])
    return _card_out(card, subtasks, (await _comment_counts(db, where)).get(card.id, 0))


def _card_sort(sort: BoardSort, descending: bool) -> list:
    """ORDER BY for the board's cards (the query joins each card's column)."""
    tail = [BoardColumn.position, BoardCard.position, BoardCard.created_at, BoardCard.id]
    if sort == "position":
        return tail
    if sort == "due":
        key = BoardCard.due_date.desc() if descending else BoardCard.due_date.asc()
        return [nulls_last(key), *tail]
    if sort == "priority":
        rank = case(
            {p: i for i, p in enumerate(PRIORITY_ORDER)}, value=BoardCard.priority, else_=len(PRIORITY_ORDER)
        )
        return [rank.desc() if descending else rank.asc(), *tail]
    created = BoardCard.created_at.desc() if descending else BoardCard.created_at.asc()
    return [created, BoardCard.id]


def _group_cards(
    group: BoardGroup, columns: list[BoardColumn], cards: list[CardOutV2]
) -> list[BoardGroupOut]:
    """Groups in display order; card order inside a group follows the requested sort."""
    buckets: dict[str, list[uuid.UUID]] = {}

    def add(key: str, card: CardOutV2) -> None:
        buckets.setdefault(key, []).append(card.id)

    if group == "column":
        for c in columns:
            buckets[str(c.id)] = []
        for card in cards:
            add(str(card.column_id), card)
        return [BoardGroupOut(key=k, card_ids=v) for k, v in buckets.items()]
    if group == "priority":
        for p in PRIORITY_ORDER:
            buckets[p] = []
        for card in cards:
            add(card.priority, card)
        return [BoardGroupOut(key=k, card_ids=v) for k, v in buckets.items()]
    if group == "assignee":
        for card in cards:
            add(str(card.assignee_id) if card.assignee_id else "none", card)
        keys = [k for k in buckets if k != "none"] + (["none"] if "none" in buckets else [])
    else:  # label: a card shows up under each of its labels
        for card in cards:
            for label in card.labels or ["none"]:
                add(label if card.labels else "none", card)
        keys = sorted((k for k in buckets if k != "none"), key=str.casefold)
        keys += ["none"] if "none" in buckets else []
    return [BoardGroupOut(key=k, card_ids=buckets[k]) for k in keys]


async def serialize_board(
    db: AsyncSession,
    board: Board,
    *,
    filters: Iterable = (),
    sort: BoardSort = "position",
    descending: bool = False,
    group: BoardGroup | None = None,
) -> BoardOutV2:
    columns = list(
        await db.scalars(
            select(BoardColumn)
            .where(BoardColumn.board_id == board.id)
            .order_by(BoardColumn.position, BoardColumn.created_at)
        )
    )
    fields = await db.scalars(
        select(BoardField)
        .where(BoardField.board_id == board.id)
        .order_by(BoardField.position, BoardField.created_at)
    )
    cards = list(
        await db.scalars(
            select(BoardCard)
            .join(BoardColumn, BoardColumn.id == BoardCard.column_id)
            .where(BoardCard.board_id == board.id, *filters)
            .order_by(*_card_sort(sort, descending))
        )
    )
    in_board = BoardCard.board_id == board.id
    subtasks = await _subtasks_by_card(db, in_board)
    counts = await _comment_counts(db, in_board)
    cards_out = [_card_out(c, subtasks.get(c.id, []), counts.get(c.id, 0)) for c in cards]
    return BoardOutV2(
        id=board.id,
        channel_id=board.channel_id,
        columns=[ColumnOut.model_validate(c) for c in columns],
        fields=[_field_out(f) for f in fields],
        cards=cards_out,
        groups=_group_cards(group, columns, cards_out) if group else None,
    )


async def _publish(db: AsyncSession, board: Board) -> None:
    out = await serialize_board(db, board)
    await publish_to_channel(
        board.channel_id,
        {
            "type": "board.updated",
            "channel_id": str(board.channel_id),
            "board": out.model_dump(mode="json"),
        },
    )


async def _publish_comments(board: Board, card_id: uuid.UUID) -> None:
    await publish_to_channel(
        board.channel_id,
        {
            "type": "board.comments.updated",
            "channel_id": str(board.channel_id),
            "card_id": str(card_id),
        },
    )


# --- Custom field values -----------------------------------------------------------------


def _options(options: list[FieldOption]) -> list[dict]:
    return [
        {"id": o.id or uuid.uuid4().hex[:12], "label": o.label, "color": o.color} for o in options
    ]


async def _coerce_value(db: AsyncSession, board: Board, field: BoardField, value: Any) -> Any:
    """The stored form of `value` for `field`, or None when it clears the field. Raises 422."""
    name, kind = field.name, field.type
    option_ids = {o["id"] for o in field.options or []}
    if kind == "text":
        if not isinstance(value, str):
            raise _unprocessable(f"{name}: expected text")
        value = value.strip()
        if len(value) > MAX_TEXT_VALUE:
            raise _unprocessable(f"{name}: at most {MAX_TEXT_VALUE} characters")
        return value or None
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise _unprocessable(f"{name}: expected a number")
        if not math.isfinite(value) or abs(value) > MAX_NUMBER_VALUE:
            raise _unprocessable(f"{name}: number out of range")
        return value
    if kind == "checkbox":
        if not isinstance(value, bool):
            raise _unprocessable(f"{name}: expected true or false")
        return value
    if kind == "select":
        if not isinstance(value, str) or value not in option_ids:
            raise _unprocessable(f"{name}: not one of the field's options")
        return value
    if kind == "multi_select":
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise _unprocessable(f"{name}: expected a list of option ids")
        if any(v not in option_ids for v in value):
            raise _unprocessable(f"{name}: not one of the field's options")
        return list(dict.fromkeys(value)) or None
    if kind == "person":
        try:
            user_id = uuid.UUID(str(value)) if isinstance(value, str) else None
        except ValueError:
            user_id = None
        if user_id is None:
            raise _unprocessable(f"{name}: expected a user id")
        if not await _is_workspace_member(db, board, user_id):
            raise _unprocessable(f"{name}: must be a workspace member")
        return str(user_id)
    if kind == "date":
        try:
            if not isinstance(value, str) or not _DATE_RE.match(value):
                raise ValueError
            return date.fromisoformat(value).isoformat()
        except ValueError:
            raise _unprocessable(f"{name}: expected a date (YYYY-MM-DD)") from None
    # url
    if not isinstance(value, str):
        raise _unprocessable(f"{name}: expected a URL")
    value = value.strip()
    if not value:
        return None
    parts = urlsplit(value)
    if (
        len(value) > MAX_TEXT_VALUE
        or parts.scheme not in ("http", "https")
        or not parts.netloc
        or any(ch.isspace() for ch in value)
    ):
        raise _unprocessable(f"{name}: expected an http(s) URL")
    return value


async def _field_changes(
    db: AsyncSession, board: Board, values: dict[uuid.UUID, Any]
) -> tuple[dict[str, Any], set[str]]:
    """Validate a {field_id: value} map: (values to set, field keys to clear)."""
    if not values:
        return {}, set()
    defs = {
        f.id: f
        for f in await db.scalars(
            select(BoardField).where(BoardField.board_id == board.id, BoardField.id.in_(values))
        )
    }
    sets: dict[str, Any] = {}
    clears: set[str] = set()
    for field_id, value in values.items():
        field = defs.get(field_id)
        if field is None:
            raise _unprocessable(f"Unknown field {field_id}")
        stored = None if value is None else await _coerce_value(db, board, field, value)
        if stored is None:
            clears.add(str(field_id))
        else:
            sets[str(field_id)] = stored
    return sets, clears


async def _rewrite_field_values(
    db: AsyncSession, field: BoardField, *, drop: bool
) -> None:
    """Drop (or prune to the remaining options) this field's value on every card."""
    key = str(field.id)
    cards = await db.scalars(
        select(BoardCard)
        .where(BoardCard.board_id == field.board_id, BoardCard.fields.has_key(key))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    option_ids = {o["id"] for o in field.options or []}
    for card in cards:
        values = dict(card.fields or {})
        current = values.get(key)
        if drop or (field.type == "select" and current not in option_ids):
            values.pop(key, None)
        elif field.type == "multi_select":
            kept = [v for v in current or [] if v in option_ids]
            if kept:
                values[key] = kept
            else:
                values.pop(key, None)
        if values != card.fields:
            card.fields = values


# --- Board -------------------------------------------------------------------------------


@router.get("/channels/{channel_id}/board", response_model=BoardOutV2)
async def get_board(
    channel: ChannelAccess,
    db: DB,
    sort: BoardSort = "position",
    order: Annotated[str, Query(pattern="^(asc|desc)$")] = "asc",
    group: BoardGroup | None = None,
    assignee_id: Annotated[
        str | None,
        Query(description='A user id, or "none" for unassigned cards'),
    ] = None,
    priority: Annotated[list[Priority] | None, Query()] = None,
    label: Annotated[str | None, Query(max_length=24)] = None,
    due: DueFilter | None = None,
    today: Annotated[
        date | None, Query(description="The viewer's local date for `due` (default: UTC today)")
    ] = None,
) -> BoardOutV2:
    """The channel's board (created with To do / In progress / Done on first access).

    Without parameters this is the full board. The table view can sort, group and filter
    server-side; columns and field definitions are always returned in full.
    """
    board = await get_or_create_board(db, channel)
    filters = []
    if assignee_id is not None:
        if assignee_id == "none":
            filters.append(BoardCard.assignee_id.is_(None))
        else:
            try:
                filters.append(BoardCard.assignee_id == uuid.UUID(assignee_id))
            except ValueError:
                raise _unprocessable('assignee_id must be a user id or "none"') from None
    if priority:
        filters.append(BoardCard.priority.in_(priority))
    if label is not None:
        filters.append(BoardCard.labels.contains([label.strip()]))
    if due is not None:
        day = today or datetime.now(UTC).date()
        if due == "overdue":
            filters += [BoardCard.due_date < day, BoardCard.completed.is_(False)]
        else:
            filters += [BoardCard.due_date >= day, BoardCard.due_date <= day + timedelta(days=7)]
    return await serialize_board(
        db, board, filters=filters, sort=sort, descending=order == "desc", group=group
    )


# --- Columns -----------------------------------------------------------------------------


@router.post(
    "/channels/{channel_id}/board/columns",
    response_model=ColumnOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_column(data: ColumnIn, channel: ChannelAccess, db: DB) -> BoardColumn:
    ensure_not_archived(channel)
    board = await get_or_create_board(db, channel)
    await _lock_board(db, board)
    count, top = (
        await db.execute(
            select(func.count(), func.max(BoardColumn.position)).where(
                BoardColumn.board_id == board.id
            )
        )
    ).one()
    if count >= MAX_COLUMNS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"A board can have at most {MAX_COLUMNS} columns")
    column = BoardColumn(
        board_id=board.id, name=data.name, color=data.color, position=(top or 0.0) + 1.0
    )
    db.add(column)
    await db.commit()
    await _publish(db, board)
    return column


@router.post("/board/columns/reorder", response_model=list[ColumnOut])
async def reorder_columns(data: ColumnReorderIn, db: DB, user: CurrentUser) -> list[BoardColumn]:
    """Set the full column order of a board: `column_ids` must list each of its columns once."""
    if len(set(data.column_ids)) != len(data.column_ids):
        raise _unprocessable("column_ids has duplicates")
    _, board = await _load_column(db, data.column_ids[0], user)
    await _lock_board(db, board)
    columns = {
        c.id: c
        for c in await db.scalars(select(BoardColumn).where(BoardColumn.board_id == board.id))
    }
    if set(columns) != set(data.column_ids):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "column_ids must list every column of the board once"
        )
    ordered = [columns[cid] for cid in data.column_ids]
    for n, column in enumerate(ordered, start=1):
        column.position = float(n)
    await db.commit()
    await _publish(db, board)
    return ordered


@router.patch("/board/columns/{column_id}", response_model=ColumnOut)
async def update_column(
    column_id: uuid.UUID, data: ColumnPatch, db: DB, user: CurrentUser
) -> BoardColumn:
    column, board = await _load_column(db, column_id, user)
    changes = data.model_dump(exclude_unset=True)
    if "name" in changes:
        if changes["name"] is None:
            raise _unprocessable("name can't be empty")
        column.name = changes["name"]
    if "color" in changes:
        column.color = changes["color"]
    if changes.get("position") is not None:
        column.position = changes["position"]
        await db.flush()
        await _renumber_if_crowded(
            db,
            list(
                await db.scalars(
                    select(BoardColumn)
                    .where(BoardColumn.board_id == board.id)
                    .order_by(BoardColumn.position, BoardColumn.created_at)
                )
            ),
        )
    await db.commit()
    await _publish(db, board)
    return column


@router.delete("/board/columns/{column_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_column(column_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    column, board = await _load_column(db, column_id, user)
    # Lock the board row so two concurrent deletes can't remove the last two columns.
    await _lock_board(db, board)
    remaining = await db.scalar(
        select(func.count()).where(BoardColumn.board_id == board.id)
    )
    if remaining <= 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A board needs at least one column")
    await db.delete(column)  # its cards go with it (ON DELETE CASCADE)
    await db.commit()
    await _publish(db, board)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Custom field definitions --------------------------------------------------------------


@router.post(
    "/channels/{channel_id}/board/fields",
    response_model=FieldDefOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_field(data: FieldDefIn, channel: ChannelAccess, db: DB) -> FieldDefOut:
    ensure_not_archived(channel)
    board = await get_or_create_board(db, channel)
    await _lock_board(db, board)
    count, top = (
        await db.execute(
            select(func.count(), func.max(BoardField.position)).where(
                BoardField.board_id == board.id
            )
        )
    ).one()
    if count >= MAX_FIELDS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"A board can have at most {MAX_FIELDS} fields")
    field = BoardField(
        board_id=board.id,
        name=data.name,
        type=data.type,
        options=_options(data.options),
        position=(top or 0.0) + 1.0,
    )
    db.add(field)
    await db.commit()
    await _publish(db, board)
    return _field_out(field)


@router.patch("/board/fields/{field_id}", response_model=FieldDefOut)
async def update_field(
    field_id: uuid.UUID, data: FieldDefPatch, db: DB, user: CurrentUser
) -> FieldDefOut:
    """Rename, retype, edit options or move a field.

    Changing the type clears the field on every card; removing select options drops them
    from the cards that had them.
    """
    field, board = await _load_field(db, field_id, user)
    changes = data.model_dump(exclude_unset=True)
    for required in ("name", "type", "options"):
        if required in changes and changes[required] is None:
            raise _unprocessable(f"{required} can't be null")
    if "name" in changes:
        field.name = data.name
    retyped = "type" in changes and data.type != field.type
    if retyped:
        field.type = data.type
        if data.type not in SELECT_TYPES and "options" not in changes:
            field.options = []
    if "options" in changes:
        if data.options and field.type not in SELECT_TYPES:
            raise _unprocessable("only select and multi_select fields have options")
        field.options = _options(data.options)
    if retyped:
        await _rewrite_field_values(db, field, drop=True)
    elif "options" in changes:
        await _rewrite_field_values(db, field, drop=False)
    if changes.get("position") is not None:
        field.position = data.position
        await db.flush()
        await _renumber_if_crowded(
            db,
            list(
                await db.scalars(
                    select(BoardField)
                    .where(BoardField.board_id == board.id)
                    .order_by(BoardField.position, BoardField.created_at)
                )
            ),
        )
    await db.commit()
    await _publish(db, board)
    return _field_out(field)


@router.delete("/board/fields/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_field(field_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    field, board = await _load_field(db, field_id, user)
    await _rewrite_field_values(db, field, drop=True)
    await db.delete(field)
    await db.commit()
    await _publish(db, board)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Cards -------------------------------------------------------------------------------


@router.post(
    "/channels/{channel_id}/board/cards",
    response_model=CardOutV2,
    status_code=status.HTTP_201_CREATED,
)
async def create_card(
    data: CardInV2, channel: ChannelAccess, db: DB, user: CurrentUser
) -> CardOutV2:
    ensure_not_archived(channel)
    board = await get_or_create_board(db, channel)
    await _column_in_board(db, board, data.column_id)
    await _assert_assignee(db, board, data.assignee_id)
    # Callers may pass the v1 CardIn (the AI agent does), which has no v2 keys.
    sets, _ = await _field_changes(db, board, getattr(data, "fields", None) or {})
    await _lock_board(db, board)
    total = await db.scalar(select(func.count()).where(BoardCard.board_id == board.id))
    if total >= MAX_CARDS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"A board can have at most {MAX_CARDS} cards")
    card = BoardCard(
        board_id=board.id,
        column_id=data.column_id,
        title=data.title,
        description=data.description,
        assignee_id=data.assignee_id,
        due_date=data.due_date,
        labels=data.labels,
        priority=getattr(data, "priority", "none"),
        cover_color=getattr(data, "cover_color", None),
        fields=sets,
        position=await _next_position(db, BoardCard.position, BoardCard.column_id == data.column_id),
        created_by=user.id,
        completed=False,
    )
    db.add(card)
    await db.commit()
    await _publish(db, board)
    return _card_out(card, [], 0)


@router.patch("/board/cards/{card_id}", response_model=CardOutV2)
async def update_card(
    card_id: uuid.UUID, data: CardPatchV2, db: DB, user: CurrentUser
) -> CardOutV2:
    """Edit fields and/or move: set `column_id` and/or a `position` between the neighbours.

    Moving to another column without a position appends the card at its end. `fields` is a
    partial map merged into the card's values (a null value clears that field).
    """
    card, board = await _load_card(db, card_id, user)
    changes = data.model_dump(exclude_unset=True)
    for required in ("title", "labels", "completed", "priority", "fields"):
        if required in changes and changes[required] is None:
            raise _unprocessable(f"{required} can't be null")
    if "assignee_id" in changes:
        await _assert_assignee(db, board, changes["assignee_id"])

    field_values = changes.pop("fields", None)
    if field_values:
        sets, clears = await _field_changes(db, board, data.fields)
        # Lock + re-read so concurrent edits of different fields both survive the merge.
        await db.refresh(card, with_for_update=True)
        merged = {k: v for k, v in (card.fields or {}).items() if k not in clears}
        merged.update(sets)
        card.fields = merged

    new_column = changes.pop("column_id", None)
    new_position = changes.pop("position", None)
    for name, value in changes.items():
        setattr(card, name, value)

    moved = False
    if new_column is not None and new_column != card.column_id:
        await _column_in_board(db, board, new_column)
        card.column_id = new_column
        if new_position is None:
            new_position = await _next_position(
                db, BoardCard.position, BoardCard.column_id == new_column
            )
        moved = True
    if new_position is not None:
        card.position = new_position
        moved = True
    if moved:
        await db.flush()
        await _renumber_if_crowded(
            db,
            list(
                await db.scalars(
                    select(BoardCard)
                    .where(BoardCard.column_id == card.column_id)
                    .order_by(BoardCard.position, BoardCard.created_at)
                )
            ),
        )
    await db.commit()
    await _publish(db, board)
    return await card_out(db, card)


@router.delete("/board/cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_card(card_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    card, board = await _load_card(db, card_id, user)
    await _delete_mention_events(db, card_id=card.id)
    await db.delete(card)  # subtasks and comments cascade
    await db.commit()
    await _publish(db, board)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Subtasks ----------------------------------------------------------------------------


@router.post(
    "/board/cards/{card_id}/subtasks",
    response_model=SubtaskOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_subtask(
    card_id: uuid.UUID, data: SubtaskIn, db: DB, user: CurrentUser
) -> BoardSubtask:
    card, board = await _load_card(db, card_id, user)
    await _assert_assignee(db, board, data.assignee_id)
    # Lock the card so concurrent adds can't overshoot the cap or share a position.
    await db.execute(select(BoardCard.id).where(BoardCard.id == card.id).with_for_update())
    count, top = (
        await db.execute(
            select(func.count(), func.max(BoardSubtask.position)).where(
                BoardSubtask.card_id == card.id
            )
        )
    ).one()
    if count >= MAX_SUBTASKS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"A card can have at most {MAX_SUBTASKS} subtasks"
        )
    subtask = BoardSubtask(
        card_id=card.id,
        title=data.title,
        assignee_id=data.assignee_id,
        done=False,
        position=(top or 0.0) + 1.0,
    )
    db.add(subtask)
    await db.commit()
    await _publish(db, board)
    return subtask


@router.patch("/board/subtasks/{subtask_id}", response_model=SubtaskOut)
async def update_subtask(
    subtask_id: uuid.UUID, data: SubtaskPatch, db: DB, user: CurrentUser
) -> BoardSubtask:
    subtask, card, board = await _load_subtask(db, subtask_id, user)
    changes = data.model_dump(exclude_unset=True)
    for required in ("title", "done"):
        if required in changes and changes[required] is None:
            raise _unprocessable(f"{required} can't be null")
    if "assignee_id" in changes:
        await _assert_assignee(db, board, changes["assignee_id"])
    position = changes.pop("position", None)
    for name, value in changes.items():
        setattr(subtask, name, value)
    if position is not None:
        subtask.position = position
        await db.flush()
        await _renumber_if_crowded(
            db,
            list(
                await db.scalars(
                    select(BoardSubtask)
                    .where(BoardSubtask.card_id == card.id)
                    .order_by(BoardSubtask.position, BoardSubtask.created_at)
                )
            ),
        )
    await db.commit()
    await _publish(db, board)
    return subtask


@router.delete("/board/subtasks/{subtask_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_subtask(subtask_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    subtask, _, board = await _load_subtask(db, subtask_id, user)
    await db.delete(subtask)
    await db.commit()
    await _publish(db, board)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Card comments -----------------------------------------------------------------------


async def _delete_mention_events(
    db: AsyncSession, *, card_id: uuid.UUID | None = None, comment_id: uuid.UUID | None = None
) -> None:
    """Remove card_mention activity for a deleted card or comment (call before commit)."""
    conds = []
    if card_id is not None:
        conds.append(ActivityEvent.meta["card_id"].astext == str(card_id))
    if comment_id is not None:
        conds.append(ActivityEvent.meta["comment_id"].astext == str(comment_id))
    await db.execute(delete(ActivityEvent).where(ActivityEvent.type == CARD_MENTION, or_(*conds)))


async def _notify_mentions(
    db: AsyncSession,
    board: Board,
    card: BoardCard,
    comment: BoardCardComment,
    user_ids: set[uuid.UUID],
) -> None:
    """Record + publish a card_mention activity item per mentioned reader. Never raises."""
    # Imported lazily: app.productivity pulls in services/schemas that import a lot.
    from app.productivity import can_read_channel, publish_activity, should_notify

    try:
        channel = await db.get(Channel, board.channel_id)
        targets = [
            uid
            for uid in sorted(user_ids - {comment.author_id})[:MAX_MENTION_FANOUT]
            if await can_read_channel(db, channel.id, uid)
        ]
        if not targets:
            return
        meta = {
            "card_id": str(card.id),
            "card_title": card.title,
            "comment_id": str(comment.id),
            "excerpt": comment.body[:200],
        }
        events = [
            ActivityEvent(
                workspace_id=channel.workspace_id,
                user_id=uid,
                type=CARD_MENTION,
                actor_id=comment.author_id,
                channel_id=channel.id,
                meta=meta,
            )
            for uid in targets
        ]
        db.add_all(events)
        await db.commit()
        for ev in events:
            # card_mention is an Activity item (activity.new). The direct board.mention push is
            # only a fallback for when the item can't be loaded (e.g. the channel became
            # unreadable in between).
            if await publish_activity(db, channel.workspace_id, ev.user_id, ev.id) is None:
                await notify_user(
                    ev.user_id,
                    {
                        "type": "board.mention",
                        "activity_id": str(ev.id),
                        "channel_id": str(channel.id),
                        "actor_id": str(comment.author_id) if comment.author_id else None,
                        **meta,
                        "notify": await should_notify(db, ev.user_id, channel.id, "mention"),
                    },
                )
    except Exception:
        await db.rollback()
        log.exception("Mention fan-out failed for card comment %s", comment.id)


@router.get("/board/cards/{card_id}/comments", response_model=list[CardCommentOut])
async def list_comments(card_id: uuid.UUID, db: DB, user: CurrentUser) -> list[BoardCardComment]:
    """The card's comments, oldest first (readable on archived channels too)."""
    card, _ = await _load_card(db, card_id, user, write=False)
    return list(
        await db.scalars(
            select(BoardCardComment)
            .where(BoardCardComment.card_id == card.id)
            .order_by(BoardCardComment.created_at, BoardCardComment.id)
        )
    )


@router.post(
    "/board/cards/{card_id}/comments",
    response_model=CardCommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    card_id: uuid.UUID, data: CardCommentIn, db: DB, user: CurrentUser
) -> CardCommentOut:
    card, board = await _load_card(db, card_id, user)
    await db.execute(select(BoardCard.id).where(BoardCard.id == card.id).with_for_update())
    count = await db.scalar(select(func.count()).where(BoardCardComment.card_id == card.id))
    if count >= MAX_COMMENTS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"A card can have at most {MAX_COMMENTS} comments"
        )
    comment = BoardCardComment(card_id=card.id, author_id=user.id, body=data.body)
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    out = CardCommentOut.model_validate(comment)
    await _publish_comments(board, card.id)
    await _publish(db, board)
    await _notify_mentions(db, board, card, comment, mentioned_user_ids(comment.body))
    return out


@router.patch("/board/comments/{comment_id}", response_model=CardCommentOut)
async def update_comment(
    comment_id: uuid.UUID, data: CardCommentPatch, db: DB, user: CurrentUser
) -> CardCommentOut:
    """Edit your own comment; users newly mentioned by the edit are notified."""
    comment, card, board = await _load_comment(db, comment_id, user)
    if comment.author_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only edit your own comments")
    before = mentioned_user_ids(comment.body)
    if data.body != comment.body:
        comment.body = data.body
        comment.edited_at = func.now()
    await db.commit()
    await db.refresh(comment)
    out = CardCommentOut.model_validate(comment)
    await _publish_comments(board, card.id)
    added = mentioned_user_ids(comment.body) - before
    if added:
        await _notify_mentions(db, board, card, comment, added)
    return out


@router.delete("/board/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(comment_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    """Authors delete their comments; workspace owners/admins can delete any."""
    comment, card, board = await _load_comment(db, comment_id, user)
    if comment.author_id != user.id:
        channel = await db.get(Channel, board.channel_id)
        member = await get_workspace_membership(db, channel.workspace_id, user.id)
        if member.role not in (WorkspaceRole.owner, WorkspaceRole.admin):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "You can only delete your own comments"
            )
    await _delete_mention_events(db, comment_id=comment.id)
    await db.delete(comment)
    await db.commit()
    await _publish_comments(board, card.id)
    await _publish(db, board)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
