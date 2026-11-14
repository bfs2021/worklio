"""Wave A1 productivity: Threads, Activity, Later, reminders, browse views (sent, calls, files,
unreads), channel prefs, sidebar sections, do-not-disturb and notification preferences."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from app import productivity as svc
from app.api.routes import (
    productivity_browse,
    productivity_inbox,
    productivity_later,
    productivity_sidebar,
)
from app.core.db import SessionLocal
from app.models import (
    Attachment,
    Call,
    CallInvite,
    Channel,
    ChannelMember,
    Message,
    Reminder,
    WorkspaceMember,
)
from tests.conftest import register
from tests.test_collab import _archive, _channel, _guest


class Recorder:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    async def __call__(self, target, event):
        self.events.append((str(target), event))

    def of(self, kind: str, target: str | None = None) -> list[dict]:
        return [e for t, e in self.events if e["type"] == kind and (target is None or t == target)]


@pytest.fixture
def rt(monkeypatch):
    """Capture realtime events from the productivity services and routes."""
    users, channels = Recorder(), Recorder()
    for mod in (svc, productivity_inbox, productivity_later, productivity_browse, productivity_sidebar):
        if hasattr(mod, "notify_user"):
            monkeypatch.setattr(mod, "notify_user", users)
        if hasattr(mod, "publish_to_channel"):
            monkeypatch.setattr(mod, "publish_to_channel", channels)
    return {"user": users, "channel": channels}


def H(u):
    return u["headers"]


async def _post(client, user, channel_id, body="hi", parent_id=None):
    payload = {"body": body}
    if parent_id:
        payload["parent_id"] = parent_id
    r = await client.post(f"/channels/{channel_id}/messages", json=payload, headers=H(user))
    assert r.status_code == 201, r.text
    return r.json()


async def _outsider(client):
    """A user in a different workspace."""
    eve = await register(client, "eve")
    r = await client.post(
        "/workspaces", json={"name": "Other", "slug": f"o-{uuid.uuid4().hex[:6]}"}, headers=H(eve)
    )
    assert r.status_code == 201, r.text
    eve["ws"] = r.json()
    return eve


def _future(**kw) -> str:
    return (datetime.now(UTC) + timedelta(**kw)).isoformat()


async def _message(message_id: str) -> Message:
    async with SessionLocal() as db:
        return await db.get(Message, uuid.UUID(message_id))


# --- Threads ------------------------------------------------------------------------------


async def test_threads_follow_rules_unread_and_read(client, team, rt):
    alice, bob, carol, ws, gen = team["alice"], team["bob"], team["carol"], team["ws"], team["general"]
    root = await _post(client, alice, gen["id"], "root")
    for i in range(4):
        await _post(client, bob, gen["id"], f"reply {i}", root["id"])
    url = f"/workspaces/{ws['id']}/threads"

    page = (await client.get(url, headers=H(alice))).json()
    assert [t["root"]["id"] for t in page["items"]] == [root["id"]]
    t = page["items"][0]
    assert t["reply_count"] == 4 and t["unread_count"] == 4
    assert [m["body"] for m in t["latest_replies"]] == ["reply 1", "reply 2", "reply 3"]
    assert t["participant_ids"] == [alice["id"], bob["id"]]
    assert t["channel_id"] == gen["id"] and page["next_cursor"] is None

    # Bob replied, so he follows it and his own replies are read.
    bob_t = (await client.get(url, headers=H(bob))).json()["items"]
    assert bob_t[0]["unread_count"] == 0
    # Carol is not involved.
    assert (await client.get(url, headers=H(carol))).json()["items"] == []
    # ... until she's mentioned in a reply.
    await _post(client, bob, gen["id"], f"cc <@{carol['id']}>", root["id"])
    carol_t = (await client.get(url, headers=H(carol))).json()["items"]
    assert len(carol_t) == 1 and carol_t[0]["unread_count"] == 5

    # Reading clears alice's unread count; only later replies count again.
    r = await client.post(f"/messages/{root['id']}/thread-read", headers=H(alice))
    assert r.status_code == 200 and r.json()["unread_count"] == 0 and r.json()["following"]
    assert rt["user"].of("thread.updated", alice["id"])[-1]["unread_count"] == 0
    assert (await client.get(url, params={"unread_only": True}, headers=H(alice))).json()["items"] == []
    await _post(client, carol, gen["id"], "late", root["id"])
    t = (await client.get(url, params={"unread_only": True}, headers=H(alice))).json()["items"][0]
    assert t["unread_count"] == 1 and t["reply_count"] == 6


async def test_thread_follow_unfollow_and_reply_resolves_to_root(client, team, rt):
    alice, bob, carol, ws, gen = team["alice"], team["bob"], team["carol"], team["ws"], team["general"]
    root = await _post(client, alice, gen["id"], "root")
    reply = await _post(client, bob, gen["id"], "reply", root["id"])
    url = f"/workspaces/{ws['id']}/threads"

    # Following via a reply id follows the root.
    r = await client.post(f"/messages/{reply['id']}/follow", headers=H(carol))
    assert r.status_code == 200 and r.json() == {
        "root_id": root["id"], "channel_id": gen["id"], "following": True, "unread_count": 1
    }
    assert [t["root"]["id"] for t in (await client.get(url, headers=H(carol))).json()["items"]] == [root["id"]]

    # Alice unfollows her own thread: it disappears even though she wrote the root.
    r = await client.delete(f"/messages/{root['id']}/follow", headers=H(alice))
    assert r.status_code == 200 and r.json()["following"] is False
    assert (await client.get(url, headers=H(alice))).json()["items"] == []
    assert (await client.get(f"/messages/{root['id']}/thread-state", headers=H(alice))).json()["following"] is False
    # Following again brings it back.
    await client.post(f"/messages/{root['id']}/follow", headers=H(alice))
    assert len((await client.get(url, headers=H(alice))).json()["items"]) == 1


async def test_threads_pagination(client, team, rt):
    alice, bob, ws, gen = team["alice"], team["bob"], team["ws"], team["general"]
    roots = []
    for i in range(3):
        root = await _post(client, alice, gen["id"], f"root {i}")
        await _post(client, bob, gen["id"], "r", root["id"])
        roots.append(root["id"])
    url = f"/workspaces/{ws['id']}/threads"
    p1 = (await client.get(url, params={"limit": 2}, headers=H(alice))).json()
    assert [t["root"]["id"] for t in p1["items"]] == roots[::-1][:2] and p1["next_cursor"]
    p2 = (await client.get(url, params={"limit": 2, "cursor": p1["next_cursor"]}, headers=H(alice))).json()
    assert [t["root"]["id"] for t in p2["items"]] == [roots[0]] and p2["next_cursor"] is None
    assert (await client.get(url, params={"cursor": "garbage!"}, headers=H(alice))).status_code == 400


async def test_threads_hide_channels_you_cannot_read(client, team, rt):
    alice, bob, carol, ws = team["alice"], team["bob"], team["carol"], team["ws"]
    secret = await _channel(client, team, kind="private", members=["bob"])
    root = await _post(client, alice, secret["id"], f"<@{carol['id']}> root")
    await _post(client, bob, secret["id"], "reply", root["id"])
    # Carol was "mentioned" in a channel she can't read: nothing leaks.
    assert (await client.get(f"/workspaces/{ws['id']}/threads", headers=H(carol))).json()["items"] == []
    assert (await client.post(f"/messages/{root['id']}/follow", headers=H(carol))).status_code == 404
    assert (await client.post(f"/messages/{root['id']}/thread-read", headers=H(carol))).status_code == 404


async def test_thread_realtime_fanout(client, team, rt):
    alice, bob, carol, gen = team["alice"], team["bob"], team["carol"], team["general"]
    root = await _post(client, alice, gen["id"], "root")
    await client.post(f"/messages/{root['id']}/follow", headers=H(carol))
    reply = await _post(client, bob, gen["id"], "reply", root["id"])
    async with SessionLocal() as db:
        await svc.on_message_created(db, await db.get(Message, uuid.UUID(reply["id"])))
    for u in (alice, carol):
        new = rt["user"].of("activity.new", u["id"])
        assert new and new[-1]["item"]["type"] == "thread_reply" and new[-1]["item"]["id"] == reply["id"]
        assert new[-1]["notify"] is True
        assert rt["user"].of("thread.updated", u["id"])[-1]["unread_count"] == 1
    # The author gets the thread state (0 unread) but no activity item.
    assert not rt["user"].of("activity.new", bob["id"])
    assert rt["user"].of("thread.updated", bob["id"])[-1]["unread_count"] == 0


# --- Activity -----------------------------------------------------------------------------


async def test_activity_feed_types_read_state_and_pagination(client, team, rt):
    alice, bob, carol, ws, gen = team["alice"], team["bob"], team["carol"], team["ws"], team["general"]
    url = f"/workspaces/{ws['id']}/activity"
    mine = await _post(client, alice, gen["id"], "my message")
    mention = await _post(client, bob, gen["id"], f"hey <@{alice['id']}>")
    r = await client.post(f"/messages/{mine['id']}/reactions", json={"emoji": "🎉"}, headers=H(carol))
    assert r.status_code == 200
    # Alice reacting to her own message is not activity.
    await client.post(f"/messages/{mine['id']}/reactions", json={"emoji": "👍"}, headers=H(alice))
    reply = await _post(client, carol, gen["id"], "thread reply", mine["id"])
    mention_reply = await _post(client, bob, gen["id"], f"<@{alice['id']}> in thread", mine["id"])

    page = (await client.get(url, headers=H(alice))).json()
    kinds = [(i["type"], i["message"]["id"] if i["message"] else None) for i in page["items"]]
    assert kinds == [
        ("mention", mention_reply["id"]),  # not duplicated as a thread_reply
        ("thread_reply", reply["id"]),
        ("reaction", mine["id"]),
        ("mention", mention["id"]),
    ]
    assert page["unread_count"] == 4 and all(not i["read"] for i in page["items"])
    reaction = page["items"][2]
    assert reaction["emoji"] == "🎉" and reaction["actor_id"] == carol["id"]
    assert reaction["channel_id"] == gen["id"]

    # Type filters.
    only = lambda t: client.get(url, params={"type": t}, headers=H(alice))
    assert [i["type"] for i in (await only("mentions")).json()["items"]] == ["mention", "mention"]
    assert [i["type"] for i in (await only("reactions")).json()["items"]] == ["reaction"]
    assert [i["type"] for i in (await only("threads")).json()["items"]] == ["thread_reply"]
    assert (await only("invites")).json()["items"] == []
    assert (await only("bogus")).status_code == 422

    # Pagination.
    p1 = (await client.get(url, params={"limit": 3}, headers=H(alice))).json()
    p2 = (await client.get(url, params={"limit": 3, "cursor": p1["next_cursor"]}, headers=H(alice))).json()
    assert [i["id"] for i in p1["items"] + p2["items"]] == [i["id"] for i in page["items"]]
    assert p2["next_cursor"] is None

    # Mark one read.
    r = await client.post(f"{url}/read", json={"ids": [reaction["id"]]}, headers=H(alice))
    assert r.status_code == 200 and r.json()["unread_count"] == 3
    assert rt["user"].of("activity.read", alice["id"])[-1]["ids"] == [reaction["id"]]
    unread = (await client.get(url, params={"unread_only": True}, headers=H(alice))).json()
    assert reaction["id"] not in {i["id"] for i in unread["items"]} and unread["unread_count"] == 3

    # Reading the thread marks its replies read.
    await client.post(f"/messages/{mine['id']}/thread-read", headers=H(alice))
    items = {i["id"]: i for i in (await client.get(url, headers=H(alice))).json()["items"]}
    assert items[reply["id"]]["read"] is True

    # Mark all read; newer items are unread again.
    r = await client.post(f"{url}/read", json={"all": True}, headers=H(alice))
    assert r.json()["unread_count"] == 0
    assert rt["user"].of("activity.read", alice["id"])[-1]["all"] is True
    await _post(client, carol, gen["id"], f"again <@{alice['id']}>")
    page = (await client.get(url, headers=H(alice))).json()
    assert page["unread_count"] == 1 and page["items"][0]["read"] is False
    assert all(i["read"] for i in page["items"][1:])

    # Other users' feeds are their own.
    assert (await client.get(url, params={"type": "reactions"}, headers=H(carol))).json()["items"] == []


async def test_activity_channel_invites_reminders_and_missed_calls(client, team, rt):
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    ch = await _channel(client, team, kind="private")
    async with SessionLocal() as db:
        channel = await db.get(Channel, uuid.UUID(ch["id"]))
        # Simulates channels.add_channel_member calling the hook after its commit.
        db.add(ChannelMember(channel_id=channel.id, user_id=uuid.UUID(bob["id"])))
        await db.commit()
        await svc.notify_channel_invite(db, channel, uuid.UUID(alice["id"]), {uuid.UUID(bob["id"])})
        # A missed call from alice in the channel.
        call = Call(
            workspace_id=channel.workspace_id, channel_id=channel.id, kind="audio", status="missed",
            started_by=uuid.UUID(alice["id"]), started_at=datetime.now(UTC), joined_ids=[],
        )
        db.add(call)
        await db.flush()
        db.add(CallInvite(
            call_id=call.id, user_id=uuid.UUID(bob["id"]), invited_by=uuid.UUID(alice["id"]),
            status="missed", expires_at=datetime.now(UTC),
        ))
        await db.commit()
        await svc.notify_call_missed(db, call.id, uuid.UUID(bob["id"]))

    invites = rt["user"].of("activity.new", bob["id"])
    assert [e["item"]["type"] for e in invites] == ["channel_invite", "call_missed"]
    page = (await client.get(f"/workspaces/{ws['id']}/activity", headers=H(bob))).json()
    assert [i["type"] for i in page["items"]] == ["call_missed", "channel_invite"]
    assert page["items"][0]["meta"]["call_id"] == str(call.id)
    assert page["items"][1]["actor_id"] == alice["id"] and page["items"][1]["channel_id"] == ch["id"]
    r = await client.get(f"/workspaces/{ws['id']}/activity", params={"type": "invites"}, headers=H(bob))
    assert [i["type"] for i in r.json()["items"]] == ["channel_invite"]

    # Leaving the private channel hides its items.
    await client.delete(f"/channels/{ch['id']}/members/me", headers=H(bob))
    assert (await client.get(f"/workspaces/{ws['id']}/activity", headers=H(bob))).json()["items"] == []


async def test_activity_tenant_isolation_and_guests(client, team, rt):
    alice, bob, ws, gen = team["alice"], team["bob"], team["ws"], team["general"]
    eve = await _outsider(client)
    for path in ("threads", "activity", "later", "reminders", "sent", "calls", "files", "unreads",
                 "channel-prefs", "sidebar-sections"):
        r = await client.get(f"/workspaces/{ws['id']}/{path}", headers=H(eve))
        assert r.status_code == 404, path
    assert (await client.post(f"/workspaces/{ws['id']}/read-all", headers=H(eve))).status_code == 404
    assert (await client.post(f"/workspaces/{ws['id']}/activity/read", json={"all": True}, headers=H(eve))).status_code == 404
    msg = await _post(client, alice, gen["id"], f"<@{eve['id']}> not a member")
    assert (await client.post(f"/messages/{msg['id']}/follow", headers=H(eve))).status_code == 404
    # Eve's own workspace shows nothing from Acme.
    assert (await client.get(f"/workspaces/{eve['ws']['id']}/activity", headers=H(eve))).json()["items"] == []

    # A guest never sees activity from public channels they weren't added to.
    room = await _channel(client, team, kind="private", members=["bob"])
    lobby = await _channel(client, team, members=["bob"])
    guest = await _guest(client, team, channels=[room])
    await _post(client, bob, lobby["id"], f"<@{guest['id']}> in a public channel")
    in_room = await _post(client, bob, room["id"], f"<@{guest['id']}> in room")
    items = (await client.get(f"/workspaces/{ws['id']}/activity", headers=H(guest))).json()["items"]
    assert [i["message"]["id"] for i in items if i["type"] == "mention"] == [in_room["id"]]


# --- Later & reminders --------------------------------------------------------------------


async def test_later_save_message_todo_lifecycle(client, team, rt):
    alice, bob, ws, gen = team["alice"], team["bob"], team["ws"], team["general"]
    url = f"/workspaces/{ws['id']}/later"
    msg = await _post(client, bob, gen["id"], "read this later")

    r = await client.post(url, json={"message_id": msg["id"]}, headers=H(alice))
    assert r.status_code == 201, r.text
    item = r.json()
    assert item["kind"] == "message" and item["message"]["id"] == msg["id"]
    assert item["message"]["saved"] is True and item["channel_id"] == gen["id"]
    assert item["status"] == "in_progress" and rt["user"].of("later.updated", alice["id"])
    # Saving it again returns the same item.
    r2 = await client.post(url, json={"message_id": msg["id"]}, headers=H(alice))
    assert r2.status_code == 200 and r2.json()["id"] == item["id"]
    # saved is per viewer.
    sent = (await client.get(f"/workspaces/{ws['id']}/sent", headers=H(bob))).json()["items"]
    assert sent[0]["id"] == msg["id"] and sent[0]["saved"] is False

    # Validation.
    assert (await client.post(url, json={}, headers=H(alice))).status_code == 422
    assert (await client.post(url, json={"title": "   "}, headers=H(alice))).status_code == 422
    assert (await client.post(url, json={"title": "x", "remind_at": "2001-01-01T00:00:00Z"}, headers=H(alice))).status_code == 422

    due = _future(days=1)
    todo = (await client.post(url, json={"title": "Ship A1", "notes": "n", "due_at": due}, headers=H(alice))).json()
    assert todo["kind"] == "todo" and todo["message"] is None and todo["title"] == "Ship A1"
    listing = (await client.get(url, headers=H(alice))).json()
    assert [i["id"] for i in listing] == [todo["id"], item["id"]]  # dated items first

    r = await client.patch(f"/later/{todo['id']}", json={"status": "completed"}, headers=H(alice))
    assert r.status_code == 200 and r.json()["completed_at"] is not None
    assert [i["id"] for i in (await client.get(url, params={"status": "completed"}, headers=H(alice))).json()] == [todo["id"]]
    r = await client.patch(f"/later/{todo['id']}", json={"status": "in_progress", "notes": ""}, headers=H(alice))
    assert r.json()["completed_at"] is None and r.json()["notes"] is None
    assert (await client.patch(f"/later/{todo['id']}", json={"title": None}, headers=H(alice))).status_code == 422
    r = await client.patch(f"/later/{item['id']}", json={"status": "archived"}, headers=H(alice))
    assert [i["id"] for i in (await client.get(url, params={"status": "archived"}, headers=H(alice))).json()] == [item["id"]]
    # Saving an archived message again brings it back.
    r = await client.post(url, json={"message_id": msg["id"]}, headers=H(alice))
    assert r.status_code == 200 and r.json()["status"] == "in_progress"

    # Only the owner can touch an item.
    assert (await client.patch(f"/later/{todo['id']}", json={"status": "archived"}, headers=H(bob))).status_code == 404
    assert (await client.delete(f"/later/{todo['id']}", headers=H(bob))).status_code == 404
    assert (await client.delete(f"/later/{todo['id']}", headers=H(alice))).status_code == 204
    assert rt["user"].of("later.deleted", alice["id"])[-1]["id"] == todo["id"]

    # A deleted message stays in Later but reads as null.
    await client.delete(f"/messages/{msg['id']}", headers=H(bob))
    listing = (await client.get(url, headers=H(alice))).json()
    assert listing[0]["id"] == item["id"] and listing[0]["message"] is None


async def test_later_isolation_guests_and_archived(client, team, rt):
    alice, bob, ws, gen = team["alice"], team["bob"], team["ws"], team["general"]
    eve = await _outsider(client)
    msg = await _post(client, alice, gen["id"], "x")
    # Not a member / message from another workspace.
    assert (await client.post(f"/workspaces/{ws['id']}/later", json={"title": "t"}, headers=H(eve))).status_code == 404
    assert (await client.post(f"/workspaces/{eve['ws']['id']}/later", json={"message_id": msg["id"]}, headers=H(eve))).status_code == 404

    secret = await _channel(client, team, kind="private", members=["bob"])
    hidden = await _post(client, bob, secret["id"], "secret")
    guest = await _guest(client, team, channels=[secret])
    lobby = await _channel(client, team)
    public = await _post(client, alice, lobby["id"], "public, but not the guest's")
    # The guest can save what they can read, not public channels they weren't added to.
    assert (await client.post(f"/workspaces/{ws['id']}/later", json={"message_id": hidden["id"]}, headers=H(guest))).status_code == 201
    assert (await client.post(f"/workspaces/{ws['id']}/later", json={"message_id": public["id"]}, headers=H(guest))).status_code == 404
    # Carol can't save a private message.
    assert (await client.post(f"/workspaces/{ws['id']}/later", json={"message_id": hidden["id"]}, headers=H(team["carol"]))).status_code == 404

    # Saving from an archived channel is fine (it's personal and read-only).
    old = await _channel(client, team)
    old_msg = await _post(client, alice, old["id"], "archived soon")
    await _archive(old["id"])
    assert (await client.post(f"/workspaces/{ws['id']}/later", json={"message_id": old_msg["id"]}, headers=H(alice))).status_code == 201


async def test_reminders_crud_and_saved_item_link(client, team, rt):
    alice, bob, ws, gen = team["alice"], team["bob"], team["ws"], team["general"]
    url = f"/workspaces/{ws['id']}/reminders"
    assert (await client.post(url, json={"text": "x", "remind_at": "2001-01-01T00:00:00Z"}, headers=H(alice))).status_code == 422
    assert (await client.post(url, json={"text": "x", "remind_at": _future(days=400)}, headers=H(alice))).status_code == 422
    assert (await client.post(url, json={"text": " ", "remind_at": _future(hours=1)}, headers=H(alice))).status_code == 422
    r = await client.post(url, json={"text": "Stand-up", "remind_at": _future(hours=1)}, headers=H(alice))
    assert r.status_code == 201 and r.json()["status"] == "pending"
    rem = r.json()
    assert rt["user"].of("reminder.updated", alice["id"])
    assert [x["id"] for x in (await client.get(url, headers=H(alice))).json()] == [rem["id"]]
    assert (await client.get(url, headers=H(bob))).json() == []
    # Snooze.
    later = _future(hours=2)
    r = await client.patch(f"/reminders/{rem['id']}", json={"remind_at": later}, headers=H(alice))
    assert r.status_code == 200 and r.json()["remind_at"].startswith(later[:16])
    assert (await client.delete(f"/reminders/{rem['id']}", headers=H(bob))).status_code == 404
    assert (await client.delete(f"/reminders/{rem['id']}", headers=H(alice))).status_code == 204

    # remind_at on a Later item drives its reminder.
    msg = await _post(client, bob, gen["id"], "follow up on this")
    item = (await client.post(f"/workspaces/{ws['id']}/later", json={"message_id": msg["id"], "remind_at": _future(hours=3)}, headers=H(alice))).json()
    pending = (await client.get(url, headers=H(alice))).json()
    assert len(pending) == 1 and pending[0]["saved_item_id"] == item["id"]
    assert pending[0]["message_id"] == msg["id"] and pending[0]["text"] == "follow up on this"
    # Completing the item cancels it; re-opening with a new time re-arms it.
    await client.patch(f"/later/{item['id']}", json={"status": "completed"}, headers=H(alice))
    assert (await client.get(url, headers=H(alice))).json() == []
    assert len((await client.get(url, params={"status": "cancelled"}, headers=H(alice))).json()) == 1
    await client.patch(f"/later/{item['id']}", json={"status": "in_progress", "remind_at": _future(hours=4)}, headers=H(alice))
    assert len((await client.get(url, headers=H(alice))).json()) == 1
    await client.patch(f"/later/{item['id']}", json={"remind_at": None}, headers=H(alice))
    assert (await client.get(url, headers=H(alice))).json() == []
    # Deleting a linked reminder clears the item's remind_at.
    await client.patch(f"/later/{item['id']}", json={"remind_at": _future(hours=5)}, headers=H(alice))
    rid = (await client.get(url, headers=H(alice))).json()[0]["id"]
    await client.delete(f"/reminders/{rid}", headers=H(alice))
    listing = (await client.get(f"/workspaces/{ws['id']}/later", headers=H(alice))).json()
    assert next(i for i in listing if i["id"] == item["id"])["remind_at"] is None


async def test_deliver_due_reminders_posts_to_self_dm_once(client, team, rt):
    alice, bob, carol, ws, gen = team["alice"], team["bob"], team["carol"], team["ws"], team["general"]
    url = f"/workspaces/{ws['id']}/reminders"
    msg = await _post(client, bob, gen["id"], "the thing")
    r1 = (await client.post(url, json={"text": "Do the thing", "remind_at": _future(minutes=5), "message_id": msg["id"]}, headers=H(alice))).json()
    r2 = (await client.post(url, json={"text": "Carol's", "remind_at": _future(minutes=5)}, headers=H(carol))).json()
    r3 = (await client.post(url, json={"text": "Not yet", "remind_at": _future(days=1)}, headers=H(alice))).json()
    async with SessionLocal() as db:
        await db.execute(
            update(Reminder)
            .where(Reminder.id.in_([uuid.UUID(r1["id"]), uuid.UUID(r2["id"])]))
            .values(remind_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        # Carol leaves the workspace before hers is due.
        await db.execute(
            WorkspaceMember.__table__.delete().where(
                WorkspaceMember.workspace_id == uuid.UUID(ws["id"]),
                WorkspaceMember.user_id == uuid.UUID(carol["id"]),
            )
        )
        await db.commit()

    async with SessionLocal() as db:
        delivered = await svc.deliver_due_reminders(db)
    assert delivered >= 1
    async with SessionLocal() as db:
        statuses = {
            str(r.id): r.status
            for r in await db.scalars(
                select(Reminder).where(Reminder.id.in_([uuid.UUID(x["id"]) for x in (r1, r2, r3)]))
            )
        }
        assert statuses == {r1["id"]: "sent", r2["id"]: "cancelled", r3["id"]: "pending"}
        # Delivered exactly once.
        assert await svc.deliver_due_reminders(db) == 0

    # The card is in alice's self-DM (created on the fly).
    due = [e for e in rt["user"].of("reminder.due", alice["id"]) if e["reminder"]["id"] == r1["id"]]
    assert len(due) == 1 and due[0]["reminder"]["status"] == "sent"
    created = [e for _, e in rt["channel"].events if e["type"] == "message.created"
               and e["message"]["meta"] and e["message"]["meta"].get("reminder_id") == r1["id"]]
    assert len(created) == 1
    card = created[0]["message"]
    assert card["kind"] == "system" and card["body"] == "⏰ Reminder: Do the thing"
    assert card["meta"] == {"type": "reminder", "reminder_id": r1["id"], "text": "Do the thing", "message_id": msg["id"]}
    dm = (await client.get(f"/channels/{card['channel_id']}", headers=H(alice))).json()
    assert dm["kind"] == "dm" and dm["member_ids"] == [alice["id"]]
    # The same self-DM the client opens with POST /dms.
    opened = (await client.post(f"/workspaces/{ws['id']}/dms", json={"user_ids": [alice["id"]]}, headers=H(alice))).json()
    assert opened["id"] == dm["id"]
    assert (await client.get(f"/channels/{dm['id']}", headers=H(bob))).status_code == 404

    # An activity item points at the message the reminder is about.
    items = (await client.get(f"/workspaces/{ws['id']}/activity", headers=H(alice))).json()["items"]
    reminder_items = [i for i in items if i["type"] == "reminder"]
    assert len(reminder_items) == 1
    assert reminder_items[0]["message"]["id"] == msg["id"]
    assert reminder_items[0]["meta"]["text"] == "Do the thing"
    assert rt["user"].of("activity.new", alice["id"])[-1]["item"]["type"] == "reminder"
    assert (await client.get(url, params={"status": "sent"}, headers=H(alice))).json()[0]["id"] == r1["id"]


# --- Sent, calls, files -------------------------------------------------------------------


async def test_sent_lists_my_messages_newest_first(client, team, rt):
    alice, bob, ws, gen = team["alice"], team["bob"], team["ws"], team["general"]
    a = await _post(client, alice, gen["id"], "one")
    b = await _post(client, alice, gen["id"], "two", a["id"])
    c = await _post(client, alice, gen["id"], "three")
    await _post(client, bob, gen["id"], "not mine")
    d = await _post(client, alice, gen["id"], "deleted")
    await client.delete(f"/messages/{d['id']}", headers=H(alice))
    url = f"/workspaces/{ws['id']}/sent"
    p1 = (await client.get(url, params={"limit": 2}, headers=H(alice))).json()
    assert [m["id"] for m in p1["items"]] == [c["id"], b["id"]]
    p2 = (await client.get(url, params={"limit": 2, "cursor": p1["next_cursor"]}, headers=H(alice))).json()
    assert [m["id"] for m in p2["items"]] == [a["id"]] and p2["next_cursor"] is None


async def _call(channel_id: str, starter: str, status_: str, **kw) -> Call:
    async with SessionLocal() as db:
        channel = await db.get(Channel, uuid.UUID(channel_id))
        call = Call(
            workspace_id=channel.workspace_id, channel_id=channel.id, kind="video", status=status_,
            started_by=uuid.UUID(starter), started_at=kw.pop("started_at", datetime.now(UTC)),
            joined_ids=[uuid.UUID(starter)], **kw,
        )
        db.add(call)
        await db.commit()
        return call


async def test_calls_history(client, team, rt):
    alice, bob, carol, ws, gen = team["alice"], team["bob"], team["carol"], team["ws"], team["general"]
    now = datetime.now(UTC)
    ended = await _call(gen["id"], alice["id"], "ended", started_at=now - timedelta(hours=2),
                        answered_at=now - timedelta(hours=2), ended_at=now - timedelta(hours=1),
                        notes={"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Decided X"}]}]})
    dm = (await client.post(f"/workspaces/{ws['id']}/dms", json={"user_ids": [bob["id"]]}, headers=H(alice))).json()
    live = await _call(dm["id"], alice["id"], "active", started_at=now - timedelta(minutes=5))
    url = f"/workspaces/{ws['id']}/calls"

    items = (await client.get(url, headers=H(alice))).json()["items"]
    assert [i["id"] for i in items][:2] == [str(live.id), str(ended.id)]
    by_id = {i["id"]: i for i in items}
    assert by_id[str(ended.id)]["channel_label_hint"] == f"#{gen['name']}"
    assert by_id[str(ended.id)]["notes_preview"] == "Decided X"
    assert by_id[str(ended.id)]["duration_s"] == 3600
    assert by_id[str(live.id)]["channel_label_hint"] == "bob"
    assert by_id[str(live.id)]["notes_preview"] is None
    active = (await client.get(url, params={"status": "active"}, headers=H(alice))).json()["items"]
    assert str(live.id) in {i["id"] for i in active} and str(ended.id) not in {i["id"] for i in active}
    ended_only = (await client.get(url, params={"status": "ended"}, headers=H(alice))).json()["items"]
    assert str(live.id) not in {i["id"] for i in ended_only}
    # Carol can't see the DM call.
    carol_ids = {i["id"] for i in (await client.get(url, headers=H(carol))).json()["items"]}
    assert str(ended.id) in carol_ids and str(live.id) not in carol_ids
    p1 = (await client.get(url, params={"limit": 1}, headers=H(alice))).json()
    assert len(p1["items"]) == 1 and p1["next_cursor"]


async def _attach(message_id: str, uploader: str, filename: str, content_type: str, kind=None):
    async with SessionLocal() as db:
        msg = await db.get(Message, uuid.UUID(message_id))
        a = Attachment(
            workspace_id=msg.workspace_id, uploader_id=uuid.UUID(uploader), message_id=msg.id,
            storage_key=f"test/{uuid.uuid4()}/{filename}", filename=filename,
            content_type=content_type, size=10, kind=kind,
        )
        db.add(a)
        await db.commit()
        return str(a.id)


async def test_files_browser_filters_and_access(client, team, rt):
    alice, bob, carol, ws, gen = team["alice"], team["bob"], team["carol"], team["ws"], team["general"]
    m1 = await _post(client, alice, gen["id"], "files")
    img = await _attach(m1["id"], alice["id"], "photo.png", "image/png")
    pdf = await _attach(m1["id"], alice["id"], "Q3_report.pdf", "application/pdf")
    m2 = await _post(client, bob, gen["id"], "voice")
    voice = await _attach(m2["id"], bob["id"], "voice.webm", "audio/webm", kind="voice")
    secret = await _channel(client, team, kind="private", members=["bob"])
    m3 = await _post(client, bob, secret["id"], "secret file")
    hidden = await _attach(m3["id"], bob["id"], "secret.txt", "text/plain")
    url = f"/workspaces/{ws['id']}/files"

    def ids(r):
        return [i["id"] for i in r.json()["items"]]

    everything = await client.get(url, headers=H(alice))
    assert set(ids(everything)) >= {img, pdf, voice, hidden}
    assert everything.json()["items"][0]["channel_id"] in (gen["id"], secret["id"])
    carol_ids = ids(await client.get(url, headers=H(carol)))
    assert hidden not in carol_ids and img in carol_ids
    assert ids(await client.get(url, params={"type": "images", "channel_id": gen["id"]}, headers=H(alice))) == [img]
    assert ids(await client.get(url, params={"type": "documents", "channel_id": gen["id"]}, headers=H(alice))) == [pdf]
    assert ids(await client.get(url, params={"type": "recordings", "channel_id": gen["id"]}, headers=H(alice))) == [voice]
    assert ids(await client.get(url, params={"type": "audio", "channel_id": gen["id"]}, headers=H(alice))) == [voice]
    assert ids(await client.get(url, params={"q": "q3_", "channel_id": gen["id"]}, headers=H(alice))) == [pdf]
    assert ids(await client.get(url, params={"q": "%", "channel_id": gen["id"]}, headers=H(alice))) == []
    assert set(ids(await client.get(url, params={"user_id": bob["id"]}, headers=H(alice)))) == {voice, hidden}
    p1 = await client.get(url, params={"limit": 1, "channel_id": gen["id"]}, headers=H(alice))
    p2 = await client.get(url, params={"limit": 5, "channel_id": gen["id"], "cursor": p1.json()["next_cursor"]}, headers=H(alice))
    assert ids(p1) + ids(p2) == ids(await client.get(url, params={"channel_id": gen["id"]}, headers=H(alice)))
    # Deleting the message hides its files.
    await client.delete(f"/messages/{m1['id']}", headers=H(alice))
    assert img not in ids(await client.get(url, headers=H(alice)))


# --- Unreads & channel prefs --------------------------------------------------------------


async def test_unreads_muted_mentions_archived_and_read_all(client, team, rt):
    alice, bob, carol, ws, gen = team["alice"], team["bob"], team["carol"], team["ws"], team["general"]
    url = f"/workspaces/{ws['id']}/unreads"
    await client.post(f"/workspaces/{ws['id']}/read-all", headers=H(alice))
    noisy = await _channel(client, team, members=["bob"])
    gone = await _channel(client, team, members=["bob"])
    await _post(client, bob, gen["id"], "g1")
    await _post(client, bob, gen["id"], f"<@{alice['id']}> g2")
    await _post(client, bob, noisy["id"], "n1")
    await _post(client, bob, gone["id"], "x")
    await _archive(gone["id"])
    root = await _post(client, alice, gen["id"], "mine doesn't count")
    await _post(client, bob, gen["id"], "replies don't count", root["id"])
    for i in range(25):
        await _post(client, carol, gen["id"], f"spam {i}")
    r = await client.patch(f"/channels/{noisy['id']}/prefs", json={"muted": True}, headers=H(alice))
    assert r.status_code == 200 and r.json()["muted"] is True

    data = (await client.get(url, headers=H(alice))).json()
    assert [c["channel_id"] for c in data] == [gen["id"], noisy["id"]]  # muted last, archived skipped
    g, n = data
    assert g["unread_count"] == 27 and g["mention_count"] == 1 and g["muted"] is False
    assert len(g["messages"]) == 20 and g["messages"][-1]["body"] == "spam 24"
    assert g["messages"][0]["body"] == "spam 5"  # the 20 newest, oldest first
    assert n["muted"] is True and n["unread_count"] == 1 and n["messages"][0]["body"] == "n1"
    # The sidebar badge agrees (unread counts are still computed for muted channels).
    chans = {c["id"]: c for c in (await client.get(f"/workspaces/{ws['id']}/channels", headers=H(alice))).json()}
    assert chans[gen["id"]]["unread_count"] == 27 and chans[noisy["id"]]["unread_count"] == 1

    dm = (await client.post(f"/workspaces/{ws['id']}/dms", json={"user_ids": [bob["id"]]}, headers=H(alice))).json()
    r = await client.post(f"/workspaces/{ws['id']}/read-all", headers=H(alice))
    assert r.status_code == 204
    assert (await client.get(url, headers=H(alice))).json() == []
    assert rt["user"].of("channels.read_all", alice["id"])
    receipts = rt["channel"].of("channel.read", dm["id"])
    assert receipts and receipts[-1]["user_id"] == alice["id"]
    # Bob's unreads are untouched.
    assert any(c["channel_id"] == gen["id"] for c in (await client.get(url, headers=H(bob))).json())


async def test_channel_prefs_sections_and_notification_rules(client, team, rt):
    alice, bob, carol, ws, gen = team["alice"], team["bob"], team["carol"], team["ws"], team["general"]
    eve = await _outsider(client)
    secret = await _channel(client, team, kind="private", members=["bob"])

    # Defaults: nothing stored.
    assert (await client.get(f"/workspaces/{ws['id']}/channel-prefs", headers=H(alice))).json() == []
    r = await client.patch(f"/channels/{gen['id']}/prefs", json={"starred": True, "notify": "mentions"}, headers=H(alice))
    assert r.status_code == 200
    assert r.json() == {"channel_id": gen["id"], "muted": False, "notify": "mentions", "starred": True, "section_id": None}
    assert rt["user"].of("channel_prefs.updated", alice["id"])[-1]["pref"]["starred"] is True
    r = await client.patch(f"/channels/{gen['id']}/prefs", json={"muted": True}, headers=H(alice))
    assert r.json()["starred"] is True and r.json()["muted"] is True  # merged, not replaced
    assert (await client.patch(f"/channels/{gen['id']}/prefs", json={"notify": "loud"}, headers=H(alice))).status_code == 422
    assert (await client.patch(f"/channels/{gen['id']}/prefs", json={"muted": None}, headers=H(alice))).status_code == 422
    assert (await client.patch(f"/channels/{secret['id']}/prefs", json={"muted": True}, headers=H(carol))).status_code == 404
    assert (await client.patch(f"/channels/{gen['id']}/prefs", json={"muted": True}, headers=H(eve))).status_code == 404

    # Sections.
    surl = f"/workspaces/{ws['id']}/sidebar-sections"
    s1 = (await client.post(surl, json={"name": " Projects "}, headers=H(alice))).json()
    s2 = (await client.post(surl, json={"name": "Social"}, headers=H(alice))).json()
    assert s1["name"] == "Projects" and s2["position"] > s1["position"]
    assert (await client.post(surl, json={"name": ""}, headers=H(alice))).status_code == 422
    r = await client.patch(f"/sidebar-sections/{s2['id']}", json={"position": 0, "collapsed": True}, headers=H(alice))
    assert r.status_code == 200 and r.json()["collapsed"] is True
    assert [s["id"] for s in (await client.get(surl, headers=H(alice))).json()] == [s2["id"], s1["id"]]
    assert rt["user"].of("sidebar_sections.updated", alice["id"])
    assert (await client.get(surl, headers=H(bob))).json() == []
    assert (await client.patch(f"/sidebar-sections/{s1['id']}", json={"name": "x"}, headers=H(bob))).status_code == 404
    assert (await client.patch(f"/sidebar-sections/{s1['id']}", json={"name": None}, headers=H(alice))).status_code == 422

    r = await client.patch(f"/channels/{gen['id']}/prefs", json={"section_id": s1["id"]}, headers=H(alice))
    assert r.json()["section_id"] == s1["id"]
    # Someone else's section can't be used.
    bob_s = (await client.post(surl, json={"name": "Bob's"}, headers=H(bob))).json()
    assert (await client.patch(f"/channels/{gen['id']}/prefs", json={"section_id": bob_s["id"]}, headers=H(alice))).status_code == 400
    # Deleting a section drops its channels back to the default.
    assert (await client.delete(f"/sidebar-sections/{s1['id']}", headers=H(alice))).status_code == 204
    prefs = (await client.get(f"/workspaces/{ws['id']}/channel-prefs", headers=H(alice))).json()
    assert prefs == [{"channel_id": gen["id"], "muted": True, "notify": "mentions", "starred": True, "section_id": None}]

    # Notification rules.
    a, g = uuid.UUID(alice["id"]), uuid.UUID(gen["id"])
    async with SessionLocal() as db:
        assert await svc.should_notify(db, a, g, "mention") is False  # muted
        await client.patch(f"/channels/{gen['id']}/prefs", json={"muted": False}, headers=H(alice))
        db.expire_all()
        assert await svc.should_notify(db, a, g, "mention") is True
        assert await svc.should_notify(db, a, g, "reaction") is False  # notify = mentions
        await client.patch(f"/channels/{gen['id']}/prefs", json={"notify": "nothing"}, headers=H(alice))
        db.expire_all()
        assert await svc.should_notify(db, a, g, "mention") is False
        assert await svc.should_notify(db, a, g, "reminder") is True  # reminders ignore channel prefs
        assert await svc.should_notify(db, a, None, "channel_invite") is True


async def test_muted_mention_is_listed_but_silent(client, team, rt):
    alice, bob, gen = team["alice"], team["bob"], team["general"]
    await client.patch(f"/channels/{gen['id']}/prefs", json={"muted": True}, headers=H(alice))
    msg = await _post(client, bob, gen["id"], f"<@{alice['id']}> ping")
    async with SessionLocal() as db:
        await svc.on_message_created(db, await db.get(Message, uuid.UUID(msg["id"])))
    ev = rt["user"].of("activity.new", alice["id"])[-1]
    assert ev["item"]["type"] == "mention" and ev["item"]["message"]["id"] == msg["id"]
    assert ev["notify"] is False


# --- DND & preferences --------------------------------------------------------------------


async def test_dnd(client, team, rt):
    alice, bob, ws, gen = team["alice"], team["bob"], team["ws"], team["general"]
    until = _future(minutes=30)
    r = await client.put("/auth/me/dnd", json={"until": until}, headers=H(alice))
    assert r.status_code == 200 and r.json()["dnd_until"].startswith(until[:16])
    assert (await client.get("/auth/me", headers=H(alice))).json()["dnd_until"] is not None
    members = (await client.get(f"/workspaces/{ws['id']}/members", headers=H(bob))).json()
    assert next(m for m in members if m["user_id"] == alice["id"])["dnd_until"] is not None
    async with SessionLocal() as db:
        assert await svc.should_notify(db, uuid.UUID(alice["id"]), uuid.UUID(gen["id"]), "mention") is False
    assert (await client.put("/auth/me/dnd", json={"until": "2001-01-01T00:00:00Z"}, headers=H(alice))).status_code == 422
    assert (await client.put("/auth/me/dnd", json={"until": _future(days=500)}, headers=H(alice))).status_code == 422
    r = await client.put("/auth/me/dnd", json={"until": None}, headers=H(alice))
    assert r.status_code == 200 and r.json()["dnd_until"] is None
    async with SessionLocal() as db:
        assert await svc.should_notify(db, uuid.UUID(alice["id"]), uuid.UUID(gen["id"]), "mention") is True


async def test_expired_dnd_reads_as_off(client, team, rt):
    from app.models import User

    alice = team["alice"]
    async with SessionLocal() as db:
        await db.execute(
            update(User).where(User.id == uuid.UUID(alice["id"])).values(dnd_until=datetime.now(UTC) - timedelta(minutes=1))
        )
        await db.commit()
    assert (await client.get("/auth/me", headers=H(alice))).json()["dnd_until"] is None


async def test_preferences_validation(client, team):
    alice = team["alice"]
    url = "/auth/me/preferences"
    good = {
        "show_workspace_switcher": "auto",
        "sidebar_compact": True,
        "sidebar_hidden_items": ["files", "drafts", "files"],
        "notify_schedule": {"enabled": True, "days": [5, 1, 1], "start": "08:30", "end": "17:00", "tz": "Europe/Berlin"},
        "notify_sound": False,
        "desktop_notify": "mentions",
    }
    r = await client.patch(url, json=good, headers=H(alice))
    assert r.status_code == 200, r.text
    prefs = r.json()["preferences"]
    assert prefs["sidebar_hidden_items"] == ["files", "drafts"]
    assert prefs["notify_schedule"] == {"enabled": True, "days": [1, 5], "start": "08:30", "end": "17:00", "tz": "Europe/Berlin"}
    assert prefs["desktop_notify"] == "mentions" and prefs["notify_sound"] is False
    for bad in (
        {"show_workspace_switcher": "sometimes"},
        {"sidebar_hidden_items": ["channels"]},
        {"notify_schedule": {"enabled": True, "days": [7]}},
        {"notify_schedule": {"enabled": True, "start": "25:00"}},
        {"notify_schedule": {"enabled": True, "tz": "Mars/Base"}},
        {"desktop_notify": "loud"},
        {"sidebar_compact": "very"},
    ):
        assert (await client.patch(url, json=bad, headers=H(alice))).status_code == 422, bad
    r = await client.patch(url, json={"notify_schedule": None}, headers=H(alice))
    assert "notify_schedule" not in r.json()["preferences"]
    assert r.json()["preferences"]["sidebar_compact"] is True  # other keys kept


def test_notify_schedule_windows():
    sched = {"enabled": True, "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00", "tz": "UTC"}
    monday_10 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)  # a Monday
    assert svc.in_notify_schedule(sched, monday_10)
    assert not svc.in_notify_schedule(sched, monday_10.replace(hour=8, minute=59))
    assert not svc.in_notify_schedule(sched, monday_10.replace(hour=18))
    assert not svc.in_notify_schedule(sched, datetime(2026, 11, 15, 10, tzinfo=UTC))  # Sunday
    # Time zones: 08:30 UTC is 09:30 in Berlin.
    berlin = {**sched, "tz": "Europe/Berlin"}
    assert svc.in_notify_schedule(berlin, monday_10.replace(hour=8, minute=30))
    # Overnight window starting Friday 22:00 runs into Saturday morning.
    night = {"enabled": True, "days": [5], "start": "22:00", "end": "06:00", "tz": "UTC"}
    assert svc.in_notify_schedule(night, datetime(2026, 11, 20, 23, tzinfo=UTC))  # Fri 23:00
    assert svc.in_notify_schedule(night, datetime(2026, 11, 21, 5, tzinfo=UTC))  # Sat 05:00
    assert not svc.in_notify_schedule(night, datetime(2026, 11, 21, 23, tzinfo=UTC))  # Sat 23:00
    assert not svc.in_notify_schedule(night, datetime(2026, 11, 20, 5, tzinfo=UTC))  # Fri 05:00
    # Disabled or missing: always on.
    assert svc.in_notify_schedule(None) and svc.in_notify_schedule({**sched, "enabled": False}, datetime(2026, 11, 15, tzinfo=UTC))


async def test_notify_schedule_blocks_notifications(client, team):
    alice = team["alice"]
    # A schedule that never matches (no days).
    await client.patch(
        "/auth/me/preferences",
        json={"notify_schedule": {"enabled": True, "days": [], "start": "00:00", "end": "23:59", "tz": "UTC"}},
        headers=H(alice),
    )
    async with SessionLocal() as db:
        assert await svc.should_notify(db, uuid.UUID(alice["id"]), None, "mention") is False


async def test_archived_channel_threads_still_readable(client, team, rt):
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    ch = await _channel(client, team, members=["bob"])
    root = await _post(client, alice, ch["id"], "root")
    await _post(client, bob, ch["id"], "reply", root["id"])
    await _archive(ch["id"])
    items = (await client.get(f"/workspaces/{ws['id']}/threads", headers=H(alice))).json()["items"]
    assert root["id"] in {t["root"]["id"] for t in items}
    assert (await client.post(f"/messages/{root['id']}/thread-read", headers=H(alice))).status_code == 200
    assert (await client.patch(f"/channels/{ch['id']}/prefs", json={"starred": True}, headers=H(alice))).status_code == 200


async def test_route_hooks_publish_activity(client, team, rt):
    """The real message/reaction/channel routes fan out activity without manual hook calls."""
    alice, bob, gen = team["alice"], team["bob"], team["general"]
    msg = await _post(client, alice, gen["id"], f"hey <@{bob['id']}>")
    mention = rt["user"].of("activity.new", bob["id"])
    assert mention and mention[-1]["item"]["type"] == "mention"
    assert mention[-1]["item"]["message"]["id"] == msg["id"]

    r = await client.post(f"/messages/{msg['id']}/reactions", json={"emoji": "🎉"}, headers=H(bob))
    assert r.status_code == 200, r.text
    reacted = rt["user"].of("activity.new", alice["id"])
    assert reacted and reacted[-1]["item"]["type"] == "reaction" and reacted[-1]["item"]["emoji"] == "🎉"
    # Removing the reaction publishes nothing new.
    before = len(rt["user"].of("activity.new", alice["id"]))
    await client.post(f"/messages/{msg['id']}/reactions", json={"emoji": "🎉"}, headers=H(bob))
    assert len(rt["user"].of("activity.new", alice["id"])) == before

    ch = await _channel(client, team, kind="private")
    r = await client.post(f"/channels/{ch['id']}/members", json={"user_id": bob["id"]}, headers=H(alice))
    assert r.status_code == 204, r.text
    assert rt["user"].of("activity.new", bob["id"])[-1]["item"]["type"] == "channel_invite"


async def test_starring_keeps_default_notify_level(client, team):
    """A prefs row created by star/mute must not override the user's global notify level."""
    alice, gen = team["alice"], team["general"]
    r = await client.patch(f"/channels/{gen['id']}/prefs", json={"starred": True}, headers=H(alice))
    assert r.status_code == 200, r.text
    assert r.json()["notify"] == "default"
    r = await client.patch(f"/channels/{gen['id']}/prefs", json={"notify": "default"}, headers=H(alice))
    assert r.status_code == 200 and r.json()["notify"] == "default"
