"""Wave A2 messaging: pins, bookmarks, forwards, scheduled sends, polls, link unfurls (SSRF
guard), special/group mentions, edit history, DM read state and search filters.

Nothing here touches the real internet: DNS and HTTP are mocked.
"""

import asyncio
import ipaddress
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select, update

from app import messaging_extras as mx
from app.core.db import SessionLocal
from app.models import Channel, Message, ScheduledMessage
from app.realtime.hub import presence_connect, presence_disconnect
from tests.conftest import register
from tests.test_hardening import Recorder

# --- helpers ----------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def no_unfurl_tasks(monkeypatch):
    """Never enqueue real Celery unfurl jobs from tests; record what would be scheduled."""
    scheduled: list[uuid.UUID] = []
    monkeypatch.setattr(mx, "schedule_unfurl", scheduled.append)
    return scheduled


@pytest.fixture
def channel_events(monkeypatch):
    rec = Recorder()
    monkeypatch.setattr(mx, "publish_to_channel", rec)
    return rec


@pytest.fixture
def user_events(monkeypatch):
    rec = Recorder()
    monkeypatch.setattr(mx, "notify_user", rec)
    return rec


def _of(rec: Recorder, kind: str) -> list[dict]:
    return [e for _, e in rec.events if e["type"] == kind]


async def _post(client, channel_id, who, body, **extra) -> dict:
    r = await client.post(
        f"/channels/{channel_id}/messages", json={"body": body, **extra}, headers=who["headers"]
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _channel(client, team, *, kind="public", members=(), owner="alice") -> dict:
    body = {
        "name": f"c-{uuid.uuid4().hex[:8]}",
        "kind": kind,
        "member_ids": [team[m]["id"] for m in members],
    }
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/channels", json=body, headers=team[owner]["headers"]
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _dm(client, team, a="alice", b="bob") -> dict:
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/dms",
        json={"user_ids": [team[b]["id"]]},
        headers=team[a]["headers"],
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _archive(channel_id: str) -> None:
    async with SessionLocal() as db:
        await db.execute(
            update(Channel).where(Channel.id == uuid.UUID(channel_id)).values(is_archived=True)
        )
        await db.commit()


async def _messages(client, channel_id, who) -> list[dict]:
    r = await client.get(f"/channels/{channel_id}/messages", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


async def _other_team(client) -> dict:
    eve = await register(client, "eve")
    ws = (
        await client.post(
            "/workspaces",
            json={"name": "Other", "slug": f"other-{uuid.uuid4().hex[:6]}"},
            headers=eve["headers"],
        )
    ).json()
    chans = (await client.get(f"/workspaces/{ws['id']}/channels", headers=eve["headers"])).json()
    return {"eve": eve, "ws": ws, "general": next(c for c in chans if c["name"] == "general")}


# --- MessageOut shape -------------------------------------------------------------------------


async def test_message_out_has_extras_defaults(client, team):
    msg = await _post(client, team["general"]["id"], team["alice"], "plain")
    for key, value in {
        "pinned": False,
        "pinned_by": None,
        "forwarded_from": None,
        "poll": None,
        "unfurls": [],
        "edit_count": 0,
        "scheduled": False,
    }.items():
        assert msg[key] == value, key


# --- Pins -------------------------------------------------------------------------------------


async def test_pin_unpin_list_and_realtime(client, team, channel_events):
    alice, bob, general = team["alice"], team["bob"], team["general"]
    await client.post(f"/channels/{general['id']}/join", headers=bob["headers"])
    m1 = await _post(client, general["id"], alice, "first")
    m2 = await _post(client, general["id"], alice, "second")

    r = await client.post(f"/messages/{m1['id']}/pin", headers=bob["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["pinned"] is True and r.json()["pinned_by"] == bob["id"]
    updated = _of(channel_events, "message.updated")
    assert len(updated) == 1 and updated[0]["message"]["pinned"] is True

    # Pinning again is a no-op (no second broadcast).
    assert (await client.post(f"/messages/{m1['id']}/pin", headers=bob["headers"])).status_code == 200
    assert len(_of(channel_events, "message.updated")) == 1

    await client.post(f"/messages/{m2['id']}/pin", headers=alice["headers"])
    pins = (await client.get(f"/channels/{general['id']}/pins", headers=bob["headers"])).json()
    assert [p["id"] for p in pins] == [m2["id"], m1["id"]]  # newest pin first
    timeline = {m["id"]: m for m in await _messages(client, general["id"], bob)}
    assert timeline[m1["id"]]["pinned"] and timeline[m2["id"]]["pinned"]

    r = await client.delete(f"/messages/{m1['id']}/pin", headers=alice["headers"])
    assert r.status_code == 200 and r.json()["pinned"] is False
    assert _of(channel_events, "message.updated")[-1]["message"]["pinned"] is False
    pins = (await client.get(f"/channels/{general['id']}/pins", headers=bob["headers"])).json()
    assert [p["id"] for p in pins] == [m2["id"]]


async def test_pin_permissions(client, team):
    alice, carol = team["alice"], team["carol"]
    ch = await _channel(client, team)  # public, only alice is a member
    msg = await _post(client, ch["id"], alice, "pin me")
    r = await client.post(f"/messages/{msg['id']}/pin", headers=carol["headers"])
    assert r.status_code == 403  # can read a public channel but must join to pin

    private = await _channel(client, team, kind="private", members=("bob",))
    secret = await _post(client, private["id"], alice, "secret")
    assert (await client.post(f"/messages/{secret['id']}/pin", headers=carol["headers"])).status_code == 404
    assert (await client.get(f"/channels/{private['id']}/pins", headers=carol["headers"])).status_code == 404

    other = await _other_team(client)
    assert (await client.post(f"/messages/{msg['id']}/pin", headers=other["eve"]["headers"])).status_code == 404

    await _archive(ch["id"])
    assert (await client.post(f"/messages/{msg['id']}/pin", headers=alice["headers"])).status_code == 403


async def test_system_messages_can_be_pinned(client, team):
    alice, general = team["alice"], team["general"]
    async with SessionLocal() as db:
        msg = Message(
            workspace_id=uuid.UUID(team["ws"]["id"]),
            channel_id=uuid.UUID(general["id"]),
            author_id=uuid.UUID(alice["id"]),
            body="",
            kind="system",
            meta={"type": "call"},
        )
        db.add(msg)
        await db.commit()
        msg_id = str(msg.id)
    r = await client.post(f"/messages/{msg_id}/pin", headers=alice["headers"])
    assert r.status_code == 200 and r.json()["pinned"] is True


# --- Bookmarks --------------------------------------------------------------------------------


async def test_bookmarks_crud_and_realtime(client, team, channel_events):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, members=("bob",))
    url = f"/channels/{ch['id']}/bookmarks"

    r = await client.post(url, json={"title": " Roadmap ", "url": "https://example.com/r", "emoji": "🗺️"}, headers=alice["headers"])
    assert r.status_code == 201, r.text
    b1 = r.json()
    assert b1["title"] == "Roadmap" and b1["emoji"] == "🗺️" and b1["created_by"] == alice["id"]
    b2 = (await client.post(url, json={"title": "Docs", "url": "http://docs.example.com"}, headers=bob["headers"])).json()
    assert b2["position"] > b1["position"]
    ev = _of(channel_events, "bookmarks.updated")[-1]
    assert ev["channel_id"] == ch["id"] and [b["id"] for b in ev["bookmarks"]] == [b1["id"], b2["id"]]

    # Reorder + clear emoji.
    r = await client.patch(f"/bookmarks/{b2['id']}", json={"position": 0, "emoji": None}, headers=alice["headers"])
    assert r.status_code == 200 and r.json()["emoji"] is None
    listed = (await client.get(url, headers=carol["headers"])).json()  # public: readers can list
    assert [b["id"] for b in listed] == [b2["id"], b1["id"]]
    assert [b["id"] for b in _of(channel_events, "bookmarks.updated")[-1]["bookmarks"]] == [b2["id"], b1["id"]]

    # Non-members can't change bookmarks; bad URLs are rejected.
    assert (await client.post(url, json={"title": "x", "url": "https://x.io"}, headers=carol["headers"])).status_code == 403
    assert (await client.patch(f"/bookmarks/{b1['id']}", json={"title": "x"}, headers=carol["headers"])).status_code == 403
    for bad in ("javascript:alert(1)", "ftp://example.com", "data:text/html,hi", "https://"):
        r = await client.post(url, json={"title": "x", "url": bad}, headers=alice["headers"])
        assert r.status_code == 422, bad
    assert (await client.post(url, json={"title": "x", "url": "https://x.io", "emoji": "nope!"}, headers=alice["headers"])).status_code == 422

    r = await client.delete(f"/bookmarks/{b1['id']}", headers=bob["headers"])
    assert r.status_code == 204
    assert [b["id"] for b in _of(channel_events, "bookmarks.updated")[-1]["bookmarks"]] == [b2["id"]]

    other = await _other_team(client)
    assert (await client.get(url, headers=other["eve"]["headers"])).status_code == 404
    assert (await client.delete(f"/bookmarks/{b2['id']}", headers=other["eve"]["headers"])).status_code == 404


# --- Forward ----------------------------------------------------------------------------------


async def test_forward_to_channels(client, team):
    alice, bob = team["alice"], team["bob"]
    source_ch = await _channel(client, team, kind="private", members=("bob",))
    src = await _post(client, source_ch["id"], alice, "launch is friday")
    target_a = await _channel(client, team, members=("bob",))
    dm = await _dm(client, team, "bob", "carol")

    r = await client.post(
        f"/messages/{src['id']}/forward",
        json={"channel_ids": [target_a["id"], dm["id"], target_a["id"]], "comment": " FYI "},
        headers=bob["headers"],
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert [m["channel_id"] for m in out] == [target_a["id"], dm["id"]]  # deduped
    for m in out:
        assert m["author_id"] == bob["id"] and m["body"] == "FYI"
        fwd = m["forwarded_from"]
        assert fwd["message_id"] == src["id"] and fwd["channel_id"] == source_ch["id"]
        assert fwd["author_id"] == alice["id"] and fwd["body_preview"] == "launch is friday"
    timeline = await _messages(client, dm["id"], team["carol"])
    assert timeline[0]["forwarded_from"]["message_id"] == src["id"]

    # A bare forward of a forward shares the original.
    r = await client.post(f"/messages/{out[0]['id']}/forward", json={"channel_ids": [target_a["id"]]}, headers=alice["headers"])
    assert r.status_code == 200
    again = r.json()[0]
    assert again["body"] == ""
    assert again["forwarded_from"]["message_id"] == out[0]["id"]  # had a comment, so it's the source
    r = await client.post(f"/messages/{again['id']}/forward", json={"channel_ids": [target_a["id"]]}, headers=alice["headers"])
    assert r.json()[0]["forwarded_from"]["message_id"] == out[0]["id"]


async def test_forward_permissions(client, team):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    private = await _channel(client, team, kind="private", members=("bob",))
    src = await _post(client, private["id"], alice, "secret plan")
    general = team["general"]

    # Carol can't read the source.
    r = await client.post(f"/messages/{src['id']}/forward", json={"channel_ids": [general["id"]]}, headers=carol["headers"])
    assert r.status_code == 404
    # Bob can't post into a private channel he isn't in (and nothing is posted anywhere).
    other_private = await _channel(client, team, kind="private", members=("carol",))
    before = len(await _messages(client, general["id"], bob))
    r = await client.post(
        f"/messages/{src['id']}/forward",
        json={"channel_ids": [general["id"], other_private["id"]]},
        headers=bob["headers"],
    )
    assert r.status_code == 404
    assert len(await _messages(client, general["id"], bob)) == before
    # Other workspace targets look like missing channels.
    other = await _other_team(client)
    r = await client.post(f"/messages/{src['id']}/forward", json={"channel_ids": [other["general"]["id"]]}, headers=bob["headers"])
    assert r.status_code == 404
    # Archived targets, too many targets, system messages.
    archived = await _channel(client, team, members=("bob",))
    await _archive(archived["id"])
    r = await client.post(f"/messages/{src['id']}/forward", json={"channel_ids": [archived["id"]]}, headers=bob["headers"])
    assert r.status_code == 403
    r = await client.post(
        f"/messages/{src['id']}/forward",
        json={"channel_ids": [str(uuid.uuid4()) for _ in range(11)]},
        headers=bob["headers"],
    )
    assert r.status_code == 422
    async with SessionLocal() as db:
        sysmsg = Message(
            workspace_id=uuid.UUID(team["ws"]["id"]), channel_id=uuid.UUID(general["id"]),
            author_id=uuid.UUID(alice["id"]), body="", kind="system", meta={"type": "call"},
        )
        db.add(sysmsg)
        await db.commit()
    r = await client.post(f"/messages/{sysmsg.id}/forward", json={"channel_ids": [general["id"]]}, headers=alice["headers"])
    assert r.status_code == 400


# --- Scheduled send ---------------------------------------------------------------------------


async def _make_due(scheduled_id: str) -> None:
    async with SessionLocal() as db:
        await db.execute(
            update(ScheduledMessage)
            .where(ScheduledMessage.id == uuid.UUID(scheduled_id))
            .values(send_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await db.commit()


def _in(minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()


async def test_schedule_validation_and_management(client, team, user_events):
    alice, bob, general, ws = team["alice"], team["bob"], team["general"], team["ws"]
    url = f"/channels/{general['id']}/scheduled"
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    too_far = (datetime.now(UTC) + timedelta(days=121)).isoformat()
    assert (await client.post(url, json={"body": "x", "send_at": past}, headers=alice["headers"])).status_code == 422
    assert (await client.post(url, json={"body": "x", "send_at": too_far}, headers=alice["headers"])).status_code == 422
    assert (await client.post(url, json={"body": "  ", "send_at": _in(5)}, headers=alice["headers"])).status_code == 422
    r = await client.post(url, json={"body": "x", "send_at": _in(5), "parent_id": str(uuid.uuid4())}, headers=alice["headers"])
    assert r.status_code == 400
    r = await client.post(url, json={"body": "x", "send_at": _in(5), "attachment_ids": [str(uuid.uuid4())]}, headers=alice["headers"])
    assert r.status_code == 400

    r = await client.post(url, json={"body": "standup in 5", "send_at": _in(60)}, headers=alice["headers"])
    assert r.status_code == 201, r.text
    sched = r.json()
    assert sched["status"] == "pending" and sched["channel_id"] == general["id"]
    assert _of(user_events, "scheduled.updated")

    listed = (await client.get(f"/workspaces/{ws['id']}/scheduled", headers=alice["headers"])).json()
    assert sched["id"] in {s["id"] for s in listed}
    # Private to the author.
    assert sched["id"] not in {s["id"] for s in (await client.get(f"/workspaces/{ws['id']}/scheduled", headers=bob["headers"])).json()}
    assert (await client.patch(f"/scheduled/{sched['id']}", json={"body": "hi"}, headers=bob["headers"])).status_code == 404
    assert (await client.delete(f"/scheduled/{sched['id']}", headers=bob["headers"])).status_code == 404
    assert (await client.post(f"/scheduled/{sched['id']}/send-now", headers=bob["headers"])).status_code == 404

    r = await client.patch(f"/scheduled/{sched['id']}", json={"body": "standup now", "send_at": _in(30)}, headers=alice["headers"])
    assert r.status_code == 200 and r.json()["body"] == "standup now"

    r = await client.delete(f"/scheduled/{sched['id']}", headers=alice["headers"])
    assert r.status_code == 204
    cancelled = (await client.get(f"/workspaces/{ws['id']}/scheduled?status=cancelled", headers=alice["headers"])).json()
    assert sched["id"] in {s["id"] for s in cancelled}
    assert (await client.patch(f"/scheduled/{sched['id']}", json={"body": "x"}, headers=alice["headers"])).status_code == 409
    assert (await client.post(f"/scheduled/{sched['id']}/send-now", headers=alice["headers"])).status_code == 409


async def test_scheduled_send_now(client, team):
    alice, bob, general = team["alice"], team["bob"], team["general"]
    sched = (await client.post(f"/channels/{general['id']}/scheduled", json={"body": "ship it", "send_at": _in(60)}, headers=alice["headers"])).json()
    timeline = await _messages(client, general["id"], bob)
    assert "ship it" not in {m["body"] for m in timeline}  # not in timelines until sent

    r = await client.post(f"/scheduled/{sched['id']}/send-now", headers=alice["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["body"] == "ship it" and r.json()["scheduled"] is False
    assert (await client.post(f"/scheduled/{sched['id']}/send-now", headers=alice["headers"])).status_code == 409
    sent = (await client.get(f"/workspaces/{team['ws']['id']}/scheduled?status=sent", headers=alice["headers"])).json()
    row = next(s for s in sent if s["id"] == sched["id"])
    assert row["sent_message_id"] == r.json()["id"]


async def test_scheduled_delivery_is_exactly_once(client, team, user_events):
    alice, bob, general = team["alice"], team["bob"], team["general"]
    body = f"due {uuid.uuid4().hex[:8]} <@{bob['id']}>"
    sched = (await client.post(f"/channels/{general['id']}/scheduled", json={"body": body, "send_at": _in(10)}, headers=alice["headers"])).json()
    await _make_due(sched["id"])

    # Several beat runs racing each other still post it once.
    await asyncio.gather(*(mx.deliver_due_scheduled() for _ in range(4)))
    await mx.deliver_due_scheduled()
    async with SessionLocal() as db:
        posted = list(
            await db.scalars(select(Message).where(Message.channel_id == uuid.UUID(general["id"]), Message.body == body))
        )
        row = await db.get(ScheduledMessage, uuid.UUID(sched["id"]))
    assert len(posted) == 1
    assert row.status == "sent" and row.sent_message_id == posted[0].id
    assert posted[0].author_id == uuid.UUID(alice["id"])
    assert any(e["scheduled"]["id"] == sched["id"] for e in _of(user_events, "scheduled.sent"))
    # Normal post path: mentions are indexed.
    mentions = (await client.get(f"/workspaces/{team['ws']['id']}/mentions", headers=bob["headers"])).json()
    assert str(posted[0].id) in {m["id"] for m in mentions}


async def test_scheduled_delivery_failure_marks_failed(client, team, user_events):
    alice = team["alice"]
    ch = await _channel(client, team)
    sched = (await client.post(f"/channels/{ch['id']}/scheduled", json={"body": "too late", "send_at": _in(10)}, headers=alice["headers"])).json()
    await _make_due(sched["id"])
    await _archive(ch["id"])
    await mx.deliver_due_scheduled()
    listed = (await client.get(f"/workspaces/{team['ws']['id']}/scheduled", headers=alice["headers"])).json()
    row = next(s for s in listed if s["id"] == sched["id"])
    assert row["status"] == "failed" and "archived" in row["error"]
    assert any(e["scheduled"]["id"] == sched["id"] for e in _of(user_events, "scheduled.failed"))
    # Editing a failed message needs a future time to re-arm it.
    r = await client.patch(f"/scheduled/{sched['id']}", json={"body": "x"}, headers=alice["headers"])
    assert r.status_code == 422


async def test_scheduled_attachments_are_not_orphan_swept(client, team):
    from app.models import Attachment
    from app.workers.tasks import purge_orphaned_uploads

    alice, general = team["alice"], team["general"]
    async with SessionLocal() as db:
        att = Attachment(
            workspace_id=uuid.UUID(team["ws"]["id"]), uploader_id=uuid.UUID(alice["id"]),
            storage_key=f"test/{uuid.uuid4()}", filename="a.txt", content_type="text/plain", size=1,
        )
        db.add(att)
        await db.commit()
        att_id = att.id
    r = await client.post(
        f"/channels/{general['id']}/scheduled",
        json={"body": "", "attachment_ids": [str(att_id)], "send_at": _in(60)},
        headers=alice["headers"],
    )
    assert r.status_code == 201, r.text
    # The same upload can't be reserved twice.
    r2 = await client.post(
        f"/channels/{general['id']}/scheduled",
        json={"body": "", "attachment_ids": [str(att_id)], "send_at": _in(60)},
        headers=alice["headers"],
    )
    assert r2.status_code == 400
    async with SessionLocal() as db:
        await purge_orphaned_uploads(db, datetime.now(UTC) + timedelta(days=1))
        assert await db.get(Attachment, att_id) is not None
    sent = await client.post(f"/scheduled/{r.json()['id']}/send-now", headers=alice["headers"])
    assert sent.status_code == 200 and sent.json()["attachments"][0]["id"] == str(att_id)


# --- Polls ------------------------------------------------------------------------------------


async def _poll(client, channel_id, who, **body) -> dict:
    payload = {"question": "Lunch?", "options": ["Pizza", "Sushi", "Tacos"], **body}
    r = await client.post(f"/channels/{channel_id}/polls", json=payload, headers=who["headers"])
    assert r.status_code == 201, r.text
    return r.json()


async def test_poll_vote_replace_and_close(client, team, channel_events):
    alice, bob, carol, general = team["alice"], team["bob"], team["carol"], team["general"]
    msg = await _poll(client, general["id"], alice)
    poll = msg["poll"]
    assert msg["body"] == "Lunch?" and msg["kind"] == "user"
    assert [o["text"] for o in poll["options"]] == ["Pizza", "Sushi", "Tacos"]
    assert poll["closed"] is False and poll["total_voters"] == 0 and poll["multiple"] is False
    pizza, sushi, tacos = (o["id"] for o in poll["options"])
    vote = f"/polls/{poll['id']}/vote"

    r = await client.post(vote, json={"option_ids": [pizza]}, headers=bob["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["my_votes"] == [pizza]
    r = await client.post(vote, json={"option_ids": [sushi]}, headers=bob["headers"])  # replace
    assert r.json()["my_votes"] == [sushi]
    r = await client.post(vote, json={"option_ids": [sushi]}, headers=carol["headers"])
    out = r.json()
    counts = {o["id"]: o["votes"] for o in out["options"]}
    assert counts == {pizza: 0, sushi: 2, tacos: 0} and out["total_voters"] == 2
    assert sorted(next(o for o in out["options"] if o["id"] == sushi)["voter_ids"]) == sorted([bob["id"], carol["id"]])

    # Broadcasts carry the fresh poll but never anyone's my_votes.
    last = _of(channel_events, "message.updated")[-1]["message"]["poll"]
    assert last["total_voters"] == 2 and last["my_votes"] == []
    # Reads are per viewer.
    timeline = {m["id"]: m for m in await _messages(client, general["id"], bob)}
    assert timeline[msg["id"]]["poll"]["my_votes"] == [sushi]

    assert (await client.post(vote, json={"option_ids": [pizza, sushi]}, headers=bob["headers"])).status_code == 400
    assert (await client.post(vote, json={"option_ids": [str(uuid.uuid4())]}, headers=bob["headers"])).status_code == 400
    r = await client.post(vote, json={"option_ids": []}, headers=bob["headers"])  # withdraw
    assert r.json()["my_votes"] == [] and r.json()["total_voters"] == 1

    assert (await client.post(f"/polls/{poll['id']}/close", headers=bob["headers"])).status_code == 403
    r = await client.post(f"/polls/{poll['id']}/close", headers=alice["headers"])
    assert r.status_code == 200 and r.json()["closed"] is True
    assert _of(channel_events, "message.updated")[-1]["message"]["poll"]["closed"] is True
    assert (await client.post(vote, json={"option_ids": [pizza]}, headers=bob["headers"])).status_code == 400


async def test_poll_multiple_anonymous_and_access(client, team):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, kind="private", members=("bob",))
    msg = await _poll(client, ch["id"], alice, multiple=True, anonymous=True)
    a, b, _ = (o["id"] for o in msg["poll"]["options"])
    r = await client.post(f"/polls/{msg['poll']['id']}/vote", json={"option_ids": [a, b, a]}, headers=bob["headers"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert sorted(out["my_votes"]) == sorted([a, b]) and out["total_voters"] == 1
    assert all(o["voter_ids"] == [] for o in out["options"])  # anonymous
    assert [o["votes"] for o in out["options"]] == [1, 1, 0]

    # Outsiders can't see or vote.
    assert (await client.post(f"/polls/{msg['poll']['id']}/vote", json={"option_ids": [a]}, headers=carol["headers"])).status_code == 404
    other = await _other_team(client)
    assert (await client.post(f"/polls/{msg['poll']['id']}/close", headers=other["eve"]["headers"])).status_code == 404

    # Validation.
    url = f"/channels/{ch['id']}/polls"
    for bad in (
        {"question": "Q", "options": ["only one"]},
        {"question": "Q", "options": [str(i) for i in range(11)]},
        {"question": "Q", "options": ["Same", "same"]},
        {"question": " ", "options": ["a", "b"]},
    ):
        assert (await client.post(url, json=bad, headers=alice["headers"])).status_code == 422, bad

    # Polls in threads.
    root = await _post(client, ch["id"], alice, "root")
    reply = await _poll(client, ch["id"], bob, parent_id=root["id"])
    assert reply["parent_id"] == root["id"] and reply["poll"]


# --- Link unfurls: SSRF guard ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("addr", "public"),
    [
        ("93.184.216.34", True),
        ("2606:4700:4700::1111", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),  # cloud metadata
        ("100.64.0.1", False),  # carrier-grade NAT
        ("0.0.0.0", False),
        ("224.0.0.1", False),
        ("::1", False),
        ("fe80::1", False),
        ("fc00::1", False),
        ("::ffff:127.0.0.1", False),  # IPv4-mapped
        ("::ffff:10.0.0.1", False),
        ("2002:7f00:0001::", False),  # 6to4 of 127.0.0.1
        ("64:ff9b::a00:1", False),  # NAT64 of 10.0.0.1
        ("198.18.0.1", False),  # benchmarking
    ],
)
def test_is_public_ip(addr, public):
    assert mx.is_public_ip(ipaddress.ip_address(addr)) is public


@pytest.fixture
def fake_dns(monkeypatch):
    table: dict[str, list[str]] = {}

    async def resolve(host, port):
        if host not in table:
            raise OSError("NXDOMAIN")
        return table[host]

    monkeypatch.setattr(mx, "_resolve", resolve)
    return table


async def test_check_url_blocks_private_targets(fake_dns):
    fake_dns.update(
        {
            "public.test": ["93.184.216.34"],
            "internal.test": ["10.0.0.5"],
            "mixed.test": ["93.184.216.34", "127.0.0.1"],  # any private answer blocks
            "rebind.test": ["::ffff:169.254.169.254"],
        }
    )
    await mx.check_url("https://public.test/page")
    for url in (
        "http://internal.test/",
        "http://mixed.test/",
        "http://rebind.test/",
        "http://127.0.0.1/",
        "http://[::1]:8080/",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost/",
        "http://foo.localhost/",
        "http://nxdomain.test/",
        "ftp://public.test/",
        "file:///etc/passwd",
        "http://user:pw@public.test/",
        "http://public.test:99999/",
    ):
        with pytest.raises(mx.UnsafeURLError):
            await mx.check_url(url)


async def test_safe_backend_checks_the_dialed_address(fake_dns, monkeypatch):
    fake_dns["rebind.test"] = ["127.0.0.1"]
    dialed = []

    async def fake_connect(self, host, port, **kw):
        dialed.append(host)
        raise AssertionError("must not dial")

    monkeypatch.setattr(mx.httpcore.AnyIOBackend, "connect_tcp", fake_connect)
    backend = mx.SafeNetworkBackend()
    with pytest.raises(mx.UnsafeURLError):
        await backend.connect_tcp("rebind.test", 80)
    with pytest.raises(mx.UnsafeURLError):
        await backend.connect_tcp("10.0.0.1", 443)
    with pytest.raises(mx.UnsafeURLError):
        await backend.connect_unix_socket("/var/run/docker.sock")
    assert dialed == []

    # A public answer dials the resolved IP (not the name), so DNS can't change in between.
    fake_dns["ok.test"] = ["93.184.216.34"]

    async def record_connect(self, host, port, **kw):
        dialed.append((host, port))
        return "stream"

    monkeypatch.setattr(mx.httpcore.AnyIOBackend, "connect_tcp", record_connect)
    assert await backend.connect_tcp("ok.test", 443) == "stream"
    assert dialed == [("93.184.216.34", 443)]


OG_PAGE = """<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Worklio &amp; friends">
<meta property="og:description" content="  Team chat,
   done right. ">
<meta property="og:image" content="/img/card.png">
<meta property="og:site_name" content="Worklio">
<link rel="icon" href="/favicon-32.png">
</head><body>hi</body></html>"""


async def test_fetch_preview_parses_opengraph(fake_dns):
    fake_dns["site.test"] = ["93.184.216.34"]
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=OG_PAGE)

    out = await mx.fetch_preview("https://site.test/post/1", transport=httpx.MockTransport(handler))
    assert out == {
        "url": "https://site.test/post/1",
        "title": "Worklio & friends",
        "description": "Team chat, done right.",
        "image_url": "https://site.test/img/card.png",
        "site_name": "Worklio",
        "favicon_url": "https://site.test/favicon-32.png",
    }
    assert seen[0].headers["user-agent"].startswith("WorklioBot/1.0")


async def test_fetch_preview_title_fallback_and_non_html(fake_dns):
    fake_dns["site.test"] = ["93.184.216.34"]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/plain":
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<title> Just a title </title>")
        if request.url.path == "/pdf":
            return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF")
        if request.url.path == "/empty":
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<p>nothing</p>")
        return httpx.Response(404)

    t = httpx.MockTransport(handler)
    plain = await mx.fetch_preview("http://site.test/plain", transport=t)
    assert plain["title"] == "Just a title" and plain["site_name"] == "site.test"
    assert plain["favicon_url"] == "http://site.test/favicon.ico"
    assert await mx.fetch_preview("http://site.test/pdf", transport=t) is None
    assert await mx.fetch_preview("http://site.test/empty", transport=t) is None
    assert await mx.fetch_preview("http://site.test/missing", transport=t) is None


async def test_fetch_preview_revalidates_every_redirect(fake_dns):
    fake_dns.update({"site.test": ["93.184.216.34"], "evil.test": ["192.168.0.10"]})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "evil.test":
            raise AssertionError("must never be requested")
        return {
            "/to-private": httpx.Response(302, headers={"location": "http://evil.test/admin"}),
            "/to-metadata": httpx.Response(301, headers={"location": "http://169.254.169.254/"}),
            "/to-file": httpx.Response(302, headers={"location": "file:///etc/passwd"}),
            "/hop1": httpx.Response(302, headers={"location": "/hop2"}),
            "/hop2": httpx.Response(302, headers={"location": "/final"}),
            "/final": httpx.Response(200, headers={"content-type": "text/html"}, text="<title>Made it</title>"),
            "/loop": httpx.Response(302, headers={"location": "/loop"}),
        }[request.url.path]

    t = httpx.MockTransport(handler)
    for path in ("/to-private", "/to-metadata", "/to-file"):
        with pytest.raises(mx.UnsafeURLError):
            await mx.fetch_preview(f"http://site.test{path}", transport=t)
    ok = await mx.fetch_preview("http://site.test/hop1", transport=t)
    assert ok["title"] == "Made it" and ok["url"] == "http://site.test/hop1"
    assert await mx.fetch_preview("http://site.test/loop", transport=t) is None  # > 3 redirects


async def test_fetch_preview_caps_body_size(fake_dns):
    fake_dns["big.test"] = ["93.184.216.34"]
    huge = "<title>Big</title>" + "x" * (3 * mx.UNFURL_MAX_BYTES)
    read = []

    async def stream():
        data = huge.encode()
        for i in range(0, len(data), 65536):
            read.append(i)
            yield data[i : i + 65536]

    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/html"}, content=stream())

    out = await mx.fetch_preview("http://big.test/", transport=httpx.MockTransport(handler))
    assert out["title"] == "Big"
    assert len(read) * 65536 <= mx.UNFURL_MAX_BYTES + 65536  # stopped reading at ~1 MB


def test_extract_urls():
    body = "see https://a.test/x, (http://b.test/y) and https://a.test/x again https://c.test https://d.test <@x>"
    assert mx.extract_urls(body) == ["https://a.test/x", "http://b.test/y", "https://c.test"]
    assert mx.extract_urls("no links <!here>") == []


# --- Link unfurls: pipeline -------------------------------------------------------------------


async def test_unfurl_pipeline_cache_and_hide(client, team, no_unfurl_tasks, channel_events):
    alice, bob, general = team["alice"], team["bob"], team["general"]
    host = f"u{uuid.uuid4().hex[:8]}.test"
    calls = []

    async def fake_fetch(url):
        calls.append(url)
        return {"url": url, "title": f"Title of {url}", "description": None, "image_url": None,
                "site_name": host, "favicon_url": None}

    msg = await _post(client, general["id"], alice, f"look https://{host}/a and https://{host}/b")
    assert no_unfurl_tasks == [uuid.UUID(msg["id"])]
    assert msg["unfurls"] == []

    async with SessionLocal() as db:
        assert await mx.run_unfurls(db, uuid.UUID(msg["id"]), fetch=fake_fetch) is True
    ev = _of(channel_events, "message.updated")[-1]["message"]
    assert [u["url"] for u in ev["unfurls"]] == [f"https://{host}/a", f"https://{host}/b"]
    assert sorted(calls) == [f"https://{host}/a", f"https://{host}/b"]

    # A second message with the same link is served from the 24 h cache.
    msg2 = await _post(client, general["id"], bob, f"dup https://{host}/a")
    async with SessionLocal() as db:
        await mx.run_unfurls(db, uuid.UUID(msg2["id"]), fetch=fake_fetch)
    assert len(calls) == 2

    # Only the author can hide a preview; it stays hidden after edits.
    assert (await client.delete(f"/messages/{msg['id']}/unfurls/0", headers=bob["headers"])).status_code == 403
    assert (await client.delete(f"/messages/{msg['id']}/unfurls/5", headers=alice["headers"])).status_code == 404
    r = await client.delete(f"/messages/{msg['id']}/unfurls/0", headers=alice["headers"])
    assert r.status_code == 204
    assert [u["url"] for u in _of(channel_events, "message.updated")[-1]["message"]["unfurls"]] == [f"https://{host}/b"]
    r = await client.patch(f"/messages/{msg['id']}", json={"body": f"edited https://{host}/a https://{host}/b"}, headers=alice["headers"])
    assert [u["url"] for u in r.json()["unfurls"]] == [f"https://{host}/b"]
    async with SessionLocal() as db:
        await mx.run_unfurls(db, uuid.UUID(msg["id"]), fetch=fake_fetch)
    timeline = {m["id"]: m for m in await _messages(client, general["id"], bob)}
    assert [u["url"] for u in timeline[msg["id"]]["unfurls"]] == [f"https://{host}/b"]

    # Editing the link away drops its preview immediately.
    r = await client.patch(f"/messages/{msg['id']}", json={"body": "no links now"}, headers=alice["headers"])
    assert r.json()["unfurls"] == []


async def test_unfurl_failures_are_cached_and_harmless(client, team):
    alice, general = team["alice"], team["general"]
    host = f"f{uuid.uuid4().hex[:8]}.test"

    async def blocked(url):
        raise mx.UnsafeURLError("private")

    msg = await _post(client, general["id"], alice, f"https://{host}/x")
    async with SessionLocal() as db:
        assert await mx.run_unfurls(db, uuid.UUID(msg["id"]), fetch=blocked) is False
        # Cached negative result: no refetch within the failure TTL.
        assert await mx.get_preview(db, f"https://{host}/x", fetch=blocked) is None


# --- Special mentions & user groups -----------------------------------------------------------


async def _mention_ids(client, team, who) -> set[str]:
    r = await client.get(f"/workspaces/{team['ws']['id']}/mentions", headers=team[who]["headers"])
    assert r.status_code == 200, r.text
    return {m["id"] for m in r.json()}


async def test_channel_and_everyone_mentions(client, team):
    alice = team["alice"]
    ch = await _channel(client, team, kind="private", members=("bob",))
    m1 = await _post(client, ch["id"], alice, "<!channel> heads up")
    m2 = await _post(client, ch["id"], alice, "<!everyone> also")
    bob_mentions = await _mention_ids(client, team, "bob")
    assert {m1["id"], m2["id"]} <= bob_mentions
    assert m1["id"] not in await _mention_ids(client, team, "carol")  # not a member
    assert m1["id"] not in await _mention_ids(client, team, "alice")  # never yourself


async def test_here_mentions_reach_online_members_only(client, team):
    alice, bob = team["alice"], team["bob"]
    ch = await _channel(client, team, members=("bob", "carol"))
    conn = uuid.uuid4().hex
    await presence_connect(bob["id"], conn)
    try:
        msg = await _post(client, ch["id"], alice, "<!here> who's around?")
    finally:
        await presence_disconnect(bob["id"], conn)
    assert msg["id"] in await _mention_ids(client, team, "bob")
    assert msg["id"] not in await _mention_ids(client, team, "carol")


async def test_group_mentions_and_group_permissions(client, team):
    alice, bob, carol, ws = team["alice"], team["bob"], team["carol"], team["ws"]
    handle = f"design-{uuid.uuid4().hex[:6]}"
    url = f"/workspaces/{ws['id']}/groups"
    r = await client.post(url, json={"handle": handle.upper(), "name": "Design", "member_ids": [bob["id"], carol["id"]]}, headers=bob["headers"])
    assert r.status_code == 201, r.text
    group = r.json()
    assert group["handle"] == handle and sorted(group["member_ids"]) == sorted([bob["id"], carol["id"]])
    assert group["id"] in {g["id"] for g in (await client.get(url, headers=carol["headers"])).json()}

    # Public channel: every group member who can read it is mentioned (even without joining).
    public = await _channel(client, team)
    m1 = await _post(client, public["id"], alice, f"<!subteam^{group['id']}> review please")
    assert m1["id"] in await _mention_ids(client, team, "bob")
    assert m1["id"] in await _mention_ids(client, team, "carol")
    # Private channel: only members who can read it.
    private = await _channel(client, team, kind="private", members=("bob",))
    m2 = await _post(client, private["id"], alice, f"<!subteam^{group['id']}> secret review")
    assert m2["id"] in await _mention_ids(client, team, "bob")
    assert m2["id"] not in await _mention_ids(client, team, "carol")
    # Groups from another workspace don't expand.
    other = await _other_team(client)
    foreign = (await client.post(f"/workspaces/{other['ws']['id']}/groups", json={"handle": "x", "name": "X"}, headers=other["eve"]["headers"])).json()
    m3 = await _post(client, public["id"], alice, f"<!subteam^{foreign['id']}> nope")
    assert m3["id"] not in await _mention_ids(client, team, "bob")

    # Validation and permissions.
    assert (await client.post(url, json={"handle": handle, "name": "Dup"}, headers=alice["headers"])).status_code == 409
    assert (await client.post(url, json={"handle": "here", "name": "x"}, headers=alice["headers"])).status_code == 422
    assert (await client.post(url, json={"handle": "bad handle", "name": "x"}, headers=alice["headers"])).status_code == 422
    assert (await client.post(url, json={"handle": "ok-1", "name": "x", "member_ids": [other["eve"]["id"]]}, headers=alice["headers"])).status_code == 400
    assert (await client.patch(f"/groups/{group['id']}", json={"name": "Nope"}, headers=carol["headers"])).status_code == 403
    r = await client.patch(f"/groups/{group['id']}", json={"name": "Design team", "member_ids": [carol["id"]]}, headers=alice["headers"])  # owner
    assert r.status_code == 200 and r.json()["name"] == "Design team" and r.json()["member_ids"] == [carol["id"]]
    r = await client.patch(f"/groups/{group['id']}", json={"name": "By creator"}, headers=bob["headers"])  # creator
    assert r.status_code == 200
    assert (await client.delete(f"/groups/{group['id']}", headers=other["eve"]["headers"])).status_code == 404
    assert (await client.delete(f"/groups/{group['id']}", headers=carol["headers"])).status_code == 403
    assert (await client.delete(f"/groups/{group['id']}", headers=bob["headers"])).status_code == 204

    guest = await register(client, "guest")
    await client.post(f"/workspaces/{ws['id']}/members", json={"email": guest["email"], "role": "guest"}, headers=alice["headers"])
    assert (await client.post(url, json={"handle": "guests", "name": "G"}, headers=guest["headers"])).status_code == 403


# --- Edit history -----------------------------------------------------------------------------


async def test_edit_history(client, team):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, kind="private", members=("bob",))
    msg = await _post(client, ch["id"], alice, "v1")
    await client.patch(f"/messages/{msg['id']}", json={"body": "v2"}, headers=alice["headers"])
    await client.patch(f"/messages/{msg['id']}", json={"body": "v2"}, headers=alice["headers"])  # no change
    r = await client.patch(f"/messages/{msg['id']}", json={"body": "v3"}, headers=alice["headers"])
    assert r.json()["edit_count"] == 2 and r.json()["body"] == "v3"
    edits = (await client.get(f"/messages/{msg['id']}/edits", headers=bob["headers"])).json()
    assert [e["body"] for e in edits] == ["v1", "v2"]
    assert all(e["edited_at"] for e in edits)
    assert (await client.get(f"/messages/{msg['id']}/edits", headers=carol["headers"])).status_code == 404


# --- Read receipts ----------------------------------------------------------------------------


async def test_dm_read_state(client, team, channel_events):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    dm = await _dm(client, team)
    await _post(client, dm["id"], alice, "hey")
    assert (await client.post(f"/channels/{dm['id']}/read", headers=bob["headers"])).status_code == 204
    state = (await client.get(f"/channels/{dm['id']}/read-state", headers=alice["headers"])).json()
    assert {s["user_id"] for s in state} == {alice["id"], bob["id"]}
    assert (await client.get(f"/channels/{dm['id']}/read-state", headers=carol["headers"])).status_code == 404
    assert (await client.get(f"/channels/{team['general']['id']}/read-state", headers=alice["headers"])).status_code == 400

    async with SessionLocal() as db:
        channel = await db.get(Channel, uuid.UUID(dm["id"]))
        await mx.publish_read_state(db, channel, uuid.UUID(bob["id"]))
        general = await db.get(Channel, uuid.UUID(team["general"]["id"]))
        await mx.publish_read_state(db, general, uuid.UUID(bob["id"]))  # channels: no event
    events = _of(channel_events, "channel.read")
    # One from POST /channels/{id}/read itself, one from the direct DM call; none for #general.
    assert len(events) == 2
    assert {e["channel_id"] for e in events} == {dm["id"]}
    bob_state = next(s for s in state if s["user_id"] == bob["id"])
    assert events[0]["user_id"] == bob["id"] and events[0]["channel_id"] == dm["id"]
    assert datetime.fromisoformat(events[0]["last_read_at"]) == datetime.fromisoformat(bob_state["last_read_at"])


# --- Search filters ---------------------------------------------------------------------------


def test_parse_search():
    sq = mx.parse_search('deploy from:@Alice in:#general has:link has:pins before:2026-01-02 after:2025-12-01 is:thread "exact words" from:me bogus:x before:nope')
    assert sq.from_ == ["Alice", "me"] and sq.in_ == ["general"]
    assert sq.has == {"link", "pin"} and sq.is_thread
    assert str(sq.before) == "2026-01-02" and str(sq.after) == "2025-12-01"
    assert sq.text == 'deploy "exact words" bogus:x before:nope'


async def test_search_filters(client, team):
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    word = f"zebra{uuid.uuid4().hex[:6]}"
    ch = await _channel(client, team, members=("bob",))
    a1 = await _post(client, ch["id"], alice, f"{word} release notes https://example.com/notes")
    b1 = await _post(client, team["general"]["id"], bob, f"{word} by bob")
    reply = await _post(client, ch["id"], bob, f"{word} thread reply", parent_id=a1["id"])
    await client.post(f"/messages/{b1['id']}/pin", headers=bob["headers"])
    await client.post(f"/messages/{a1['id']}/reactions", json={"emoji": "👍"}, headers=bob["headers"])

    async def search(q):
        r = await client.get(f"/workspaces/{ws['id']}/search", params={"q": q}, headers=alice["headers"])
        assert r.status_code == 200, r.text
        return {m["id"] for m in r.json()}

    assert await search(word) == {a1["id"], b1["id"], reply["id"]}
    assert await search(f"{word} from:@bob") == {b1["id"], reply["id"]}
    assert await search(f"{word} from:{alice['id']}") == {a1["id"]}
    assert await search(f"{word} from:me") == {a1["id"]}
    assert await search(f"{word} from:@nobody-{uuid.uuid4().hex[:4]}") == set()
    assert await search(f"{word} in:#{ch['name']}") == {a1["id"], reply["id"]}
    assert await search(f"{word} in:{team['general']['id']}") == {b1["id"]}
    assert await search(f"{word} has:link") == {a1["id"]}
    assert await search(f"{word} has:pin") == {b1["id"]}
    assert await search(f"{word} has:reaction") == {a1["id"]}
    assert await search(f"{word} is:thread") == {a1["id"], reply["id"]}
    assert await search(f'"{word} by bob"') == {b1["id"]}
    today = datetime.now(UTC).date()
    assert await search(f"{word} before:{today}") == set()
    assert await search(f"{word} after:{today - timedelta(days=1)}") == {a1["id"], b1["id"], reply["id"]}
    assert await search(f"{word} on:{today}") == {a1["id"], b1["id"], reply["id"]}
    # Filters alone (no words) list newest first.
    r = await client.get(f"/workspaces/{ws['id']}/search", params={"q": f"in:#{ch['name']}"}, headers=alice["headers"])
    assert [m["id"] for m in r.json()][:2] == [reply["id"], a1["id"]]
    # Filters never widen access: a private channel the searcher isn't in stays hidden.
    secret = await _channel(client, team, kind="private", members=("bob",), owner="bob")
    await _post(client, secret["id"], bob, f"{word} hidden")
    r = await client.get(f"/workspaces/{ws['id']}/search", params={"q": f"{word} in:{secret['id']}"}, headers=team["carol"]["headers"])
    assert r.json() == []
