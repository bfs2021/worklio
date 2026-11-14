"""Worklio AI core: gating, rate limits, SSE format, the Ask tool loop (run with the asking
user's permissions), citations, composer token preservation and structured tasks.

The Anthropic client is always faked: no test talks to the real API.
"""

import json
import re
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.ai import client as ai_client
from app.ai.client import AIRefused, ToolError, ToolSpec, ai_tool_loop
from app.core.config import settings
from app.core.db import SessionLocal
from app.models.ai import AIUsage
from tests.test_collab import _channel


def H(u):
    return u["headers"]


# --- Fake Anthropic client ------------------------------------------------------------------


def text_block(text):
    return SimpleNamespace(type="text", text=text)


def tool_block(name, args, block_id=None):
    return SimpleNamespace(
        type="tool_use", name=name, input=args, id=block_id or f"toolu_{uuid.uuid4().hex[:12]}"
    )


def message(content, stop_reason="end_turn"):
    return SimpleNamespace(
        content=content,
        stop_reason=stop_reason,
        stop_details=None,
        model="claude-opus-5-5",
        usage=SimpleNamespace(
            input_tokens=100,
            output_tokens=20,
            cache_read_input_tokens=50,
            cache_creation_input_tokens=0,
            iterations=None,
        ),
    )


class FakeStream:
    def __init__(self, msg):
        self._msg = msg

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def __aiter__(self):
        for b in self._msg.content:
            if b.type == "text":
                # Split into two deltas so streaming is exercised.
                half = max(1, len(b.text) // 2)
                for part in (b.text[:half], b.text[half:]):
                    if part:
                        yield SimpleNamespace(type="text", text=part)

    @property
    def text_stream(self):
        async def gen():
            async for ev in self:
                yield ev.text

        return gen()

    async def get_final_message(self):
        return self._msg


class FakeMessages:
    """Replays a script. Each entry is a message or a callable(kwargs) -> message."""

    def __init__(self, script):
        self.script = list(script)
        self.calls: list[dict] = []

    def _next(self, kw):
        # Snapshot the history: the tool loop extends the same list in place.
        self.calls.append({**kw, "messages": list(kw["messages"])})
        assert self.script, "Unexpected extra Claude call"
        step = self.script.pop(0)
        return step(kw) if callable(step) else step

    def stream(self, **kw):
        return FakeStream(self._next(kw))

    async def create(self, **kw):
        return self._next(kw)

    async def parse(self, **kw):
        msg = self._next(kw)
        raw = "".join(b.text for b in msg.content if b.type == "text")
        msg.parsed_output = kw["output_format"].model_validate(json.loads(raw)) if raw else None
        return msg


@pytest.fixture
def fake_ai(monkeypatch):
    """Enable AI with a fake client; call it with a script to install responses."""
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    monkeypatch.setattr(settings, "ai_rate_limit_requests", 1000)

    def install(script):
        fake = FakeMessages(script)
        monkeypatch.setattr(
            ai_client, "get_client", lambda: SimpleNamespace(beta=SimpleNamespace(messages=fake))
        )
        return fake

    return install


def sse_events(response) -> list[dict]:
    assert response.headers["content-type"].startswith("text/event-stream")
    raw = response.text
    assert raw.endswith("\n\n")
    events = []
    for chunk in raw.split("\n\n"):
        if not chunk:
            continue
        assert chunk.startswith("data: "), chunk
        assert "\n" not in chunk
        events.append(json.loads(chunk[len("data: "):]))
    return events


def tool_results(call: dict) -> list[dict]:
    last = call["messages"][-1]
    return [b for b in last["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]


def assert_request_shape(call: dict, effort: str):
    assert call["model"] == "claude-opus-5-5"
    assert call["output_config"]["effort"] == effort
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["fallbacks"] == "default"
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"}
    for banned in ("thinking", "temperature", "top_p", "top_k"):
        assert banned not in call
    assert call["messages"][-1]["role"] in ("user", "assistant")


async def _post(client, user, channel_id, body, parent_id=None):
    payload = {"body": body} | ({"parent_id": parent_id} if parent_id else {})
    r = await client.post(f"/channels/{channel_id}/messages", json=payload, headers=H(user))
    assert r.status_code == 201, r.text
    return r.json()


# --- Gating & limits ------------------------------------------------------------------------


async def test_ai_disabled_without_key(client, team, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    alice, ws = team["alice"], team["ws"]
    r = await client.get("/ai/status", headers=H(alice))
    assert r.status_code == 200
    assert r.json()["enabled"] is False

    msg = await _post(client, alice, team["general"]["id"], "hello")
    calls = [
        ("post", f"/workspaces/{ws['id']}/ai/ask", {"question": "hi"}),
        ("get", f"/workspaces/{ws['id']}/ai/conversations", None),
        ("post", f"/channels/{team['general']['id']}/ai/summary", {"range": "all"}),
        ("post", f"/messages/{msg['id']}/ai/thread-summary", None),
        ("post", f"/workspaces/{ws['id']}/ai/catch-up", None),
        ("post", "/ai/compose", {"text": "hi", "action": "improve"}),
        ("post", f"/messages/{msg['id']}/ai/translate", {"target_language": "French"}),
        ("post", f"/messages/{msg['id']}/ai/tasks", None),
    ]
    for method, url, body in calls:
        r = await getattr(client, method)(url, headers=H(alice), **({"json": body} if body else {}))
        assert r.status_code == 503, (url, r.text)
        assert r.json() == {"detail": "ai_not_configured"}


async def test_status_enabled(client, team, fake_ai):
    r = await client.get("/ai/status", headers=H(team["alice"]))
    body = r.json()
    assert body["enabled"] is True
    assert body["model"] == "claude-opus-5-5"
    assert "ask" in body["features"] and "compose" in body["features"]


async def test_rate_limit_returns_429(client, team, fake_ai, monkeypatch):
    monkeypatch.setattr(settings, "ai_rate_limit_requests", 2)
    fake_ai([message([text_block("Hi!")]), message([text_block("Hi!")])])
    codes = []
    for _ in range(3):
        r = await client.post(
            "/ai/compose", json={"text": "hi", "action": "improve"}, headers=H(team["bob"])
        )
        codes.append(r.status_code)
    assert codes == [200, 200, 429]
    assert r.json() == {"detail": "rate_limited"}
    assert int(r.headers["Retry-After"]) > 0


# --- Composer -------------------------------------------------------------------------------


async def test_compose_preserves_mentions_and_logs_usage(client, team, fake_ai):
    bob_id, carol_id, group = team["bob"]["id"], team["carol"]["id"], str(uuid.uuid4())
    draft = f"hey <@{bob_id}> and <@{carol_id}> pls check w/ <!subteam^{group}> <!here> 🎉"

    def reply(kw):
        sent = kw["messages"][0]["content"]
        # Real ids never reach the model; short placeholders do.
        assert bob_id not in sent and group not in sent
        assert "<@m1>" in sent and "<@m2>" in sent and "<!subteam^g1>" in sent
        # The model drops <@m2> and invents <@m9>: we restore the first, drop the second.
        return message(
            [text_block("Hi <@m1>, could you check with <!subteam^g1> <@m9>? <!here> 🎉")]
        )

    fake = fake_ai([reply])
    r = await client.post(
        "/ai/compose", json={"text": draft, "action": "friendlier"}, headers=H(team["alice"])
    )
    assert r.status_code == 200, r.text
    text = r.json()["text"]
    assert f"<@{bob_id}>" in text and f"<@{carol_id}>" in text
    assert f"<!subteam^{group}>" in text and "<!here>" in text and "🎉" in text
    assert "<@m" not in text and "<!subteam^g" not in text
    assert r.json()["truncated"] is False
    assert_request_shape(fake.calls[0], "low")

    async with SessionLocal() as db:
        rows = list(
            await db.scalars(
                select(AIUsage).where(AIUsage.user_id == uuid.UUID(team["alice"]["id"]))
            )
        )
    assert any(u.feature == "compose" and u.input_tokens == 100 for u in rows)


async def test_compose_translate_needs_language(client, team, fake_ai):
    fake_ai([])
    r = await client.post(
        "/ai/compose", json={"text": "hola", "action": "translate"}, headers=H(team["alice"])
    )
    assert r.status_code == 422


# --- Ask: tool loop, permissions, citations, conversations ----------------------------------


async def _ask(client, user, ws_id, question, conversation_id=None):
    body = {"question": question} | ({"conversation_id": conversation_id} if conversation_id else {})
    r = await client.post(f"/workspaces/{ws_id}/ai/ask", json=body, headers=H(user))
    assert r.status_code == 200, r.text
    return sse_events(r)


async def test_ask_never_leaks_private_channel_content(client, team, fake_ai):
    alice, carol, ws = team["alice"], team["carol"], team["ws"]
    private = await _channel(client, team, kind="private", members=("bob",))
    secret = await _post(client, alice, private["id"], "The secret codename is BLUEBIRD")
    public = await _post(client, alice, team["general"]["id"], "Public note: BLUEBIRD ships")

    seen: dict[str, list[dict]] = {}

    def search_turn(_kw):
        return message([tool_block("search_messages", {"query": "BLUEBIRD"})], "tool_use")

    def answer(who):
        def step(kw):
            seen[who] = tool_results(kw)
            return message([text_block("BLUEBIRD is shipping [1].")])

        return step

    # Carol is not in the private channel: only the public message may reach the model.
    fake = fake_ai([search_turn, answer("carol")])
    events = await _ask(client, carol, ws["id"], "What is BLUEBIRD?")
    content = seen["carol"][0]["content"]
    assert "Public note" in content
    assert "secret codename" not in content and private["name"] not in content
    citations = next(e for e in events if e["type"] == "citations")["items"]
    assert [c["message_id"] for c in citations] == [public["id"]]
    assert_request_shape(fake.calls[0], "medium")
    assert [t["name"] for t in fake.calls[0]["tools"]] == [
        "search_messages", "get_thread", "read_channel", "list_channels"
    ]

    # Alice is a member (creator), so she sees both.
    fake_ai([search_turn, answer("alice")])
    await _ask(client, alice, ws["id"], "What is BLUEBIRD?")
    assert "secret codename" in seen["alice"][0]["content"]
    assert secret["id"]  # sanity

    # Carol can't read the private channel by name either: the tool reports an error.
    def read_private(_kw):
        return message(
            [tool_block("read_channel", {"channel": f"#{private['name']}"})], "tool_use"
        )

    def check_error(kw):
        seen["read"] = tool_results(kw)
        return message([text_block("I can't access that channel.")])

    fake_ai([read_private, check_error])
    await _ask(client, carol, ws["id"], "Summarize the private channel")
    assert seen["read"][0]["is_error"] is True
    assert "secret" not in seen["read"][0]["content"]


async def test_ask_sse_flow_citations_and_conversations(client, team, fake_ai):
    alice, bob, ws = team["alice"], team["bob"], team["ws"]
    root = await _post(client, alice, team["general"]["id"], "Launch date for Orion?")
    reply = await _post(
        client, bob, team["general"]["id"], "Orion launch moved to May 2", parent_id=root["id"]
    )

    def turn1(_kw):
        # Two tool calls in one turn (run in parallel), one of them unknown -> is_error.
        return message(
            [
                SimpleNamespace(type="thinking", thinking="", signature="sig"),
                tool_block("search_messages", {"query": "Orion launch"}, "toolu_a"),
                tool_block("does_not_exist", {}, "toolu_b"),
            ],
            "tool_use",
        )

    def turn2(kw):
        results = {r["tool_use_id"]: r for r in tool_results(kw)}
        assert results["toolu_b"]["is_error"] is True
        assert "Orion launch moved" in results["toolu_a"]["content"]
        # The assistant turn (with its thinking block) is passed back unchanged.
        assert kw["messages"][-2]["content"][0].type == "thinking"
        n = re.search(r"\[(\d+)\][^\n]*\n[^\n]*Launch date", results["toolu_a"]["content"])
        return message([tool_block("get_thread", {"message_id": n.group(1)}, "toolu_c")], "tool_use")

    def turn3(kw):
        content = tool_results(kw)[0]["content"]
        num = re.search(r"\[(\d+)\][^\n]*\n[^\n]*moved to May 2", content).group(1)
        return message([text_block(f"Orion launches on May 2 [{num}].")])

    fake_ai([turn1, turn2, turn3])
    events = await _ask(client, alice, ws["id"], "When does Orion launch?")
    types = [e["type"] for e in events]
    assert types[0] == "status" and types[-1] == "done"
    assert types.index("citations") > max(i for i, t in enumerate(types) if t == "text")
    statuses = [e["text"] for e in events if e["type"] == "status"]
    assert any("Orion launch" in s for s in statuses)
    text = "".join(e["delta"] for e in events if e["type"] == "text")
    assert text.startswith("Orion launches on May 2 [")
    items = next(e for e in events if e["type"] == "citations")["items"]
    assert len(items) == 1
    item = items[0]
    assert set(item) >= {
        "n", "message_id", "channel_id", "parent_id", "author_id", "snippet", "created_at"
    }
    assert item["message_id"] == reply["id"] and item["parent_id"] == root["id"]
    assert item["author_id"] == bob["id"] and item["channel_id"] == team["general"]["id"]
    assert f"[{item['n']}]" in text
    done = events[-1]
    conv_id = done["conversation_id"]
    assert done["usage"]["input_tokens"] == 300

    # Follow-up in the same conversation sends the history (without old citation marks).
    def followup(kw):
        history = kw["messages"]
        assert history[0] == {"role": "user", "content": "When does Orion launch?"}
        assert history[1]["role"] == "assistant" and "[" not in history[1]["content"]
        return message([text_block("You're welcome.")])

    fake_ai([followup])
    events = await _ask(client, alice, ws["id"], "Thanks!", conversation_id=conv_id)
    assert events[-1]["conversation_id"] == conv_id

    r = await client.get(f"/workspaces/{ws['id']}/ai/conversations", headers=H(alice))
    assert [c["id"] for c in r.json()] == [conv_id]
    assert r.json()[0]["title"] == "When does Orion launch?"
    r = await client.get(f"/ai/conversations/{conv_id}", headers=H(alice))
    turns = r.json()["turns"]
    assert [t["role"] for t in turns] == ["user", "assistant", "user", "assistant"]
    assert turns[1]["citations"][0]["message_id"] == reply["id"]

    # Conversations are private to their owner.
    assert (await client.get(f"/ai/conversations/{conv_id}", headers=H(bob))).status_code == 404
    r = await client.post(
        f"/workspaces/{ws['id']}/ai/ask",
        json={"question": "x", "conversation_id": conv_id},
        headers=H(bob),
    )
    assert r.status_code == 404
    assert (await client.delete(f"/ai/conversations/{conv_id}", headers=H(bob))).status_code == 404
    assert (
        await client.delete(f"/ai/conversations/{conv_id}", headers=H(alice))
    ).status_code == 204
    assert (await client.get(f"/ai/conversations/{conv_id}", headers=H(alice))).status_code == 404


async def test_ask_refusal_becomes_error_event(client, team, fake_ai):
    fake_ai([message([], "refusal")])
    events = await _ask(client, team["alice"], team["ws"]["id"], "something declined")
    assert events[-1]["type"] == "error" and events[-1]["code"] == "refusal"
    assert events[-1]["message"]


# --- Summaries & catch-up -------------------------------------------------------------------


async def test_channel_summary_streams_with_citations(client, team, fake_ai):
    alice, bob = team["alice"], team["bob"]
    channel = await _channel(client, team, members=("bob",))
    first = await _post(client, alice, channel["id"], f"We decided to ship Friday. <@{bob['id']}>")
    await _post(client, bob, channel["id"], "I'll write the release notes")

    def summarize(kw):
        prompt = kw["messages"][0]["content"]
        assert "We decided to ship Friday" in prompt and "release notes" in prompt
        return message([text_block("**TL;DR:** Shipping Friday [1]. Notes by bob [2][9].")])

    fake = fake_ai([summarize])
    r = await client.post(
        f"/channels/{channel['id']}/ai/summary", json={"range": "all"}, headers=H(alice)
    )
    assert r.status_code == 200
    events = sse_events(r)
    assert_request_shape(fake.calls[0], "medium")
    assert events[0]["type"] == "status"
    assert "".join(e["delta"] for e in events if e["type"] == "text").startswith("**TL;DR:**")
    items = next(e for e in events if e["type"] == "citations")["items"]
    assert [i["n"] for i in items] == [1, 2]  # [9] was never shown, so it's not a citation
    assert items[0]["message_id"] == first["id"]
    assert events[-1] == {"type": "done"}

    # Nothing in the window: answered without calling Claude.
    fake_ai([])
    r = await client.post(
        f"/channels/{team['general']['id']}/ai/summary", json={"range": "24h"}, headers=H(alice)
    )
    events = sse_events(r)
    assert "No messages" in "".join(e.get("delta", "") for e in events)
    assert events[-1]["type"] == "done"


async def test_summary_and_thread_permission_checks(client, team, fake_ai):
    fake_ai([])
    private = await _channel(client, team, kind="private")
    msg = await _post(client, team["alice"], private["id"], "secret")
    carol = team["carol"]
    r = await client.post(
        f"/channels/{private['id']}/ai/summary", json={"range": "all"}, headers=H(carol)
    )
    assert r.status_code == 404
    for path in ("thread-summary", "tasks"):
        r = await client.post(f"/messages/{msg['id']}/ai/{path}", headers=H(carol))
        assert r.status_code == 404, path
    r = await client.post(
        f"/messages/{msg['id']}/ai/translate", json={"target_language": "French"}, headers=H(carol)
    )
    assert r.status_code == 404


async def test_thread_summary(client, team, fake_ai):
    root = await _post(client, team["alice"], team["general"]["id"], "Which DB should we use?")
    await _post(client, team["bob"], team["general"]["id"], "Postgres.", parent_id=root["id"])

    def summarize(kw):
        assert "Which DB" in kw["messages"][0]["content"]
        assert "Postgres." in kw["messages"][0]["content"]
        return message([text_block("**TL;DR:** Postgres [2].")])

    fake_ai([summarize])
    r = await client.post(f"/messages/{root['id']}/ai/thread-summary", headers=H(team["carol"]))
    events = sse_events(r)
    items = next(e for e in events if e["type"] == "citations")["items"]
    assert items[0]["parent_id"] == root["id"]


async def test_catch_up(client, team, fake_ai):
    alice, bob = team["alice"], team["bob"]
    fake_ai([])
    r = await client.post(f"/workspaces/{team['ws']['id']}/ai/catch-up", headers=H(bob))
    events = sse_events(r)
    assert "caught up" in "".join(e.get("delta", "") for e in events)

    await _post(client, alice, team["general"]["id"], f"<@{bob['id']}> can you review the PR?")

    def digest(kw):
        prompt = kw["messages"][0]["content"]
        assert 'name="#general"' in prompt and 'mentions_you="1"' in prompt
        return message([text_block("Alice needs your PR review [1].")])

    fake_ai([digest])
    r = await client.post(f"/workspaces/{team['ws']['id']}/ai/catch-up", headers=H(bob))
    events = sse_events(r)
    assert events[-1] == {"type": "done"}
    assert next(e for e in events if e["type"] == "citations")["items"][0]["n"] == 1


# --- Translate & tasks (structured outputs) -------------------------------------------------


async def test_translate_message(client, team, fake_ai):
    bob_id = team["bob"]["id"]
    msg = await _post(client, team["alice"], team["general"]["id"], f"Hola <@{bob_id}>, ¿qué tal?")

    def translate(kw):
        assert bob_id not in kw["messages"][0]["content"]
        assert "French" in kw["messages"][0]["content"]
        return message([text_block(json.dumps({"text": "Salut <@m1>, ça va ?",
                                               "detected_language": "Spanish"}))])

    fake = fake_ai([translate])
    r = await client.post(
        f"/messages/{msg['id']}/ai/translate", json={"target_language": "French"},
        headers=H(team["carol"]),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"text": f"Salut <@{bob_id}>, ça va ?", "detected_language": "Spanish"}
    assert_request_shape(fake.calls[0], "low")


async def test_translate_refusal_is_422(client, team, fake_ai):
    msg = await _post(client, team["alice"], team["general"]["id"], "hello")
    fake_ai([message([], "refusal")])
    r = await client.post(
        f"/messages/{msg['id']}/ai/translate", json={"target_language": "French"},
        headers=H(team["alice"]),
    )
    assert r.status_code == 422


async def test_extract_tasks_structured(client, team, fake_ai):
    alice, bob = team["alice"], team["bob"]
    root = await _post(
        client, alice, team["general"]["id"], "Can someone send the deck by 2026-11-20?"
    )
    reply = await _post(
        client, bob, team["general"]["id"], "I'll send it.", parent_id=root["id"]
    )

    def extract(kw):
        prompt = kw["messages"][0]["content"]
        bob_ref = int(re.search(rf"(\d+)\. [^\n]*<@{bob['id']}>", prompt).group(1))
        reply_ref = int(re.search(r"\[(\d+)\][^\n]*\nI'll send it", prompt).group(1))
        tasks = [
            {"title": "Send the deck", "assignee_ref": bob_ref, "due_date": "2026-11-20",
             "source_ref": reply_ref},
            {"title": "  Book   a room ", "assignee_ref": 99, "due_date": "soon",
             "source_ref": 42},
        ]
        return message([text_block(json.dumps({"tasks": tasks}))])

    fake = fake_ai([extract])
    r = await client.post(f"/messages/{reply['id']}/ai/tasks", headers=H(alice))
    assert r.status_code == 200, r.text
    assert r.json() == {
        "tasks": [
            {"title": "Send the deck", "assignee_id": bob["id"], "due_date": "2026-11-20",
             "source_message_id": reply["id"]},
            {"title": "Book a room", "assignee_id": None, "due_date": None,
             "source_message_id": root["id"]},
        ]
    }
    assert_request_shape(fake.calls[0], "low")
    assert fake.calls[0].get("output_format") is not None


# --- Tool loop unit behaviour ---------------------------------------------------------------


async def test_tool_loop_handles_errors_status_and_refusal(fake_ai):
    calls: list[str] = []

    async def ok(args):
        calls.append(args["q"])
        return {"found": args["q"]}

    async def broken(_args):
        raise ToolError("Nope: try again")

    tools = [
        ToolSpec("ok", "ok tool", {"type": "object", "properties": {}}, ok, status="Working…"),
        ToolSpec("broken", "fails", {"type": "object", "properties": {}}, broken),
    ]

    def check(kw):
        results = {r["tool_use_id"]: r for r in tool_results(kw)}
        assert json.loads(results["a"]["content"]) == {"found": "x"}
        assert results["b"] == {
            "type": "tool_result", "tool_use_id": "b", "content": "Nope: try again",
            "is_error": True,
        }
        return message([text_block("done")])

    fake_ai(
        [message([tool_block("ok", {"q": "x"}, "a"), tool_block("broken", {}, "b")], "tool_use"),
         check]
    )
    statuses, deltas = [], []

    async def on_status(s):
        statuses.append(s)

    async def on_text(t):
        deltas.append(t)

    msgs = [{"role": "user", "content": "go"}]
    result = await ai_tool_loop(
        "sys", msgs, tools, feature="test", on_status=on_status, on_text=on_text
    )
    assert result.text == "done" and "".join(deltas) == "done"
    assert statuses == ["Working…"]
    assert [c.name for c in result.tool_calls] == ["ok", "broken"]
    assert result.tool_calls[1].is_error
    assert calls == ["x"]

    # Max turns: the last request disables tools so the model must answer.
    loop = [message([tool_block("ok", {"q": str(i)})], "tool_use") for i in range(2)]
    fake = fake_ai([*loop, message([text_block("final")])])
    result = await ai_tool_loop("sys", [{"role": "user", "content": "go"}], tools,
                                feature="test", max_turns=2)
    assert result.text == "final"
    assert fake.calls[-1]["tool_choice"] == {"type": "none"}
    assert "tool_choice" not in fake.calls[0]

    fake_ai([message([text_block("partial")], "refusal")])
    with pytest.raises(AIRefused):
        await ai_tool_loop("sys", [{"role": "user", "content": "go"}], tools, feature="test")
