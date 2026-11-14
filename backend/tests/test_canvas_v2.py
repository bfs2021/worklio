"""Canvases v2: multi-canvas access, Yjs persistence/relay over the WebSocket, comments."""

import asyncio
import base64
import json
import uuid

import pytest
from pycrdt import Doc, Text
from sqlalchemy import select

from app import canvas_collab
from app.api.routes import canvas as canvas_routes
from app.core.db import SessionLocal
from app.core.redis import redis
from app.models import Canvas
from app.realtime import hub as hub_module
from app.realtime import routes as ws_routes
from tests.conftest import register
from tests.test_collab import _archive, _channel, _doc, _guest
from tests.test_hardening import FakeWS, _token


class Published:
    """Records publish_to_canvas / notify_user / publish_to_* calls (target, event, origin)."""

    def __init__(self):
        self.events: list[tuple[str, dict, str | None]] = []

    async def __call__(self, target, event, origin=None):
        self.events.append((str(target), event, origin))

    def of(self, kind: str) -> list[dict]:
        return [e for _, e, _ in self.events if e["type"] == kind]


@pytest.fixture
def published(monkeypatch):
    rec = Published()
    for name in ("publish_to_canvas", "publish_to_channel", "publish_to_workspace", "notify_user"):
        monkeypatch.setattr(canvas_routes, name, rec)
    monkeypatch.setattr(ws_routes, "publish_to_canvas", rec)
    monkeypatch.setattr(ws_routes, "publish_to_workspace", Published())
    return rec


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _text_update(text: str) -> bytes:
    doc = Doc()
    doc["t"] = Text()
    doc["t"] += text
    return doc.get_update()


def _text_of(state_b64: str) -> str:
    doc = Doc()
    doc.apply_update(base64.b64decode(state_b64))
    return str(doc.get("t", type=Text))


async def _create(client, team, who="alice", **body) -> dict:
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/canvases",
        json={"title": "Doc", **body},
        headers=team[who]["headers"],
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _ids(client, team, who) -> set[str]:
    r = await client.get(f"/workspaces/{team['ws']['id']}/canvases", headers=who["headers"])
    assert r.status_code == 200, r.text
    return {c["id"] for c in r.json()}


def _frame(event: dict) -> dict:
    return {"type": "websocket.receive", "text": json.dumps(event)}


async def _ws(user: dict, *events: dict) -> FakeWS:
    """Run one socket: auth, the given frames, disconnect. Returns what the server sent it."""
    ws = FakeWS(
        [
            _frame({"type": "auth", "token": _token(user["id"], 60)}),
            *(_frame(e) for e in events),
            {"type": "websocket.disconnect", "code": 1000},
        ]
    )
    await asyncio.wait_for(ws_routes.websocket_endpoint(ws, token=None), timeout=10)
    return ws


def _join(canvas_id: str) -> dict:
    return {"type": "canvas.join", "canvas_id": canvas_id}


def _update(canvas_id: str, data: bytes, client_id="c1") -> dict:
    return {"type": "canvas.update", "canvas_id": canvas_id, "client_id": client_id, "update": _b64(data)}


# --- REST: access matrix ---------------------------------------------------------------------


async def test_access_matrix(client, team, published):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    priv_channel = await _channel(client, team, kind="private", owner="bob")
    guest = await _guest(client, team)
    r = await client.post(
        f"/channels/{priv_channel['id']}/members", json={"user_id": guest["id"]}, headers=bob["headers"]
    )
    assert r.status_code == 204, r.text
    outsider = await register(client, "outsider")

    open_doc = await _create(client, team, title="  Roadmap  ", emoji="🗺️")
    assert (open_doc["title"], open_doc["emoji"], open_doc["access"]) == ("Roadmap", "🗺️", "workspace")
    assert open_doc["member_ids"] == [] and open_doc["created_by"] == alice["id"]
    assert open_doc["is_channel_canvas"] is False and open_doc["channel_id"] is None

    private = await _create(client, team, access="private", member_ids=[bob["id"], guest["id"], alice["id"]])
    assert sorted(private["member_ids"]) == sorted([bob["id"], guest["id"]])  # creator implied
    chan = await _create(client, team, who="bob", access="channel", channel_id=priv_channel["id"])
    r = await client.get(f"/channels/{priv_channel['id']}/canvas", headers=bob["headers"])
    channel_canvas = r.json()
    assert (channel_canvas["is_channel_canvas"], channel_canvas["access"]) == (True, "channel")
    assert channel_canvas["workspace_id"] == team["ws"]["id"]
    # The channel canvas is created once.
    again = await client.get(f"/channels/{priv_channel['id']}/canvas", headers=bob["headers"])
    assert again.json()["id"] == channel_canvas["id"]

    everything = {open_doc["id"], private["id"], chan["id"], channel_canvas["id"]}
    assert await _ids(client, team, alice) == {open_doc["id"], private["id"]}
    assert await _ids(client, team, bob) == everything
    assert await _ids(client, team, carol) == {open_doc["id"]}
    # Guests only see what they're invited to: the private canvas and their channel's canvases.
    assert await _ids(client, team, guest) == {private["id"], chan["id"], channel_canvas["id"]}
    r = await client.get(f"/workspaces/{team['ws']['id']}/canvases", headers=outsider["headers"])
    assert r.status_code == 404

    for who, visible in (
        (alice, {open_doc["id"], private["id"]}),
        (carol, {open_doc["id"]}),
        (guest, {private["id"], chan["id"], channel_canvas["id"]}),
        (outsider, set()),
    ):
        for cid in everything:
            for path in ("", "/state", "/comments"):
                r = await client.get(f"/canvases/{cid}{path}", headers=who["headers"])
                assert r.status_code == (200 if cid in visible else 404), (who["email"], cid, path)
    assert (await client.get(f"/canvases/{open_doc['id']}")).status_code == 401

    # Search by title (case-insensitive, LIKE wildcards are literal).
    r = await client.get(f"/workspaces/{team['ws']['id']}/canvases?q=ROAD", headers=carol["headers"])
    assert [c["id"] for c in r.json()] == [open_doc["id"]]
    r = await client.get(f"/workspaces/{team['ws']['id']}/canvases?q=%25", headers=carol["headers"])
    assert r.json() == []

    # Guests can't create canvases; channel canvases need channel access.
    r = await client.post(f"/workspaces/{team['ws']['id']}/canvases", json={"title": "x"}, headers=guest["headers"])
    assert r.status_code == 403
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/canvases",
        json={"title": "x", "access": "channel", "channel_id": priv_channel["id"]},
        headers=carol["headers"],
    )
    assert r.status_code == 404
    for bad in (
        {"title": "x", "access": "channel"},
        {"title": "x", "access": "secret"},
        {"title": ""},
        {"title": "x", "access": "private", "member_ids": [outsider["id"]]},
    ):
        r = await client.post(f"/workspaces/{team['ws']['id']}/canvases", json=bad, headers=alice["headers"])
        assert r.status_code == 422, bad
    assert published.of("canvases.changed")


async def test_patch_and_delete_permissions(client, team, published):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    doc = await _create(client, team, who="bob", title="Bob's")
    url = f"/canvases/{doc['id']}"

    # Any editor may rename; only the creator or an admin changes sharing.
    r = await client.patch(url, json={"title": "Renamed", "emoji": "🔥"}, headers=carol["headers"])
    assert r.status_code == 200 and (r.json()["title"], r.json()["emoji"], r.json()["updated_by"]) == (
        "Renamed", "🔥", carol["id"]
    )
    assert (await client.patch(url, json={"emoji": None}, headers=carol["headers"])).json()["emoji"] is None
    r = await client.patch(url, json={"access": "private"}, headers=carol["headers"])
    assert r.status_code == 403
    assert (await client.patch(url, json={"title": None}, headers=bob["headers"])).status_code == 422

    published.events.clear()
    r = await client.patch(url, json={"access": "private", "member_ids": [carol["id"]]}, headers=bob["headers"])
    assert r.status_code == 200 and r.json()["member_ids"] == [carol["id"]]
    assert published.of("canvas.access_changed") == [{"type": "canvas.access_changed", "canvas_id": doc["id"]}]
    assert (await client.get(url, headers=alice["headers"])).status_code == 404  # admin, not invited
    assert (await client.get(url, headers=carol["headers"])).status_code == 200

    # Removing a member revokes their live subscription.
    published.events.clear()
    r = await client.patch(url, json={"member_ids": []}, headers=bob["headers"])
    assert r.json()["member_ids"] == []
    assert (carol["id"], {"type": "canvas.access_revoked", "canvas_id": doc["id"]}, None) in published.events
    assert (await client.get(url, headers=carol["headers"])).status_code == 404

    r = await client.patch(url, json={"access": "channel"}, headers=bob["headers"])
    assert r.status_code == 422  # no channel to follow
    r = await client.patch(url, json={"access": "workspace"}, headers=bob["headers"])
    assert r.status_code == 200 and r.json()["member_ids"] == []

    # Delete: creator or admin only.
    assert (await client.delete(url, headers=carol["headers"])).status_code == 403
    published.events.clear()
    assert (await client.delete(url, headers=alice["headers"])).status_code == 204
    assert published.of("canvas.deleted") == [{"type": "canvas.deleted", "canvas_id": doc["id"]}]
    assert (await client.get(url, headers=bob["headers"])).status_code == 404

    # A channel's own canvas can't be deleted or re-shared.
    general = (await client.get(f"/channels/{team['general']['id']}/canvas", headers=bob["headers"])).json()
    assert (await client.delete(f"/canvases/{general['id']}", headers=alice["headers"])).status_code == 400
    r = await client.patch(f"/canvases/{general['id']}", json={"access": "workspace"}, headers=alice["headers"])
    assert r.status_code == 400


async def test_archived_channel_canvas_is_read_only(client, team, published):
    ch = await _channel(client, team)
    h = team["alice"]["headers"]
    canvas = (await client.get(f"/channels/{ch['id']}/canvas", headers=h)).json()
    await _archive(ch["id"])
    assert (await client.get(f"/canvases/{canvas['id']}", headers=h)).status_code == 200
    r = await client.patch(f"/canvases/{canvas['id']}", json={"title": "x"}, headers=h)
    assert r.status_code == 403
    r = await client.post(f"/canvases/{canvas['id']}/comments", json={"body": "hi"}, headers=h)
    assert r.status_code == 403

    ws = await _ws(team["alice"], _join(canvas["id"]), _update(canvas["id"], _text_update("x")))
    assert ws.sent[-1] == {"type": "canvas.error", "canvas_id": canvas["id"], "error": "read_only"}
    assert not published.of("canvas.update")


async def test_legacy_content_seeds_until_yjs_state_exists(client, team, published):
    ch = await _channel(client, team)
    h = team["alice"]["headers"]
    url = f"/channels/{ch['id']}/canvas"
    old = (await client.get(url, headers=h)).json()
    assert {"content", "version", "access", "is_channel_canvas", "member_ids"} <= old.keys()
    assert (await client.get(f"/canvases/{old['id']}", headers=h)).json()["legacy_content"] is None
    r = await client.put(url, json={"title": "Plan", "content": _doc("legacy"), "base_version": 0}, headers=h)
    assert r.status_code == 200
    detail = (await client.get(f"/canvases/{old['id']}", headers=h)).json()
    assert detail["legacy_content"] == _doc("legacy") and detail["title"] == "Plan"

    await _ws(team["alice"], _join(old["id"]), _update(old["id"], _text_update("seeded")))
    detail = (await client.get(f"/canvases/{old['id']}", headers=h)).json()
    assert detail["legacy_content"] is None
    assert detail["updated_by"] == team["alice"]["id"]


# --- Yjs state + realtime --------------------------------------------------------------------


async def test_two_clients_updates_merge_and_persist(client, team, published):
    alice, bob = team["alice"], team["bob"]
    doc = await _create(client, team)
    cid = doc["id"]
    empty = (await client.get(f"/canvases/{cid}/state", headers=alice["headers"])).json()
    assert empty["state"] == "" and base64.b64decode(empty["state_vector"]) == canvas_collab.EMPTY_STATE_VECTOR

    # Two independent replicas edit concurrently; each socket sends its own update.
    hello, world = _text_update("hello"), _text_update("world")
    ws_a = await _ws(alice, _join(cid), _update(cid, hello, "client-a"))
    ws_b = await _ws(bob, _join(cid), _update(cid, world, "client-b"))
    assert ws_a.sent[0] == {"type": "canvas.joined", "canvas_id": cid}
    assert ws_b.sent == [{"type": "canvas.joined", "canvas_id": cid}]

    # Relay shape: exactly the contract fields, tagged with the sending connection.
    relayed = [(t, e, o) for t, e, o in published.events if e["type"] == "canvas.update"]
    assert [(t, e) for t, e, _ in relayed] == [
        (cid, {"type": "canvas.update", "canvas_id": cid, "client_id": "client-a", "update": _b64(hello)}),
        (cid, {"type": "canvas.update", "canvas_id": cid, "client_id": "client-b", "update": _b64(world)}),
    ]
    assert all(o for _, _, o in relayed) and relayed[0][2] != relayed[1][2]

    # Flushed on disconnect: the stored doc holds both edits.
    assert not await canvas_collab.has_pending(cid)
    state = (await client.get(f"/canvases/{cid}/state", headers=bob["headers"])).json()
    text = _text_of(state["state"])
    assert "hello" in text and "world" in text and len(text) == 10
    async with SessionLocal() as db:
        row = await db.get(Canvas, uuid.UUID(cid))
        stored = await db.scalar(select(Canvas.ydoc_state).where(Canvas.id == row.id))
        assert row.ydoc_size == len(stored) > 0 and row.updated_by == uuid.UUID(bob["id"])
    vector_doc = Doc()
    vector_doc.apply_update(stored)
    assert base64.b64decode(state["state_vector"]) == vector_doc.get_state()


async def test_pending_updates_are_visible_before_flush_and_never_lost(client, team, monkeypatch):
    doc = await _create(client, team)
    cid, uid = doc["id"], team["alice"]["id"]
    monkeypatch.setattr(canvas_collab, "FLUSH_DELAY_SECONDS", 30)  # only explicit flushes here
    base = Doc()
    base["t"] = Text()
    base["t"] += "abc"
    first = base.get_update()
    sv = base.get_state()
    base["t"] += "def"
    second = base.get_update(sv)
    await canvas_collab.enqueue_update(cid, uid, first)
    await canvas_collab.enqueue_update(cid, uid, second)
    try:
        # Not flushed yet, but a joining client fetching the state still sees everything.
        async with SessionLocal() as db:
            assert (await db.get(Canvas, uuid.UUID(cid))).ydoc_size == 0
            state, _ = await canvas_collab.read_state(db, uuid.UUID(cid))
        assert _text_of(_b64(state)) == "abcdef"

        # A failed commit puts the entries back.
        original_merge = canvas_collab.merge

        def boom(*args):
            raise RuntimeError("db down")

        monkeypatch.setattr(canvas_collab, "merge", boom)
        with pytest.raises(RuntimeError):
            await canvas_collab.flush(cid)
        monkeypatch.setattr(canvas_collab, "merge", original_merge)
        assert await redis.llen(f"canvas:pending:{cid}") == 2

        assert await canvas_collab.flush(cid) is True
        assert not await canvas_collab.has_pending(cid)
        assert int(await redis.get(f"canvas:pending-bytes:{cid}") or 0) == 0
        assert await canvas_collab.flush(cid) is False  # nothing left
        async with SessionLocal() as db:
            state, _ = await canvas_collab.read_state(db, uuid.UUID(cid))
        assert _text_of(_b64(state)) == "abcdef"
    finally:
        canvas_collab._cancel_waiting(cid)


async def test_debounced_flush_runs_within_delay(client, team, monkeypatch):
    doc = await _create(client, team)
    monkeypatch.setattr(canvas_collab, "FLUSH_DELAY_SECONDS", 0.05)
    await canvas_collab.enqueue_update(doc["id"], team["alice"]["id"], _text_update("debounced"))
    for _ in range(100):
        if not await canvas_collab.has_pending(doc["id"]):
            break
        await asyncio.sleep(0.02)
    async with SessionLocal() as db:
        assert (await db.get(Canvas, uuid.UUID(doc["id"]))).ydoc_size > 0


async def test_ws_join_access_and_frame_validation(client, team, published, monkeypatch):
    alice, carol = team["alice"], team["carol"]
    private = await _create(client, team, access="private")
    cid = private["id"]
    ws = await _ws(
        carol,
        _join(cid),  # not invited
        _update(cid, _text_update("sneaky")),  # not joined: ignored
        _join("junk"),
        _join(str(uuid.uuid4())),
    )
    assert ws.sent == [
        {"type": "canvas.error", "canvas_id": cid, "error": "not_found"},
        {"type": "canvas.error", "canvas_id": "junk", "error": "not_found"},
        {"type": "canvas.error", "canvas_id": ws.sent[2]["canvas_id"], "error": "not_found"},
    ]
    assert not published.of("canvas.update")

    garbage = _b64(b"\xff" * 40)
    ws = await _ws(
        alice,
        _join(cid),
        {"type": "canvas.update", "canvas_id": cid, "client_id": "c", "update": garbage},
        {"type": "canvas.update", "canvas_id": cid, "client_id": "c", "update": "not base64!"},
        {"type": "canvas.update", "canvas_id": cid, "update": _b64(_text_update("x"))},  # no client_id
        {"type": "canvas.leave", "canvas_id": cid},
        _update(cid, _text_update("after leave")),  # ignored
    )
    assert ws.sent == [
        {"type": "canvas.joined", "canvas_id": cid},
        {"type": "canvas.error", "canvas_id": cid, "error": "invalid_update"},
        {"type": "canvas.error", "canvas_id": cid, "error": "invalid_update"},
    ]
    assert not published.of("canvas.update")


async def test_ws_size_limits(client, team, published, monkeypatch):
    alice = team["alice"]
    cid = (await _create(client, team))["id"]

    # Updates over 256 KB (the general frame cap) are accepted for canvas.update...
    big = _text_update("x" * 300_000)
    assert 256 * 1024 < len(json.dumps(_update(cid, big))) and len(big) <= canvas_collab.MAX_UPDATE_BYTES
    # ...but not over 512 KB decoded.
    huge = _text_update("y" * (canvas_collab.MAX_UPDATE_BYTES + 10))
    ws = await _ws(alice, _join(cid), _update(cid, big), _update(cid, huge))
    assert ws.sent[1:] == [{"type": "canvas.error", "canvas_id": cid, "error": "invalid_update"}]
    assert len(published.of("canvas.update")) == 1

    # Document cap: an update that would push the stored doc over it is refused, not relayed.
    monkeypatch.setattr(canvas_collab, "MAX_STATE_BYTES", len(big) + 100)
    published.events.clear()
    ws = await _ws(alice, _join(cid), _update(cid, _text_update("z" * 500)))
    assert ws.sent[-1] == {"type": "canvas.error", "canvas_id": cid, "error": "too_large"}
    assert not published.of("canvas.update")

    # Awareness: <= 32 KB, rate limited, relayed as-is, never stored.
    monkeypatch.setattr(canvas_collab, "AWARENESS_PER_SECOND", 2)
    small = _b64(b"\x01" * 100)
    aw = {"type": "canvas.awareness", "canvas_id": cid, "client_id": "a1", "update": small}
    too_big = {**aw, "update": _b64(b"\x01" * (canvas_collab.MAX_AWARENESS_BYTES + 1))}
    published.events.clear()
    await _ws(alice, _join(cid), too_big, aw, aw, aw, aw)
    assert 1 <= len(published.of("canvas.awareness")) <= 3  # 2/s budget (may straddle a second)
    assert published.of("canvas.awareness")[0] == {
        "type": "canvas.awareness", "canvas_id": cid, "client_id": "a1", "update": small
    }
    # Leaving announces the socket's awareness clients so peers drop its cursor.
    assert published.of("canvas.peer_left") == [
        {"type": "canvas.peer_left", "canvas_id": cid, "user_id": alice["id"], "client_ids": ["a1"]}
    ]


async def test_hub_canvas_topic_excludes_sender_and_revocation():
    h = hub_module.Hub()
    a = hub_module.Connection(FakeWS(), uuid.uuid4(), {"ch1"}, set())
    b = hub_module.Connection(FakeWS(), uuid.uuid4(), {"ch1"}, set())
    for conn in (a, b):
        h.register(conn)
        h.subscribe_canvas(conn, "cv1", "ch1")
    h.subscribe_canvas(a, "cv2", None)
    update = {"type": "canvas.update", "canvas_id": "cv1", "client_id": "x", "update": "AA=="}
    await h._dispatch("rt:canvas:cv1", json.dumps({"origin": a.id, "event": update}))
    assert a.ws.sent == [] and b.ws.sent == [update]

    comments = {"type": "canvas.comments.updated", "canvas_id": "cv1"}
    await h._dispatch("rt:canvas:cv1", json.dumps({"origin": None, "event": comments}))
    assert a.ws.sent == [comments] and b.ws.sent == [update, comments]

    # Leaving the channel drops canvases tied to it (not the others).
    await h._dispatch(f"rt:user:{b.user_id}", json.dumps({"type": "channel.left", "channel_id": "ch1"}))
    assert b.canvas_ids == {} and b not in h._by_canvas["cv1"]
    assert {"type": "canvas.left", "canvas_id": "cv1", "reason": "channel_left"} in b.ws.sent

    await h._dispatch(f"rt:user:{a.user_id}", json.dumps({"type": "canvas.access_revoked", "canvas_id": "cv2"}))
    assert "cv2" not in a.canvas_ids and "cv2" not in h._by_canvas
    assert a.ws.sent[-1] == {"type": "canvas.left", "canvas_id": "cv2", "reason": "access_revoked"}

    # Deleted canvases unsubscribe everyone after the event goes out.
    await h._dispatch("rt:canvas:cv1", json.dumps({"origin": None, "event": {"type": "canvas.deleted", "canvas_id": "cv1"}}))
    assert a.ws.sent[-1] == {"type": "canvas.deleted", "canvas_id": "cv1"}
    assert "cv1" not in h._by_canvas and a.canvas_ids == {}
    for conn in (a, b):
        h.unregister(conn)
    assert not h._by_canvas and not h._by_channel and not h._by_user


# --- Comments --------------------------------------------------------------------------------


async def test_comments_threads_and_permissions(client, team, published):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    doc = await _create(client, team)
    base = f"/canvases/{doc['id']}/comments"

    published.events.clear()
    r = await client.post(base, json={"body": " Typo here ", "anchor_id": "m-1", "quote": "teh"}, headers=bob["headers"])
    assert r.status_code == 201, r.text
    root = r.json()
    assert root["thread_id"] == root["id"] and (root["body"], root["anchor_id"], root["quote"]) == ("Typo here", "m-1", "teh")
    assert root["author_id"] == bob["id"] and root["resolved"] is False
    assert published.events == [(doc["id"], {"type": "canvas.comments.updated", "canvas_id": doc["id"]}, None)]

    reply = (await client.post(base, json={"body": "Fixed", "thread_id": root["id"], "anchor_id": "other"}, headers=carol["headers"])).json()
    assert (reply["thread_id"], reply["anchor_id"], reply["quote"]) == (root["id"], "m-1", None)
    general = (await client.post(base, json={"body": "Looks good overall"}, headers=alice["headers"])).json()
    assert general["anchor_id"] is None and general["thread_id"] == general["id"]
    # Threads are one level deep, and only within the same canvas.
    assert (await client.post(base, json={"body": "x", "thread_id": reply["id"]}, headers=bob["headers"])).status_code == 404
    other = await _create(client, team)
    r = await client.post(f"/canvases/{other['id']}/comments", json={"body": "x", "thread_id": root["id"]}, headers=bob["headers"])
    assert r.status_code == 404
    for bad in ({"body": "   "}, {"body": "x", "anchor_id": "has space"}, {"body": "x" * 10_001}):
        assert (await client.post(base, json=bad, headers=bob["headers"])).status_code == 422, bad

    listed = (await client.get(base, headers=carol["headers"])).json()
    assert [c["id"] for c in listed] == [root["id"], reply["id"], general["id"]]

    # Resolving (anyone with access) applies to the whole thread; a new reply reopens it.
    r = await client.patch(f"/canvas-comments/{reply['id']}", json={"resolved": True}, headers=alice["headers"])
    assert r.status_code == 200 and r.json()["resolved"] is True
    listed = {c["id"]: c for c in (await client.get(base, headers=bob["headers"])).json()}
    assert listed[root["id"]]["resolved"] and listed[reply["id"]]["resolved"] and not listed[general["id"]]["resolved"]
    await client.post(base, json={"body": "Not quite", "thread_id": root["id"]}, headers=bob["headers"])
    assert not any(c["resolved"] for c in (await client.get(base, headers=bob["headers"])).json())

    # Only the author edits the body; author or admin deletes.
    r = await client.patch(f"/canvas-comments/{root['id']}", json={"body": "edited"}, headers=carol["headers"])
    assert r.status_code == 403
    r = await client.patch(f"/canvas-comments/{root['id']}", json={"body": "edited"}, headers=bob["headers"])
    assert r.status_code == 200 and r.json()["body"] == "edited"
    assert (await client.delete(f"/canvas-comments/{general['id']}", headers=carol["headers"])).status_code == 403
    assert (await client.delete(f"/canvas-comments/{reply['id']}", headers=carol["headers"])).status_code == 204
    # Deleting a root removes its whole thread (admin may delete others' comments).
    assert (await client.delete(f"/canvas-comments/{root['id']}", headers=alice["headers"])).status_code == 204
    assert [c["id"] for c in (await client.get(base, headers=bob["headers"])).json()] == [general["id"]]

    # No access to the canvas = the comment doesn't exist.
    private = await _create(client, team, access="private")
    c = (await client.post(f"/canvases/{private['id']}/comments", json={"body": "secret"}, headers=alice["headers"])).json()
    for method in ("patch", "delete"):
        kwargs = {"json": {"resolved": True}} if method == "patch" else {}
        r = await getattr(client, method)(f"/canvas-comments/{c['id']}", headers=carol["headers"], **kwargs)
        assert r.status_code == 404
    assert (await client.get(f"/canvases/{private['id']}/comments", headers=carol["headers"])).status_code == 404


async def test_attachment_url_refresh_access(client, team):
    """Canvas images store the attachment id; the URL can be re-signed by readers only."""
    alice, bob, carol, ws = team["alice"], team["bob"], team["carol"], team["ws"]

    async def upload(user):
        r = await client.post(
            f"/workspaces/{ws['id']}/uploads",
            files={"file": ("pic.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
            headers=user["headers"],
        )
        assert r.status_code == 201, r.text
        return r.json()

    # Unlinked upload (e.g. a canvas image): any workspace member, nobody outside.
    img = await upload(alice)
    r = await client.get(f"/attachments/{img['id']}/url", headers=bob["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["id"] == img["id"] and r.json()["url"].startswith("http")
    outsider = await register(client, "outsider")
    r = await client.get(f"/attachments/{img['id']}/url", headers=outsider["headers"])
    assert r.status_code == 404
    r = await client.get(f"/attachments/{uuid.uuid4()}/url", headers=alice["headers"])
    assert r.status_code == 404

    # Linked to a message in a private channel: only that channel's readers.
    ch = await _channel(client, team, kind="private", members=("bob",))
    att = await upload(alice)
    r = await client.post(
        f"/channels/{ch['id']}/messages", json={"attachment_ids": [att["id"]]}, headers=alice["headers"]
    )
    assert r.status_code == 201, r.text
    assert (await client.get(f"/attachments/{att['id']}/url", headers=bob["headers"])).status_code == 200
    assert (await client.get(f"/attachments/{att['id']}/url", headers=carol["headers"])).status_code == 404
