"""Security/robustness fixes: DM squatting, races, uploads, guests, archived channels,
validation, auth hardening, realtime hub and WebSocket behaviour."""

import asyncio
import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from sqlalchemy import select, update

from app.api.routes import channels as channel_routes
from app.api.routes import messages as message_routes
from app.core import storage
from app.core.config import Settings, settings
from app.core.db import SessionLocal
from app.core.security import ALGORITHM
from app.models import Attachment, Channel, ChannelKind, User
from app.realtime import hub as hub_module
from app.realtime import routes as ws_routes
from app.workers.tasks import purge_orphaned_uploads
from tests.conftest import register


def _dm_name(*user_ids: str) -> str:
    digest = hashlib.sha1(",".join(sorted(user_ids)).encode()).hexdigest()
    return f"dm-{digest[:24]}"


class Recorder:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    async def __call__(self, target, event):
        self.events.append((str(target), event))

    def types(self) -> list[str]:
        return [e["type"] for _, e in self.events]


# --- DMs ------------------------------------------------------------------------------------


async def test_channel_names_cannot_use_dm_prefix(client, team):
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/channels",
        json={"name": _dm_name(team["alice"]["id"], team["bob"]["id"])},
        headers=team["carol"]["headers"],
    )
    assert r.status_code == 422


async def test_open_dm_never_returns_a_squatted_non_dm_channel(client, team):
    alice, bob, carol, ws = team["alice"], team["bob"], team["carol"], team["ws"]
    # A legacy public channel already holding the DM's deterministic name.
    async with SessionLocal() as db:
        db.add(
            Channel(
                workspace_id=uuid.UUID(ws["id"]),
                name=_dm_name(alice["id"], bob["id"]),
                kind=ChannelKind.public,
                created_by=uuid.UUID(carol["id"]),
            )
        )
        await db.commit()
    r = await client.post(f"/workspaces/{ws['id']}/dms", json={"user_ids": [bob["id"]]}, headers=alice["headers"])
    assert r.status_code == 409


async def test_concurrent_dm_open_returns_one_dm(client, team):
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    url = f"/workspaces/{ws['id']}/dms"
    rs = await asyncio.gather(
        *(
            client.post(url, json={"user_ids": [other["id"]]}, headers=me["headers"])
            for me, other in [(alice, bob), (bob, alice)] * 3
        )
    )
    assert [r.status_code for r in rs] == [200] * 6
    assert len({r.json()["id"] for r in rs}) == 1
    assert sorted(rs[0].json()["member_ids"]) == sorted([alice["id"], bob["id"]])


# --- Races ----------------------------------------------------------------------------------


async def test_concurrent_reactions_and_joins_never_500(client, team):
    alice, bob, ws, general = team["alice"], team["bob"], team["ws"], team["general"]
    msg = (await client.post(f"/channels/{general['id']}/messages", json={"body": "x"}, headers=alice["headers"])).json()
    rs = await asyncio.gather(
        *(client.post(f"/messages/{msg['id']}/reactions", json={"emoji": "🎉"}, headers=bob["headers"]) for _ in range(6))
    )
    assert all(r.status_code == 200 for r in rs), [r.status_code for r in rs]

    ch = (await client.post(f"/workspaces/{ws['id']}/channels", json={"name": f"r-{uuid.uuid4().hex[:6]}"}, headers=alice["headers"])).json()
    rs = await asyncio.gather(*(client.post(f"/channels/{ch['id']}/join", headers=bob["headers"]) for _ in range(6)))
    assert all(r.status_code == 200 for r in rs), [r.status_code for r in rs]
    members = (await client.get(f"/channels/{ch['id']}/members", headers=bob["headers"])).json()
    assert members.count(bob["id"]) == 1


async def test_concurrent_register_same_email(client):
    email = f"race-{uuid.uuid4().hex[:8]}@example.com"
    body = {"email": email, "full_name": "Race", "password": "password123"}
    rs = await asyncio.gather(*(client.post("/auth/register", json=body) for _ in range(4)))
    codes = sorted(r.status_code for r in rs)
    assert codes == [201, 409, 409, 409]


# --- Leaving / realtime events ---------------------------------------------------------------


async def test_leave_unsubscribes_and_broadcasts(client, team, monkeypatch):
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    users, chans = Recorder(), Recorder()
    monkeypatch.setattr(channel_routes, "notify_user", users)
    monkeypatch.setattr(channel_routes, "publish_to_channel", chans)
    ch = (
        await client.post(
            f"/workspaces/{ws['id']}/channels",
            json={"name": f"p-{uuid.uuid4().hex[:6]}", "kind": "private", "member_ids": [bob["id"]]},
            headers=alice["headers"],
        )
    ).json()
    assert (await client.delete(f"/channels/{ch['id']}/members/me", headers=bob["headers"])).status_code == 204
    assert (bob["id"], {"type": "channel.left", "channel_id": ch["id"]}) in users.events
    assert (ch["id"], {"type": "channel.member_left", "channel_id": ch["id"], "user_id": bob["id"]}) in chans.events

    # Last member out of a private channel archives it.
    assert (await client.delete(f"/channels/{ch['id']}/members/me", headers=alice["headers"])).status_code == 204
    async with SessionLocal() as db:
        assert (await db.get(Channel, uuid.UUID(ch["id"]))).is_archived


async def test_public_channel_created_and_join_events(client, team, monkeypatch):
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    wss, chans = Recorder(), Recorder()
    monkeypatch.setattr(channel_routes, "publish_to_workspace", wss)
    monkeypatch.setattr(channel_routes, "publish_to_channel", chans)
    ch = (await client.post(f"/workspaces/{ws['id']}/channels", json={"name": f"pub-{uuid.uuid4().hex[:6]}"}, headers=alice["headers"])).json()
    target, event = wss.events[0]
    assert target == ws["id"] and event["type"] == "channel.created"
    assert event["channel"]["id"] == ch["id"] and event["channel"]["is_member"] is False

    await client.post(f"/channels/{ch['id']}/join", headers=bob["headers"])
    assert (ch["id"], {"type": "channel.member_joined", "channel_id": ch["id"], "user_id": bob["id"]}) in chans.events

    # Private channels are not announced.
    wss.events.clear()
    await client.post(f"/workspaces/{ws['id']}/channels", json={"name": f"priv-{uuid.uuid4().hex[:6]}", "kind": "private"}, headers=alice["headers"])
    assert wss.events == []


async def test_posting_in_unjoined_public_channel_auto_joins(client, team):
    alice, carol, ws = team["alice"], team["carol"], team["ws"]
    ch = (await client.post(f"/workspaces/{ws['id']}/channels", json={"name": f"aj-{uuid.uuid4().hex[:6]}"}, headers=alice["headers"])).json()
    r = await client.post(f"/channels/{ch['id']}/messages", json={"body": "hi"}, headers=carol["headers"])
    assert r.status_code == 201
    assert carol["id"] in (await client.get(f"/channels/{ch['id']}/members", headers=carol["headers"])).json()


# --- Uploads / storage ------------------------------------------------------------------------


def test_presigned_urls_only_inline_safe_types():
    def params(url):
        return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}

    html = params(storage.presigned_get("k", "x.html", "text/html"))
    assert html["response-content-disposition"].startswith("attachment")
    assert html["response-content-type"] == "application/octet-stream"
    svg = params(storage.presigned_get("k", "x.svg", "image/svg+xml"))
    assert svg["response-content-disposition"].startswith("attachment")
    png = params(storage.presigned_get("k", "x.png", "image/png"))
    assert png["response-content-disposition"].startswith("inline")
    assert png["response-content-type"] == "image/png"


def test_normalize_content_type():
    assert storage.normalize_content_type("Text/Plain; charset=UTF-8") == "text/plain"
    assert storage.normalize_content_type("x" * 300) == "application/octet-stream"
    assert storage.normalize_content_type("not a type") == "application/octet-stream"
    assert storage.normalize_content_type(None) == "application/octet-stream"


async def test_upload_html_is_download_only_and_long_type_is_normalised(client, team):
    ws, alice = team["ws"], team["alice"]
    r = await client.post(
        f"/workspaces/{ws['id']}/uploads",
        files={"file": ("x.html", b"<script>alert(1)</script>", "text/html")},
        headers=alice["headers"],
    )
    assert r.status_code == 201
    assert "attachment" in parse_qs(urlparse(r.json()["url"]).query)["response-content-disposition"][0]

    r = await client.post(
        f"/workspaces/{ws['id']}/uploads",
        files={"file": ("y.bin", b"data", "a/" + "b" * 300)},
        headers=alice["headers"],
    )
    assert r.status_code == 201, r.text
    assert r.json()["content_type"] == "application/octet-stream"


async def test_oversized_upload_rejected_before_reading(client, team, monkeypatch):
    monkeypatch.setattr(settings, "max_upload_bytes", 1024)
    monkeypatch.setattr(settings, "max_recording_bytes", 1024)
    monkeypatch.setattr("app.api.routes.uploads.MULTIPART_OVERHEAD_BYTES", 0)
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/uploads",
        files={"file": ("big.txt", b"x" * 5000, "text/plain")},
        headers=team["alice"]["headers"],
    )
    assert r.status_code == 413
    assert r.json()["detail"].startswith("File too large (max ")


async def test_orphaned_uploads_are_purged(client, team):
    ws, alice = team["ws"], team["alice"]
    att = (
        await client.post(f"/workspaces/{ws['id']}/uploads", files={"file": ("o.txt", b"o", "text/plain")}, headers=alice["headers"])
    ).json()
    kept = (
        await client.post(f"/workspaces/{ws['id']}/uploads", files={"file": ("k.txt", b"k", "text/plain")}, headers=alice["headers"])
    ).json()
    await client.post(f"/channels/{team['general']['id']}/messages", json={"attachment_ids": [kept["id"]]}, headers=alice["headers"])
    async with SessionLocal() as db:
        old = datetime.now(UTC) - timedelta(days=2)
        await db.execute(update(Attachment).where(Attachment.id.in_([att["id"], kept["id"]])).values(created_at=old))
        await db.commit()
        await purge_orphaned_uploads(db, datetime.now(UTC) - timedelta(hours=24))
        remaining = set(await db.scalars(select(Attachment.id).where(Attachment.id.in_([att["id"], kept["id"]]))))
    assert remaining == {uuid.UUID(kept["id"])}


# --- Guests & archived channels ------------------------------------------------------------------


async def test_guests_are_restricted(client, team):
    alice, bob, ws, general = team["alice"], team["bob"], team["ws"], team["general"]
    guest = await register(client, "guest")
    r = await client.post(f"/workspaces/{ws['id']}/members", json={"email": guest["email"], "role": "guest"}, headers=alice["headers"])
    assert r.status_code == 201
    word = f"walrus{uuid.uuid4().hex[:6]}"
    pub = (await client.post(f"/workspaces/{ws['id']}/channels", json={"name": f"g-{uuid.uuid4().hex[:6]}"}, headers=alice["headers"])).json()
    await client.post(f"/channels/{pub['id']}/messages", json={"body": word}, headers=alice["headers"])

    gh = guest["headers"]
    assert (await client.post(f"/workspaces/{ws['id']}/channels", json={"name": "nope"}, headers=gh)).status_code == 403
    assert (await client.get(f"/channels/{pub['id']}", headers=gh)).status_code == 404
    assert (await client.post(f"/channels/{pub['id']}/join", headers=gh)).status_code == 404
    listed = {c["id"] for c in (await client.get(f"/workspaces/{ws['id']}/channels", headers=gh)).json()}
    assert pub["id"] not in listed and general["id"] in listed
    assert (await client.get(f"/workspaces/{ws['id']}/search", params={"q": word}, headers=gh)).json() == []
    members = (await client.get(f"/workspaces/{ws['id']}/members", headers=gh)).json()
    assert {m["email"] for m in members if m["user_id"] != guest["id"]} == {None}
    # Guests can't add people to channels, but can DM people they share #general with.
    assert (await client.post(f"/channels/{general['id']}/members", json={"user_id": bob["id"]}, headers=gh)).status_code == 403
    assert (await client.post(f"/workspaces/{ws['id']}/dms", json={"user_ids": [bob["id"]]}, headers=gh)).status_code == 200


async def test_archived_channel_is_read_only(client, team):
    alice, ws = team["alice"], team["ws"]
    ch = (await client.post(f"/workspaces/{ws['id']}/channels", json={"name": f"a-{uuid.uuid4().hex[:6]}"}, headers=alice["headers"])).json()
    msg = (await client.post(f"/channels/{ch['id']}/messages", json={"body": "before"}, headers=alice["headers"])).json()
    async with SessionLocal() as db:
        await db.execute(update(Channel).where(Channel.id == uuid.UUID(ch["id"])).values(is_archived=True))
        await db.commit()
    h = alice["headers"]
    assert (await client.post(f"/channels/{ch['id']}/messages", json={"body": "x"}, headers=h)).status_code == 403
    assert (await client.post(f"/messages/{msg['id']}/reactions", json={"emoji": "👍"}, headers=h)).status_code == 403
    assert (await client.patch(f"/channels/{ch['id']}", json={"topic": "t"}, headers=h)).status_code == 403
    assert (await client.patch(f"/messages/{msg['id']}", json={"body": "y"}, headers=h)).status_code == 403
    assert (await client.get(f"/channels/{ch['id']}/messages", headers=h)).status_code == 200


# --- Validation ------------------------------------------------------------------------------


async def test_input_validation(client, team):
    alice, ws, general = team["alice"], team["ws"], team["general"]
    h = alice["headers"]
    assert (await client.patch("/auth/me", json={"full_name": "   "}, headers=h)).status_code == 422
    assert (await client.post("/workspaces", json={"name": "  ", "slug": f"s-{uuid.uuid4().hex[:6]}"}, headers=h)).status_code == 422
    r = await client.post(f"/workspaces/{ws['id']}/channels", json={"name": "long-topic", "topic": "x" * 5000}, headers=h)
    assert r.status_code == 422
    r = await client.post(f"/workspaces/{ws['id']}/channels", json={"name": "many", "member_ids": [str(uuid.uuid4())] * 101}, headers=h)
    assert r.status_code == 422

    msg = (await client.post(f"/channels/{general['id']}/messages", json={"body": "hi"}, headers=h)).json()
    assert (await client.patch(f"/messages/{msg['id']}", json={"body": "   "}, headers=h)).status_code == 422
    r = await client.patch(f"/messages/{msg['id']}", json={"body": "  edited  "}, headers=h)
    assert r.json()["body"] == "edited"

    url = f"/messages/{msg['id']}/reactions"
    for bad in ("hello world", "<script>", "abc😀def!"):
        assert (await client.post(url, json={"emoji": bad}, headers=h)).status_code == 422, bad
    for good in ("👍", "❤️", "👍🏽", "🇵🇰", "1️⃣", "thumbsup"):
        assert (await client.post(url, json={"emoji": good}, headers=h)).status_code == 200, good


async def test_reaction_kinds_are_capped(client, team, monkeypatch):
    monkeypatch.setattr(message_routes, "MAX_REACTION_KINDS_PER_MESSAGE", 2)
    alice, general = team["alice"], team["general"]
    msg = (await client.post(f"/channels/{general['id']}/messages", json={"body": "cap"}, headers=alice["headers"])).json()
    url = f"/messages/{msg['id']}/reactions"
    for e in ("👍", "🎉"):
        assert (await client.post(url, json={"emoji": e}, headers=alice["headers"])).status_code == 200
    assert (await client.post(url, json={"emoji": "🔥"}, headers=alice["headers"])).status_code == 400
    # Joining an existing reaction is still fine.
    assert (await client.post(url, json={"emoji": "👍"}, headers=team["bob"]["headers"])).status_code == 200


# --- Threads, search, mentions -----------------------------------------------------------------


async def test_deleted_parent_blocks_replies_and_hides_them(client, team):
    alice, bob, ws, general = team["alice"], team["bob"], team["ws"], team["general"]
    word = f"orca{uuid.uuid4().hex[:6]}"
    parent = (await client.post(f"/channels/{general['id']}/messages", json={"body": "root"}, headers=alice["headers"])).json()
    await client.post(
        f"/channels/{general['id']}/messages",
        json={"body": f"{word} <@{bob['id']}>", "parent_id": parent["id"]},
        headers=alice["headers"],
    )
    search = f"/workspaces/{ws['id']}/search"
    assert len((await client.get(search, params={"q": word}, headers=bob["headers"])).json()) == 1
    assert (await client.delete(f"/messages/{parent['id']}", headers=alice["headers"])).status_code == 204

    r = await client.post(f"/channels/{general['id']}/messages", json={"body": "late", "parent_id": parent["id"]}, headers=bob["headers"])
    assert r.status_code == 400
    assert (await client.get(search, params={"q": word}, headers=bob["headers"])).json() == []
    mentions = (await client.get(f"/workspaces/{ws['id']}/mentions", headers=bob["headers"])).json()
    assert all(word not in m["body"] for m in mentions)


async def test_mentions_follow_edits(client, team):
    alice, bob, ws, general = team["alice"], team["bob"], team["ws"], team["general"]
    url = f"/workspaces/{ws['id']}/mentions"
    msg = (await client.post(f"/channels/{general['id']}/messages", json={"body": f"hey <@{bob['id']}>"}, headers=alice["headers"])).json()
    assert msg["id"] in [m["id"] for m in (await client.get(url, headers=bob["headers"])).json()]
    await client.patch(f"/messages/{msg['id']}", json={"body": "never mind"}, headers=alice["headers"])
    assert msg["id"] not in [m["id"] for m in (await client.get(url, headers=bob["headers"])).json()]


# --- Auth -------------------------------------------------------------------------------------


def test_settings_refuse_default_secret_outside_development():
    with pytest.raises(ValueError):
        Settings(environment="production", secret_key="change-me")
    with pytest.raises(ValueError):
        Settings(environment="production", secret_key="short")
    lk = {"livekit_api_key": "prod-key", "livekit_api_secret": "y" * 40}
    assert Settings(environment="production", secret_key="x" * 40, **lk).secret_key == "x" * 40
    assert Settings(environment="development", secret_key="change-me")


def test_settings_refuse_livekit_dev_keys_outside_development():
    with pytest.raises(ValueError):
        Settings(environment="production", secret_key="x" * 40)  # devkey / secret defaults
    assert Settings(environment="development", secret_key="change-me").livekit_api_key == "devkey"


async def test_login_hardening(client, monkeypatch):
    u = await register(client, "login")
    ok = {"email": u["email"], "password": "password123"}
    assert (await client.post("/auth/login", json=ok)).status_code == 200
    assert (await client.post("/auth/login", json={**ok, "password": "x" * 129})).status_code == 422

    async with SessionLocal() as db:
        await db.execute(update(User).where(User.id == uuid.UUID(u["id"])).values(is_active=False))
        await db.commit()
    assert (await client.post("/auth/login", json=ok)).status_code == 401

    monkeypatch.setattr(settings, "login_rate_limit_per_email", 2)
    email = f"nobody-{uuid.uuid4().hex[:8]}@example.com"
    codes = [(await client.post("/auth/login", json={"email": email, "password": "wrongpass"})).status_code for _ in range(3)]
    assert codes == [401, 401, 429]


# --- Realtime hub ----------------------------------------------------------------------------------


class FakeWS:
    def __init__(self, frames=()):
        self.frames: asyncio.Queue = asyncio.Queue()
        for f in frames:
            self.frames.put_nowait(f)
        self.sent: list[dict] = []
        self.closed: int | None = None
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def receive(self):
        return await self.frames.get()

    async def send_text(self, raw):
        self.sent.append(json.loads(raw))

    async def close(self, code=1000, reason=""):
        self.closed = code
        self.frames.put_nowait({"type": "websocket.disconnect", "code": code})


def _token(user_id: str, seconds: float) -> str:
    exp = datetime.now(UTC) + timedelta(seconds=seconds)
    return jwt.encode({"sub": user_id, "exp": exp}, settings.secret_key, ALGORITHM)


async def test_hub_unsubscribe_and_cleanup():
    h = hub_module.Hub()
    conn = hub_module.Connection(FakeWS(), uuid.uuid4(), {"c1"}, {"w1"})
    h.register(conn)
    await h._dispatch(f"rt:user:{conn.user_id}", json.dumps({"type": "channel.left", "channel_id": "c1"}))
    assert "c1" not in conn.channel_ids and "c1" not in h._by_channel
    assert conn.ws.sent == [{"type": "channel.left", "channel_id": "c1"}]
    h.unregister(conn)
    assert not h._by_channel and not h._by_user and not h._by_workspace

    conn2 = hub_module.Connection(FakeWS(), uuid.uuid4(), set(), set())
    h.register(conn2)
    await h._broadcast_local({"type": "resync"})
    assert conn2.ws.sent == [{"type": "resync"}]
    await h._dispatch(f"rt:user:{conn2.user_id}", json.dumps({"type": "session.revoked"}))
    assert conn2.ws.closed == hub_module.CLOSE_SESSION_REVOKED


async def test_presence_tracks_connections():
    user = uuid.uuid4()
    assert await hub_module.presence_connect(user, "a") is True
    assert await hub_module.presence_connect(user, "b") is False
    assert await hub_module.presence_disconnect(user, "a") is False
    assert await hub_module.online_user_ids([user]) == [user]
    # The key lapsing (missed heartbeats) heals on the next heartbeat.
    await hub_module.redis.delete(hub_module._presence_key(user))
    assert await hub_module.online_user_ids([user]) == []
    assert await hub_module.presence_heartbeat(user, "b") is True
    assert await hub_module.presence_disconnect(user, "b") is True
    assert await hub_module.presence_disconnect(user, "b") is True  # never goes negative
    assert await hub_module.online_user_ids([user]) == []


async def test_typing_is_throttled():
    user, cid = uuid.uuid4(), str(uuid.uuid4())
    assert await hub_module.allow_typing(user, cid) is True
    assert await hub_module.allow_typing(user, cid) is False


async def test_websocket_ignores_junk_and_closes_on_expiry(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(ws_routes, "publish_to_workspace", published)
    alice = team["alice"]
    frames = [
        {"type": "websocket.receive", "text": json.dumps({"type": "auth", "token": _token(alice["id"], 1.5)})},
        {"type": "websocket.receive", "text": "1"},
        {"type": "websocket.receive", "text": "[]"},
        {"type": "websocket.receive", "text": "not json"},
        {"type": "websocket.receive", "bytes": b"\x00"},
        {"type": "websocket.receive", "text": json.dumps({"type": "ping"})},
    ]
    ws = FakeWS(frames)
    await asyncio.wait_for(ws_routes.websocket_endpoint(ws, token=None), timeout=5)
    assert ws.accepted and {"type": "pong"} in ws.sent
    assert ws.closed == hub_module.CLOSE_TOKEN_EXPIRED


async def test_websocket_rejects_missing_or_bad_first_frame(monkeypatch):
    monkeypatch.setattr(ws_routes, "AUTH_TIMEOUT_SECONDS", 0.1)
    ws = FakeWS([{"type": "websocket.receive", "text": json.dumps({"type": "ping"})}])
    await ws_routes.websocket_endpoint(ws, token=None)
    assert ws.closed == 1008
    ws = FakeWS()
    await ws_routes.websocket_endpoint(ws, token=None)
    assert ws.closed == 1008


async def test_websocket_peek_subscription(client, team):
    alice, carol, ws_ = team["alice"], team["carol"], team["ws"]
    pub = (await client.post(f"/workspaces/{ws_['id']}/channels", json={"name": f"pk-{uuid.uuid4().hex[:6]}"}, headers=alice["headers"])).json()
    priv = (await client.post(f"/workspaces/{ws_['id']}/channels", json={"name": f"pv-{uuid.uuid4().hex[:6]}", "kind": "private"}, headers=alice["headers"])).json()
    carol_id = uuid.UUID(carol["id"])
    assert await ws_routes._can_peek(carol_id, pub["id"]) is True
    assert await ws_routes._can_peek(carol_id, priv["id"]) is False
    assert await ws_routes._can_peek(carol_id, "garbage") is False


async def test_chunked_oversized_upload_rejected(client, team, monkeypatch):
    monkeypatch.setattr(settings, "max_upload_bytes", 1024)
    monkeypatch.setattr(settings, "max_recording_bytes", 1024)
    monkeypatch.setattr("app.api.routes.uploads.MULTIPART_OVERHEAD_BYTES", 0)
    boundary = "worklioboundary"

    async def body():  # no Content-Length: streamed in chunks
        yield (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\n'
            "Content-Type: text/plain\r\n\r\n"
        ).encode()
        for _ in range(10):
            yield b"x" * 1000
        yield f"\r\n--{boundary}--\r\n".encode()

    r = await client.post(
        f"/workspaces/{team['ws']['id']}/uploads",
        content=body(),
        headers={**team["alice"]["headers"], "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    assert r.status_code == 413
