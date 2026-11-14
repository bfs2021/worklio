"""Real-time fan-out.

Every API process keeps its own WebSocket connections in memory and subscribes
to Redis pub/sub. Publishing goes through Redis so a message posted on process A
reaches sockets held by process B. Redis is the *bus*, never the store.

Redis topics:
    rt:channel:<channel_id>  -> events for everyone subscribed to a channel
    rt:user:<user_id>        -> events for one user (e.g. "you joined/left a channel")
    rt:workspace:<ws_id>     -> workspace-wide events (presence, channel.created, user.updated,
                                huddle.updated for public channels)
    rt:canvas:<canvas_id>    -> collaborative canvas traffic (Yjs updates, awareness, comments)
                                for sockets that sent `canvas.join`. Payloads are wrapped as
                                {"origin": <connection id> | null, "event": {...}} so the
                                sending socket doesn't get its own updates echoed back.

Presence: `presence:conns:<user_id>` is a sorted set of the user's open connection ids,
scored by their last heartbeat. A user is online while at least one entry is fresher than
PRESENCE_TTL_SECONDS, so a crashed process or a throttled background tab can't pin anyone
online, and a missed heartbeat heals itself on the next one.
"""

import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime

from fastapi import WebSocket, WebSocketDisconnect

from app.core.redis import redis

log = logging.getLogger(__name__)

PRESENCE_TTL_SECONDS = 60
TYPING_THROTTLE_SECONDS = 3
CANVAS_PRESENCE_THROTTLE_SECONDS = 5
# Close codes the client reacts to by reconnecting with a fresh token.
CLOSE_TOKEN_EXPIRED = 4001
CLOSE_SESSION_REVOKED = 4003


def _channel_topic(channel_id: uuid.UUID | str) -> str:
    return f"rt:channel:{channel_id}"


def _user_topic(user_id: uuid.UUID | str) -> str:
    return f"rt:user:{user_id}"


def _workspace_topic(workspace_id: uuid.UUID | str) -> str:
    return f"rt:workspace:{workspace_id}"


def _canvas_topic(canvas_id: uuid.UUID | str) -> str:
    return f"rt:canvas:{canvas_id}"


async def publish_to_channel(channel_id: uuid.UUID | str, event: dict) -> None:
    await redis.publish(_channel_topic(channel_id), json.dumps(event))


async def notify_user(user_id: uuid.UUID | str, event: dict) -> None:
    await redis.publish(_user_topic(user_id), json.dumps(event))


async def publish_to_workspace(workspace_id: uuid.UUID | str, event: dict) -> None:
    await redis.publish(_workspace_topic(workspace_id), json.dumps(event))


async def publish_to_canvas(
    canvas_id: uuid.UUID | str, event: dict, origin: str | None = None
) -> None:
    """Send to every socket that joined the canvas, except connection `origin` (the sender)."""
    await redis.publish(_canvas_topic(canvas_id), json.dumps({"origin": origin, "event": event}))


async def revoke_sessions(user_id: uuid.UUID | str) -> None:
    """Close every open socket of a user (call after deactivating them or changing credentials)."""
    await notify_user(user_id, {"type": "session.revoked"})


def _presence_key(user_id: uuid.UUID | str) -> str:
    return f"presence:conns:{user_id}"


async def _touch_presence(user_id: uuid.UUID | str, conn_id: str) -> bool:
    """Mark the connection alive; True if the user had no live connection before (came online)."""
    key, now = _presence_key(user_id), time.time()
    async with redis.pipeline(transaction=True) as pipe:
        pipe.zremrangebyscore(key, "-inf", now - PRESENCE_TTL_SECONDS)
        pipe.zcard(key)
        pipe.zadd(key, {conn_id: now})
        pipe.expire(key, PRESENCE_TTL_SECONDS)
        _, live_before, _, _ = await pipe.execute()
    return live_before == 0


async def presence_connect(user_id: uuid.UUID | str, conn_id: str) -> bool:
    """Returns True if this is the user's first live socket (they just came online)."""
    return await _touch_presence(user_id, conn_id)


async def presence_heartbeat(user_id: uuid.UUID | str, conn_id: str) -> bool:
    """Refresh the connection. Returns True if the user had lapsed offline and is back."""
    return await _touch_presence(user_id, conn_id)


async def presence_disconnect(user_id: uuid.UUID | str, conn_id: str) -> bool:
    """Returns True if that was the user's last live socket (they just went offline)."""
    key, now = _presence_key(user_id), time.time()
    async with redis.pipeline(transaction=True) as pipe:
        pipe.zrem(key, conn_id)
        pipe.zremrangebyscore(key, "-inf", now - PRESENCE_TTL_SECONDS)
        pipe.zcard(key)
        _, _, live_after = await pipe.execute()
    return live_after == 0


async def online_user_ids(user_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    if not user_ids:
        return []
    cutoff = time.time() - PRESENCE_TTL_SECONDS
    async with redis.pipeline(transaction=False) as pipe:
        for u in user_ids:
            pipe.zcount(_presence_key(u), cutoff, "+inf")
        counts = await pipe.execute()
    return [u for u, n in zip(user_ids, counts, strict=True) if n]


async def allow_typing(user_id: uuid.UUID | str, channel_id: str) -> bool:
    """At most one typing broadcast per user per channel every few seconds (across processes)."""
    return bool(
        await redis.set(
            f"typing:{user_id}:{channel_id}", "1", nx=True, ex=TYPING_THROTTLE_SECONDS
        )
    )


async def allow_canvas_presence(user_id: uuid.UUID | str, channel_id: str) -> bool:
    """At most one canvas-presence broadcast per user per channel every few seconds."""
    return bool(
        await redis.set(
            f"canvas-presence:{user_id}:{channel_id}",
            "1",
            nx=True,
            ex=CANVAS_PRESENCE_THROTTLE_SECONDS,
        )
    )


async def allow_per_second(scope: str, user_id: uuid.UUID | str, channel_id: str, limit: int) -> bool:
    """Fixed one-second window: at most `limit` frames per user per channel (across processes)."""
    key = f"rl1s:{scope}:{user_id}:{channel_id}:{int(time.time())}"
    async with redis.pipeline(transaction=False) as pipe:
        count, _ = await pipe.incr(key).expire(key, 2).execute()
    return count <= limit


class Connection:
    def __init__(
        self,
        ws: WebSocket,
        user_id: uuid.UUID,
        channel_ids: set[str],
        workspace_ids: set[str],
        expires_at: datetime | None = None,
        guest_workspace_ids: set[str] | None = None,
    ):
        self.id = uuid.uuid4().hex
        self.ws = ws
        self.user_id = str(user_id)
        self.channel_ids = channel_ids
        self.workspace_ids = workspace_ids
        # Workspaces where this user is a guest (they don't get workspace-wide channel events).
        self.guest_workspace_ids = guest_workspace_ids or set()
        # Public channels being viewed without membership (WS "subscribe"); a subset of channel_ids.
        self.peek_ids: set[str] = set()
        # Joined canvases -> the channel they're tied to (None for workspace/private canvases).
        self.canvas_ids: dict[str, str | None] = {}
        # Awareness client ids seen per joined canvas (announced as gone when the socket leaves).
        self.canvas_clients: dict[str, set[str]] = {}
        self.expires_at = expires_at

    async def send(self, raw: str) -> None:
        try:
            await self.ws.send_text(raw)
        except (WebSocketDisconnect, RuntimeError):
            # Socket closed mid-send; the route's `finally` unregisters it.
            log.debug("Dropped event for closed socket (user %s)", self.user_id)

    async def close(self, code: int, reason: str = "") -> None:
        try:
            await self.ws.close(code=code, reason=reason)
        except (WebSocketDisconnect, RuntimeError):
            pass


def _discard(index: dict[str, set[Connection]], key: str, conn: Connection) -> None:
    """Remove conn from index[key] and drop the key once empty (no unbounded growth)."""
    conns = index.get(key)
    if conns is None:
        return
    conns.discard(conn)
    if not conns:
        del index[key]


class Hub:
    def __init__(self) -> None:
        self._by_channel: dict[str, set[Connection]] = defaultdict(set)
        self._by_user: dict[str, set[Connection]] = defaultdict(set)
        self._by_workspace: dict[str, set[Connection]] = defaultdict(set)
        self._by_canvas: dict[str, set[Connection]] = defaultdict(set)
        self._task: asyncio.Task | None = None

    def register(self, conn: Connection) -> None:
        self._by_user[conn.user_id].add(conn)
        for cid in conn.channel_ids:
            self._by_channel[cid].add(conn)
        for wid in conn.workspace_ids:
            self._by_workspace[wid].add(conn)

    def unregister(self, conn: Connection) -> None:
        _discard(self._by_user, conn.user_id, conn)
        for cid in conn.channel_ids:
            _discard(self._by_channel, cid, conn)
        for wid in conn.workspace_ids:
            _discard(self._by_workspace, wid, conn)
        for canvas_id in conn.canvas_ids:
            _discard(self._by_canvas, canvas_id, conn)

    def subscribe(self, conn: Connection, channel_id: str) -> None:
        conn.channel_ids.add(channel_id)
        self._by_channel[channel_id].add(conn)

    def unsubscribe(self, conn: Connection, channel_id: str) -> None:
        conn.channel_ids.discard(channel_id)
        conn.peek_ids.discard(channel_id)
        _discard(self._by_channel, channel_id, conn)

    def subscribe_canvas(self, conn: Connection, canvas_id: str, channel_id: str | None) -> None:
        conn.canvas_ids[canvas_id] = channel_id
        self._by_canvas[canvas_id].add(conn)

    def unsubscribe_canvas(self, conn: Connection, canvas_id: str) -> None:
        conn.canvas_ids.pop(canvas_id, None)
        conn.canvas_clients.pop(canvas_id, None)
        _discard(self._by_canvas, canvas_id, conn)

    async def _drop_canvases(self, conn: Connection, canvas_ids: list[str], reason: str) -> None:
        """Unsubscribe and tell the client (it may `canvas.join` again to re-check access)."""
        for canvas_id in canvas_ids:
            self.unsubscribe_canvas(conn, canvas_id)
            await conn.send(json.dumps({"type": "canvas.left", "canvas_id": canvas_id, "reason": reason}))

    def subscribe_workspace(self, conn: Connection, workspace_id: str) -> None:
        conn.workspace_ids.add(workspace_id)
        self._by_workspace[workspace_id].add(conn)

    def connections(self) -> list[Connection]:
        return [c for conns in self._by_user.values() for c in conns]

    async def start(self) -> None:
        self._task = asyncio.create_task(self._listen())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _listen(self) -> None:
        reconnecting = False
        while True:
            try:
                pubsub = redis.pubsub()
                await pubsub.psubscribe("rt:*")
                if reconnecting:
                    # Events published while we were disconnected are gone; have clients refetch.
                    await self._broadcast_local({"type": "resync"})
                    reconnecting = False
                async for item in pubsub.listen():
                    if item["type"] == "pmessage":
                        try:
                            await self._dispatch(item["channel"], item["data"])
                        except Exception:
                            log.exception("Failed to dispatch event on %s", item["channel"])
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Redis pub/sub listener crashed; reconnecting")
                reconnecting = True
                await asyncio.sleep(1)

    async def _broadcast_local(self, event: dict) -> None:
        raw = json.dumps(event)
        await asyncio.gather(*(c.send(raw) for c in self.connections()))

    async def _dispatch(self, topic: str, raw: str) -> None:
        _, kind, ident = topic.split(":", 2)
        if kind == "canvas":
            await self._dispatch_canvas(ident, raw)
            return
        if kind == "channel":
            targets = list(self._by_channel.get(ident, ()))
        elif kind == "workspace":
            targets = list(self._by_workspace.get(ident, ()))
            event = json.loads(raw)
            match event.get("type"):
                case "channel.created":
                    # Guests only learn about channels they're added to.
                    targets = [c for c in targets if ident not in c.guest_workspace_ids]
                case "huddle.updated":
                    # ...and only about huddles in channels they're in.
                    targets = [
                        c
                        for c in targets
                        if ident not in c.guest_workspace_ids or event["channel_id"] in c.channel_ids
                    ]
                case "user.updated":
                    # Guests never see other people's email addresses.
                    guests = [
                        c
                        for c in targets
                        if ident in c.guest_workspace_ids and c.user_id != event["user"]["user_id"]
                    ]
                    if guests:
                        hidden = json.dumps({**event, "user": {**event["user"], "email": None}})
                        await asyncio.gather(*(c.send(hidden) for c in guests))
                        targets = [c for c in targets if c not in guests]
        else:  # user
            targets = list(self._by_user.get(ident, ()))
            event = json.loads(raw)
            match event.get("type"):
                case "channel.joined":
                    for conn in targets:
                        conn.peek_ids.discard(event["channel_id"])
                        self.subscribe(conn, event["channel_id"])
                case "channel.left":
                    for conn in targets:
                        self.unsubscribe(conn, event["channel_id"])
                        tied = [k for k, ch in conn.canvas_ids.items() if ch == event["channel_id"]]
                        await self._drop_canvases(conn, tied, "channel_left")
                case "canvas.access_revoked":
                    for conn in targets:
                        if event["canvas_id"] in conn.canvas_ids:
                            await self._drop_canvases(conn, [event["canvas_id"]], "access_revoked")
                    return
                case "workspace.joined":
                    for conn in targets:
                        self.subscribe_workspace(conn, event["workspace_id"])
                case "session.revoked":
                    await asyncio.gather(
                        *(c.close(CLOSE_SESSION_REVOKED, "Session revoked") for c in targets)
                    )
                    return
        await asyncio.gather(*(c.send(raw) for c in targets))

    async def _dispatch_canvas(self, canvas_id: str, raw: str) -> None:
        wrapped = json.loads(raw)
        origin, event = wrapped.get("origin"), wrapped["event"]
        conns = list(self._by_canvas.get(canvas_id, ()))
        out = json.dumps(event)
        await asyncio.gather(*(c.send(out) for c in conns if c.id != origin))
        if event.get("type") in ("canvas.deleted", "canvas.access_changed"):
            # Everyone re-joins (re-checking access) or closes the canvas.
            for conn in conns:
                self.unsubscribe_canvas(conn, canvas_id)


hub = Hub()
