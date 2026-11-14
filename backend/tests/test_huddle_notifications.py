"""huddle.started / huddle.ended fan-out for channel calls, and the huddle_started activity item."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app import calls, productivity
from tests.conftest import register
from tests.test_hardening import Recorder

pytestmark = pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")


@pytest.fixture
def rt(monkeypatch):
    """Capture per-user events from the call service and from productivity (activity.new)."""
    call_users, activity_users, channel = Recorder(), Recorder(), Recorder()
    monkeypatch.setattr(calls, "notify_user", call_users)
    monkeypatch.setattr(calls, "publish_to_channel", channel)
    monkeypatch.setattr(calls, "schedule_ring_timeout", lambda _call_id: None)
    monkeypatch.setattr(productivity, "notify_user", activity_users)
    return call_users, activity_users


def _of(rec: Recorder, kind: str, target: str | None = None) -> list[dict]:
    return [e for t, e in rec.events if e["type"] == kind and (target is None or t == target)]


def _targets(rec: Recorder, kind: str) -> set[str]:
    return {t for t, e in rec.events if e["type"] == kind}


def _huddle_items(rec: Recorder, target: str | None = None) -> list[dict]:
    """activity.new events for huddle_started items (channel invites also produce activity)."""
    return [e for e in _of(rec, "activity.new", target) if e["item"]["type"] == "huddle_started"]


def _huddle_item_targets(rec: Recorder) -> set[str]:
    return {t for t, e in rec.events if e["type"] == "activity.new" and e["item"]["type"] == "huddle_started"}


async def _member(client, team, name: str) -> dict:
    user = await register(client, name)
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/members", json={"email": user["email"]}, headers=team["alice"]["headers"]
    )
    assert r.status_code == 201, r.text
    return user


async def _channel(client, team, members, *, kind="public") -> dict:
    body = {"name": f"h-{uuid.uuid4().hex[:8]}", "kind": kind, "member_ids": [m["id"] for m in members]}
    r = await client.post(f"/workspaces/{team['ws']['id']}/channels", json=body, headers=team["alice"]["headers"])
    assert r.status_code == 201, r.text
    return r.json()


async def _prefs(client, channel_id, who, **body) -> None:
    r = await client.patch(f"/channels/{channel_id}/prefs", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text


async def _start(client, channel_id, who, **body) -> dict:
    r = await client.post(f"/channels/{channel_id}/calls", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()["call"]


async def _leave(client, call_id, *who) -> None:
    for u in who:
        assert (await client.post(f"/calls/{call_id}/leave", headers=u["headers"])).status_code == 204


async def test_huddle_start_notifies_members_and_records_activity(client, team, rt):
    call_ev, act_ev = rt
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    outsider = await _member(client, team, "dave")  # in the workspace, not in the channel
    ch = await _channel(client, team, [bob, carol], kind="private")

    call = await _start(client, ch["id"], alice, kind="video")
    assert call["status"] == "active"

    # Every channel member except the starter hears about it; non-members don't.
    assert _targets(call_ev, "huddle.started") == {bob["id"], carol["id"]}
    ev = _of(call_ev, "huddle.started", bob["id"])
    assert len(ev) == 1
    ev = ev[0]
    assert ev["channel_id"] == ch["id"] and ev["starter_id"] == alice["id"]
    assert ev["call"]["id"] == call["id"] and ev["call"]["kind"] == "video"
    assert alice["id"] in ev["call"]["participant_ids"]
    assert ev["notify"] is True and ev["invited"] is False
    assert not _of(call_ev, "huddle.started", outsider["id"])

    # An activity item for each audience member, published silently (the huddle event alerts).
    news = _huddle_items(act_ev, bob["id"])
    assert len(news) == 1 and news[0]["notify"] is False
    item = news[0]["item"]
    assert item["type"] == "huddle_started" and item["actor_id"] == alice["id"]
    assert item["channel_id"] == ch["id"] and item["meta"]["call_id"] == call["id"]
    assert item["meta"]["kind"] == "video" and item["read"] is False
    assert item["message"]["id"] == call["message_id"]
    assert not _huddle_items(act_ev, alice["id"])

    page = (await client.get(f"/workspaces/{team['ws']['id']}/activity", headers=carol["headers"])).json()
    huddle_items = [i for i in page["items"] if i["type"] == "huddle_started"]
    assert [i["meta"]["call_id"] for i in huddle_items] == [call["id"]]
    assert page["unread_count"] >= 1
    mine = (await client.get(f"/workspaces/{team['ws']['id']}/activity", headers=alice["headers"])).json()
    assert not [i for i in mine["items"] if i["type"] == "huddle_started"]
    # The "invites" filter stays about channel invites.
    invites = (
        await client.get(f"/workspaces/{team['ws']['id']}/activity?type=invites", headers=carol["headers"])
    ).json()
    assert not [i for i in invites["items"] if i["type"] == "huddle_started"]

    # Joining a live huddle doesn't announce it again.
    call_ev.events.clear()
    await client.post(f"/channels/{ch['id']}/huddle/join", headers=bob["headers"])
    assert not _of(call_ev, "huddle.started")

    # When it ends, every member drops the banner.
    await _leave(client, call["id"], alice, bob)
    ended = _of(call_ev, "huddle.ended")
    assert _targets(call_ev, "huddle.ended") == {alice["id"], bob["id"], carol["id"]}
    assert all(e == {"type": "huddle.ended", "call_id": call["id"], "channel_id": ch["id"]} for e in ended)
    assert len(_of(call_ev, "huddle.ended", carol["id"])) == 1


async def test_muted_and_nothing_members_are_skipped_unless_invited(client, team, rt):
    call_ev, act_ev = rt
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    dave, erin = await _member(client, team, "dave"), await _member(client, team, "erin")
    ch = await _channel(client, team, [bob, carol, dave, erin])
    await _prefs(client, ch["id"], bob, muted=True)
    await _prefs(client, ch["id"], carol, notify="nothing")
    await _prefs(client, ch["id"], dave, muted=True)
    await _prefs(client, ch["id"], erin, notify="mentions")

    # Dave muted the channel but is explicitly invited, so he still hears about it.
    call = await _start(client, ch["id"], alice, invitee_ids=[dave["id"]])
    assert _targets(call_ev, "huddle.started") == {dave["id"], erin["id"]}
    dave_ev = _of(call_ev, "huddle.started", dave["id"])[0]
    assert dave_ev["invited"] is True and dave_ev["notify"] is False  # muted: listed, silent
    assert _of(call_ev, "call.ringing", dave["id"])  # and his phone rings as before
    # "mentions" level: listed but not an alert.
    assert _of(call_ev, "huddle.started", erin["id"])[0]["notify"] is False
    assert _huddle_item_targets(act_ev) == {dave["id"], erin["id"]}

    # Skipped members get no activity item either.
    for who in (bob, carol):
        page = (await client.get(f"/workspaces/{team['ws']['id']}/activity", headers=who["headers"])).json()
        assert not [i for i in page["items"] if i["type"] == "huddle_started"]
    await _leave(client, call["id"], alice)


async def test_dnd_and_schedule_silence_the_huddle_alert(client, team, rt):
    call_ev, _ = rt
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, [bob, carol])
    until = (datetime.now(UTC) + timedelta(minutes=30)).isoformat()
    assert (await client.put("/auth/me/dnd", json={"until": until}, headers=bob["headers"])).status_code == 200

    call = await _start(client, ch["id"], alice)
    assert _of(call_ev, "huddle.started", bob["id"])[0]["notify"] is False
    assert _of(call_ev, "huddle.started", carol["id"])[0]["notify"] is True
    await _leave(client, call["id"], alice)


async def test_huddle_join_endpoint_announces_the_start(client, team, rt):
    call_ev, _ = rt
    alice, bob = team["alice"], team["bob"]
    gen = team["general"]
    r = await client.post(f"/channels/{gen['id']}/huddle/join", headers=bob["headers"])
    assert r.status_code == 200, r.text
    started = _of(call_ev, "huddle.started")
    assert started and all(e["starter_id"] == bob["id"] for e in started)
    assert alice["id"] in _targets(call_ev, "huddle.started")
    assert bob["id"] not in _targets(call_ev, "huddle.started")
    await client.post(f"/channels/{gen['id']}/huddle/leave", headers=bob["headers"])
    assert alice["id"] in _targets(call_ev, "huddle.ended")


async def test_dm_calls_keep_ringing_without_huddle_events(client, team, rt):
    call_ev, act_ev = rt
    alice, bob = team["alice"], team["bob"]
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/dms", json={"user_ids": [bob["id"]]}, headers=alice["headers"]
    )
    dm = r.json()
    call = await _start(client, dm["id"], alice)
    assert call["status"] == "ringing"
    assert _of(call_ev, "call.ringing", bob["id"])
    assert not _of(call_ev, "huddle.started") and not _huddle_items(act_ev)

    r = await client.post(f"/calls/{call['id']}/accept", headers=bob["headers"])
    assert r.status_code == 200, r.text
    await _leave(client, call["id"], alice, bob)
    assert not _of(call_ev, "huddle.ended")
    page = (await client.get(f"/workspaces/{team['ws']['id']}/activity", headers=bob["headers"])).json()
    assert not [i for i in page["items"] if i["type"] == "huddle_started"]


async def test_cancelled_solo_huddle_sends_ended(client, team, rt):
    call_ev, _ = rt
    alice, bob = team["alice"], team["bob"]
    ch = await _channel(client, team, [bob])
    call = await _start(client, ch["id"], alice)
    assert (await client.post(f"/calls/{call['id']}/cancel", headers=alice["headers"])).status_code in (200, 204)
    assert _of(call_ev, "huddle.ended", bob["id"]) == [
        {"type": "huddle.ended", "call_id": call["id"], "channel_id": ch["id"]}
    ]
