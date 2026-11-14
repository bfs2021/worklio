"""Canvas collaboration: access rules and Yjs document persistence.

Access (one SQL filter shared by listing, single reads and WebSocket joins):
    workspace  every full (non-guest) member of the canvas's workspace
    private    the creator and `canvas_members`
    channel    whoever can read `channel_id` (guests only channels they were added to)

Yjs persistence. Every accepted `canvas.update` frame is validated, appended to a Redis list
(`canvas:pending:<id>`) *before* it is relayed, and a flush is scheduled at most
FLUSH_DELAY_SECONDS later. A flush locks the canvas row (SELECT ... FOR UPDATE), merges the
stored state with every pending update in one pycrdt Doc, writes the compacted result and only
then trims what it consumed from the list (still under the row lock, so concurrent flushers on
other processes can't trim each other's entries). If the commit fails the entries are pushed
back (CRDT updates commute, order doesn't matter); if the process dies before flushing, the
entries stay in Redis and are picked up by the next flush or join. `read_state` always merges
the pending entries, so a client that subscribes and then fetches the state sees every update
that was relayed before it subscribed.
"""

import asyncio
import base64
import binascii
import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from pycrdt import Doc
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import readable_channel_ids
from app.core.db import SessionLocal
from app.core.redis import redis
from app.models import Canvas, CanvasMember, Channel, WorkspaceMember, WorkspaceRole
from app.models.canvas import CanvasAccess

log = logging.getLogger(__name__)

MAX_STATE_BYTES = 5 * 1024 * 1024
MAX_UPDATE_BYTES = 512 * 1024
MAX_AWARENESS_BYTES = 32 * 1024
FLUSH_DELAY_SECONDS = 1.0
FLUSH_RETRY_SECONDS = 5.0
UPDATES_PER_SECOND = 60
AWARENESS_PER_SECOND = 20
JOINS_PER_SECOND = 10
MAX_CANVASES_PER_SOCKET = 20
# Validating big updates off the event loop keeps other sockets responsive.
OFFLOAD_BYTES = 64 * 1024
SIZE_CACHE_SECONDS = 3600
# Encoded state vector of an empty doc (no clients).
EMPTY_STATE_VECTOR = Doc().get_state()


class CanvasTooLarge(Exception):
    pass


class InvalidUpdate(Exception):
    pass


# --- Access --------------------------------------------------------------------------------


def accessible_filter(workspace_id: uuid.UUID, user_id: uuid.UUID, guest: bool):
    """WHERE clause selecting the canvases of a workspace the user may open."""
    shared_with_me = select(CanvasMember.canvas_id).where(CanvasMember.user_id == user_id)
    readable = readable_channel_ids(workspace_id, user_id, guest)
    conds = [
        and_(Canvas.access == CanvasAccess.channel.value, Canvas.channel_id.in_(readable)),
        and_(
            Canvas.access == CanvasAccess.private.value,
            or_(Canvas.created_by == user_id, Canvas.id.in_(shared_with_me)),
        ),
    ]
    if not guest:
        conds.append(Canvas.access == CanvasAccess.workspace.value)
    return and_(Canvas.workspace_id == workspace_id, or_(*conds))


async def membership_for(
    db: AsyncSession, canvas: Canvas, user_id: uuid.UUID
) -> WorkspaceMember | None:
    """The user's workspace membership if they may open the canvas, else None."""
    member = await db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == canvas.workspace_id, WorkspaceMember.user_id == user_id
        )
    )
    if member is None:
        return None
    allowed = await db.scalar(
        select(Canvas.id).where(
            Canvas.id == canvas.id,
            accessible_filter(canvas.workspace_id, user_id, member.role == WorkspaceRole.guest),
        )
    )
    return member if allowed else None


def bound_channel_id(canvas: Canvas) -> uuid.UUID | None:
    """The channel whose archived flag makes this canvas read-only (if any)."""
    if canvas.is_channel_canvas or canvas.access == CanvasAccess.channel.value:
        return canvas.channel_id
    return None


async def is_read_only(db: AsyncSession, canvas: Canvas) -> bool:
    cid = bound_channel_id(canvas)
    if cid is None:
        return False
    return bool(await db.scalar(select(Channel.is_archived).where(Channel.id == cid)))


@dataclass(frozen=True)
class JoinInfo:
    canvas_id: str
    # Channel this canvas is tied to: leaving the channel drops the subscription, and its
    # archived flag makes the canvas read-only.
    channel_id: str | None


async def join_info(user_id: uuid.UUID | str, canvas_id: str) -> JoinInfo | None:
    """Access check for a WebSocket `canvas.join` (None: no such canvas or no access)."""
    try:
        cid = uuid.UUID(canvas_id)
    except (ValueError, TypeError):
        return None
    async with SessionLocal() as db:
        canvas = await db.get(Canvas, cid)
        if canvas is None or await membership_for(db, canvas, uuid.UUID(str(user_id))) is None:
            return None
        channel = bound_channel_id(canvas)
        return JoinInfo(str(canvas.id), str(channel) if channel else None)


# --- Yjs encoding --------------------------------------------------------------------------


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode()


def b64decode(value: object, max_bytes: int) -> bytes | None:
    """Strict base64 → bytes, or None if malformed, empty or over `max_bytes` decoded."""
    if not isinstance(value, str) or not value or len(value) > (max_bytes + 2) // 3 * 4:
        return None
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None
    return data if 0 < len(data) <= max_bytes else None


def _apply(doc: Doc, data: bytes) -> None:
    try:
        doc.apply_update(data)
    except Exception as exc:
        raise InvalidUpdate(str(exc)) from exc
    except BaseException as exc:  # pyo3 PanicException derives from BaseException
        if type(exc).__name__ != "PanicException":
            raise
        raise InvalidUpdate(str(exc)) from exc


def validate_update(data: bytes) -> None:
    """Raise InvalidUpdate unless `data` decodes as a Yjs (v1) update."""
    _apply(Doc(), data)


def merge(state: bytes | None, updates: Iterable[bytes]) -> bytes:
    """Stored state + updates → one compacted update encoding the whole document."""
    doc = Doc()
    if state:
        _apply(doc, state)
    for data in updates:
        try:
            _apply(doc, data)
        except InvalidUpdate:
            # Validated before queuing, so this "can't happen"; never let one entry block the rest.
            log.warning("Skipping undecodable canvas update (%d bytes)", len(data))
    return doc.get_update()


def state_vector(state: bytes | None) -> bytes:
    if not state:
        return EMPTY_STATE_VECTOR
    doc = Doc()
    _apply(doc, state)
    return doc.get_state()


async def _offload(fn, *args):
    return await asyncio.to_thread(fn, *args)


async def check_update(data: bytes) -> None:
    if len(data) > OFFLOAD_BYTES:
        await _offload(validate_update, data)
    else:
        validate_update(data)


# --- Pending updates (Redis) ---------------------------------------------------------------


def _pending_key(canvas_id: str) -> str:
    return f"canvas:pending:{canvas_id}"


def _pending_bytes_key(canvas_id: str) -> str:
    return f"canvas:pending-bytes:{canvas_id}"


def _size_key(canvas_id: str) -> str:
    return f"canvas:size:{canvas_id}"


def _entry(user_id: str, data: bytes) -> str:
    return f"{user_id}|{b64encode(data)}"


def _parse_entry(entry: str) -> tuple[str, bytes] | None:
    user_id, _, payload = entry.partition("|")
    try:
        return user_id, base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None


async def _stored_size(canvas_id: str) -> int:
    cached = await redis.get(_size_key(canvas_id))
    if cached is not None:
        return int(cached)
    async with SessionLocal() as db:
        size = await db.scalar(select(Canvas.ydoc_size).where(Canvas.id == uuid.UUID(canvas_id)))
    size = size or 0
    await redis.set(_size_key(canvas_id), size, ex=SIZE_CACHE_SECONDS)
    return size


async def enqueue_update(canvas_id: str, user_id: str, data: bytes) -> None:
    """Queue a validated update for persistence (raises CanvasTooLarge over the size cap).

    The bound is conservative: stored size + everything pending + this update, so the merged
    document can't grow past MAX_STATE_BYTES.
    """
    stored = await _stored_size(canvas_id)
    pending = int(await redis.get(_pending_bytes_key(canvas_id)) or 0)
    if stored + pending + len(data) > MAX_STATE_BYTES:
        raise CanvasTooLarge
    async with redis.pipeline(transaction=True) as pipe:
        pipe.rpush(_pending_key(canvas_id), _entry(user_id, data))
        pipe.incrby(_pending_bytes_key(canvas_id), len(data))
        await pipe.execute()
    schedule_flush(canvas_id)


async def has_pending(canvas_id: str) -> bool:
    return bool(await redis.llen(_pending_key(canvas_id)))


async def drop_pending(canvas_id: str) -> None:
    """Forget a deleted canvas's queued updates."""
    _cancel_waiting(canvas_id)
    await redis.delete(_pending_key(canvas_id), _pending_bytes_key(canvas_id), _size_key(canvas_id))


async def flush(canvas_id: str) -> bool:
    """Merge queued updates into the stored document. Returns True if anything was written."""
    key = _pending_key(canvas_id)
    async with SessionLocal() as db:
        row = (
            await db.execute(
                select(Canvas.id, Canvas.ydoc_state)
                .where(Canvas.id == uuid.UUID(canvas_id))
                .with_for_update()
            )
        ).first()
        if row is None:
            await db.rollback()
            await drop_pending(canvas_id)
            return False
        entries: list[str] = await redis.lrange(key, 0, -1)
        if not entries:
            await db.rollback()
            return False
        parsed = [p for p in map(_parse_entry, entries) if p is not None]
        merged = await _offload(merge, row.ydoc_state, [data for _, data in parsed])
        last_user = next((u for u, _ in reversed(parsed) if u), None)
        await db.execute(
            update(Canvas)
            .where(Canvas.id == row.id)
            .values(
                ydoc_state=merged,
                ydoc_size=len(merged),
                updated_at=func.now(),
                updated_by=uuid.UUID(last_user) if last_user else Canvas.updated_by,
            )
            .execution_options(synchronize_session=False)
        )
        consumed = sum(len(data) for _, data in parsed)
        # Trim while still holding the row lock: no other flusher can read the list meanwhile.
        async with redis.pipeline(transaction=True) as pipe:
            pipe.ltrim(key, len(entries), -1)
            pipe.decrby(_pending_bytes_key(canvas_id), consumed)
            pipe.set(_size_key(canvas_id), len(merged), ex=SIZE_CACHE_SECONDS)
            await pipe.execute()
        try:
            await db.commit()
        except BaseException:
            # Put the entries back so nothing is lost; a later flush retries them.
            async with redis.pipeline(transaction=True) as pipe:
                pipe.rpush(key, *entries)
                pipe.incrby(_pending_bytes_key(canvas_id), consumed)
                pipe.delete(_size_key(canvas_id))
                await pipe.execute()
            raise
    return True


_flush_tasks: dict[str, asyncio.Task] = {}
# Canvases whose scheduled flush is still waiting (safe to cancel; a running flush never is).
_sleeping: set[str] = set()


def schedule_flush(canvas_id: str, delay: float = FLUSH_DELAY_SECONDS) -> None:
    """Flush within `delay` seconds (not pushed back by later updates: ≤ 1 s staleness)."""
    if canvas_id in _flush_tasks:
        return
    _sleeping.add(canvas_id)
    _flush_tasks[canvas_id] = asyncio.create_task(_delayed_flush(canvas_id, delay))


async def _delayed_flush(canvas_id: str, delay: float) -> None:
    retry = False
    try:
        await asyncio.sleep(delay)
        _sleeping.discard(canvas_id)
        await flush(canvas_id)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("Canvas %s flush failed; retrying", canvas_id)
        retry = True
    finally:
        _sleeping.discard(canvas_id)
        if _flush_tasks.get(canvas_id) is asyncio.current_task():
            del _flush_tasks[canvas_id]
    try:
        again = retry or await has_pending(canvas_id)
    except Exception:
        log.exception("Canvas %s: can't check pending updates", canvas_id)
        again = True
    if again:
        schedule_flush(canvas_id, FLUSH_RETRY_SECONDS if retry else FLUSH_DELAY_SECONDS)


def _cancel_waiting(canvas_id: str) -> None:
    if canvas_id in _sleeping:
        _sleeping.discard(canvas_id)
        task = _flush_tasks.pop(canvas_id, None)
        if task:
            task.cancel()


async def flush_now(canvas_id: str) -> None:
    """Persist this canvas's queued updates right away (leave / disconnect / shutdown)."""
    _cancel_waiting(canvas_id)
    try:
        if await has_pending(canvas_id):
            await flush(canvas_id)
    except Exception:
        log.exception("Canvas %s flush failed; retrying later", canvas_id)
        schedule_flush(canvas_id, FLUSH_RETRY_SECONDS)


async def flush_all() -> None:
    """Flush every canvas with a scheduled flush in this process (shutdown)."""
    running = [t for cid, t in _flush_tasks.items() if cid not in _sleeping]
    await asyncio.gather(
        *(flush_now(cid) for cid in list(_sleeping)), *running, return_exceptions=True
    )


async def read_state(db: AsyncSession, canvas_id: uuid.UUID) -> tuple[bytes, bytes]:
    """(full document update, state vector), including updates not flushed yet."""
    stored = await db.scalar(select(Canvas.ydoc_state).where(Canvas.id == canvas_id))
    entries: list[str] = await redis.lrange(_pending_key(str(canvas_id)), 0, -1)
    pending = [p[1] for p in map(_parse_entry, entries) if p is not None]
    if not stored and not pending:
        return b"", EMPTY_STATE_VECTOR
    if not pending:
        return stored, await _offload(state_vector, stored)

    def _merged() -> tuple[bytes, bytes]:
        doc = Doc()
        full = merge(stored, pending)
        _apply(doc, full)
        return full, doc.get_state()

    return await _offload(_merged)
