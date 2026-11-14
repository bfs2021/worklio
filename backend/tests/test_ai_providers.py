"""Worklio AI providers (Wave D1): encrypted per-workspace settings, provider switching
(Anthropic / Gemini / DeepSeek), the connection test, usage, feature toggles, the use_ai
policy, per-user limits and @worklio agent installs.

No test talks to a real provider: the Anthropic client and the OpenAI-compatible client are
replaced with scripted fakes.
"""

import json
import uuid
from types import SimpleNamespace

import httpx
import openai
import pytest
from sqlalchemy import select, update

from app.ai import agent, providers
from app.ai import client as ai_client
from app.ai import workspace as ai_ws
from app.ai.keys import decrypt_key, encrypt_key, key_hint
from app.core.config import settings
from app.core.db import SessionLocal
from app.models import Workspace, WorkspaceMember, WorkspaceRole
from app.models.ai import AIUsage
from app.models.ai_settings import WorkspaceAISettings
from tests.conftest import register
from tests.test_ai_core import FakeMessages, message, text_block

pytestmark = pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")

DEEPSEEK_KEY = "sk-deepseek-test-1234567890abcd"
GEMINI_KEY = "AIza-gemini-test-key-9876wxyz"
ANTHROPIC_KEY = "sk-ant-workspace-key-0000zz11"


def H(u):
    return u["headers"]


@pytest.fixture(autouse=True)
def no_env_key(monkeypatch):
    """Start every test with no server-wide key and a cold settings cache."""
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    monkeypatch.setattr(settings, "ai_rate_limit_requests", 1000)
    ai_ws.invalidate()
    yield
    ai_ws.invalidate()


# --- Fake OpenAI-compatible client ----------------------------------------------------------


def oa_usage(prompt=120, completion=30, cached=20):
    return SimpleNamespace(
        prompt_tokens=prompt,
        completion_tokens=completion,
        prompt_tokens_details=SimpleNamespace(cached_tokens=cached),
    )


def oa_response(content, finish="stop"):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=content, refusal=None), finish_reason=finish
            )
        ],
        usage=oa_usage(),
    )


def chunk(content=None, tool_calls=None, finish=None, usage=None):
    choices = []
    if content is not None or tool_calls is not None or finish is not None:
        choices = [
            SimpleNamespace(
                delta=SimpleNamespace(content=content, tool_calls=tool_calls, refusal=None),
                finish_reason=finish,
            )
        ]
    return SimpleNamespace(choices=choices, usage=usage)


def tc_delta(index, call_id=None, name=None, arguments=None):
    return SimpleNamespace(
        index=index,
        id=call_id,
        function=SimpleNamespace(name=name, arguments=arguments),
        model_extra={},
    )


def text_stream(text, finish="stop"):
    half = max(1, len(text) // 2)
    return [chunk(text[:half]), chunk(text[half:]), chunk(finish=finish), chunk(usage=oa_usage())]


class FakeStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        async def gen():
            for c in self._chunks:
                yield c

        return gen()


class FakeCompletions:
    """Replays a script; each step is a response, a list of chunks (stream) or an exception."""

    def __init__(self, script):
        self.script = list(script)
        self.calls: list[dict] = []

    async def create(self, **kw):
        self.calls.append({**kw, "messages": json.loads(json.dumps(kw["messages"], default=str))})
        assert self.script, "Unexpected extra provider call"
        step = self.script.pop(0)
        if callable(step):
            step = step(kw)
        if isinstance(step, Exception):
            raise step
        if kw.get("stream"):
            assert isinstance(step, list), "expected a streamed step"
            return FakeStream(step)
        return step


class FakeModels:
    def __init__(self, ids, error=None):
        self.ids, self.error = ids, error

    def list(self, **_kw):
        ids, error = self.ids, self.error

        async def gen():
            if error:
                raise error
            for i in ids:
                yield SimpleNamespace(id=i)

        return gen()


@pytest.fixture
def fake_oa(monkeypatch):
    """Install a fake OpenAI-compatible client; returns (completions, seen client args)."""
    seen: list[tuple[str, str]] = []

    def install(script, model_ids=(), models_error=None):
        completions = FakeCompletions(script)
        fake = SimpleNamespace(
            chat=SimpleNamespace(completions=completions),
            models=FakeModels(list(model_ids), models_error),
        )

        def get(provider, api_key):
            seen.append((provider, api_key))
            return fake

        monkeypatch.setattr(providers, "get_openai_client", get)
        return completions

    install.seen = seen
    return install


def api_error(cls, status, text):
    req = httpx.Request("POST", "https://provider.test/v1/chat/completions")
    return cls(text, response=httpx.Response(status, request=req), body=None)


async def configure(client, team, **body):
    r = await client.put(
        f"/workspaces/{team['ws']['id']}/ai/settings", json=body, headers=H(team["alice"])
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _post(client, channel_id, who, body, parent_id=None) -> dict:
    payload = {"body": body} | ({"parent_id": parent_id} if parent_id else {})
    r = await client.post(f"/channels/{channel_id}/messages", json=payload, headers=H(who))
    assert r.status_code == 201, r.text
    return r.json()


async def _set_role(team, who, role):
    async with SessionLocal() as db:
        await db.execute(
            update(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == uuid.UUID(team["ws"]["id"]),
                WorkspaceMember.user_id == uuid.UUID(team[who]["id"]),
            )
            .values(role=role)
        )
        await db.commit()


async def _set_policy(team, name, value):
    async with SessionLocal() as db:
        ws = await db.get(Workspace, uuid.UUID(team["ws"]["id"]))
        ws.policies = {**(ws.policies or {}), name: value}
        await db.commit()


# --- Encryption -----------------------------------------------------------------------------


def test_key_encryption_round_trip(monkeypatch):
    token = encrypt_key(DEEPSEEK_KEY)
    assert DEEPSEEK_KEY.encode() not in token
    assert decrypt_key(token) == DEEPSEEK_KEY
    assert encrypt_key(DEEPSEEK_KEY) != token  # Fernet tokens are randomized
    assert key_hint(DEEPSEEK_KEY) == "…abcd"
    # A different SECRET_KEY can't read it (and doesn't raise).
    monkeypatch.setattr(settings, "secret_key", "another-secret-key-that-is-long-enough-xx")
    assert decrypt_key(token) is None


# --- Settings endpoints ---------------------------------------------------------------------


async def test_settings_are_admin_only_and_never_return_the_key(client, team):
    ws = team["ws"]["id"]
    for method, body in (("get", None), ("put", {"provider": "deepseek"})):
        r = await getattr(client, method)(
            f"/workspaces/{ws}/ai/settings", headers=H(team["bob"]), **({"json": body} if body else {})
        )
        assert r.status_code == 403, r.text
    r = await client.post(
        f"/workspaces/{ws}/ai/test", json={"provider": "deepseek", "api_key": DEEPSEEK_KEY},
        headers=H(team["bob"]),
    )
    assert r.status_code == 403
    assert (await client.get(f"/workspaces/{ws}/ai/usage", headers=H(team["bob"]))).status_code == 403

    # Nothing configured yet.
    empty = (await client.get(f"/workspaces/{ws}/ai/settings", headers=H(team["alice"]))).json()
    assert empty["provider"] is None and empty["key_set"] is False and empty["source"] is None
    assert all(empty["features"].values()) and set(empty["features"]) == set(ai_ws.FEATURE_KEYS)
    assert empty["per_user_limit"] == settings.ai_rate_limit_requests

    out = await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY, per_user_limit=25)
    assert out["provider"] == "deepseek" and out["model"] == "deepseek-chat"
    assert out["key_set"] is True and out["key_hint"] == "…abcd" and out["source"] == "workspace"
    assert out["per_user_limit"] == 25 and out["updated_by"] == team["alice"]["id"]
    assert "api_key" not in out and DEEPSEEK_KEY not in json.dumps(out)
    again = await client.get(f"/workspaces/{ws}/ai/settings", headers=H(team["alice"]))
    assert DEEPSEEK_KEY not in again.text and "1234567890" not in again.text

    # Stored encrypted only.
    async with SessionLocal() as db:
        row = await db.get(WorkspaceAISettings, uuid.UUID(ws))
        assert DEEPSEEK_KEY.encode() not in bytes(row.api_key_encrypted)
        assert decrypt_key(row.api_key_encrypted) == DEEPSEEK_KEY
        # Audited without the key.
        from app.models.admin import AuditEvent

        events = list(
            await db.scalars(
                select(AuditEvent).where(
                    AuditEvent.workspace_id == uuid.UUID(ws), AuditEvent.action == "ai.settings_updated"
                )
            )
        )
    assert events and events[-1].meta["key"] == "set" and "api_key" in events[-1].meta["changes"]
    assert all(DEEPSEEK_KEY not in json.dumps(e.meta) and "abcd" not in json.dumps(e.meta) for e in events)

    # Partial update keeps the key; "" clears it; switching provider without a key clears it.
    out = await configure(client, team, features={"translate": False})
    assert out["key_set"] is True and out["features"]["translate"] is False and out["features"]["ask"]
    out = await configure(client, team, api_key="")
    assert out["key_set"] is False and out["source"] is None
    await configure(client, team, api_key=DEEPSEEK_KEY)
    out = await configure(client, team, provider="gemini")
    assert out["provider"] == "gemini" and out["key_set"] is False and out["model"] is None

    # Validation.
    for bad in (
        {"features": {"bogus": True}},
        {"per_user_limit": 0},
        {"provider": "openai"},
        {"model": "bad model id!"},
        {"api_key": "short"},
    ):
        r = await client.put(f"/workspaces/{ws}/ai/settings", json=bad, headers=H(team["alice"]))
        assert r.status_code == 422, (bad, r.text)


async def test_env_key_is_the_fallback(client, team, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "env-key")
    ws = team["ws"]["id"]
    out = (await client.get(f"/workspaces/{ws}/ai/settings", headers=H(team["alice"]))).json()
    assert out["provider"] == "anthropic" and out["source"] == "env" and out["key_set"] is False
    status = (await client.get(f"/workspaces/{ws}/ai/status", headers=H(team["bob"]))).json()
    assert status["enabled"] is True and status["provider"] == "anthropic"
    assert status["model"] == settings.ai_model and status["can_configure"] is False
    # A workspace key takes precedence over the env key.
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    status = (await client.get(f"/workspaces/{ws}/ai/status", headers=H(team["alice"]))).json()
    assert status["provider"] == "deepseek" and status["can_configure"] is True
    # Legacy server-wide status still works.
    legacy = (await client.get("/ai/status", headers=H(team["bob"]))).json()
    assert legacy["enabled"] is True


# --- Provider switching ---------------------------------------------------------------------


async def test_compose_uses_the_workspace_provider(client, team, fake_oa, monkeypatch):
    ws = team["ws"]["id"]
    url = f"/workspaces/{ws}/ai/compose"
    body = {"text": f"hey <@{team['bob']['id']}> pls check", "action": "friendlier"}
    r = await client.post(url, json=body, headers=H(team["alice"]))
    assert r.status_code == 503 and r.json() == {"detail": "ai_not_configured"}

    # DeepSeek via the OpenAI-compatible client.
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    calls = fake_oa([oa_response("Hi <@m1>, could you check?")])
    r = await client.post(url, json=body, headers=H(team["alice"]))
    assert r.status_code == 200, r.text
    assert r.json()["text"] == f"Hi <@{team['bob']['id']}>, could you check?"
    sent = calls.calls[0]
    assert fake_oa.seen[-1] == ("deepseek", DEEPSEEK_KEY)
    assert sent["model"] == "deepseek-chat" and sent["max_tokens"] <= 8192
    assert sent["messages"][0]["role"] == "system" and sent["messages"][1]["role"] == "user"
    assert team["bob"]["id"] not in sent["messages"][1]["content"]
    assert "reasoning_effort" not in sent

    # Gemini: effort maps to reasoning_effort, the admin's model is used.
    await configure(client, team, provider="gemini", api_key=GEMINI_KEY, model="gemini-2.5-pro")
    calls = fake_oa([oa_response("Hello there")])
    r = await client.post(url, json=body, headers=H(team["alice"]))
    assert r.status_code == 200, r.text
    assert calls.calls[0]["model"] == "gemini-2.5-pro" and calls.calls[0]["reasoning_effort"] == "low"
    assert fake_oa.seen[-1] == ("gemini", GEMINI_KEY)

    # Anthropic with the workspace's own key: the Anthropic SDK path, same request shape.
    keys: list = []
    fake = FakeMessages([message([text_block("Hey!")])])

    def get_client(api_key=None):
        keys.append(api_key)
        return SimpleNamespace(beta=SimpleNamespace(messages=fake))

    monkeypatch.setattr(ai_client, "get_client", get_client)
    await configure(client, team, provider="anthropic", api_key=ANTHROPIC_KEY)
    r = await client.post(url, json=body, headers=H(team["alice"]))
    # (the model dropped the mention placeholder, so the mention is kept up front)
    assert r.status_code == 200 and r.json()["text"] == f"<@{team['bob']['id']}> Hey!"
    assert keys == [ANTHROPIC_KEY]
    assert fake.calls[0]["model"] == "claude-opus-5-5" and fake.calls[0]["fallbacks"] == "default"
    assert fake.calls[0]["output_config"] == {"effort": "low"}

    # Usage was logged per provider model.
    async with SessionLocal() as db:
        models = set(
            await db.scalars(select(AIUsage.model).where(AIUsage.workspace_id == uuid.UUID(ws)))
        )
    assert {"deepseek-chat", "gemini-2.5-pro", "claude-opus-5-5"} <= models

    # The legacy route accepts workspace_id too.
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    fake_oa([oa_response("ok")])
    r = await client.post(
        f"/ai/compose?workspace_id={ws}", json={"text": "hi", "action": "improve"}, headers=H(team["bob"])
    )
    assert r.status_code == 200 and r.json()["text"] == "ok"


async def test_provider_errors_map_to_http_errors(client, team, fake_oa):
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    url = f"/workspaces/{team['ws']['id']}/ai/compose"
    body = {"text": "hello", "action": "improve"}
    cases = [
        (api_error(openai.RateLimitError, 429, "slow down"), 429),
        (api_error(openai.AuthenticationError, 401, f"bad key {DEEPSEEK_KEY}"), 502),
        (api_error(openai.BadRequestError, 400, "Content Exists Risk"), 422),
        (api_error(openai.InternalServerError, 500, "oops"), 502),
    ]
    for exc, code in cases:
        fake_oa([exc])
        r = await client.post(url, json=body, headers=H(team["alice"]))
        assert r.status_code == code, (exc, r.text)
        assert DEEPSEEK_KEY not in r.text
    fake_oa([oa_response("", finish="content_filter")])
    r = await client.post(url, json=body, headers=H(team["alice"]))
    assert r.status_code == 422


async def test_json_results_validate_and_retry_once(client, team, fake_oa):
    await configure(client, team, provider="gemini", api_key=GEMINI_KEY, model="gemini-2.5-flash")
    msg = await _post(client, team["general"]["id"], team["alice"], "Bonjour tout le monde")
    url = f"/messages/{msg['id']}/ai/translate"
    calls = fake_oa(
        [
            oa_response('{"text": "Hello everyone"}'),  # missing detected_language
            oa_response('```json\n{"text": "Hello everyone", "detected_language": "French"}\n```'),
        ]
    )
    r = await client.post(url, json={"target_language": "English"}, headers=H(team["alice"]))
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "Hello everyone", "detected_language": "French"}
    first, retry = calls.calls
    assert first["response_format"] == {"type": "json_object"}
    assert "JSON Schema" in first["messages"][0]["content"]
    assert retry["messages"][-1]["role"] == "user" and "did not match" in retry["messages"][-1]["content"]

    fake_oa([oa_response("not json"), oa_response("still not json")])
    r = await client.post(url, json={"target_language": "English"}, headers=H(team["alice"]))
    assert r.status_code == 502


async def test_streaming_summary_through_openai_compatible_provider(client, team, fake_oa):
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    await _post(client, team["general"]["id"], team["bob"], "We ship on Friday")
    calls = fake_oa([text_stream("Shipping Friday [1].")])
    r = await client.post(
        f"/channels/{team['general']['id']}/ai/summary", json={"range": "all"}, headers=H(team["alice"])
    )
    assert r.status_code == 200, r.text
    events = [json.loads(c[6:]) for c in r.text.split("\n\n") if c]
    deltas = "".join(e["delta"] for e in events if e["type"] == "text")
    assert deltas == "Shipping Friday [1]."
    cites = next(e for e in events if e["type"] == "citations")["items"]
    assert len(cites) == 1 and events[-1]["type"] == "done"
    assert calls.calls[0]["stream"] is True and calls.calls[0]["stream_options"] == {"include_usage": True}

    # Truncation is reported like the Anthropic path.
    fake_oa([text_stream("Partial", finish="length")])
    r = await client.post(
        f"/channels/{team['general']['id']}/ai/summary", json={"range": "all"}, headers=H(team["alice"])
    )
    deltas = "".join(json.loads(c[6:]).get("delta", "") for c in r.text.split("\n\n") if c)
    assert deltas.endswith(ai_client.TRUNCATION_NOTE)


async def test_ask_tool_loop_with_function_calling(client, team, fake_oa):
    await configure(client, team, provider="gemini", api_key=GEMINI_KEY, model="gemini-2.5-pro")
    await _post(client, team["general"]["id"], team["bob"], "Pricing stays at 12 dollars per seat")

    def second(kw):
        tool_msgs = [m for m in kw["messages"] if m["role"] == "tool"]
        assert len(tool_msgs) == 1 and "12 dollars" in tool_msgs[0]["content"]
        assistant = next(m for m in kw["messages"] if m["role"] == "assistant")
        call = assistant["tool_calls"][0]
        assert call["function"]["name"] == "search_messages" and call["id"] == "call_1"
        # Gemini thought signatures are echoed back unchanged.
        assert call["extra_content"] == {"google": {"thought_signature": "sig"}}
        return text_stream("Pricing is $12 per seat [1].")

    tool_chunks = [
        chunk(tool_calls=[tc_delta(0, "call_1", "search_messages", '{"query": ')]),
        chunk(tool_calls=[tc_delta(0, None, None, '"pricing"}')]),
        chunk(finish="tool_calls"),
        chunk(usage=oa_usage()),
    ]
    tool_chunks[0].choices[0].delta.tool_calls[0].model_extra = {
        "extra_content": {"google": {"thought_signature": "sig"}}
    }
    calls = fake_oa([tool_chunks, second])
    r = await client.post(
        f"/workspaces/{team['ws']['id']}/ai/ask", json={"question": "What's our pricing?"},
        headers=H(team["alice"]),
    )
    assert r.status_code == 200, r.text
    events = [json.loads(c[6:]) for c in r.text.split("\n\n") if c]
    answer = "".join(e["delta"] for e in events if e["type"] == "text")
    assert answer == "Pricing is $12 per seat [1]."
    assert any(e["type"] == "status" and "Search" in e["text"] for e in events)
    assert events[-1]["type"] == "done" and events[-1]["usage"]["input_tokens"] == 200
    tools = calls.calls[0]["tools"]
    params = next(t for t in tools if t["function"]["name"] == "search_messages")["function"]["parameters"]
    assert "additionalProperties" not in json.dumps(params)  # sanitized for Gemini
    assert calls.calls[0]["tool_choice"] == "auto"


def test_gemini_schema_sanitizer():
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"a": {"type": ["string", "null"], "default": "x", "description": "d"}},
        "required": ["a"],
    }
    out = providers.sanitize_schema(schema, "gemini")
    assert out == {
        "type": "object",
        "properties": {"a": {"type": "string", "nullable": True, "description": "d"}},
        "required": ["a"],
    }
    assert providers.sanitize_schema(schema, "deepseek") is schema


# --- Connection test ------------------------------------------------------------------------


async def test_connection_test_lists_models(client, team, fake_oa):
    ws = team["ws"]["id"]
    url = f"/workspaces/{ws}/ai/test"
    fake_oa(
        [oa_response("OK")],
        model_ids=[
            "models/gemini-2.0-flash", "models/gemini-2.5-pro", "models/gemini-2.5-flash",
            "models/text-embedding-004", "models/gemini-3.0-pro-preview", "models/gemini-3.0-flash",
        ],
    )
    r = await client.post(
        url, json={"provider": "gemini", "api_key": GEMINI_KEY, "model": "gemini-2.5-flash"},
        headers=H(team["alice"]),
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] is True and out["latency_ms"] >= 0 and "error" not in out
    assert "text-embedding-004" not in out["models"] and out["models"][0].startswith("gemini-3.0")
    assert out["suggested_model"] == "gemini-3.0-flash"  # newest stable pro/flash
    assert GEMINI_KEY not in r.text

    # A rejected key: ok false, a safe error, never the key.
    fake_oa([], models_error=api_error(openai.AuthenticationError, 401, f"invalid {GEMINI_KEY}"))
    out = (
        await client.post(url, json={"provider": "gemini", "api_key": GEMINI_KEY}, headers=H(team["alice"]))
    ).json()
    assert out["ok"] is False and "rejected" in out["error"] and GEMINI_KEY not in json.dumps(out)

    # Without api_key the saved key for that provider is used; none saved -> 422.
    r = await client.post(url, json={"provider": "deepseek"}, headers=H(team["alice"]))
    assert r.status_code == 422
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    fake_oa([], model_ids=["deepseek-reasoner", "deepseek-chat"])
    out = (await client.post(url, json={"provider": "deepseek"}, headers=H(team["alice"]))).json()
    assert out["ok"] is True and out["models"] == ["deepseek-chat", "deepseek-reasoner"]
    assert out["suggested_model"] == "deepseek-chat"
    assert fake_oa.seen[-1] == ("deepseek", DEEPSEEK_KEY)


# --- Toggles, policy, limits, status, usage -------------------------------------------------


async def test_feature_toggles_and_use_ai_policy(client, team, fake_oa):
    ws = team["ws"]["id"]
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY, features={"composer": False})
    url = f"/workspaces/{ws}/ai/compose"
    body = {"text": "hello", "action": "improve"}
    r = await client.post(url, json=body, headers=H(team["bob"]))
    assert r.status_code == 403 and r.json() == {"detail": "ai_feature_disabled"}
    r = await client.post(f"/ai/compose?workspace_id={ws}", json=body, headers=H(team["bob"]))
    assert r.status_code == 403
    status = (await client.get(f"/workspaces/{ws}/ai/status", headers=H(team["bob"]))).json()
    assert status["features"]["composer"] is False and status["features"]["ask"] is True

    await configure(client, team, features={"composer": True})
    await _set_policy(team, "use_ai", "admins")
    r = await client.post(url, json=body, headers=H(team["bob"]))
    assert r.status_code == 403 and r.json() == {"detail": "policy:use_ai"}
    r = await client.post(
        f"/workspaces/{ws}/ai/ask", json={"question": "hi"}, headers=H(team["bob"])
    )
    assert r.status_code == 403 and r.json() == {"detail": "policy:use_ai"}
    status = (await client.get(f"/workspaces/{ws}/ai/status", headers=H(team["bob"]))).json()
    assert status["enabled"] is True and status["can_use"] is False
    fake_oa([oa_response("Hello!")])
    assert (await client.post(url, json=body, headers=H(team["alice"]))).status_code == 200

    # Guests never, whatever the policy says.
    await _set_policy(team, "use_ai", "everyone")
    await _set_role(team, "carol", WorkspaceRole.guest)
    r = await client.post(url, json=body, headers=H(team["carol"]))
    assert r.status_code == 403 and r.json() == {"detail": "policy:use_ai"}
    # Outsiders get 404.
    stranger = await register(client, "stranger")
    assert (await client.post(url, json=body, headers=H(stranger))).status_code == 404


async def test_per_user_limit_comes_from_settings(client, team, fake_oa):
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY, per_user_limit=2)
    fake_oa([oa_response("a"), oa_response("b")])
    url = f"/workspaces/{team['ws']['id']}/ai/compose"
    codes = [
        (await client.post(url, json={"text": "hi", "action": "improve"}, headers=H(team["bob"]))).status_code
        for _ in range(3)
    ]
    assert codes == [200, 200, 429]


async def test_usage_report(client, team, fake_oa):
    ws = team["ws"]["id"]
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    fake_oa([oa_response("a"), oa_response("b")])
    for who in ("alice", "bob"):
        r = await client.post(
            f"/workspaces/{ws}/ai/compose", json={"text": "hi", "action": "improve"}, headers=H(team[who])
        )
        assert r.status_code == 200
    out = (await client.get(f"/workspaces/{ws}/ai/usage?days=7", headers=H(team["alice"]))).json()
    assert out["days"] == 7
    assert sum(d["requests"] for d in out["by_day"]) == 2
    # 100 uncached + 20 cached prompt tokens per call, 30 output.
    assert sum(d["input_tokens"] for d in out["by_day"]) == 240
    assert sum(d["output_tokens"] for d in out["by_day"]) == 60
    assert out["by_feature"] == [
        {"feature": "composer", "requests": 2, "input_tokens": 240, "output_tokens": 60}
    ]
    assert {u["user_id"] for u in out["by_user"]} == {team["alice"]["id"], team["bob"]["id"]}
    r = await client.get(f"/workspaces/{ws}/ai/usage?days=0", headers=H(team["alice"]))
    assert r.status_code == 422


# --- Agent installs -------------------------------------------------------------------------


@pytest.fixture
def enqueued(monkeypatch):
    sent: list[tuple[uuid.UUID, uuid.UUID]] = []
    monkeypatch.setattr(agent, "_send_agent_task", lambda m, u: sent.append((m, u)))
    return sent


async def _new_channel(client, team, kind="public", members=("bob",), owner="alice"):
    body = {"name": f"c-{uuid.uuid4().hex[:8]}", "kind": kind, "member_ids": [team[m]["id"] for m in members]}
    r = await client.post(f"/workspaces/{team['ws']['id']}/channels", json=body, headers=H(team[owner]))
    assert r.status_code == 201, r.text
    return r.json()


async def _thread(client, message_id, who):
    r = await client.get(f"/messages/{message_id}/replies", headers=H(who))
    assert r.status_code == 200, r.text
    return r.json()


async def test_agent_answers_only_where_installed(client, team, fake_oa, enqueued):
    ws = team["ws"]["id"]
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    bot_id = (await client.get(f"/workspaces/{ws}/ai/bot", headers=H(team["alice"]))).json()["user_id"]
    channel = await _new_channel(client, team)
    status = (await client.get(f"/workspaces/{ws}/ai/status", headers=H(team["bob"]))).json()
    assert status["agent_installed_channel_ids"] == [] and status["agent_installed_everywhere"] is False

    # Not installed: one notice (system message, in the thread), nothing enqueued.
    ask = await _post(client, channel["id"], team["bob"], f"<@{bot_id}> summarize please")
    await agent.drain()
    assert enqueued == []
    notice = await _thread(client, ask["id"], team["bob"])
    assert len(notice) == 1 and notice[0]["kind"] == "system" and notice[0]["author_id"] == bot_id
    assert notice[0]["body"] == (
        f"Worklio AI isn't added to #{channel['name']}. Channel managers can add it from "
        "Channel details → Integrations."
    )
    assert notice[0]["meta"]["type"] == "ai_agent_not_installed" and notice[0]["meta"]["ephemeral"]
    # Rate limited: a second mention the same day stays quiet.
    again = await _post(client, channel["id"], team["bob"], f"<@{bot_id}> hello?")
    await agent.drain()
    assert await _thread(client, again["id"], team["bob"]) == []
    members = (await client.get(f"/channels/{channel['id']}/members", headers=H(team["bob"]))).json()
    assert bot_id not in members

    # Install: install_apps policy + channel membership.
    url = f"/channels/{channel['id']}/apps/worklio"
    assert (await client.post(url, headers=H(team["carol"]))).status_code == 403  # not a member
    await _set_policy(team, "install_apps", "admins")
    r = await client.post(url, headers=H(team["bob"]))
    assert r.status_code == 403 and r.json() == {"detail": "policy:install_apps"}
    await _set_policy(team, "install_apps", "everyone")
    r = await client.post(url, headers=H(team["bob"]))
    assert r.status_code == 200, r.text
    assert r.json()["installed"] is True and r.json()["bot_user_id"] == bot_id
    assert (await client.post(url, headers=H(team["bob"]))).status_code == 200  # idempotent
    members = (await client.get(f"/channels/{channel['id']}/members", headers=H(team["bob"]))).json()
    assert bot_id in members
    history = (await client.get(f"/channels/{channel['id']}/messages", headers=H(team["bob"]))).json()
    system = [m for m in history if m["kind"] == "system" and m["parent_id"] is None]
    assert [m["body"] for m in system] == ["bob added Worklio AI to this channel"]
    status = (await client.get(f"/workspaces/{ws}/ai/status", headers=H(team["bob"]))).json()
    assert status["agent_installed_channel_ids"] == [channel["id"]]

    # Now a mention is handed to the worker, and the agent answers through DeepSeek tools.
    ask = await _post(client, channel["id"], team["bob"], f"<@{bot_id}> what's new?")
    await agent.drain()
    assert enqueued == [(uuid.UUID(ask["id"]), uuid.UUID(team["bob"]["id"]))]
    fake_oa([text_stream("Nothing much yet.")])
    run = await agent.run_agent(ask["id"], team["bob"]["id"])
    assert run is not None and run.outcome == "answered"
    reply = (await _thread(client, ask["id"], team["bob"]))[0]
    assert reply["author_id"] == bot_id and reply["body"] == "Nothing much yet."

    # The agent toggle off: a short notice instead of an answer.
    await configure(client, team, features={"agent": False})
    ask = await _post(client, channel["id"], team["bob"], f"<@{bot_id}> still there?")
    await agent.drain()
    assert len(enqueued) == 1
    reply = (await _thread(client, ask["id"], team["bob"]))[0]
    assert reply["body"] == agent.FEATURE_DISABLED_TEXT and reply["meta"]["outcome"] == "feature_disabled"
    await configure(client, team, features={"agent": True})

    # use_ai = admins: members get the policy notice.
    await _set_policy(team, "use_ai", "admins")
    ask = await _post(client, channel["id"], team["bob"], f"<@{bot_id}> hi")
    await agent.drain()
    reply = (await _thread(client, ask["id"], team["bob"]))[0]
    assert reply["body"] == agent.POLICY_TEXT
    await _set_policy(team, "use_ai", "everyone")

    # Uninstall: the bot leaves and mentions stop reaching the worker.
    r = await client.delete(url, headers=H(team["bob"]))
    assert r.status_code == 200 and r.json()["installed"] is False
    members = (await client.get(f"/channels/{channel['id']}/members", headers=H(team["bob"]))).json()
    assert bot_id not in members
    await _post(client, channel["id"], team["bob"], f"<@{bot_id}> gone?")
    await agent.drain()
    assert len(enqueued) == 1


async def test_install_everywhere_covers_public_channels_and_dms_always_work(
    client, team, fake_oa, enqueued
):
    ws = team["ws"]["id"]
    await configure(client, team, provider="deepseek", api_key=DEEPSEEK_KEY)
    url = f"/workspaces/{ws}/apps/worklio/install-everywhere"
    assert (await client.post(url, headers=H(team["bob"]))).status_code == 403  # admins only
    r = await client.post(url, headers=H(team["alice"]))
    assert r.status_code == 200 and r.json()["channel_id"] is None
    bot_id = r.json()["bot_user_id"]
    status = (await client.get(f"/workspaces/{ws}/ai/status", headers=H(team["bob"]))).json()
    assert status["agent_installed_everywhere"] is True

    public = await _new_channel(client, team)
    private = await _new_channel(client, team, kind="private")
    pub_ask = await _post(client, public["id"], team["bob"], f"<@{bot_id}> hi")
    priv_ask = await _post(client, private["id"], team["bob"], f"<@{bot_id}> hi")
    await agent.drain()
    assert enqueued == [(uuid.UUID(pub_ask["id"]), uuid.UUID(team["bob"]["id"]))]
    assert (await _thread(client, priv_ask["id"], team["bob"]))[0]["meta"]["type"] == "ai_agent_not_installed"

    # DMs need no install.
    dm = (
        await client.post(f"/workspaces/{ws}/dms", json={"user_ids": [bot_id]}, headers=H(team["carol"]))
    ).json()
    dm_msg = await _post(client, dm["id"], team["carol"], "hey")
    await agent.drain()
    assert enqueued[-1] == (uuid.UUID(dm_msg["id"]), uuid.UUID(team["carol"]["id"]))
    r = await client.post(f"/channels/{dm['id']}/apps/worklio", headers=H(team["carol"]))
    assert r.status_code == 400

    # Removing the everywhere install stops public coverage.
    assert (await client.delete(url, headers=H(team["alice"]))).status_code == 200
    enqueued.clear()
    await _post(client, public["id"], team["bob"], f"<@{bot_id}> again")
    await agent.drain()
    assert enqueued == []

    # Install / uninstall are audited.
    from app.models.admin import AuditEvent

    async with SessionLocal() as db:
        actions = list(
            await db.scalars(
                select(AuditEvent.action).where(
                    AuditEvent.workspace_id == uuid.UUID(ws), AuditEvent.action.like("app.%")
                )
            )
        )
    assert actions.count("app.installed") == 1 and actions.count("app.uninstalled") == 1

