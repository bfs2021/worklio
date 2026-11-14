"""@worklio agent (bot user, trigger, tools, answers), live captions and the AI call summary.

The Claude API is never called: `app.ai.client` functions are replaced with fakes.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.ai import agent, captions
from app.ai import client as ai
from app.core.config import settings
from app.core.db import SessionLocal
from app.models import Message
from app.realtime import hub as hub_module
from tests.conftest import register
from tests.test_hardening import Recorder

pytestmark = pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")


@pytest.fixture
def ai_on(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")

    async def no_real_calls(*_a, **_k):
        raise AssertionError("the real Claude API must not be called in tests")

    monkeypatch.setattr(ai, "get_client", no_real_calls)
    return monkeypatch


@pytest.fixture
def enqueued(monkeypatch):
    """Agent requests handed to Celery (instead of really sending them)."""
    sent: list[tuple[uuid.UUID, uuid.UUID]] = []
    monkeypatch.setattr(agent, "_send_agent_task", lambda m, u: sent.append((m, u)))
    return sent


@pytest.fixture
async def ai_team(ai_on, team, client):
    r = await client.get(f"/workspaces/{team['ws']['id']}/ai/bot", headers=team["alice"]["headers"])
    assert r.status_code == 200, r.text
    team["bot_id"] = r.json()["user_id"]
    # The agent only answers where it is installed: make it available in public channels.
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/apps/worklio/install-everywhere", headers=team["alice"]["headers"]
    )
    assert r.status_code == 200, r.text
    return team


def fake_loop(monkeypatch, script):
    """Replace ai_tool_loop: `script(tools_by_name, messages)` returns the answer text."""
    seen: dict = {}

    async def loop(system, messages, tools, **kwargs):
        seen.update(system=system, messages=messages, tools=tools, kwargs=kwargs)
        await asyncio.sleep(0.05)  # let the typing indicator tick
        if kwargs.get("on_status"):
            await kwargs["on_status"]("Searching messages…")
        text = await script({t.name: t for t in tools}, messages)
        return ai.AILoopResult(text=text)

    monkeypatch.setattr(ai, "ai_tool_loop", loop)
    return seen


async def _post(client, channel_id, who, body, parent_id=None) -> dict:
    payload = {"body": body} | ({"parent_id": parent_id} if parent_id else {})
    r = await client.post(f"/channels/{channel_id}/messages", json=payload, headers=who["headers"])
    assert r.status_code == 201, r.text
    return r.json()


async def _channel(client, team, *, kind="public", members=(), owner="alice") -> dict:
    body = {"name": f"c-{uuid.uuid4().hex[:8]}", "kind": kind, "member_ids": [team[m]["id"] for m in members]}
    r = await client.post(f"/workspaces/{team['ws']['id']}/channels", json=body, headers=team[owner]["headers"])
    assert r.status_code == 201, r.text
    return r.json()


async def _replies(client, message_id, who) -> list[dict]:
    r = await client.get(f"/messages/{message_id}/replies", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _ctx(team, who: str, channel_id: str, message_id: str | None = None) -> agent.AgentContext:
    return agent.AgentContext(
        user_id=uuid.UUID(team[who]["id"]),
        workspace_id=uuid.UUID(team["ws"]["id"]),
        channel_id=uuid.UUID(channel_id),
        message_id=uuid.UUID(message_id) if message_id else uuid.uuid4(),
        session_factory=SessionLocal,
    )


# --- Bot user -------------------------------------------------------------------------------


async def test_bot_user_per_workspace(client, ai_team):
    team = ai_team
    alice, bob = team["alice"], team["bob"]
    ws = team["ws"]["id"]
    # Same bot on every call; listed as a member with is_bot and no email.
    again = (await client.get(f"/workspaces/{ws}/ai/bot", headers=bob["headers"])).json()
    assert again["user_id"] == team["bot_id"]
    members = (await client.get(f"/workspaces/{ws}/members", headers=alice["headers"])).json()
    bot = next(m for m in members if m["user_id"] == team["bot_id"])
    assert bot["is_bot"] is True and bot["full_name"] == "Worklio" and bot["email"] is None
    assert all(m["is_bot"] is False for m in members if m["user_id"] != team["bot_id"])
    # The bot can't log in.
    r = await client.post("/auth/login", json={"email": agent.bot_email(uuid.UUID(ws)), "password": "x" * 12})
    assert r.status_code in (401, 422)
    # Outsiders can't look it up.
    stranger = await register(client, "stranger")
    assert (await client.get(f"/workspaces/{ws}/ai/bot", headers=stranger["headers"])).status_code == 404


async def test_new_workspaces_get_their_bot_when_ai_is_enabled(client, ai_on):
    owner = await register(client, "owner")
    ws = (await client.post("/workspaces", json={"name": "Bots", "slug": f"b-{uuid.uuid4().hex[:6]}"}, headers=owner["headers"])).json()
    members = (await client.get(f"/workspaces/{ws['id']}/members", headers=owner["headers"])).json()
    assert [m["full_name"] for m in members if m["is_bot"]] == ["Worklio"]


async def test_ai_endpoints_503_without_key(client, team, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    r = await client.get(f"/workspaces/{team['ws']['id']}/ai/bot", headers=team["alice"]["headers"])
    assert r.status_code == 503 and r.json() == {"detail": "ai_not_configured"}
    members = (await client.get(f"/workspaces/{team['ws']['id']}/members", headers=team["alice"]["headers"])).json()
    assert not any(m["is_bot"] for m in members)


# --- Trigger ----------------------------------------------------------------------------------


async def test_mention_enqueues_the_agent(client, ai_team, enqueued):
    team = ai_team
    alice, bot_id = team["alice"], team["bot_id"]
    general = team["general"]["id"]
    await _post(client, general, alice, "no mention here")
    await _post(client, general, alice, f"<@{team['bob']['id']}> not the bot either")
    msg = await _post(client, general, alice, f"<@{bot_id}> what did we decide about pricing?")
    await agent.drain()
    assert enqueued == [(uuid.UUID(msg["id"]), uuid.UUID(alice["id"]))]

    # DMs with the bot need no mention.
    enqueued.clear()
    dm = (await client.post(f"/workspaces/{team['ws']['id']}/dms", json={"user_ids": [bot_id]}, headers=alice["headers"])).json()
    dm_msg = await _post(client, dm["id"], alice, "hi there")
    await agent.drain()
    assert enqueued == [(uuid.UUID(dm_msg["id"]), uuid.UUID(alice["id"]))]


async def test_loop_guard_bot_messages_never_trigger(client, ai_team, enqueued):
    team = ai_team
    async with SessionLocal() as db:
        msg = Message(
            workspace_id=uuid.UUID(team["ws"]["id"]),
            channel_id=uuid.UUID(team["general"]["id"]),
            author_id=uuid.UUID(team["bot_id"]),
            body=f"<@{team['bot_id']}> talking to myself <@{team['alice']['id']}>",
        )
        db.add(msg)
        await db.commit()
        channel = await db.get(agent.Channel, msg.channel_id)
        assert await agent.should_trigger(db, msg, channel) is None
        # Even when run directly (e.g. a forged task), nothing is posted.
        assert await agent.run_agent(msg.id, uuid.UUID(team["bot_id"])) is None


# --- Answers ----------------------------------------------------------------------------------


async def test_agent_answers_in_thread_as_the_bot(client, ai_team, ai_on, enqueued):
    team = ai_team
    alice, bot_id = team["alice"], team["bot_id"]
    general = team["general"]["id"]
    source = await _post(client, general, team["bob"], "We agreed pricing stays at 12 dollars per seat")

    async def script(tools, messages):
        assert "pricing" in messages[0]["content"]
        out = await tools["search_messages"].handler({"query": "pricing seat"})
        assert "12 dollars" in out and "[1]" in out
        return "Pricing stays at $12 per seat [1]."

    seen = fake_loop(ai_on, script)
    typing = Recorder()
    ai_on.setattr(hub_module, "publish_to_channel", typing)

    ask = await _post(client, general, alice, f"<@{bot_id}> what did we decide about pricing?")
    await agent.drain()
    run = await agent.run_agent(ask["id"], alice["id"])
    assert run.outcome == "answered"
    assert seen["kwargs"]["effort"] == "medium" and seen["kwargs"]["user_id"] == uuid.UUID(alice["id"])

    replies = await _replies(client, ask["id"], alice)
    assert len(replies) == 1
    reply = replies[0]
    assert reply["author_id"] == bot_id and reply["parent_id"] == ask["id"] and reply["kind"] == "user"
    assert reply["body"] == "Pricing stays at $12 per seat [1]."
    meta = reply["meta"]
    assert meta["type"] == "ai_agent" and meta["in_reply_to"] == ask["id"] and meta["outcome"] == "answered"
    assert [c["message_id"] for c in meta["citations"]] == [source["id"]]
    assert meta["citations"][0]["n"] == 1 and meta["citations"][0]["channel_id"] == general
    # Typing indicator (and a status line) while it worked.
    kinds = {e["type"] for _, e in typing.events}
    assert {"typing", "ai.agent_status"} <= kinds
    typing_ev = next(e for _, e in typing.events if e["type"] == "typing")
    assert typing_ev["user_id"] == bot_id and typing_ev["parent_id"] == ask["id"]
    # The bot's own answer didn't wake it again, and a retried task doesn't answer twice.
    assert [m for m, _ in enqueued] == [uuid.UUID(ask["id"])]
    assert await agent.run_agent(ask["id"], alice["id"]) is None
    assert len(await _replies(client, ask["id"], alice)) == 1


async def test_agent_joins_a_private_channel_it_is_mentioned_in(client, ai_team, ai_on, enqueued):
    team = ai_team
    priv = await _channel(client, team, kind="private", members=("bob",))
    # Private channels opt in individually (the everywhere install covers public ones only).
    r = await client.post(f"/channels/{priv['id']}/apps/worklio", headers=team["bob"]["headers"])
    assert r.status_code == 200, r.text
    fake_loop(ai_on, lambda tools, messages: asyncio.sleep(0, "On it."))
    ask = await _post(client, priv["id"], team["bob"], f"<@{team['bot_id']}> hello")
    await agent.drain()
    await agent.run_agent(ask["id"], team["bob"]["id"])
    members = (await client.get(f"/channels/{priv['id']}/members", headers=team["bob"]["headers"])).json()
    assert team["bot_id"] in members
    assert [r["author_id"] for r in await _replies(client, ask["id"], team["bob"])] == [team["bot_id"]]


async def test_dm_answers_are_normal_replies(client, ai_team, ai_on, enqueued):
    team = ai_team
    alice = team["alice"]
    fake_loop(ai_on, lambda tools, messages: asyncio.sleep(0, "Hello!"))
    dm = (await client.post(f"/workspaces/{team['ws']['id']}/dms", json={"user_ids": [team["bot_id"]]}, headers=alice["headers"])).json()
    msg = await _post(client, dm["id"], alice, "hey")
    await agent.drain()
    await agent.run_agent(msg["id"], alice["id"])
    latest = (await client.get(f"/channels/{dm['id']}/messages", headers=alice["headers"])).json()[0]
    assert latest["author_id"] == team["bot_id"] and latest["parent_id"] is None and latest["body"] == "Hello!"


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        ("refused", agent.REFUSED_TEXT),
        ("rate_limited", agent.RATE_LIMITED_TEXT),
        ("failed", agent.FAILED_TEXT),
    ],
)
async def test_graceful_replies_when_ai_fails(client, ai_team, ai_on, enqueued, failure, expected):
    team = ai_team

    async def script(tools, messages):
        raise {"refused": ai.AIRefused(), "failed": RuntimeError("boom")}[failure]

    fake_loop(ai_on, script)
    if failure == "rate_limited":
        async def limited(*_a, **_k):
            raise ai.AIRateLimited()

        ai_on.setattr(ai, "enforce_rate_limit", limited)
    ask = await _post(client, team["general"]["id"], team["alice"], f"<@{team['bot_id']}> help")
    await agent.drain()
    run = await agent.run_agent(ask["id"], team["alice"]["id"])
    assert run.outcome == failure
    reply = (await _replies(client, ask["id"], team["alice"]))[0]
    assert reply["body"] == expected and reply["meta"]["outcome"] == failure


async def test_not_configured_reply_when_ai_is_turned_off(client, ai_team, monkeypatch, enqueued):
    team = ai_team
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    ask = await _post(client, team["general"]["id"], team["alice"], f"<@{team['bot_id']}> are you there?")
    await agent.drain()  # without AI the reply is posted in-process, no worker needed
    assert enqueued == []
    reply = (await _replies(client, ask["id"], team["alice"]))[0]
    assert reply["author_id"] == team["bot_id"] and reply["body"] == agent.NOT_CONFIGURED_TEXT
    assert reply["meta"]["outcome"] == "not_configured"


# --- Tools: permissions and side effects ------------------------------------------------------


async def test_tools_only_see_what_the_user_can_read(client, ai_team):
    team = ai_team
    priv = await _channel(client, team, kind="private", members=("bob",))
    secret = await _post(client, priv["id"], team["bob"], "the zanzibar launch codename is secret")
    general = team["general"]["id"]

    carol = {t.name: t for t in agent.build_tools(_ctx(team, "carol", general))}
    out = await carol["search_messages"].handler({"query": "zanzibar"})
    assert "zanzibar" not in out
    for name, args in (
        ("read_channel", {"channel": priv["id"]}),
        ("read_channel", {"channel": "#" + priv["name"]}),
        ("get_thread", {"message_id": secret["id"]}),
        ("summarize_channel", {"channel": priv["id"]}),
        ("create_board_card", {"channel_id": priv["id"], "title": "sneaky"}),
        ("save_for_later", {"message_id": secret["id"]}),
    ):
        with pytest.raises(ai.ToolError):
            await carol[name].handler(args)
    assert priv["name"] not in await carol["list_channels"].handler({})

    bob = {t.name: t for t in agent.build_tools(_ctx(team, "bob", general))}
    assert "zanzibar" in await bob["search_messages"].handler({"query": "zanzibar"})
    assert "zanzibar" in await bob["get_thread"].handler({"message_id": secret["id"]})
    assert "zanzibar" in await bob["read_channel"].handler({"channel": "#" + priv["name"]})
    assert priv["name"] in await bob["list_channels"].handler({})


async def test_tools_side_effects(client, ai_team):
    team = ai_team
    alice, bob = team["alice"], team["bob"]
    ws, general = team["ws"]["id"], team["general"]["id"]
    msg = await _post(client, general, bob, "please review the Q3 deck")
    ctx = _ctx(team, "alice", general, msg["id"])
    tools = {t.name: t for t in agent.build_tools(ctx)}

    when = (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0).isoformat()
    out = await tools["create_reminder"].handler({"text": "Review the Q3 deck", "remind_at": when, "message_id": msg["id"]})
    assert "Reminder" in out
    reminders = (await client.get(f"/workspaces/{ws}/reminders", headers=alice["headers"])).json()
    assert [r["text"] for r in reminders] == ["Review the Q3 deck"]
    with pytest.raises(ai.ToolError):  # in the past
        await tools["create_reminder"].handler({"text": "x", "remind_at": "2001-01-01T00:00:00Z"})

    await tools["save_for_later"].handler({"message_id": msg["id"]})
    await tools["save_for_later"].handler({"title": "Book the offsite"})
    later = (await client.get(f"/workspaces/{ws}/later", headers=alice["headers"])).json()
    assert msg["id"] in {(i.get("message") or {}).get("id") for i in later}
    assert "Book the offsite" in {i.get("title") for i in later}

    out = await tools["create_board_card"].handler(
        {"title": "Ship Q3 deck", "column": "in progress", "assignee": "bob", "due": "2030-01-15"}
    )
    assert "In progress" in out
    board = (await client.get(f"/channels/{general}/board", headers=alice["headers"])).json()
    card = next(c for c in board["cards"] if c["title"] == "Ship Q3 deck")
    col = next(c for c in board["columns"] if c["id"] == card["column_id"])
    assert col["name"] == "In progress" and card["assignee_id"] == bob["id"] and card["due_date"] == "2030-01-15"
    with pytest.raises(ai.ToolError):
        await tools["create_board_card"].handler({"title": "x", "column": "nope"})
    assert [a["type"] for a in ctx.actions] == ["reminder", "saved_item", "saved_item", "board_card"]

    # Nobody else's lists were touched.
    assert (await client.get(f"/workspaces/{ws}/reminders", headers=bob["headers"])).json() == []


async def test_summarize_channel_tool_uses_a_low_effort_call(client, ai_team, ai_on):
    team = ai_team
    general = team["general"]["id"]
    await _post(client, general, team["bob"], "standup moved to 10am")
    calls = []

    async def fake_text(system, messages, **kwargs):
        calls.append(kwargs)
        assert "standup moved" in messages[0]["content"]
        return "TL;DR: standup is at 10am [1]"

    ai_on.setattr(ai, "ai_text", fake_text)
    tools = {t.name: t for t in agent.build_tools(_ctx(team, "alice", general))}
    assert "10am" in await tools["summarize_channel"].handler({})
    assert calls[0]["effort"] == "low"


# --- Live captions ----------------------------------------------------------------------------


async def _start_call(client, channel_id, who) -> dict:
    r = await client.post(f"/channels/{channel_id}/calls", json={}, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()["call"]


async def test_captions_broadcast_store_and_participants_only(client, team, monkeypatch):
    alice, bob = team["alice"], team["bob"]
    ch = await _channel(client, team)
    rec = Recorder()
    monkeypatch.setattr(captions, "publish_to_channel", rec)
    call = await _start_call(client, ch["id"], alice)
    url = f"/calls/{call['id']}/captions"

    r = await client.post(url, json={"text": "hello every", "final": False}, headers=alice["headers"])
    assert r.status_code == 202, r.text
    started = datetime.now(UTC).isoformat()
    r = await client.post(url, json={"text": "hello  everyone", "final": True, "started_at": started}, headers=alice["headers"])
    assert r.status_code == 202
    events = [e for t, e in rec.events if t == ch["id"] and e["type"] == "call.caption"]
    assert [(e["text"], e["final"]) for e in events] == [("hello every", False), ("hello everyone", True)]
    assert events[1]["user_id"] == alice["id"] and events[1]["call_id"] == call["id"] and events[1]["ts"]

    # Bob can see the channel but isn't in the call; Carol can't see it... both refused.
    assert (await client.post(url, json={"text": "hi", "final": True}, headers=bob["headers"])).status_code == 403
    stranger = await register(client, "stranger")
    assert (await client.post(url, json={"text": "hi", "final": True}, headers=stranger["headers"])).status_code == 404

    # Bob joins: now he can caption too.
    await _start_call(client, ch["id"], bob)
    assert (await client.post(url, json={"text": "hi alice", "final": True}, headers=bob["headers"])).status_code == 202

    transcript = (await client.get(f"/calls/{call['id']}/transcript", headers=alice["headers"])).json()
    assert [(s["user_id"], s["text"]) for s in transcript] == [(alice["id"], "hello everyone"), (bob["id"], "hi alice")]
    # Not in the channel or the call: no transcript.
    assert (await client.get(f"/calls/{call['id']}/transcript", headers=team["carol"]["headers"])).status_code == 403

    # Rate limited per participant.
    codes = [
        (await client.post(url, json={"text": f"spam {i}", "final": False}, headers=alice["headers"])).status_code
        for i in range(25)
    ]
    assert 429 in codes

    # Validation; and once the call ended nobody can caption it.
    assert (await client.post(url, json={"text": "x" * 5000, "final": True}, headers=alice["headers"])).status_code == 422
    for who in (alice, bob):
        await client.post(f"/calls/{call['id']}/leave", headers=who["headers"])
    assert (await client.post(url, json={"text": "late", "final": True}, headers=alice["headers"])).status_code == 403


# --- AI call summary --------------------------------------------------------------------------


async def test_call_summary_posted_as_system_reply(client, team, ai_on):
    alice, bob = team["alice"], team["bob"]
    ch = await _channel(client, team, members=("bob",))
    queued = []
    ai_on.setattr(captions, "_send_summary_task", queued.append)
    call = await _start_call(client, ch["id"], alice)
    await _start_call(client, ch["id"], bob)
    for who, text in ((alice, "Let's ship on Friday"), (bob, "I'll write the release notes"), (alice, "Agreed")):
        r = await client.post(f"/calls/{call['id']}/captions", json={"text": text, "final": True}, headers=who["headers"])
        assert r.status_code == 202

    # Live calls can't be summarised yet.
    assert (await client.post(f"/calls/{call['id']}/ai/summary", headers=alice["headers"])).status_code == 409

    prompts = []

    async def fake_json(system, messages, schema, **kwargs):
        prompts.append((messages[0]["content"], kwargs))
        return schema(
            summary="Team agreed to ship on Friday.",
            decisions=["Ship on Friday"],
            action_items=[
                {"title": "Write the release notes", "assignee_id": bob["id"]},
                {"title": "Tell support", "assignee_id": str(uuid.uuid4())},  # not a member: dropped
            ],
        )

    ai_on.setattr(ai, "ai_json", fake_json)
    for who in (alice, bob):
        await client.post(f"/calls/{call['id']}/leave", headers=who["headers"])
    await asyncio.gather(*list(captions._background))
    assert queued == [uuid.UUID(call["id"])]  # the call-end hook enqueued the Celery task

    # What the task does:
    async with SessionLocal() as db:
        result = await captions.summarize_call(db, uuid.UUID(call["id"]))
    assert result["action_items"] == [
        {"title": "Write the release notes", "assignee_id": bob["id"]},
        {"title": "Tell support", "assignee_id": None},
    ]
    transcript_prompt, kwargs = prompts[0]
    assert "I'll write the release notes" in transcript_prompt and bob["id"] in transcript_prompt
    assert kwargs["feature"] == "call_summary"

    replies = await _replies(client, call["message_id"], alice)
    summary = [r for r in replies if (r["meta"] or {}).get("type") == "call_ai_summary"]
    assert len(summary) == 1
    reply = summary[0]
    assert reply["kind"] == "system" and reply["parent_id"] == call["message_id"]
    assert reply["meta"]["call_id"] == call["id"]
    assert reply["meta"]["action_items"][0] == {"title": "Write the release notes", "assignee_id": bob["id"]}
    assert "Ship on Friday" in reply["body"] and f"<@{bob['id']}>" in reply["body"]

    # On demand: regenerates and replaces (still one summary reply).
    r = await client.post(f"/calls/{call['id']}/ai/summary", headers=bob["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["decisions"] == ["Ship on Friday"]
    replies = await _replies(client, call["message_id"], alice)
    assert len([x for x in replies if (x["meta"] or {}).get("type") == "call_ai_summary"]) == 1
    # Not in the channel: refused.
    assert (await client.post(f"/calls/{call['id']}/ai/summary", headers=team["carol"]["headers"])).status_code == 403

    # Refusals come back as a clear error.
    async def refuse(*_a, **_k):
        raise ai.AIRefused()

    ai_on.setattr(ai, "ai_json", refuse)
    assert (await client.post(f"/calls/{call['id']}/ai/summary", headers=alice["headers"])).status_code == 422


async def test_short_calls_get_no_summary(client, team, ai_on):
    alice = team["alice"]
    ch = await _channel(client, team)
    ai_on.setattr(captions, "_send_summary_task", lambda _c: None)

    async def must_not_run(*_a, **_k):
        raise AssertionError("no summary for an empty call")

    ai_on.setattr(ai, "ai_json", must_not_run)
    call = await _start_call(client, ch["id"], alice)
    await client.post(f"/calls/{call['id']}/captions", json={"text": "test", "final": True}, headers=alice["headers"])
    await client.post(f"/calls/{call['id']}/leave", headers=alice["headers"])
    async with SessionLocal() as db:
        assert await captions.summarize_call(db, uuid.UUID(call["id"])) is None
    assert (await client.post(f"/calls/{call['id']}/ai/summary", headers=alice["headers"])).status_code == 422


async def test_call_summary_endpoint_503_without_ai(client, team, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    call = await _start_call(client, team["general"]["id"], team["alice"])
    r = await client.post(f"/calls/{call['id']}/ai/summary", headers=team["alice"]["headers"])
    assert r.status_code == 503 and r.json() == {"detail": "ai_not_configured"}
    await client.post(f"/calls/{call['id']}/leave", headers=team["alice"]["headers"])
