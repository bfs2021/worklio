"""Whiteboards (REST + WebSocket relay), screen-recording uploads and self-DM calls."""

import asyncio
import json
import uuid

import pytest

from app.api.routes import whiteboard as whiteboard_routes
from app.core.config import settings
from app.realtime import hub as hub_module
from app.realtime import routes as ws_routes
from tests.conftest import register
from tests.test_collab import _archive, _channel, _guest
from tests.test_hardening import FakeWS, Recorder, _token

pytestmark = pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")


def _el(eid: str, version: int = 1, **extra) -> dict:
    return {"id": eid, "version": version, "type": "rectangle", "x": 0, "y": 0, **extra}


# --- REST ------------------------------------------------------------------------------------


async def test_whiteboard_save_conflict_and_noop(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(whiteboard_routes, "publish_to_channel", published)
    ch = await _channel(client, team)
    alice, bob = team["alice"], team["bob"]
    url = f"/channels/{ch['id']}/whiteboard"

    r = await client.get(url, headers=bob["headers"])
    assert r.status_code == 200, r.text
    board = r.json()
    assert set(board) == {"channel_id", "elements", "version", "updated_by", "updated_at"}
    assert (board["channel_id"], board["elements"], board["version"], board["updated_by"]) == (ch["id"], [], 0, None)

    v1 = [_el("a"), _el("b", 3, isDeleted=True)]
    r = await client.put(url, json={"elements": v1, "base_version": 0}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    saved = r.json()
    assert (saved["elements"], saved["version"], saved["updated_by"]) == (v1, 1, alice["id"])
    assert published.events == [
        (ch["id"], {"type": "whiteboard.saved", "channel_id": ch["id"], "version": 1, "user_id": alice["id"]})
    ]

    # Same scene again (even from a stale base): no-op, no bump, no event.
    r = await client.put(url, json={"elements": v1, "base_version": 0}, headers=bob["headers"])
    assert r.status_code == 200 and r.json() == saved
    assert len(published.events) == 1

    # Stale base with different content: 409 with the current scene.
    r = await client.put(url, json={"elements": [_el("c")], "base_version": 0}, headers=bob["headers"])
    assert r.status_code == 409
    assert r.json() == {"detail": "Whiteboard changed", "whiteboard": saved}
    assert len(published.events) == 1

    r = await client.put(url, json={"elements": [*v1, _el("c")], "base_version": 1}, headers=bob["headers"])
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["updated_by"] == bob["id"]
    assert [e["id"] for e in (await client.get(url, headers=alice["headers"])).json()["elements"]] == ["a", "b", "c"]

    # Concurrent saves from the same base: exactly one wins.
    rs = await asyncio.gather(
        *(
            client.put(url, json={"elements": [_el(f"x{i}")], "base_version": 2}, headers=alice["headers"])
            for i in range(4)
        )
    )
    assert sorted(r.status_code for r in rs) == [200, 409, 409, 409]
    assert (await client.get(url, headers=alice["headers"])).json()["version"] == 3


@pytest.mark.parametrize(
    "body",
    [
        {"elements": [_el("a")]},
        {"elements": [_el("a")], "base_version": -1},
        {"elements": "nope", "base_version": 0},
        {"elements": [1], "base_version": 0},
        {"elements": [{"version": 1}], "base_version": 0},
        {"elements": [{"id": "", "version": 1}], "base_version": 0},
        {"elements": [{"id": 5, "version": 1}], "base_version": 0},
        {"elements": [{"id": "a"}], "base_version": 0},
        {"elements": [{"id": "a", "version": "1"}], "base_version": 0},
        {"elements": [{"id": "a", "version": 1.5}], "base_version": 0},
        {"elements": [{"id": "a", "version": True}], "base_version": 0},
        {"elements": [{"id": f"e{i}", "version": 1} for i in range(10_001)], "base_version": 0},
    ],
)
async def test_whiteboard_validation(client, team, body):
    r = await client.put(f"/channels/{team['general']['id']}/whiteboard", json=body, headers=team["alice"]["headers"])
    assert r.status_code == 422, r.text


async def test_whiteboard_max_elements_allowed(client, team, monkeypatch):
    monkeypatch.setattr(whiteboard_routes, "publish_to_channel", Recorder())
    ch = await _channel(client, team)
    elements = [{"id": f"e{i}", "version": 1} for i in range(10_000)]
    r = await client.put(f"/channels/{ch['id']}/whiteboard", json={"elements": elements, "base_version": 0}, headers=team["alice"]["headers"])
    assert r.status_code == 200, r.text
    assert len(r.json()["elements"]) == 10_000


async def test_whiteboard_size_limits(client, team, monkeypatch):
    ch, h = await _channel(client, team), team["alice"]["headers"]
    url = f"/channels/{ch['id']}/whiteboard"
    big = [_el("a", text="x" * 3000)]
    # Scenes over the limit are refused (before parsing), with or without Content-Length.
    monkeypatch.setattr(settings, "max_whiteboard_bytes", 3000)
    r = await client.put(url, json={"elements": big, "base_version": 0}, headers=h)
    assert r.status_code == 413
    assert r.json()["detail"].startswith("Whiteboard too large")
    r = await client.put(url, content=b"[" + b" " * 10_000 + b"]", headers={**h, "Content-Type": "application/json"})
    assert r.status_code == 413

    async def chunked():
        for _ in range(10):
            yield b" " * 1000

    r = await client.put(url, content=chunked(), headers={**h, "Content-Type": "application/json"})
    assert r.status_code == 413
    assert (await client.get(url, headers=h)).json()["version"] == 0


async def test_whiteboard_access_guests_tenants_and_archived(client, team, monkeypatch):
    monkeypatch.setattr(whiteboard_routes, "publish_to_channel", Recorder())
    alice = team["alice"]
    body = {"elements": [_el("a")], "base_version": 0}

    # Private channel: non-members and outsiders get 404.
    priv = await _channel(client, team, kind="private")
    outsider = await register(client, "outsider")
    for who in (team["bob"], outsider):
        assert (await client.get(f"/channels/{priv['id']}/whiteboard", headers=who["headers"])).status_code == 404
        r = await client.put(f"/channels/{priv['id']}/whiteboard", json=body, headers=who["headers"])
        assert r.status_code == 404

    # Another workspace's owner can't reach this workspace's public channel either.
    other_ws = await client.post(
        "/workspaces", json={"name": "Other", "slug": f"other-{uuid.uuid4().hex[:6]}"}, headers=outsider["headers"]
    )
    assert other_ws.status_code == 201, other_ws.text
    assert (await client.get(f"/channels/{team['general']['id']}/whiteboard", headers=outsider["headers"])).status_code == 404
    assert (await client.get(f"/channels/{team['general']['id']}/whiteboard")).status_code == 401

    # Guests only reach channels they were added to.
    pub, other = await _channel(client, team), await _channel(client, team)
    guest = await _guest(client, team, channels=[pub])
    assert (await client.get(f"/channels/{other['id']}/whiteboard", headers=guest["headers"])).status_code == 404
    r = await client.put(f"/channels/{pub['id']}/whiteboard", json=body, headers=guest["headers"])
    assert r.status_code == 200 and r.json()["updated_by"] == guest["id"]

    # Archived: readable, not writable.
    await _archive(pub["id"])
    assert (await client.get(f"/channels/{pub['id']}/whiteboard", headers=alice["headers"])).status_code == 200
    r = await client.put(f"/channels/{pub['id']}/whiteboard", json={"elements": [_el("z")], "base_version": 1}, headers=alice["headers"])
    assert r.status_code == 403


# --- WebSocket relay ---------------------------------------------------------------------------


def _frames(token: str, *events) -> list[dict]:
    frames = [{"type": "websocket.receive", "text": json.dumps({"type": "auth", "token": token})}]
    for e in events:
        text = e if isinstance(e, str) else json.dumps(e)
        frames.append({"type": "websocket.receive", "text": text})
    frames.append({"type": "websocket.disconnect", "code": 1000})
    return frames


async def _run_ws(user_id: str, *events) -> None:
    await asyncio.wait_for(ws_routes.websocket_endpoint(FakeWS(_frames(_token(user_id, 60), *events)), token=None), timeout=5)


@pytest.fixture
def ws_published(monkeypatch):
    published = Recorder()
    monkeypatch.setattr(ws_routes, "publish_to_channel", published)
    monkeypatch.setattr(ws_routes, "publish_to_workspace", Recorder())
    return published


async def test_whiteboard_ops_relay(client, team, ws_published):
    alice, general = team["alice"], team["general"]
    cid = general["id"]
    priv = await _channel(client, team, kind="private", owner="bob")
    archived = await _channel(client, team)
    await _archive(archived["id"])
    els = [_el("a"), _el("b", 2, isDeleted=True)]
    ops = {"type": "whiteboard.ops", "channel_id": cid, "client_id": "tab-1", "elements": els}
    await _run_ws(
        alice["id"],
        ops,
        {**ops, "channel_id": priv["id"]},  # not subscribed
        {**ops, "channel_id": "junk"},
        {**ops, "channel_id": archived["id"]},
        {**ops, "client_id": None},
        {**ops, "client_id": ""},
        {**ops, "client_id": "x" * 65},
        {**ops, "elements": []},
        {**ops, "elements": "nope"},
        {**ops, "elements": [1]},
        {**ops, "elements": [{"id": "a"}]},
        {**ops, "elements": [{"id": "a", "version": True}]},
        {**ops, "elements": [{"id": 1, "version": 1}]},
        {**ops, "elements": [_el(f"e{i}") for i in range(301)]},
        json.dumps({**ops, "elements": [_el("big", text="x" * (256 * 1024))]}),  # frame too big
        {**ops, "client_id": "tab-2", "elements": [_el(f"e{i}") for i in range(300)]},
    )
    assert ws_published.events == [
        (cid, {"type": "whiteboard.ops", "channel_id": cid, "user_id": alice["id"], "client_id": "tab-1", "elements": els}),
        (
            cid,
            {
                "type": "whiteboard.ops",
                "channel_id": cid,
                "user_id": alice["id"],
                "client_id": "tab-2",
                "elements": [_el(f"e{i}") for i in range(300)],
            },
        ),
    ]


async def test_whiteboard_pointer_relay(client, team, ws_published):
    alice, cid = team["alice"], team["general"]["id"]
    priv = await _channel(client, team, kind="private", owner="bob")
    ptr = {"type": "whiteboard.pointer", "channel_id": cid, "client_id": "tab-1", "x": 10.5, "y": -3}
    await _run_ws(
        alice["id"],
        ptr,
        {**ptr, "tool": "laser", "x": 1, "y": 2},
        {**ptr, "channel_id": priv["id"]},
        {**ptr, "tool": "pen"},
        {**ptr, "x": "1"},
        {**ptr, "x": True},
        {**ptr, "y": None},
        {**ptr, "x": 1e9},
        json.dumps({**ptr, "x": float("nan")}),  # NaN is valid for json.loads, not a coordinate
        {**ptr, "client_id": 7},
    )
    base = {"type": "whiteboard.pointer", "channel_id": cid, "user_id": alice["id"], "client_id": "tab-1"}
    assert ws_published.events == [
        (cid, {**base, "x": 10.5, "y": -3, "tool": "pointer"}),
        (cid, {**base, "x": 1, "y": 2, "tool": "laser"}),
    ]


async def test_whiteboard_relay_guest_and_peek(client, team, ws_published):
    pub, other = await _channel(client, team), await _channel(client, team)
    guest = await _guest(client, team, channels=[pub])
    ptr = {"type": "whiteboard.pointer", "client_id": "g", "x": 0, "y": 0}
    # A guest relays in their own channel but can't peek into (or relay to) others.
    await _run_ws(
        guest["id"],
        {**ptr, "channel_id": pub["id"]},
        {"type": "subscribe", "channel_id": other["id"]},
        {**ptr, "channel_id": other["id"]},
    )
    assert [t for t, _ in ws_published.events] == [pub["id"]]
    # A full member peeking at a public channel may relay into it.
    ws_published.events.clear()
    await _run_ws(
        team["carol"]["id"],
        {**ptr, "channel_id": pub["id"]},  # not subscribed yet
        {"type": "subscribe", "channel_id": pub["id"]},
        {**ptr, "channel_id": pub["id"]},
    )
    assert [(t, e["user_id"]) for t, e in ws_published.events] == [(pub["id"], team["carol"]["id"])]


async def test_whiteboard_relay_rate_limited(client, team, ws_published, monkeypatch):
    monkeypatch.setattr(settings, "whiteboard_pointer_per_second", 0)
    monkeypatch.setattr(settings, "whiteboard_ops_per_second", 0)
    cid = team["general"]["id"]
    await _run_ws(
        team["alice"]["id"],
        {"type": "whiteboard.pointer", "channel_id": cid, "client_id": "t", "x": 0, "y": 0},
        {"type": "whiteboard.ops", "channel_id": cid, "client_id": "t", "elements": [_el("a")]},
    )
    assert ws_published.events == []


async def test_allow_per_second_window(monkeypatch):
    monkeypatch.setattr(hub_module.time, "time", lambda: 1_700_000_000.2)
    user = uuid.uuid4()
    assert [await hub_module.allow_per_second("t", user, "c1", 2) for _ in range(3)] == [True, True, False]
    assert await hub_module.allow_per_second("t", user, "c2", 2) is True  # per channel
    assert await hub_module.allow_per_second("t", uuid.uuid4(), "c1", 2) is True  # per user
    monkeypatch.setattr(hub_module.time, "time", lambda: 1_700_000_001.2)
    assert await hub_module.allow_per_second("t", user, "c1", 2) is True  # next window


# --- Screen recordings ---------------------------------------------------------------------------


async def test_screen_recording_upload_and_limits(client, team, monkeypatch):
    alice, url = team["alice"], f"/workspaces/{team['ws']['id']}/uploads"

    async def up(size: int, ctype: str = "video/webm", **data):
        return await client.post(url, files={"file": ("rec.webm", b"x" * size, ctype)}, data=data, headers=alice["headers"])

    r = await up(10, kind="screen_recording", duration_ms="3600000")
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "screen_recording" and r.json()["duration_ms"] == 3_600_000
    assert (await up(10, "video/mp4", kind="screen_recording")).status_code == 201
    assert (await up(10, "audio/webm", kind="screen_recording")).status_code == 422
    assert (await up(10, "text/plain", kind="screen_recording")).status_code == 422
    assert (await up(10, kind="screen_recording", duration_ms=str(4 * 3600 * 1000 + 1))).status_code == 422
    # Video clips keep their 10 minute cap.
    assert (await up(10, kind="video_clip", duration_ms="600001")).status_code == 422

    monkeypatch.setattr(settings, "max_upload_bytes", 1024)
    monkeypatch.setattr(settings, "max_recording_bytes", 4096)
    # Recording kinds use the larger limit; everything else keeps the regular one.
    assert (await up(2000, kind="screen_recording")).status_code == 201
    assert (await up(2000, kind="video_clip")).status_code == 201
    r = await up(2000, "text/plain")
    assert r.status_code == 413 and r.json()["detail"] == "File too large (max 0.000976562 MB)"
    assert (await up(2000, "audio/webm", kind="voice")).status_code == 413
    r = await up(4097, kind="screen_recording")
    assert r.status_code == 413 and r.json()["detail"] == "File too large (max 0.00390625 MB)"
    # The transport cap (largest limit + multipart overhead) refuses before reading.
    monkeypatch.setattr("app.api.routes.uploads.MULTIPART_OVERHEAD_BYTES", 0)
    r = await up(5000, kind="screen_recording")
    assert r.status_code == 413 and r.json()["detail"] == "File too large (max 0.00390625 MB)"


async def test_screen_recording_in_message(client, team):
    alice, general = team["alice"], team["general"]
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/uploads",
        files={"file": ("rec.webm", b"\x1aE\xdf\xa3", "video/webm")},
        data={"kind": "screen_recording", "duration_ms": "1234"},
        headers=alice["headers"],
    )
    assert r.status_code == 201, r.text
    att = r.json()
    r = await client.post(f"/channels/{general['id']}/messages", json={"attachment_ids": [att["id"]]}, headers=alice["headers"])
    assert r.status_code == 201, r.text
    assert r.json()["attachments"][0]["kind"] == "screen_recording"


# --- Calls -----------------------------------------------------------------------------------


async def test_cannot_call_yourself(client, team):
    alice = team["alice"]
    r = await client.post(f"/workspaces/{team['ws']['id']}/dms", json={"user_ids": [alice["id"]]}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    self_dm = r.json()
    for kind in ("audio", "video"):
        r = await client.post(f"/channels/{self_dm['id']}/calls", json={"kind": kind}, headers=alice["headers"])
        assert r.status_code == 400
        assert r.json() == {"detail": "You can't call yourself"}
