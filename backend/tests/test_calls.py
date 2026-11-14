"""Calls (ringing, accept/decline/cancel/timeout), call cards, call notes and voice/video uploads."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import update

from app import calls
from app.core.db import SessionLocal
from app.models import CallInvite
from app.realtime import huddles
from tests.conftest import register
from tests.test_hardening import Recorder

pytestmark = pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")


@pytest.fixture
def events(monkeypatch):
    """Capture what the call service publishes (channel topic / per-user) and schedules."""
    channel, user, scheduled = Recorder(), Recorder(), []
    monkeypatch.setattr(calls, "publish_to_channel", channel)
    monkeypatch.setattr(calls, "notify_user", user)
    monkeypatch.setattr(calls, "schedule_ring_timeout", scheduled.append)
    return channel, user, scheduled


def _of(rec: Recorder, kind: str, target: str | None = None) -> list[dict]:
    return [e for t, e in rec.events if e["type"] == kind and (target is None or t == target)]


async def _dm(client, team, a="alice", b="bob") -> dict:
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/dms", json={"user_ids": [team[b]["id"]]}, headers=team[a]["headers"]
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _channel(client, team, *, kind="public", members=()) -> dict:
    body = {"name": f"c-{uuid.uuid4().hex[:8]}", "kind": kind, "member_ids": [team[m]["id"] for m in members]}
    r = await client.post(f"/workspaces/{team['ws']['id']}/channels", json=body, headers=team["alice"]["headers"])
    assert r.status_code == 201, r.text
    return r.json()


async def _call(client, channel_id, who, **body) -> dict:
    r = await client.post(f"/channels/{channel_id}/calls", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


async def _get(client, call_id, who) -> dict:
    r = await client.get(f"/calls/{call_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


async def _expire_invites(call_id: str) -> None:
    async with SessionLocal() as db:
        await db.execute(
            update(CallInvite)
            .where(CallInvite.call_id == uuid.UUID(call_id))
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await db.commit()


async def _card(client, channel_id, who, call_id) -> dict:
    msgs = (await client.get(f"/channels/{channel_id}/messages", headers=who["headers"])).json()
    return next(m for m in msgs if (m.get("meta") or {}).get("call_id") == call_id)


# --- DM ringing ---------------------------------------------------------------------------------


async def test_dm_call_rings_accept_and_ends(client, team, events):
    ch_ev, user_ev, scheduled = events
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    dm = await _dm(client, team)

    out = await _call(client, dm["id"], alice, kind="video")
    call, join = out["call"], out["join"]
    assert join["room"] == f"huddle-{dm['id']}" and join["token"] and join["url"]
    assert call["kind"] == "video" and call["status"] == "ringing"
    assert call["started_by"] == alice["id"] and call["joined_ids"] == [alice["id"]]
    assert call["participant_ids"] == [alice["id"]]
    assert call["invites"] == [{"user_id": bob["id"], "status": "ringing", "invited_by": alice["id"]}]
    assert scheduled == [uuid.UUID(call["id"])]

    # Bob's phone rings; the channel gets the call card.
    ringing = _of(user_ev, "call.ringing", bob["id"])
    assert len(ringing) == 1 and ringing[0]["caller_id"] == alice["id"]
    assert ringing[0]["call"]["id"] == call["id"]
    created = _of(ch_ev, "message.created", dm["id"])
    card = created[0]["message"]
    assert card["kind"] == "system" and card["body"] == "" and card["id"] == call["message_id"]
    assert card["meta"]["type"] == "call" and card["meta"]["status"] == "ringing"
    assert card["meta"]["call_id"] == call["id"] and card["meta"]["kind"] == "video"
    assert _of(ch_ev, "call.updated", dm["id"])

    # Page load: Bob sees the ringing call, Carol can't see the call at all.
    r = await client.get("/me/calls/ringing", headers=bob["headers"])
    assert [x["call"]["id"] for x in r.json()] == [call["id"]] and r.json()[0]["caller_id"] == alice["id"]
    assert (await client.get("/me/calls/ringing", headers=alice["headers"])).json() == []
    assert (await client.get(f"/calls/{call['id']}", headers=carol["headers"])).status_code == 404

    user_ev.events.clear()
    r = await client.post(f"/calls/{call['id']}/accept", headers=bob["headers"])
    assert r.status_code == 200, r.text
    accepted = r.json()["call"]
    assert r.json()["join"]["room"] == f"huddle-{dm['id']}"
    assert accepted["status"] == "active"
    assert sorted(accepted["joined_ids"]) == sorted([alice["id"], bob["id"]])
    assert sorted(accepted["participant_ids"]) == sorted([alice["id"], bob["id"]])
    assert accepted["invites"][0]["status"] == "accepted"
    assert _of(user_ev, "call.ring_stopped", bob["id"]) == [
        {"type": "call.ring_stopped", "call_id": call["id"], "reason": "accepted"}
    ]
    assert {"type": "call.invite_updated", "call_id": call["id"], "user_id": bob["id"], "status": "accepted"} in _of(
        user_ev, "call.invite_updated", alice["id"]
    )
    assert (await client.get("/me/calls/ringing", headers=bob["headers"])).json() == []
    updated = [e["message"] for e in _of(ch_ev, "message.updated", dm["id"])]
    assert updated[-1]["meta"]["status"] == "active"

    # Both hang up: the call ends and the card says how long it lasted.
    assert (await client.post(f"/calls/{call['id']}/leave", headers=alice["headers"])).status_code == 204
    assert (await _get(client, call["id"], bob))["status"] == "active"
    assert (await client.post(f"/calls/{call['id']}/leave", headers=bob["headers"])).status_code == 204
    final = await _get(client, call["id"], alice)
    assert final["status"] == "ended" and final["ended_at"] and final["participant_ids"] == []
    card = await _card(client, dm["id"], alice, call["id"])
    assert card["meta"]["status"] == "ended" and isinstance(card["meta"]["duration_s"], int)
    assert sorted(card["meta"]["joined_ids"]) == sorted([alice["id"], bob["id"]])
    assert _of(ch_ev, "call.updated", dm["id"])[-1]["call"]["status"] == "ended"
    # Accepting an ended call is refused.
    assert (await client.post(f"/calls/{call['id']}/accept", headers=bob["headers"])).status_code == 409


async def test_dm_call_declined(client, team, events):
    ch_ev, user_ev, _ = events
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    dm = await _dm(client, team)
    call = (await _call(client, dm["id"], alice))["call"]
    assert call["kind"] == "audio"

    assert (await client.post(f"/calls/{call['id']}/decline", headers=carol["headers"])).status_code == 404
    assert (await client.post(f"/calls/{call['id']}/decline", headers=bob["headers"])).status_code == 204
    final = await _get(client, call["id"], alice)
    assert final["status"] == "declined" and final["ended_at"]
    assert final["invites"][0]["status"] == "declined"
    assert _of(user_ev, "call.ring_stopped", bob["id"])[-1]["reason"] == "declined"
    assert _of(user_ev, "call.invite_updated", alice["id"])[-1]["status"] == "declined"
    assert _of(ch_ev, "call.updated", dm["id"])[-1]["call"]["status"] == "declined"
    card = await _card(client, dm["id"], alice, call["id"])
    assert card["meta"]["status"] == "declined" and card["meta"]["duration_s"] is None
    # The caller was taken out of the room; their next heartbeat tells them to hang up.
    assert await huddles.participant_ids(dm["id"]) == []
    assert (await client.post(f"/channels/{dm['id']}/huddle/heartbeat", headers=alice["headers"])).status_code == 410
    # Declining again is a no-op.
    assert (await client.post(f"/calls/{call['id']}/decline", headers=bob["headers"])).status_code == 204

    # A new call in the same DM is a new call.
    again = (await _call(client, dm["id"], alice))["call"]
    assert again["id"] != call["id"] and again["status"] == "ringing"
    await client.post(f"/calls/{again['id']}/cancel", headers=alice["headers"])


async def test_ring_timeout_marks_missed(client, team, events):
    _, user_ev, _ = events
    alice, bob = team["alice"], team["bob"]
    dm = await _dm(client, team)
    call = (await _call(client, dm["id"], alice))["call"]

    await calls.expire_call(uuid.UUID(call["id"]))  # not due yet: nothing happens
    assert (await _get(client, call["id"], alice))["status"] == "ringing"

    await _expire_invites(call["id"])
    await calls.expire_call(uuid.UUID(call["id"]))
    final = await _get(client, call["id"], alice)
    assert final["status"] == "missed" and final["invites"][0]["status"] == "missed"
    assert _of(user_ev, "call.ring_stopped", bob["id"]) == [
        {"type": "call.ring_stopped", "call_id": call["id"], "reason": "missed"}
    ]
    assert _of(user_ev, "call.invite_updated", alice["id"])[-1]["status"] == "missed"
    assert (await _card(client, dm["id"], alice, call["id"]))["meta"]["status"] == "missed"
    # A missed call card is the one system message that counts as unread (for the callee only).
    unread = {}
    for who in (alice, bob):
        chans = (await client.get(f"/workspaces/{team['ws']['id']}/channels", headers=who["headers"])).json()
        unread[who["id"]] = next(c for c in chans if c["id"] == dm["id"])["unread_count"]
    assert unread == {alice["id"]: 0, bob["id"]: 1}
    assert await huddles.participant_ids(dm["id"]) == []
    assert (await client.get("/me/calls/ringing", headers=bob["headers"])).json() == []
    # Running the expiry again changes nothing.
    n = len(user_ev.events)
    await calls.expire_call(uuid.UUID(call["id"]))
    assert len(user_ev.events) == n


async def test_ring_timeout_is_lazy_and_swept(client, team, events):
    _, user_ev, _ = events
    alice, bob = team["alice"], team["bob"]
    dm = await _dm(client, team)

    # Lazy: reading the call expires it.
    call = (await _call(client, dm["id"], alice))["call"]
    await _expire_invites(call["id"])
    assert (await _get(client, call["id"], bob))["status"] == "missed"

    # Lazy: the ringing list never shows overdue invites.
    call = (await _call(client, dm["id"], alice))["call"]
    await _expire_invites(call["id"])
    assert (await client.get("/me/calls/ringing", headers=bob["headers"])).json() == []
    assert (await _get(client, call["id"], alice))["status"] == "missed"

    # Swept: nobody reads it, the periodic sweep still stops the ringing.
    call = (await _call(client, dm["id"], alice))["call"]
    await _expire_invites(call["id"])
    await calls.sweep()
    assert (await _get(client, call["id"], alice))["status"] == "missed"
    assert _of(user_ev, "call.ring_stopped", bob["id"])[-1] == {
        "type": "call.ring_stopped", "call_id": call["id"], "reason": "missed",
    }


async def test_caller_cancels(client, team, events):
    _, user_ev, _ = events
    alice, bob = team["alice"], team["bob"]
    dm = await _dm(client, team)
    call = (await _call(client, dm["id"], alice))["call"]
    # Only people in the call can cancel it.
    assert (await client.post(f"/calls/{call['id']}/cancel", headers=bob["headers"])).status_code == 403
    assert (await client.post(f"/calls/{call['id']}/cancel", headers=alice["headers"])).status_code == 204
    final = await _get(client, call["id"], alice)
    assert final["status"] == "cancelled" and final["invites"][0]["status"] == "cancelled"
    assert _of(user_ev, "call.ring_stopped", bob["id"])[-1]["reason"] == "cancelled"
    assert (await client.post(f"/calls/{call['id']}/accept", headers=bob["headers"])).status_code == 409


async def test_caller_hanging_up_while_ringing_cancels(client, team, events):
    _, user_ev, _ = events
    alice, bob = team["alice"], team["bob"]
    dm = await _dm(client, team)
    call = (await _call(client, dm["id"], alice))["call"]
    assert (await client.post(f"/calls/{call['id']}/leave", headers=alice["headers"])).status_code == 204
    final = await _get(client, call["id"], alice)
    assert final["status"] == "cancelled"
    assert _of(user_ev, "call.ring_stopped", bob["id"])[-1]["reason"] == "cancelled"


async def test_callee_calling_back_accepts(client, team, events):
    alice, bob = team["alice"], team["bob"]
    dm = await _dm(client, team)
    call = (await _call(client, dm["id"], alice))["call"]
    # Bob presses "call" in the DM instead of "accept": he joins the same call.
    joined = (await _call(client, dm["id"], bob))["call"]
    assert joined["id"] == call["id"] and joined["status"] == "active"
    assert joined["invites"][0]["status"] == "accepted"
    for who in (alice, bob):
        await client.post(f"/calls/{call['id']}/leave", headers=who["headers"])


# --- Channel calls / huddles -----------------------------------------------------------------------


async def test_channel_call_is_a_quiet_huddle_with_invites(client, team, events):
    _, user_ev, scheduled = events
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team)

    call = (await _call(client, ch["id"], alice))["call"]
    assert call["status"] == "active" and call["invites"] == [] and not _of(user_ev, "call.ringing")
    assert not scheduled

    # One live call per channel: starting again joins it.
    again = (await _call(client, ch["id"], carol, kind="video"))["call"]
    assert again["id"] == call["id"] and again["kind"] == "audio"
    assert sorted(again["joined_ids"]) == sorted([alice["id"], carol["id"]])

    # The legacy huddle endpoint joins the same call.
    r = await client.post(f"/channels/{ch['id']}/huddle/join", headers=bob["headers"])
    assert r.status_code == 200 and r.json()["room"] == f"huddle-{ch['id']}"
    got = await _get(client, call["id"], alice)
    assert sorted(got["participant_ids"]) == sorted([alice["id"], bob["id"], carol["id"]])

    # Ringing more people into a live huddle.
    await client.post(f"/calls/{call['id']}/leave", headers=bob["headers"])
    r = await client.post(f"/calls/{call['id']}/invite", json={"user_ids": [bob["id"]]}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["invites"] == [{"user_id": bob["id"], "status": "ringing", "invited_by": alice["id"]}]
    assert _of(user_ev, "call.ringing", bob["id"])[-1]["caller_id"] == alice["id"]
    assert scheduled == [uuid.UUID(call["id"])]
    # Ring timeout in a channel call: the invite is missed but the huddle keeps going.
    await _expire_invites(call["id"])
    got = await _get(client, call["id"], alice)
    assert got["status"] == "active" and got["invites"][0]["status"] == "missed"

    # Invitees must be able to see the channel; non-participants can't invite.
    outsider = await register(client, "outsider")
    r = await client.post(f"/calls/{call['id']}/invite", json={"user_ids": [outsider["id"]]}, headers=alice["headers"])
    assert r.status_code == 400
    priv = await _channel(client, team, kind="private")
    r = await client.post(f"/channels/{priv['id']}/calls", json={"invitee_ids": [bob["id"]]}, headers=alice["headers"])
    assert r.status_code == 400
    stranger = await register(client, "stranger")
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/members", json={"email": stranger["email"]}, headers=alice["headers"]
    )
    r = await client.post(f"/calls/{call['id']}/invite", json={"user_ids": [bob["id"]]}, headers=stranger["headers"])
    assert r.status_code == 403

    for who in (alice, carol):
        await client.post(f"/calls/{call['id']}/leave", headers=who["headers"])
    final = await _get(client, call["id"], alice)
    assert final["status"] == "ended" and isinstance(
        (await _card(client, ch["id"], alice, call["id"]))["meta"]["duration_s"], int
    )


async def test_heartbeat_and_pruning_follow_the_call(client, team, events):
    alice, bob = team["alice"], team["bob"]
    ch = await _channel(client, team)
    call = (await _call(client, ch["id"], alice))["call"]
    await client.post(f"/channels/{ch['id']}/huddle/join", headers=bob["headers"])
    assert (await client.post(f"/channels/{ch['id']}/huddle/heartbeat", headers=bob["headers"])).status_code == 204

    # Both stop heartbeating; the registry prunes them and the call ends.
    for who in (alice, bob):
        await huddles.redis.zadd(f"huddle:{ch['id']}", {who["id"]: 0})
    await huddles.redis.delete(huddles.SWEEP_LOCK_KEY)
    await huddles.sweep()
    assert (await _get(client, call["id"], alice))["status"] == "ended"

    # A lapsed heartbeat after a normal end starts a fresh call.
    assert (await client.post(f"/channels/{ch['id']}/huddle/heartbeat", headers=bob["headers"])).status_code == 204
    async with SessionLocal() as db:
        fresh = await calls.live_call(db, uuid.UUID(ch["id"]))
    assert fresh and str(fresh.id) != call["id"] and fresh.started_by == uuid.UUID(bob["id"])
    await client.post(f"/channels/{ch['id']}/huddle/leave", headers=bob["headers"])
    async with SessionLocal() as db:
        assert await calls.live_call(db, uuid.UUID(ch["id"])) is None


async def test_concurrent_starts_share_one_call(client, team, events):
    ch = await _channel(client, team)
    results = await asyncio.gather(
        *(client.post(f"/channels/{ch['id']}/calls", json={}, headers=team[w]["headers"]) for w in ("alice", "bob", "carol"))
    )
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    assert len({r.json()["call"]["id"] for r in results}) == 1
    call_id = results[0].json()["call"]["id"]
    for w in ("alice", "bob", "carol"):
        await client.post(f"/calls/{call_id}/leave", headers=team[w]["headers"])


async def test_archived_channel_cannot_start_calls(client, team, events):
    from tests.test_collab import _archive

    ch = await _channel(client, team)
    await _archive(ch["id"])
    r = await client.post(f"/channels/{ch['id']}/calls", json={}, headers=team["alice"]["headers"])
    assert r.status_code == 403


# --- System messages -----------------------------------------------------------------------------


async def test_system_messages_are_immutable_and_never_unread(client, team, events):
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    dm = await _dm(client, team)
    await client.post(f"/channels/{dm['id']}/read", headers=bob["headers"])
    call = (await _call(client, dm["id"], alice))["call"]
    card_id = call["message_id"]

    for who in (alice, bob):
        r = await client.patch(f"/messages/{card_id}", json={"body": "hacked"}, headers=who["headers"])
        assert r.status_code == 403
        assert (await client.delete(f"/messages/{card_id}", headers=who["headers"])).status_code == 403

    chans = (await client.get(f"/workspaces/{ws['id']}/channels", headers=bob["headers"])).json()
    assert next(c for c in chans if c["id"] == dm["id"])["unread_count"] == 0
    await client.post(f"/channels/{dm['id']}/messages", json={"body": "you there?"}, headers=alice["headers"])
    chans = (await client.get(f"/workspaces/{ws['id']}/channels", headers=bob["headers"])).json()
    assert next(c for c in chans if c["id"] == dm["id"])["unread_count"] == 1

    # People can still react to and reply under a call card.
    r = await client.post(f"/messages/{card_id}/reactions", json={"emoji": "👍"}, headers=bob["headers"])
    assert r.status_code == 200
    r = await client.post(
        f"/channels/{dm['id']}/messages", json={"body": "joining in 1m", "parent_id": card_id}, headers=bob["headers"]
    )
    assert r.status_code == 201
    await client.post(f"/calls/{call['id']}/cancel", headers=alice["headers"])

    # User messages report kind "user".
    msgs = (await client.get(f"/channels/{dm['id']}/messages", headers=bob["headers"])).json()
    assert {m["kind"] for m in msgs} == {"user", "system"}
    assert next(m for m in msgs if m["kind"] == "user")["meta"] is None


# --- Notes -----------------------------------------------------------------------------------------


def _doc(*blocks) -> dict:
    return {"type": "doc", "content": list(blocks)}


def _p(text: str) -> dict:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


NOTES = _doc(
    {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Sync"}]},
    {
        "type": "bulletList",
        "content": [{"type": "listItem", "content": [_p("Ship voice notes")]}],
    },
    {
        "type": "taskList",
        "content": [
            {"type": "taskItem", "attrs": {"checked": False}, "content": [_p("Write tests")]},
            {"type": "taskItem", "attrs": {"checked": True}, "content": [_p("Design review")]},
        ],
    },
)


def test_notes_to_text():
    assert calls.notes_to_text(NOTES) == "# Sync\n- Ship voice notes\n- [ ] Write tests\n- [x] Design review"
    assert calls.notes_to_text(_doc()) == ""
    assert calls.notes_to_text(_doc(_p(""), {"type": "paragraph"})) == ""
    uid = str(uuid.uuid4())
    nested = _doc(
        {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Next"}]},
        {
            "type": "orderedList",
            "content": [
                {
                    "type": "listItem",
                    "content": [
                        {"type": "paragraph", "content": [{"type": "mention", "attrs": {"id": uid, "label": "bob"}}, {"type": "text", "text": " owns it"}]},
                        {"type": "bulletList", "content": [{"type": "listItem", "content": [_p("sub")]}]},
                    ],
                }
            ],
        },
    )
    assert calls.notes_to_text(nested) == f"## Next\n1. <@{uid}> owns it\n  - sub"


async def test_call_notes_crud_conflict_and_noop(client, team, events):
    ch_ev, _, _ = events
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    dm = await _dm(client, team)
    call = (await _call(client, dm["id"], alice))["call"]
    url = f"/calls/{call['id']}/notes"

    r = await client.get(url, headers=bob["headers"])
    assert r.status_code == 200
    assert r.json() == {"call_id": call["id"], "content": _doc(), "version": 0, "updated_by": None, "updated_at": None}

    r = await client.put(url, json={"content": _doc(_p("one")), "base_version": 0}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1 and r.json()["updated_by"] == alice["id"]
    notes_ev = _of(ch_ev, "call.notes_updated", dm["id"])
    assert notes_ev[-1]["call_id"] == call["id"] and notes_ev[-1]["notes"]["version"] == 1

    # Identical content: no-op, even from a stale base version.
    n = len(ch_ev.events)
    r = await client.put(url, json={"content": _doc(_p("one")), "base_version": 0}, headers=bob["headers"])
    assert r.status_code == 200 and r.json()["version"] == 1 and len(ch_ev.events) == n

    # Stale base version with different content: 409 with the current notes.
    r = await client.put(url, json={"content": _doc(_p("two")), "base_version": 0}, headers=bob["headers"])
    assert r.status_code == 409
    assert r.json()["detail"] == "Notes changed" and r.json()["notes"]["content"] == _doc(_p("one"))
    assert r.json()["notes"]["version"] == 1

    # Validation and access.
    r = await client.put(url, json={"content": {"type": "nope"}, "base_version": 1}, headers=bob["headers"])
    assert r.status_code == 422
    assert (await client.get(url, headers=carol["headers"])).status_code == 404
    r = await client.put(url, json={"content": _doc(), "base_version": 1}, headers=carol["headers"])
    assert r.status_code == 404
    await client.post(f"/calls/{call['id']}/cancel", headers=alice["headers"])


async def test_notes_need_channel_membership_in_public_channels(client, team, events):
    alice, bob = team["alice"], team["bob"]
    ch = await _channel(client, team)  # only alice is a member
    call = (await _call(client, ch["id"], alice))["call"]
    url = f"/calls/{call['id']}/notes"
    assert (await client.get(url, headers=bob["headers"])).status_code == 403
    # ...unless they are in the call.
    await client.post(f"/channels/{ch['id']}/huddle/join", headers=bob["headers"])
    assert (await client.get(url, headers=bob["headers"])).status_code == 200
    for who in (alice, bob):
        await client.post(f"/calls/{call['id']}/leave", headers=who["headers"])


async def test_notes_are_posted_as_a_thread_reply_when_the_call_ends(client, team, events):
    ch_ev, _, _ = events
    alice, bob = team["alice"], team["bob"]
    dm = await _dm(client, team)
    call = (await _call(client, dm["id"], alice))["call"]
    await client.post(f"/calls/{call['id']}/accept", headers=bob["headers"])
    url = f"/calls/{call['id']}/notes"
    await client.put(url, json={"content": NOTES, "base_version": 0}, headers=bob["headers"])
    # Nothing is posted while the call is live.
    assert (await client.get(f"/messages/{call['message_id']}/replies", headers=alice["headers"])).json() == []

    for who in (alice, bob):
        await client.post(f"/calls/{call['id']}/leave", headers=who["headers"])
    replies = (await client.get(f"/messages/{call['message_id']}/replies", headers=alice["headers"])).json()
    assert len(replies) == 1
    reply = replies[0]
    assert reply["kind"] == "system" and reply["parent_id"] == call["message_id"]
    assert reply["meta"] == {"type": "call_notes", "call_id": call["id"]}
    assert reply["body"] == "# Sync\n- Ship voice notes\n- [ ] Write tests\n- [x] Design review"
    assert reply["author_id"] == bob["id"]
    assert any(e["message"]["id"] == reply["id"] for e in _of(ch_ev, "message.created", dm["id"]))
    card = await _card(client, dm["id"], alice, call["id"])
    assert card["reply_count"] == 1
    assert (await client.patch(f"/messages/{reply['id']}", json={"body": "x"}, headers=bob["headers"])).status_code == 403
    # Notes searchable via the body.
    hits = (await client.get(f"/workspaces/{team['ws']['id']}/search", params={"q": "voice notes"}, headers=alice["headers"])).json()
    assert reply["id"] in {h["id"] for h in hits}

    # Late edits keep the reply in step; clearing the notes removes it.
    r = await client.put(url, json={"content": _doc(_p("Final summary")), "base_version": 1}, headers=alice["headers"])
    assert r.status_code == 200
    replies = (await client.get(f"/messages/{call['message_id']}/replies", headers=alice["headers"])).json()
    assert [x["body"] for x in replies] == ["Final summary"]
    assert any(e["message"]["id"] == reply["id"] for e in _of(ch_ev, "message.updated", dm["id"]))
    r = await client.put(url, json={"content": _doc(), "base_version": 2}, headers=alice["headers"])
    assert r.status_code == 200
    assert (await client.get(f"/messages/{call['message_id']}/replies", headers=alice["headers"])).json() == []
    assert _of(ch_ev, "message.deleted", dm["id"])[-1]["message_id"] == reply["id"]


async def test_call_without_notes_posts_no_reply(client, team, events):
    alice = team["alice"]
    ch = await _channel(client, team)
    call = (await _call(client, ch["id"], alice))["call"]
    await client.put(f"/calls/{call['id']}/notes", json={"content": _doc(_p("  ")), "base_version": 0}, headers=alice["headers"])
    await client.post(f"/calls/{call['id']}/leave", headers=alice["headers"])
    assert (await _get(client, call["id"], alice))["status"] == "ended"
    assert (await client.get(f"/messages/{call['message_id']}/replies", headers=alice["headers"])).json() == []


# --- Tenant isolation -------------------------------------------------------------------------------


async def test_calls_are_tenant_isolated(client, team, events):
    alice, bob = team["alice"], team["bob"]
    dm = await _dm(client, team)
    call = (await _call(client, dm["id"], alice))["call"]
    cid = call["id"]

    # Someone from another workspace (and a member of this one outside the DM) sees nothing.
    outsider = await register(client, "outsider")
    await client.post("/workspaces", json={"name": "Other", "slug": f"other-{uuid.uuid4().hex[:6]}"}, headers=outsider["headers"])
    for who in (outsider, team["carol"]):
        h = who["headers"]
        assert (await client.get(f"/calls/{cid}", headers=h)).status_code == 404
        assert (await client.post(f"/calls/{cid}/accept", headers=h)).status_code == 404
        assert (await client.post(f"/calls/{cid}/decline", headers=h)).status_code == 404
        assert (await client.post(f"/calls/{cid}/cancel", headers=h)).status_code == 404
        assert (await client.post(f"/calls/{cid}/leave", headers=h)).status_code == 404
        assert (await client.post(f"/calls/{cid}/invite", json={"user_ids": [bob["id"]]}, headers=h)).status_code == 404
        assert (await client.get(f"/calls/{cid}/notes", headers=h)).status_code == 404
        r = await client.put(f"/calls/{cid}/notes", json={"content": _doc(), "base_version": 0}, headers=h)
        assert r.status_code == 404
        assert (await client.post(f"/channels/{dm['id']}/calls", json={}, headers=h)).status_code == 404
        assert (await client.get("/me/calls/ringing", headers=h)).json() == []
    # Can't ring someone from another workspace into this call.
    r = await client.post(f"/calls/{cid}/invite", json={"user_ids": [outsider["id"]]}, headers=alice["headers"])
    assert r.status_code == 400
    assert (await client.get(f"/calls/{uuid.uuid4()}", headers=alice["headers"])).status_code == 404

    # Unauthenticated.
    assert (await client.get(f"/calls/{cid}")).status_code == 401
    assert (await client.get("/me/calls/ringing")).status_code == 401
    assert (await client.post(f"/channels/{dm['id']}/calls", json={})).status_code == 401
    await client.post(f"/calls/{cid}/cancel", headers=alice["headers"])


async def test_call_input_validation(client, team, events):
    alice, general = team["alice"], team["general"]
    url = f"/channels/{general['id']}/calls"
    assert (await client.post(url, json={"kind": "hologram"}, headers=alice["headers"])).status_code == 422
    r = await client.post(url, json={"invitee_ids": [str(uuid.uuid4()) for _ in range(51)]}, headers=alice["headers"])
    assert r.status_code == 422
    r = await client.post(url, json={"invitee_ids": [str(uuid.uuid4())]}, headers=alice["headers"])
    assert r.status_code == 400


# --- Voice / video uploads ---------------------------------------------------------------------------


async def test_voice_and_video_upload_metadata(client, team):
    alice, ws, general = team["alice"], team["ws"], team["general"]
    url = f"/workspaces/{ws['id']}/uploads"

    r = await client.post(
        url,
        files={"file": ("voice.webm", b"\x1aE\xdf\xa3voice", "audio/webm;codecs=opus")},
        data={"kind": "voice", "duration_ms": "4200", "waveform": "[0, 12, 100, 55]"},
        headers=alice["headers"],
    )
    assert r.status_code == 201, r.text
    voice = r.json()
    assert voice["kind"] == "voice" and voice["duration_ms"] == 4200 and voice["waveform"] == [0, 12, 100, 55]
    assert voice["content_type"] == "audio/webm"
    params = parse_qs(urlparse(voice["url"]).query)
    assert params["response-content-type"] == ["audio/webm"]
    assert params["response-content-disposition"][0].startswith("inline")

    r = await client.post(
        url,
        files={"file": ("clip.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4")},
        data={"kind": "video_clip", "duration_ms": "60000"},
        headers=alice["headers"],
    )
    assert r.status_code == 201, r.text
    clip = r.json()
    assert clip["kind"] == "video_clip" and clip["duration_ms"] == 60000 and clip["waveform"] is None

    # Plain uploads have no media metadata.
    r = await client.post(url, files={"file": ("a.txt", b"hi", "text/plain")}, headers=alice["headers"])
    assert r.status_code == 201 and r.json()["kind"] is None and r.json()["duration_ms"] is None

    # Metadata survives into messages and the channel's files.
    r = await client.post(
        f"/channels/{general['id']}/messages", json={"attachment_ids": [voice["id"], clip["id"]]}, headers=alice["headers"]
    )
    assert r.status_code == 201, r.text
    atts = {a["id"]: a for a in r.json()["attachments"]}
    assert atts[voice["id"]]["waveform"] == [0, 12, 100, 55] and atts[clip["id"]]["kind"] == "video_clip"
    files = (await client.get(f"/channels/{general['id']}/files", headers=alice["headers"])).json()
    assert next(f for f in files if f["id"] == voice["id"])["duration_ms"] == 4200


@pytest.mark.parametrize(
    ("ctype", "data"),
    [
        ("audio/webm", {"kind": "podcast"}),
        ("audio/webm", {"kind": "voice", "duration_ms": "600001"}),
        ("audio/webm", {"kind": "voice", "duration_ms": "-1"}),
        ("audio/webm", {"kind": "voice", "duration_ms": "abc"}),
        ("audio/webm", {"kind": "voice", "waveform": "not json"}),
        ("audio/webm", {"kind": "voice", "waveform": "[101]"}),
        ("audio/webm", {"kind": "voice", "waveform": "[-1]"}),
        ("audio/webm", {"kind": "voice", "waveform": "[1.5]"}),
        ("audio/webm", {"kind": "voice", "waveform": "[true]"}),
        ("audio/webm", {"kind": "voice", "waveform": '{"a": 1}'}),
        ("audio/webm", {"kind": "voice", "waveform": str(list(range(65)))}),
        ("video/webm", {"kind": "voice"}),
        ("text/html", {"kind": "voice"}),
        ("audio/webm", {"kind": "video_clip"}),
    ],
)
async def test_upload_media_validation(client, team, ctype, data):
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/uploads",
        files={"file": ("x.bin", b"data", ctype)},
        data=data,
        headers=team["alice"]["headers"],
    )
    assert r.status_code == 422, r.text
