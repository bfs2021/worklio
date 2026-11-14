"""Profile v2 (status, avatar), Kanban boards, canvases and huddles."""

import asyncio
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

import jwt
import pytest
from sqlalchemy import update

from app import profiles
from app.api.routes import board as board_routes
from app.api.routes import canvas as canvas_routes
from app.core import storage
from app.core.config import settings
from app.core.db import SessionLocal
from app.models import Channel, User
from app.realtime import hub as hub_module
from app.realtime import huddles
from app.realtime import routes as ws_routes
from tests.conftest import register
from tests.test_hardening import FakeWS, Recorder, _token

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
PROFILE_KEYS = {
    "title",
    "pronouns",
    "timezone",
    "phone",
    "status_emoji",
    "status_text",
    "status_expires_at",
    "avatar_url",
}


async def _channel(client, team, *, kind="public", owner="alice", members=()):
    body = {"name": f"c-{uuid.uuid4().hex[:8]}", "kind": kind, "member_ids": [team[m]["id"] for m in members]}
    r = await client.post(f"/workspaces/{team['ws']['id']}/channels", json=body, headers=team[owner]["headers"])
    assert r.status_code == 201, r.text
    return r.json()


async def _archive(channel_id: str) -> None:
    async with SessionLocal() as db:
        await db.execute(update(Channel).where(Channel.id == uuid.UUID(channel_id)).values(is_archived=True))
        await db.commit()


async def _guest(client, team, *, channels=()):
    guest = await register(client, "guest")
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/members",
        json={"email": guest["email"], "role": "guest"},
        headers=team["alice"]["headers"],
    )
    assert r.status_code == 201
    for ch in channels:
        r = await client.post(f"/channels/{ch['id']}/members", json={"user_id": guest["id"]}, headers=team["alice"]["headers"])
        assert r.status_code == 204, r.text
    return guest


# --- Profile ---------------------------------------------------------------------------------


async def test_profile_fields_update_and_clear(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(profiles, "publish_to_workspace", published)
    alice = team["alice"]
    me = (await client.get("/auth/me", headers=alice["headers"])).json()
    assert PROFILE_KEYS <= me.keys() and all(me[k] is None for k in PROFILE_KEYS)
    assert "avatar_key" not in me

    body = {"title": "  Engineer ", "pronouns": "she/her", "timezone": "Europe/Berlin", "phone": "+1 (555) 010-2000"}
    r = await client.patch("/auth/me", json=body, headers=alice["headers"])
    assert r.status_code == 200, r.text
    me = r.json()
    assert (me["title"], me["pronouns"], me["timezone"], me["phone"]) == (
        "Engineer", "she/her", "Europe/Berlin", "+1 (555) 010-2000"
    )
    assert me["full_name"] == "alice"  # untouched

    # The change reaches every workspace the user is in, as a MemberOut.
    assert published.types() == ["user.updated"]
    target, event = published.events[0]
    assert target == team["ws"]["id"]
    member = event["user"]
    assert member["user_id"] == alice["id"] and member["role"] == "owner"
    assert member["email"] == alice["email"] and member["full_name"] == "alice"
    assert PROFILE_KEYS <= member.keys() and member["title"] == "Engineer"

    # "" clears; omitted fields stay.
    me = (await client.patch("/auth/me", json={"title": "", "phone": ""}, headers=alice["headers"])).json()
    assert me["title"] is None and me["phone"] is None and me["pronouns"] == "she/her"
    me = (await client.patch("/auth/me", json={"full_name": "Alice A."}, headers=alice["headers"])).json()
    assert me["full_name"] == "Alice A." and me["timezone"] == "Europe/Berlin"

    members = (await client.get(f"/workspaces/{team['ws']['id']}/members", headers=team["bob"]["headers"])).json()
    mine = next(m for m in members if m["user_id"] == alice["id"])
    assert mine["timezone"] == "Europe/Berlin" and PROFILE_KEYS <= mine.keys()


@pytest.mark.parametrize(
    "body",
    [
        {"timezone": "Mars/Olympus"},
        {"timezone": "../../etc/passwd"},
        {"title": "x" * 101},
        {"pronouns": "x" * 41},
        {"phone": "call me maybe"},
        {"full_name": ""},
        {"full_name": None},
    ],
)
async def test_profile_validation(client, team, body):
    r = await client.patch("/auth/me", json=body, headers=team["alice"]["headers"])
    assert r.status_code == 422, r.text


async def test_profile_requires_auth(client):
    assert (await client.patch("/auth/me", json={"title": "x"})).status_code == 401
    assert (await client.put("/auth/me/status", json={"text": "x"})).status_code == 401
    assert (await client.post("/auth/me/avatar", files={"file": ("a.png", PNG, "image/png")})).status_code == 401


async def test_status_set_clear_and_expiry(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(profiles, "publish_to_workspace", published)
    bob = team["bob"]
    expires = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    r = await client.put("/auth/me/status", json={"emoji": "🌴", "text": " On vacation ", "expires_at": expires}, headers=bob["headers"])
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["status_emoji"] == "🌴" and me["status_text"] == "On vacation" and me["status_expires_at"]
    assert published.events[-1][1]["user"]["status_text"] == "On vacation"

    # Shortcode emoji, no expiry.
    me = (await client.put("/auth/me/status", json={"emoji": ":coffee:", "text": None, "expires_at": None}, headers=bob["headers"])).json()
    assert (me["status_emoji"], me["status_text"], me["status_expires_at"]) == (":coffee:", None, None)

    # An expired status reads as no status everywhere.
    async with SessionLocal() as db:
        await db.execute(
            update(User)
            .where(User.id == uuid.UUID(bob["id"]))
            .values(status_text="stale", status_expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await db.commit()
    me = (await client.get("/auth/me", headers=bob["headers"])).json()
    assert me["status_emoji"] is me["status_text"] is me["status_expires_at"] is None
    members = (await client.get(f"/workspaces/{team['ws']['id']}/members", headers=bob["headers"])).json()
    mine = next(m for m in members if m["user_id"] == bob["id"])
    assert mine["status_text"] is None and mine["status_emoji"] is None

    await client.put("/auth/me/status", json={"text": "busy"}, headers=bob["headers"])
    r = await client.delete("/auth/me/status", headers=bob["headers"])
    assert r.status_code == 200 and r.json()["status_text"] is None
    # Both null also clears.
    await client.put("/auth/me/status", json={"text": "busy"}, headers=bob["headers"])
    me = (await client.put("/auth/me/status", json={"emoji": None, "text": ""}, headers=bob["headers"])).json()
    assert me["status_text"] is None and me["status_emoji"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"emoji": "hello world", "text": "x"},
        {"emoji": "🙂", "text": "x" * 101},
        {"text": "x", "expires_at": "2001-01-01T00:00:00Z"},
        {"text": "x", "expires_at": "not a date"},
    ],
)
async def test_status_validation(client, team, body):
    r = await client.put("/auth/me/status", json=body, headers=team["alice"]["headers"])
    assert r.status_code == 422, r.text


async def test_avatar_upload_redirect_replace_and_delete(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(profiles, "publish_to_workspace", published)
    deleted: list[str] = []
    real_delete = storage.delete

    def tracking_delete(key):
        deleted.append(key)
        real_delete(key)

    monkeypatch.setattr(storage, "delete", tracking_delete)
    carol = team["carol"]

    assert (await client.get(f"/users/{carol['id']}/avatar")).status_code == 404
    r = await client.post("/auth/me/avatar", files={"file": ("me.png", PNG, "image/png")}, headers=carol["headers"])
    assert r.status_code == 200, r.text
    url = r.json()["avatar_url"]
    parsed = urlparse(url)
    assert url.startswith(f"{settings.api_public_url}/users/{carol['id']}/avatar?v=")
    assert parsed.query.removeprefix("v=").isdigit()
    assert published.events[-1][1]["user"]["avatar_url"] == url

    # No auth needed: it's used as an <img src>.
    r = await client.get(f"{parsed.path}?{parsed.query}")
    assert r.status_code == 302
    location = r.headers["location"]
    assert f"avatars/{carol['id']}/" in location and location.split("?")[0].endswith(".png")
    first_key = urlparse(location).path.split(f"/{settings.s3_bucket}/", 1)[1]

    # Replacing deletes the old object.
    jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 64
    r = await client.post("/auth/me/avatar", files={"file": ("me.jpg", jpeg, "image/jpeg")}, headers=carol["headers"])
    assert r.status_code == 200
    assert deleted == [first_key]
    location = (await client.get(f"/users/{carol['id']}/avatar")).headers["location"]
    assert location.split("?")[0].endswith(".jpg")

    # Others see it in the member list.
    members = (await client.get(f"/workspaces/{team['ws']['id']}/members", headers=team["alice"]["headers"])).json()
    assert next(m for m in members if m["user_id"] == carol["id"])["avatar_url"].startswith(settings.api_public_url)

    r = await client.delete("/auth/me/avatar", headers=carol["headers"])
    assert r.status_code == 200 and r.json()["avatar_url"] is None
    assert len(deleted) == 2
    assert (await client.get(f"/users/{carol['id']}/avatar")).status_code == 404
    assert (await client.get(f"/users/{uuid.uuid4()}/avatar")).status_code == 404


async def test_avatar_validation(client, team, monkeypatch):
    h = team["alice"]["headers"]
    # Wrong type, or bytes that don't match the declared type.
    for name, data, ctype in [
        ("a.svg", b"<svg/>", "image/svg+xml"),
        ("a.txt", b"hello", "text/plain"),
        ("a.png", b"GIF89a" + b"\x00" * 20, "image/png"),
        ("a.webp", b"RIFF\x00\x00\x00\x00WAVE", "image/webp"),
    ]:
        r = await client.post("/auth/me/avatar", files={"file": (name, data, ctype)}, headers=h)
        assert r.status_code == 415, (name, r.status_code)
    # GIF and WebP are accepted.
    for name, data, ctype in [
        ("a.gif", b"GIF89a" + b"\x00" * 20, "image/gif"),
        ("a.webp", b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 20, "image/webp"),
    ]:
        r = await client.post("/auth/me/avatar", files={"file": (name, data, ctype)}, headers=h)
        assert r.status_code == 200, r.text

    monkeypatch.setattr(settings, "max_avatar_bytes", 50)
    r = await client.post("/auth/me/avatar", files={"file": ("a.png", PNG + b"\x00" * 100, "image/png")}, headers=h)
    assert r.status_code == 413
    # Refused from Content-Length alone, before the body is parsed.
    r = await client.post(
        "/auth/me/avatar",
        content=b"x" * 200_000,
        headers={**h, "Content-Type": "multipart/form-data; boundary=x"},
    )
    assert r.status_code == 413 and "Photo too large" in r.json()["detail"]
    await client.delete("/auth/me/avatar", headers=h)


async def test_user_updated_hides_email_from_guests():
    h = hub_module.Hub()
    ws_id, me = str(uuid.uuid4()), uuid.uuid4()
    member = hub_module.Connection(FakeWS(), uuid.uuid4(), set(), {ws_id})
    guest = hub_module.Connection(FakeWS(), uuid.uuid4(), set(), {ws_id}, guest_workspace_ids={ws_id})
    guest_self = hub_module.Connection(FakeWS(), me, set(), {ws_id}, guest_workspace_ids={ws_id})
    for c in (member, guest, guest_self):
        h.register(c)
    event = {"type": "user.updated", "user": {"user_id": str(me), "email": "me@example.com", "full_name": "Me"}}
    await h._dispatch(f"rt:workspace:{ws_id}", json.dumps(event))
    assert member.ws.sent == [event]
    assert guest.ws.sent == [{**event, "user": {**event["user"], "email": None}}]
    assert guest_self.ws.sent == [event]


# --- Board -----------------------------------------------------------------------------------


async def test_board_created_on_first_access_with_default_columns(client, team):
    general = team["general"]
    r = await client.get(f"/channels/{general['id']}/board", headers=team["bob"]["headers"])
    assert r.status_code == 200, r.text
    board = r.json()
    assert board["channel_id"] == general["id"]
    assert [c["name"] for c in board["columns"]] == ["To do", "In progress", "Done"]
    assert board["cards"] == []
    # Concurrent first access still yields a single board.
    ch = await _channel(client, team)
    rs = await asyncio.gather(*(client.get(f"/channels/{ch['id']}/board", headers=team["alice"]["headers"]) for _ in range(5)))
    assert {r.status_code for r in rs} == {200}
    assert len({r.json()["id"] for r in rs}) == 1
    assert all(len(r.json()["columns"]) == 3 for r in rs)


async def test_board_columns_crud(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(board_routes, "publish_to_channel", published)
    ch, h = team["general"], team["alice"]["headers"]
    board = (await client.get(f"/channels/{ch['id']}/board", headers=h)).json()
    todo, doing, done = board["columns"]

    r = await client.post(f"/channels/{ch['id']}/board/columns", json={"name": " Review ", "color": "#ff8800"}, headers=h)
    assert r.status_code == 201, r.text
    review = r.json()
    assert review["name"] == "Review" and review["color"] == "#ff8800"
    assert review["position"] > done["position"]

    # Move "Review" between "In progress" and "Done".
    pos = (doing["position"] + done["position"]) / 2
    r = await client.patch(f"/board/columns/{review['id']}", json={"position": pos, "name": "QA", "color": None}, headers=h)
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["color"], r.json()["position"]) == ("QA", None, pos)
    board = (await client.get(f"/channels/{ch['id']}/board", headers=h)).json()
    assert [c["name"] for c in board["columns"]] == ["To do", "In progress", "QA", "Done"]

    for bad in ({"name": ""}, {"name": "x" * 51}, {"color": "red; background:url(x)"}, {"position": "nan"}):
        assert (await client.patch(f"/board/columns/{review['id']}", json=bad, headers=h)).status_code == 422, bad

    # Deleting a column deletes its cards.
    card = (await client.post(f"/channels/{ch['id']}/board/cards", json={"column_id": review["id"], "title": "t"}, headers=h)).json()
    assert (await client.delete(f"/board/columns/{review['id']}", headers=h)).status_code == 204
    board = (await client.get(f"/channels/{ch['id']}/board", headers=h)).json()
    assert review["id"] not in {c["id"] for c in board["columns"]}
    assert card["id"] not in {c["id"] for c in board["cards"]}
    assert (await client.patch(f"/board/cards/{card['id']}", json={"title": "x"}, headers=h)).status_code == 404

    # The last column can't go.
    for col in (todo, doing):
        assert (await client.delete(f"/board/columns/{col['id']}", headers=h)).status_code == 204
    assert (await client.delete(f"/board/columns/{done['id']}", headers=h)).status_code == 400

    # Every change was broadcast to the channel with the full board.
    assert set(published.types()) == {"board.updated"}
    target, event = published.events[-1]
    assert target == ch["id"] and event["channel_id"] == ch["id"]
    assert [c["id"] for c in event["board"]["columns"]] == [done["id"]]


async def test_board_cards_create_edit_and_move(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(board_routes, "publish_to_channel", published)
    ch = await _channel(client, team)
    h = team["alice"]["headers"]
    todo, doing, _ = (await client.get(f"/channels/{ch['id']}/board", headers=h)).json()["columns"]

    async def add(title, column=todo, **extra):
        r = await client.post(f"/channels/{ch['id']}/board/cards", json={"column_id": column["id"], "title": title, **extra}, headers=h)
        assert r.status_code == 201, r.text
        return r.json()

    a = await add(
        "A",
        description="details",
        assignee_id=team["bob"]["id"],
        due_date="2026-12-01",
        labels=["bug", " ui ", "bug"],
    )
    assert a["labels"] == ["bug", "ui"] and a["due_date"] == "2026-12-01"
    assert a["assignee_id"] == team["bob"]["id"] and a["created_by"] == team["alice"]["id"]
    assert a["completed"] is False and a["created_at"] and a["updated_at"]
    b, c = await add("B"), await add("C")
    assert a["position"] < b["position"] < c["position"]  # appended at the end

    # Reorder within the column: C between A and B.
    r = await client.patch(f"/board/cards/{c['id']}", json={"position": (a["position"] + b["position"]) / 2}, headers=h)
    assert r.status_code == 200
    cards = (await client.get(f"/channels/{ch['id']}/board", headers=h)).json()["cards"]
    assert [x["title"] for x in cards if x["column_id"] == todo["id"]] == ["A", "C", "B"]

    # Move to another column without a position appends it there.
    d = await add("D", column=doing)
    r = await client.patch(f"/board/cards/{a['id']}", json={"column_id": doing["id"]}, headers=h)
    assert r.json()["column_id"] == doing["id"] and r.json()["position"] > d["position"]
    # ...and with a position lands exactly there.
    r = await client.patch(f"/board/cards/{b['id']}", json={"column_id": doing["id"], "position": d["position"] - 0.5}, headers=h)
    assert r.json()["position"] == d["position"] - 0.5
    cards = (await client.get(f"/channels/{ch['id']}/board", headers=h)).json()["cards"]
    assert [x["title"] for x in cards if x["column_id"] == doing["id"]] == ["B", "D", "A"]

    # Edits; null clears optional fields.
    r = await client.patch(
        f"/board/cards/{a['id']}",
        json={"title": "A2", "description": None, "assignee_id": None, "due_date": None, "labels": [], "completed": True},
        headers=h,
    )
    assert r.status_code == 200, r.text
    got = r.json()
    assert (got["title"], got["description"], got["assignee_id"], got["due_date"], got["labels"], got["completed"]) == (
        "A2", None, None, None, [], True
    )

    # Positions crowded beyond float precision get renumbered, keeping the order.
    def doing_cards(board):
        return [x for x in board["cards"] if x["column_id"] == doing["id"]]

    col = doing_cards((await client.get(f"/channels/{ch['id']}/board", headers=h)).json())
    assert [x["title"] for x in col] == ["B", "D", "A2"]
    await client.patch(f"/board/cards/{a['id']}", json={"position": col[0]["position"] + 1e-9}, headers=h)
    col = doing_cards((await client.get(f"/channels/{ch['id']}/board", headers=h)).json())
    assert [x["title"] for x in col] == ["B", "A2", "D"]
    assert [x["position"] for x in col] == [1.0, 2.0, 3.0]

    assert (await client.delete(f"/board/cards/{c['id']}", headers=h)).status_code == 204
    assert (await client.delete(f"/board/cards/{c['id']}", headers=h)).status_code == 404
    event = published.events[-1][1]
    assert event["type"] == "board.updated" and c["id"] not in {x["id"] for x in event["board"]["cards"]}


async def test_board_card_validation(client, team):
    ch, h = team["general"], team["alice"]["headers"]
    col = (await client.get(f"/channels/{ch['id']}/board", headers=h)).json()["columns"][0]
    url = f"/channels/{ch['id']}/board/cards"
    for bad in (
        {"column_id": col["id"], "title": " "},
        {"column_id": col["id"], "title": "x" * 201},
        {"column_id": col["id"], "title": "x", "labels": [f"l{i}" for i in range(11)]},
        {"column_id": col["id"], "title": "x", "labels": ["x" * 25]},
        {"column_id": col["id"], "title": "x", "labels": [""]},
        {"column_id": col["id"], "title": "x", "due_date": "tomorrow"},
    ):
        assert (await client.post(url, json=bad, headers=h)).status_code == 422, bad

    # Assignee must be in this workspace.
    outsider = await register(client, "outsider")
    r = await client.post(url, json={"column_id": col["id"], "title": "x", "assignee_id": outsider["id"]}, headers=h)
    assert r.status_code == 400
    # Columns of another channel's board are refused.
    other = await _channel(client, team)
    other_col = (await client.get(f"/channels/{other['id']}/board", headers=h)).json()["columns"][0]
    assert (await client.post(url, json={"column_id": other_col["id"], "title": "x"}, headers=h)).status_code == 400
    card = (await client.post(url, json={"column_id": col["id"], "title": "x"}, headers=h)).json()
    assert (await client.patch(f"/board/cards/{card['id']}", json={"column_id": other_col["id"]}, headers=h)).status_code == 400
    assert (await client.patch(f"/board/cards/{card['id']}", json={"assignee_id": outsider["id"]}, headers=h)).status_code == 400
    for bad in ({"title": None}, {"labels": None}, {"completed": None}, {"position": "inf"}):
        assert (await client.patch(f"/board/cards/{card['id']}", json=bad, headers=h)).status_code == 422, bad


async def test_board_access_rules(client, team):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    priv = await _channel(client, team, kind="private", members=("bob",))
    board = (await client.get(f"/channels/{priv['id']}/board", headers=bob["headers"])).json()
    col = board["columns"][0]
    card = (await client.post(f"/channels/{priv['id']}/board/cards", json={"column_id": col["id"], "title": "secret"}, headers=bob["headers"])).json()

    # Carol (workspace member, not in the private channel) and an outsider see nothing.
    outsider = await register(client, "outsider")
    for who in (carol, outsider):
        hh = who["headers"]
        assert (await client.get(f"/channels/{priv['id']}/board", headers=hh)).status_code == 404
        assert (await client.post(f"/channels/{priv['id']}/board/columns", json={"name": "x"}, headers=hh)).status_code == 404
        assert (await client.post(f"/channels/{priv['id']}/board/cards", json={"column_id": col["id"], "title": "x"}, headers=hh)).status_code == 404
        assert (await client.patch(f"/board/cards/{card['id']}", json={"title": "x"}, headers=hh)).status_code == 404
        assert (await client.delete(f"/board/cards/{card['id']}", headers=hh)).status_code == 404
        assert (await client.patch(f"/board/columns/{col['id']}", json={"name": "x"}, headers=hh)).status_code == 404
        assert (await client.delete(f"/board/columns/{col['id']}", headers=hh)).status_code == 404
    assert (await client.get(f"/channels/{priv['id']}/board")).status_code == 401

    # Guests: only boards of channels they were added to.
    pub = await _channel(client, team)
    guest = await _guest(client, team, channels=[team["general"]])
    gh = guest["headers"]
    assert (await client.get(f"/channels/{pub['id']}/board", headers=gh)).status_code == 404
    gcol = (await client.get(f"/channels/{team['general']['id']}/board", headers=gh)).json()["columns"][0]
    r = await client.post(f"/channels/{team['general']['id']}/board/cards", json={"column_id": gcol["id"], "title": "from guest"}, headers=gh)
    assert r.status_code == 201
    # The owner sees the guest's card.
    cards = (await client.get(f"/channels/{team['general']['id']}/board", headers=alice["headers"])).json()["cards"]
    assert "from guest" in {c["title"] for c in cards}


async def test_archived_board_is_read_only(client, team):
    ch, h = await _channel(client, team), team["alice"]["headers"]
    col = (await client.get(f"/channels/{ch['id']}/board", headers=h)).json()["columns"][0]
    card = (await client.post(f"/channels/{ch['id']}/board/cards", json={"column_id": col["id"], "title": "x"}, headers=h)).json()
    await _archive(ch["id"])
    assert (await client.get(f"/channels/{ch['id']}/board", headers=h)).status_code == 200
    assert (await client.post(f"/channels/{ch['id']}/board/columns", json={"name": "x"}, headers=h)).status_code == 403
    assert (await client.post(f"/channels/{ch['id']}/board/cards", json={"column_id": col["id"], "title": "x"}, headers=h)).status_code == 403
    assert (await client.patch(f"/board/cards/{card['id']}", json={"title": "y"}, headers=h)).status_code == 403
    assert (await client.delete(f"/board/cards/{card['id']}", headers=h)).status_code == 403
    assert (await client.patch(f"/board/columns/{col['id']}", json={"name": "y"}, headers=h)).status_code == 403
    assert (await client.delete(f"/board/columns/{col['id']}", headers=h)).status_code == 403


# --- Canvas ----------------------------------------------------------------------------------


def _doc(text: str) -> dict:
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


async def test_canvas_save_and_conflict(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(canvas_routes, "publish_to_channel", published)
    ch = await _channel(client, team)
    alice, bob = team["alice"], team["bob"]

    r = await client.get(f"/channels/{ch['id']}/canvas", headers=bob["headers"])
    assert r.status_code == 200
    canvas = r.json()
    assert (canvas["title"], canvas["content"], canvas["version"], canvas["updated_by"]) == (
        "Canvas", {"type": "doc", "content": []}, 0, None
    )
    assert canvas["channel_id"] == ch["id"] and canvas["updated_at"]

    url = f"/channels/{ch['id']}/canvas"
    r = await client.put(url, json={"title": "Plan", "content": _doc("v1"), "base_version": 0}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    saved = r.json()
    assert (saved["version"], saved["title"], saved["content"], saved["updated_by"]) == (1, "Plan", _doc("v1"), alice["id"])
    assert published.events == [(ch["id"], {"type": "canvas.updated", "channel_id": ch["id"], "canvas": saved})]

    # Bob edited from version 0 too: conflict, and he gets the current canvas back.
    r = await client.put(url, json={"title": "Bob", "content": _doc("bob"), "base_version": 0}, headers=bob["headers"])
    assert r.status_code == 409
    assert r.json() == {"detail": "Canvas changed", "canvas": saved}
    assert len(published.events) == 1

    r = await client.put(url, json={"title": "Bob", "content": _doc("bob"), "base_version": 1}, headers=bob["headers"])
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["updated_by"] == bob["id"]
    assert (await client.get(url, headers=alice["headers"])).json()["content"] == _doc("bob")

    # Concurrent saves from the same base: exactly one wins.
    rs = await asyncio.gather(
        *(client.put(url, json={"title": "T", "content": _doc(str(i)), "base_version": 2}, headers=alice["headers"]) for i in range(4))
    )
    assert sorted(r.status_code for r in rs) == [200, 409, 409, 409]
    assert (await client.get(url, headers=alice["headers"])).json()["version"] == 3


async def test_canvas_validation_size_and_access(client, team, monkeypatch):
    ch, h = await _channel(client, team), team["alice"]["headers"]
    url = f"/channels/{ch['id']}/canvas"
    for bad in (
        {"title": "", "content": _doc("x"), "base_version": 0},
        {"title": "x" * 201, "content": _doc("x"), "base_version": 0},
        {"title": "t", "content": {"type": "paragraph"}, "base_version": 0},
        {"title": "t", "content": "text", "base_version": 0},
        {"title": "t", "content": _doc("x"), "base_version": -1},
        {"title": "t", "content": _doc("x")},
    ):
        assert (await client.put(url, json=bad, headers=h)).status_code == 422, bad

    with monkeypatch.context() as m:
        m.setattr(settings, "max_canvas_bytes", 200)
        r = await client.put(url, json={"title": "t", "content": _doc("x" * 300), "base_version": 0}, headers=h)
        assert r.status_code == 413
        # Bodies far over the limit are refused before parsing.
        body = b"{" + b" " * 300_000 + b"}"
        r = await client.put(url, content=body, headers={**h, "Content-Type": "application/json"})
        assert r.status_code == 413

    priv = await _channel(client, team, kind="private")
    for who in (team["bob"], await register(client, "outsider")):
        assert (await client.get(f"/channels/{priv['id']}/canvas", headers=who["headers"])).status_code == 404
        r = await client.put(f"/channels/{priv['id']}/canvas", json={"title": "t", "content": _doc("x"), "base_version": 0}, headers=who["headers"])
        assert r.status_code == 404
    guest = await _guest(client, team)
    assert (await client.get(url, headers=guest["headers"])).status_code == 404
    assert (await client.get(url)).status_code == 401

    await _archive(ch["id"])
    assert (await client.get(url, headers=h)).status_code == 200
    r = await client.put(url, json={"title": "t", "content": _doc("x"), "base_version": 0}, headers=h)
    assert r.status_code == 403


async def test_canvas_presence_over_websocket(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(ws_routes, "publish_to_channel", published)
    monkeypatch.setattr(ws_routes, "publish_to_workspace", Recorder())
    alice, general = team["alice"], team["general"]
    priv = await _channel(client, team, kind="private", owner="bob")
    presence = {"type": "canvas.presence", "channel_id": general["id"]}
    frames = [
        {"type": "websocket.receive", "text": json.dumps({"type": "auth", "token": _token(alice["id"], 60)})},
        {"type": "websocket.receive", "text": json.dumps(presence)},
        {"type": "websocket.receive", "text": json.dumps(presence)},  # throttled
        {"type": "websocket.receive", "text": json.dumps({"type": "canvas.presence", "channel_id": priv["id"]})},
        {"type": "websocket.receive", "text": json.dumps({"type": "canvas.presence", "channel_id": "junk"})},
        {"type": "websocket.disconnect", "code": 1000},
    ]
    await asyncio.wait_for(ws_routes.websocket_endpoint(FakeWS(frames), token=None), timeout=5)
    assert published.events == [
        (general["id"], {"type": "canvas.presence", "channel_id": general["id"], "user_id": alice["id"]})
    ]


# --- Huddles ---------------------------------------------------------------------------------


@pytest.fixture
def huddle_events(monkeypatch):
    ws_events, ch_events = Recorder(), Recorder()
    monkeypatch.setattr(huddles, "publish_to_workspace", ws_events)
    monkeypatch.setattr(huddles, "publish_to_channel", ch_events)
    return ws_events, ch_events


@pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")
async def test_huddle_join_token_and_lifecycle(client, team, huddle_events):
    ws_events, ch_events = huddle_events
    ch = await _channel(client, team)
    alice, bob, ws = team["alice"], team["bob"], team["ws"]

    r = await client.post(f"/channels/{ch['id']}/huddle/join", headers=alice["headers"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["url"] == settings.livekit_public_url and out["room"] == f"huddle-{ch['id']}"

    claims = jwt.decode(out["token"], settings.livekit_api_secret, algorithms=["HS256"])
    assert claims["iss"] == settings.livekit_api_key == "devkey"
    assert claims["sub"] == alice["id"] and claims["name"] == "alice"
    assert claims["video"] == {
        "room": f"huddle-{ch['id']}",
        "roomJoin": True,
        "canPublish": True,
        "canSubscribe": True,
        "canPublishData": True,
    }
    now = time.time()
    assert claims["nbf"] <= now + 1 and abs(claims["exp"] - (now + 6 * 3600)) < 10
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(out["token"], "wrong-secret", algorithms=["HS256"])

    # Public channel: announced to the workspace.
    target, event = ws_events.events[-1]
    assert target == ws["id"] and event["type"] == "huddle.updated"
    assert event["channel_id"] == ch["id"] and event["participant_ids"] == [alice["id"]]
    started_at = event["started_at"]
    assert datetime.fromisoformat(started_at)

    await client.post(f"/channels/{ch['id']}/huddle/join", headers=bob["headers"])
    assert sorted(ws_events.events[-1][1]["participant_ids"]) == sorted([alice["id"], bob["id"]])
    assert ws_events.events[-1][1]["started_at"] == started_at  # unchanged by later joiners

    n = len(ws_events.events)
    assert (await client.post(f"/channels/{ch['id']}/huddle/heartbeat", headers=bob["headers"])).status_code == 204
    assert len(ws_events.events) == n  # heartbeats alone don't broadcast

    listed = (await client.get(f"/workspaces/{ws['id']}/huddles", headers=team["carol"]["headers"])).json()
    mine = next(x for x in listed if x["channel_id"] == ch["id"])
    assert sorted(mine["participant_ids"]) == sorted([alice["id"], bob["id"]])
    assert datetime.fromisoformat(mine["started_at"]) == datetime.fromisoformat(started_at)

    assert (await client.post(f"/channels/{ch['id']}/huddle/leave", headers=alice["headers"])).status_code == 204
    assert ws_events.events[-1][1]["participant_ids"] == [bob["id"]]
    assert (await client.post(f"/channels/{ch['id']}/huddle/leave", headers=bob["headers"])).status_code == 204
    assert ws_events.events[-1][1] == {"type": "huddle.updated", "channel_id": ch["id"], "participant_ids": [], "started_at": None}
    listed = (await client.get(f"/workspaces/{ws['id']}/huddles", headers=alice["headers"])).json()
    assert ch["id"] not in {x["channel_id"] for x in listed}
    assert not ch_events.events

    # A new huddle gets a new start time.
    await client.post(f"/channels/{ch['id']}/huddle/join", headers=alice["headers"])
    assert ws_events.events[-1][1]["started_at"] != started_at
    await client.post(f"/channels/{ch['id']}/huddle/leave", headers=alice["headers"])


async def test_huddle_participants_pruned_after_missed_heartbeats(client, team, huddle_events):
    ws_events, _ = huddle_events
    ch = await _channel(client, team)
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    for who in (alice, bob):
        await client.post(f"/channels/{ch['id']}/huddle/join", headers=who["headers"])
    # Bob's last heartbeat was 61 s ago.
    await huddles.redis.zadd(f"huddle:{ch['id']}", {bob["id"]: time.time() - 61})
    listed = (await client.get(f"/workspaces/{ws['id']}/huddles", headers=alice["headers"])).json()
    assert next(x for x in listed if x["channel_id"] == ch["id"])["participant_ids"] == [alice["id"]]
    assert ws_events.events[-1][1]["participant_ids"] == [alice["id"]]

    # The sweeper ends huddles nobody touches.
    await huddles.redis.zadd(f"huddle:{ch['id']}", {alice["id"]: time.time() - 61})
    await huddles.redis.delete(huddles.SWEEP_LOCK_KEY)
    await huddles.sweep()
    assert ws_events.events[-1][1] == {"type": "huddle.updated", "channel_id": ch["id"], "participant_ids": [], "started_at": None}
    assert not await huddles.redis.hexists(huddles.ACTIVE_KEY, ch["id"])
    assert not await huddles.redis.exists(f"huddle:{ch['id']}:started")

    # A heartbeat after lapsing puts the user back.
    await client.post(f"/channels/{ch['id']}/huddle/heartbeat", headers=bob["headers"])
    assert ws_events.events[-1][1]["participant_ids"] == [bob["id"]]
    await client.post(f"/channels/{ch['id']}/huddle/leave", headers=bob["headers"])


async def test_private_huddles_stay_private(client, team, huddle_events):
    ws_events, ch_events = huddle_events
    alice, bob, carol, ws = team["alice"], team["bob"], team["carol"], team["ws"]
    priv = await _channel(client, team, kind="private", members=("bob",))
    await client.post(f"/channels/{priv['id']}/huddle/join", headers=bob["headers"])
    # Announced on the channel topic only (members), never workspace-wide.
    assert not ws_events.events
    assert ch_events.events[-1] == (
        priv["id"],
        {"type": "huddle.updated", "channel_id": priv["id"], "participant_ids": [bob["id"]], "started_at": ch_events.events[-1][1]["started_at"]},
    )
    assert priv["id"] in {x["channel_id"] for x in (await client.get(f"/workspaces/{ws['id']}/huddles", headers=alice["headers"])).json()}
    assert priv["id"] not in {x["channel_id"] for x in (await client.get(f"/workspaces/{ws['id']}/huddles", headers=carol["headers"])).json()}

    for path in ("join", "heartbeat", "leave"):
        assert (await client.post(f"/channels/{priv['id']}/huddle/{path}", headers=carol["headers"])).status_code == 404
    outsider = await register(client, "outsider")
    assert (await client.get(f"/workspaces/{ws['id']}/huddles", headers=outsider["headers"])).status_code == 404
    assert (await client.post(f"/channels/{priv['id']}/huddle/join")).status_code == 401

    # Guests see huddles only in channels they're in.
    pub = await _channel(client, team)
    await client.post(f"/channels/{pub['id']}/huddle/join", headers=alice["headers"])
    guest = await _guest(client, team)
    listed = {x["channel_id"] for x in (await client.get(f"/workspaces/{ws['id']}/huddles", headers=guest["headers"])).json()}
    assert pub["id"] not in listed and priv["id"] not in listed
    assert (await client.post(f"/channels/{pub['id']}/huddle/join", headers=guest["headers"])).status_code == 404

    await client.post(f"/channels/{priv['id']}/huddle/leave", headers=bob["headers"])
    await client.post(f"/channels/{pub['id']}/huddle/leave", headers=alice["headers"])
    assert ch_events.events[-1][1]["participant_ids"] == []


async def test_archived_channel_has_no_huddles(client, team, huddle_events):
    ch = await _channel(client, team)
    await _archive(ch["id"])
    assert (await client.post(f"/channels/{ch['id']}/huddle/join", headers=team["alice"]["headers"])).status_code == 403


async def test_hub_hides_public_huddles_from_guests_outside_the_channel():
    h = hub_module.Hub()
    ws_id, cid = str(uuid.uuid4()), str(uuid.uuid4())
    member = hub_module.Connection(FakeWS(), uuid.uuid4(), set(), {ws_id})
    guest_in = hub_module.Connection(FakeWS(), uuid.uuid4(), {cid}, {ws_id}, guest_workspace_ids={ws_id})
    guest_out = hub_module.Connection(FakeWS(), uuid.uuid4(), set(), {ws_id}, guest_workspace_ids={ws_id})
    for c in (member, guest_in, guest_out):
        h.register(c)
    event = {"type": "huddle.updated", "channel_id": cid, "participant_ids": [], "started_at": None}
    await h._dispatch(f"rt:workspace:{ws_id}", json.dumps(event))
    assert member.ws.sent == [event] and guest_in.ws.sent == [event] and guest_out.ws.sent == []



async def test_canvas_identical_save_is_noop(client, team):
    alice, general = team["alice"], team["general"]
    url = f"/channels/{general['id']}/canvas"
    c = (await client.get(url, headers=alice["headers"])).json()
    body = {"title": "Plan", "content": {"type": "doc", "content": [{"type": "paragraph"}]}}
    saved = (await client.put(url, json={**body, "base_version": c["version"]}, headers=alice["headers"])).json()
    again = await client.put(url, json={**body, "base_version": saved["version"]}, headers=alice["headers"])
    assert again.status_code == 200 and again.json()["version"] == saved["version"]
    # Identical content is not a conflict even from a stale base_version.
    stale = await client.put(url, json={**body, "base_version": c["version"]}, headers=alice["headers"])
    assert stale.status_code == 200 and stale.json()["version"] == saved["version"]
