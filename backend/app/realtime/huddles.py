"""Huddle (LiveKit call) participant tracking in Redis.

Keys:
    huddle:<channel_id>          sorted set of user ids, scored by their last heartbeat
    huddle:<channel_id>:started  ISO timestamp of when the huddle started
    huddles:active               hash channel_id -> "<workspace_id>:<public|private>"

A participant who misses heartbeats for PARTICIPANT_TTL_SECONDS is pruned. Pruning happens on
every read/write and from `sweep()`, which the API runs periodically so stale huddles end
even when nobody touches them.

Listeners registered with `add_listener` (the call service) run after every announced change
in the participant set, so call state follows who is actually in the room.

Changes are announced as `{"type": "huddle.updated", channel_id, participant_ids, started_at}`:
on the workspace topic for public channels (the hub hides it from guests who aren't in the
channel) and on the channel topic for private channels and DMs, so their huddles never leak.
"""

import asyncio
import logging
import time
import uuid
import warnings
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
import jwt.warnings

from app.core.config import settings
from app.core.redis import redis
from app.realtime.hub import publish_to_channel, publish_to_workspace

log = logging.getLogger(__name__)

PARTICIPANT_TTL_SECONDS = 60
SWEEP_INTERVAL_SECONDS = 15
ACTIVE_KEY = "huddles:active"
SWEEP_LOCK_KEY = "huddles:sweep-lock"


def room_name(channel_id: uuid.UUID | str) -> str:
    return f"huddle-{channel_id}"


def _key(channel_id: uuid.UUID | str) -> str:
    return f"huddle:{channel_id}"


def _started_key(channel_id: uuid.UUID | str) -> str:
    return f"huddle:{channel_id}:started"


@dataclass(frozen=True)
class HuddleState:
    channel_id: str
    participant_ids: list[str]
    started_at: str | None

    def event(self) -> dict:
        return {
            "type": "huddle.updated",
            "channel_id": self.channel_id,
            "participant_ids": self.participant_ids,
            "started_at": self.started_at,
        }


def livekit_token(channel_id: uuid.UUID, user_id: uuid.UUID, name: str) -> str:
    """A LiveKit access token (HS256 JWT signed with the API secret) for the channel's room."""
    now = datetime.now(UTC)
    claims = {
        "iss": settings.livekit_api_key,
        "sub": str(user_id),
        "name": name,
        "nbf": int(now.timestamp()),
        "exp": int((now + timedelta(hours=settings.huddle_token_ttl_hours)).timestamp()),
        "video": {
            "room": room_name(channel_id),
            "roomJoin": True,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
        },
    }
    with warnings.catch_warnings():
        # LiveKit's dev secret ("secret") is short; production secrets are long and random.
        warnings.simplefilter("ignore", jwt.warnings.InsecureKeyLengthWarning)
        return jwt.encode(claims, settings.livekit_api_secret, algorithm="HS256")


async def _state(channel_id: str, *, prune: bool = True) -> HuddleState:
    key, now = _key(channel_id), time.time()
    async with redis.pipeline(transaction=True) as pipe:
        if prune:
            pipe.zremrangebyscore(key, "-inf", now - PARTICIPANT_TTL_SECONDS)
        pipe.zrange(key, 0, -1)
        pipe.get(_started_key(channel_id))
        *_, members, started = await pipe.execute()
    if not members:
        return HuddleState(channel_id, [], None)
    return HuddleState(channel_id, sorted(members), started)


async def _finish_if_empty(state: HuddleState) -> None:
    if not state.participant_ids:
        async with redis.pipeline(transaction=True) as pipe:
            pipe.delete(_started_key(state.channel_id), _key(state.channel_id))
            pipe.hdel(ACTIVE_KEY, state.channel_id)
            await pipe.execute()


Listener = Callable[[str], Awaitable[None]]
_listeners: list[Listener] = []


def add_listener(fn: Listener) -> None:
    """Call `fn(channel_id)` after every announced participant change (idempotent)."""
    if fn not in _listeners:
        _listeners.append(fn)


async def _publish(state: HuddleState, workspace_id: str, public: bool) -> None:
    if public:
        await publish_to_workspace(workspace_id, state.event())
    else:
        await publish_to_channel(state.channel_id, state.event())


async def _announce(state: HuddleState, workspace_id: str, public: bool) -> None:
    await _publish(state, workspace_id, public)
    for fn in _listeners:
        try:
            await fn(state.channel_id)
        except Exception:
            log.exception("Huddle listener failed for channel %s", state.channel_id)


async def participant_ids(channel_id: uuid.UUID | str) -> list[str]:
    """Who is in the room right now (no pruning, no announcements)."""
    return (await _state(str(channel_id), prune=False)).participant_ids


async def remove(channel_id: uuid.UUID | str, user_ids: list[uuid.UUID | str]) -> HuddleState:
    """Drop users from the room without notifying listeners (used when a call is ended)."""
    cid = str(channel_id)
    scope = await _scope(cid)
    before = await _state(cid, prune=False)
    if user_ids:
        await redis.zrem(_key(cid), *[str(u) for u in user_ids])
    state = await _state(cid)
    await _finish_if_empty(state)
    if scope and state.participant_ids != before.participant_ids:
        await _publish(state, *scope)
    return state


async def _scope(channel_id: str) -> tuple[str, bool] | None:
    raw = await redis.hget(ACTIVE_KEY, channel_id)
    if not raw:
        return None
    workspace_id, kind = raw.split(":", 1)
    return workspace_id, kind == "public"


async def join(
    channel_id: uuid.UUID, workspace_id: uuid.UUID, public: bool, user_id: uuid.UUID
) -> HuddleState:
    cid, uid = str(channel_id), str(user_id)
    before = await _state(cid)
    now = time.time()
    async with redis.pipeline(transaction=True) as pipe:
        pipe.zadd(_key(cid), {uid: now})
        pipe.set(_started_key(cid), datetime.now(UTC).isoformat(), nx=True)
        pipe.hset(ACTIVE_KEY, cid, f"{workspace_id}:{'public' if public else 'private'}")
        await pipe.execute()
    after = await _state(cid, prune=False)
    if after.participant_ids != before.participant_ids:
        await _announce(after, str(workspace_id), public)
    return after


async def heartbeat(
    channel_id: uuid.UUID, workspace_id: uuid.UUID, public: bool, user_id: uuid.UUID
) -> HuddleState:
    """Keep the user in the huddle (re-adding them if they had lapsed)."""
    return await join(channel_id, workspace_id, public, user_id)


async def leave(channel_id: uuid.UUID, user_id: uuid.UUID) -> HuddleState:
    cid = str(channel_id)
    scope = await _scope(cid)
    before = await _state(cid, prune=False)
    await redis.zrem(_key(cid), str(user_id))
    state = await _state(cid)
    await _finish_if_empty(state)
    if scope and state.participant_ids != before.participant_ids:
        await _announce(state, *scope)
    return state


async def active_in_workspace(workspace_id: uuid.UUID) -> list[HuddleState]:
    """Live huddles in a workspace (stale participants pruned, ended huddles announced)."""
    out = []
    for cid, raw in (await redis.hgetall(ACTIVE_KEY)).items():
        ws_id, kind = raw.split(":", 1)
        if ws_id != str(workspace_id):
            continue
        state = await _prune_and_announce(cid, ws_id, kind == "public")
        if state.participant_ids:
            out.append(state)
    return out


async def _prune_and_announce(cid: str, workspace_id: str, public: bool) -> HuddleState:
    before = await _state(cid, prune=False)
    state = await _state(cid)
    await _finish_if_empty(state)
    if state.participant_ids != before.participant_ids:
        await _announce(state, workspace_id, public)
    return state


async def sweep() -> None:
    """Prune every active huddle once (one API process at a time)."""
    if not await redis.set(SWEEP_LOCK_KEY, "1", nx=True, ex=SWEEP_INTERVAL_SECONDS - 1):
        return
    for cid, raw in (await redis.hgetall(ACTIVE_KEY)).items():
        ws_id, kind = raw.split(":", 1)
        await _prune_and_announce(cid, ws_id, kind == "public")


async def run_sweeper() -> None:
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
        try:
            await sweep()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Huddle sweep failed")
