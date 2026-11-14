import asyncio
import json
import logging
import math
import time
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from app import canvas_collab
from app.core.config import settings
from app.core.db import SessionLocal
from app.core.security import TokenClaims, decode_access_token_claims
from app.models import Channel, ChannelKind, ChannelMember, User, WorkspaceMember, WorkspaceRole
from app.realtime.hub import (
    CLOSE_TOKEN_EXPIRED,
    Connection,
    allow_canvas_presence,
    allow_per_second,
    allow_typing,
    hub,
    presence_connect,
    presence_disconnect,
    presence_heartbeat,
    publish_to_canvas,
    publish_to_channel,
    publish_to_workspace,
)

router = APIRouter()
log = logging.getLogger(__name__)

AUTH_TIMEOUT_SECONDS = 10
# Client frames bigger than this are dropped unparsed (whiteboard ops are the largest).
MAX_CLIENT_FRAME_BYTES = 256 * 1024
# ...except canvas.update, whose base64 Yjs update may be up to 512 KB decoded.
MAX_CANVAS_FRAME_BYTES = (canvas_collab.MAX_UPDATE_BYTES + 2) // 3 * 4 + 4 * 1024
MAX_WHITEBOARD_OPS_ELEMENTS = 300
MAX_CLIENT_ID_LENGTH = 64
# Pointer coordinates are scene coordinates; anything beyond this is junk.
MAX_POINTER_COORD = 1e7
POINTER_TOOLS = frozenset({"pointer", "laser"})
# How long "is this channel archived?" answers are reused for whiteboard frames.
ARCHIVED_CACHE_SECONDS = 15
_archived_cache: dict[str, tuple[float, bool]] = {}


async def _broadcast_presence(conn: Connection, online: bool) -> None:
    event = {"type": "presence", "user_id": conn.user_id, "online": online}
    for wid in conn.workspace_ids:
        await publish_to_workspace(wid, event)


def _parse(message: dict) -> dict | None:
    """A client event as a dict, or None for binary frames / invalid or non-object JSON."""
    text = message.get("text")
    if text is None:
        return None
    size = len(text.encode())
    if size > MAX_CANVAS_FRAME_BYTES:
        return None
    try:
        event = json.loads(text)
    except ValueError:
        return None
    if not isinstance(event, dict):
        return None
    if size > MAX_CLIENT_FRAME_BYTES and event.get("type") != "canvas.update":
        return None
    return event


async def _receive(ws: WebSocket, timeout: float | None) -> dict | None:
    """Next client event (None for ignorable frames). Raises WebSocketDisconnect / TimeoutError."""
    message = await asyncio.wait_for(ws.receive(), timeout)
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", status.WS_1000_NORMAL_CLOSURE))
    return _parse(message)


def _seconds_left(claims: TokenClaims) -> float:
    return (claims.expires_at - datetime.now(UTC)).total_seconds()


async def _can_peek(user_id: uuid.UUID, channel_id: str) -> bool:
    """May this user watch a channel live without joining? (public + non-guest workspace member)"""
    try:
        cid = uuid.UUID(channel_id)
    except ValueError:
        return False
    async with SessionLocal() as db:
        channel = await db.get(Channel, cid)
        if not channel:
            return False
        role = await db.scalar(
            select(WorkspaceMember.role).where(
                WorkspaceMember.workspace_id == channel.workspace_id,
                WorkspaceMember.user_id == user_id,
            )
        )
        if role is None:
            return False
        if channel.kind == ChannelKind.public and role != WorkspaceRole.guest:
            return True
        return bool(
            await db.scalar(
                select(ChannelMember.id).where(
                    ChannelMember.channel_id == cid, ChannelMember.user_id == user_id
                )
            )
        )


async def _channel_archived(channel_id: str) -> bool:
    """Cached archived flag (whiteboard frames are frequent; archiving is rare)."""
    now = time.monotonic()
    hit = _archived_cache.get(channel_id)
    if hit and hit[0] > now:
        return hit[1]
    async with SessionLocal() as db:
        archived = await db.scalar(
            select(Channel.is_archived).where(Channel.id == uuid.UUID(channel_id))
        )
    result = archived is not False  # missing channel counts as not writable
    if len(_archived_cache) > 10_000:
        _archived_cache.clear()
    _archived_cache[channel_id] = (now + ARCHIVED_CACHE_SECONDS, result)
    return result


def _client_id(event: dict) -> str | None:
    cid = event.get("client_id")
    if isinstance(cid, str) and 0 < len(cid) <= MAX_CLIENT_ID_LENGTH:
        return cid
    return None


def _whiteboard_elements(event: dict) -> list[dict] | None:
    elements = event.get("elements")
    if (
        not isinstance(elements, list)
        or not 0 < len(elements) <= MAX_WHITEBOARD_OPS_ELEMENTS
        or not all(
            isinstance(el, dict)
            and isinstance(el.get("id"), str)
            and el["id"]
            and type(el.get("version")) is int
            for el in elements
        )
    ):
        return None
    return elements


def _coord(value) -> float | None:
    if type(value) not in (int, float) or not math.isfinite(value):
        return None
    return value if abs(value) <= MAX_POINTER_COORD else None


async def _whiteboard_target(conn: Connection, event: dict, scope: str, limit: int) -> str | None:
    """The channel id if this whiteboard frame may be relayed (subscribed, writable, in budget)."""
    cid = str(event.get("channel_id", ""))
    if cid not in conn.channel_ids:
        return None
    if not await allow_per_second(scope, conn.user_id, cid, limit):
        return None
    if await _channel_archived(cid):
        return None
    return cid


async def _relay_whiteboard_ops(conn: Connection, event: dict) -> None:
    client_id, elements = _client_id(event), _whiteboard_elements(event)
    if client_id is None or elements is None:
        return
    cid = await _whiteboard_target(conn, event, "wb-ops", settings.whiteboard_ops_per_second)
    if cid is None:
        return
    await publish_to_channel(
        uuid.UUID(cid),
        {
            "type": "whiteboard.ops",
            "channel_id": cid,
            "user_id": conn.user_id,
            "client_id": client_id,
            "elements": elements,
        },
    )


async def _relay_whiteboard_pointer(conn: Connection, event: dict) -> None:
    client_id, x, y = _client_id(event), _coord(event.get("x")), _coord(event.get("y"))
    tool = event.get("tool", "pointer")
    if client_id is None or x is None or y is None or tool not in POINTER_TOOLS:
        return
    cid = await _whiteboard_target(
        conn, event, "wb-pointer", settings.whiteboard_pointer_per_second
    )
    if cid is None:
        return
    await publish_to_channel(
        uuid.UUID(cid),
        {
            "type": "whiteboard.pointer",
            "channel_id": cid,
            "user_id": conn.user_id,
            "client_id": client_id,
            "x": x,
            "y": y,
            "tool": tool,
        },
    )


async def _canvas_error(conn: Connection, canvas_id: object, error: str) -> None:
    await conn.send(
        json.dumps({"type": "canvas.error", "canvas_id": str(canvas_id or ""), "error": error})
    )


async def _join_canvas(conn: Connection, event: dict) -> None:
    raw_id = event.get("canvas_id")
    canvas_id = str(raw_id or "")
    if canvas_id in conn.canvas_ids:
        await conn.send(json.dumps({"type": "canvas.joined", "canvas_id": canvas_id}))
        return
    if not await allow_per_second(
        "canvas-join", conn.user_id, "-", canvas_collab.JOINS_PER_SECOND
    ):
        await _canvas_error(conn, raw_id, "rate_limited")
        return
    if len(conn.canvas_ids) >= canvas_collab.MAX_CANVASES_PER_SOCKET:
        await _canvas_error(conn, raw_id, "too_many_canvases")
        return
    info = await canvas_collab.join_info(conn.user_id, canvas_id)
    if info is None:
        await _canvas_error(conn, raw_id, "not_found")
        return
    hub.subscribe_canvas(conn, info.canvas_id, info.channel_id)
    await conn.send(json.dumps({"type": "canvas.joined", "canvas_id": info.canvas_id}))
    # Updates a crashed process queued but never flushed get persisted now.
    if await canvas_collab.has_pending(info.canvas_id):
        canvas_collab.schedule_flush(info.canvas_id)


async def _leave_canvas(conn: Connection, canvas_id: str) -> None:
    clients = sorted(conn.canvas_clients.get(canvas_id, ()))
    hub.unsubscribe_canvas(conn, canvas_id)
    if clients:
        # Lets peers drop this socket's cursors at once instead of waiting for awareness timeout.
        await publish_to_canvas(
            canvas_id,
            {
                "type": "canvas.peer_left",
                "canvas_id": canvas_id,
                "user_id": conn.user_id,
                "client_ids": clients,
            },
            origin=conn.id,
        )
    await canvas_collab.flush_now(canvas_id)


async def _canvas_writable(canvas_id: str, conn: Connection) -> bool:
    channel_id = conn.canvas_ids.get(canvas_id)
    return channel_id is None or not await _channel_archived(channel_id)


async def _relay_canvas_update(conn: Connection, event: dict) -> None:
    canvas_id, client_id = str(event.get("canvas_id", "")), _client_id(event)
    if canvas_id not in conn.canvas_ids or client_id is None:
        return
    data = canvas_collab.b64decode(event.get("update"), canvas_collab.MAX_UPDATE_BYTES)
    if data is None:
        await _canvas_error(conn, canvas_id, "invalid_update")
        return
    if not await allow_per_second(
        "canvas-update", conn.user_id, canvas_id, canvas_collab.UPDATES_PER_SECOND
    ):
        await _canvas_error(conn, canvas_id, "rate_limited")
        return
    if not await _canvas_writable(canvas_id, conn):
        await _canvas_error(conn, canvas_id, "read_only")
        return
    try:
        await canvas_collab.check_update(data)
        # Queued (durably, in Redis) before it is relayed, so a relayed update is never lost.
        await canvas_collab.enqueue_update(canvas_id, conn.user_id, data)
    except canvas_collab.InvalidUpdate:
        await _canvas_error(conn, canvas_id, "invalid_update")
        return
    except canvas_collab.CanvasTooLarge:
        await _canvas_error(conn, canvas_id, "too_large")
        return
    await publish_to_canvas(
        canvas_id,
        {
            "type": "canvas.update",
            "canvas_id": canvas_id,
            "client_id": client_id,
            "update": event["update"],
        },
        origin=conn.id,
    )


async def _relay_canvas_awareness(conn: Connection, event: dict) -> None:
    canvas_id, client_id = str(event.get("canvas_id", "")), _client_id(event)
    if canvas_id not in conn.canvas_ids or client_id is None:
        return
    if canvas_collab.b64decode(event.get("update"), canvas_collab.MAX_AWARENESS_BYTES) is None:
        return
    if not await allow_per_second(
        "canvas-awareness", conn.user_id, canvas_id, canvas_collab.AWARENESS_PER_SECOND
    ):
        return
    clients = conn.canvas_clients.setdefault(canvas_id, set())
    if len(clients) < 16:
        clients.add(client_id)
    await publish_to_canvas(
        canvas_id,
        {
            "type": "canvas.awareness",
            "canvas_id": canvas_id,
            "client_id": client_id,
            "update": event["update"],
        },
        origin=conn.id,
    )


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str | None = None) -> None:
    """Authenticate with `?token=` or, preferably (keeps the JWT out of access logs), connect
    without it and send `{"type": "auth", "token": "<jwt>"}` as the first frame.

    Client → server events:
        {"type": "auth", "token": "<jwt>"}         (first frame, or later to extend the session)
        {"type": "ping"}                           (every ~30s; keeps presence alive)
        {"type": "typing", "channel_id": "<uuid>"}
        {"type": "canvas.presence", "channel_id": "<uuid>"}   (viewing the canvas; 1 per 5 s)
        {"type": "subscribe" | "unsubscribe", "channel_id": "<uuid>"}
                                                   (watch a public channel without joining it)
        {"type": "whiteboard.ops", "channel_id", "client_id", "elements": [...]}
                                                   (changed Excalidraw elements, <= 300 per frame)
        {"type": "whiteboard.pointer", "channel_id", "client_id", "x", "y", "tool"?}
                                                   (cursor; tool "pointer" | "laser")
        {"type": "canvas.join" | "canvas.leave", "canvas_id"}
                                                   (collaborate on a canvas; access-checked,
                                                    answered with canvas.joined / canvas.error)
        {"type": "canvas.update", "canvas_id", "client_id", "update": <base64 Yjs update>}
                                                   (<= 512 KB decoded, <= 60/s; persisted
                                                    within 1 s and relayed to other sockets)
        {"type": "canvas.awareness", "canvas_id", "client_id", "update": <base64>}
                                                   (<= 32 KB, <= 20/s; relayed, not stored)
    Whiteboard frames are relayed (with the sender's `user_id`) to the channel topic only for
    channels this socket is subscribed to and that aren't archived, rate limited per user and
    channel. Frames over 256 KB are dropped (canvas.update: up to ~700 KB).
    Server → client events: message.created / message.updated / message.deleted,
        reaction.updated, typing, presence, channel.joined, channel.left, channel.created,
        channel.updated, channel.member_joined, channel.member_left, workspace.joined,
        user.updated, board.updated, canvas.updated, canvas.presence, huddle.updated,
        call.updated, call.notes_updated (channel topic), call.ringing, call.ring_stopped,
        call.invite_updated (per user), whiteboard.ops, whiteboard.pointer, whiteboard.saved,
        canvas.joined, canvas.left, canvas.error, canvas.update, canvas.awareness,
        canvas.peer_left, canvas.updated, canvas.deleted, canvas.access_changed,
        canvas.comments.updated (canvas topic), canvases.changed (workspace), resync (refetch: events may have been missed), pong.
    The server closes with 4001 when the token expires (reconnect with a fresh one) and
    4003 when the session is revoked.
    """
    if token is not None:
        claims = decode_access_token_claims(token)
        if not claims:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        await ws.accept()
    else:
        await ws.accept()
        try:
            first = await _receive(ws, AUTH_TIMEOUT_SECONDS)
        except (TimeoutError, WebSocketDisconnect):
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        claims = (
            decode_access_token_claims(str(first.get("token", "")))
            if first and first.get("type") == "auth"
            else None
        )
        if not claims:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return

    async with SessionLocal() as db:
        user = await db.get(User, claims.user_id)
        if not user or not user.is_active:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        channel_ids = {
            str(c)
            for c in await db.scalars(
                select(ChannelMember.channel_id).where(ChannelMember.user_id == user.id)
            )
        }
        memberships = (
            await db.execute(
                select(WorkspaceMember.workspace_id, WorkspaceMember.role).where(
                    WorkspaceMember.user_id == user.id
                )
            )
        ).all()
    workspace_ids = {str(w) for w, _ in memberships}
    guest_ids = {str(w) for w, role in memberships if role == WorkspaceRole.guest}

    conn = Connection(ws, user.id, channel_ids, workspace_ids, claims.expires_at, guest_ids)
    hub.register(conn)
    if await presence_connect(user.id, conn.id):
        await _broadcast_presence(conn, online=True)
    try:
        while True:
            left = _seconds_left(claims)
            if left <= 0:
                raise TimeoutError
            event = await _receive(ws, left)
            if event is None:
                continue
            match event.get("type"):
                case "ping":
                    if await presence_heartbeat(user.id, conn.id):
                        await _broadcast_presence(conn, online=True)
                    await ws.send_text(json.dumps({"type": "pong"}))
                case "auth":
                    # Token refresh on a live socket: same user only.
                    fresh = decode_access_token_claims(str(event.get("token", "")))
                    if fresh and fresh.user_id == claims.user_id:
                        claims = fresh
                        conn.expires_at = fresh.expires_at
                case "typing":
                    cid = str(event.get("channel_id", ""))
                    # Only channels the user is subscribed to, and throttled.
                    if cid in conn.channel_ids and await allow_typing(user.id, cid):
                        await publish_to_channel(
                            uuid.UUID(cid),
                            {"type": "typing", "channel_id": cid, "user_id": str(user.id)},
                        )
                case "canvas.presence":
                    cid = str(event.get("channel_id", ""))
                    if cid in conn.channel_ids and await allow_canvas_presence(user.id, cid):
                        await publish_to_channel(
                            uuid.UUID(cid),
                            {"type": "canvas.presence", "channel_id": cid, "user_id": str(user.id)},
                        )
                case "whiteboard.ops":
                    await _relay_whiteboard_ops(conn, event)
                case "whiteboard.pointer":
                    await _relay_whiteboard_pointer(conn, event)
                case "canvas.join":
                    await _join_canvas(conn, event)
                case "canvas.leave":
                    cid = str(event.get("canvas_id", ""))
                    if cid in conn.canvas_ids:
                        await _leave_canvas(conn, cid)
                case "canvas.update":
                    await _relay_canvas_update(conn, event)
                case "canvas.awareness":
                    await _relay_canvas_awareness(conn, event)
                case "subscribe":
                    cid = str(event.get("channel_id", ""))
                    if cid not in conn.channel_ids and await _can_peek(user.id, cid):
                        conn.peek_ids.add(cid)
                        hub.subscribe(conn, cid)
                case "unsubscribe":
                    cid = str(event.get("channel_id", ""))
                    if cid in conn.peek_ids:  # never drops channels the user is a member of
                        hub.unsubscribe(conn, cid)
    except TimeoutError:
        await conn.close(CLOSE_TOKEN_EXPIRED, "Token expired")
    except (WebSocketDisconnect, RuntimeError):  # RuntimeError: socket already closed by us
        pass
    finally:
        hub.unregister(conn)
        for cid in list(conn.canvas_ids):
            try:
                await _leave_canvas(conn, cid)
            except Exception:
                log.exception("Canvas %s cleanup failed", cid)
        if await presence_disconnect(user.id, conn.id):
            await _broadcast_presence(conn, online=False)
