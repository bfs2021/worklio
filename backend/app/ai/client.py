"""The one place Worklio talks to an AI provider.

Each public function (`ai_text`, `ai_stream`, `ai_json`, `ai_tool_loop`) takes the
`workspace_id` it works for and resolves that workspace's provider (app/ai/workspace.py): the
workspace's own Anthropic / Gemini / DeepSeek key, else the server's ANTHROPIC_API_KEY, else
AINotConfigured. Gemini and DeepSeek go through their OpenAI-compatible endpoints
(app/ai/providers.py) with the same semantics (tools, streaming, JSON, errors, usage).

Every Anthropic request:
- goes through the beta Messages endpoint with server-side refusal fallbacks opted in
  (`betas=["server-side-fallback-2026-07-01"]`, `fallbacks="default"`);
- uses the workspace's model (default `settings.ai_model`, "claude-opus-5-5"), never sends `thinking` (always adaptive on this
  model) or sampling parameters, and controls depth/latency/cost with `output_config.effort`;
- puts the stable system prompt first with a `cache_control` breakpoint so it is prompt-cached;
- checks `stop_reason` ("refusal" raises AIRefused, "max_tokens" is reported as truncation);
- logs token usage to the `ai_usage` table (never fails the caller).

Rate limiting is separate (`enforce_rate_limit`) so callers decide what one "request" is
(a whole Ask answer is one request even though the tool loop makes several API calls).

Callers outside the API process (Celery) must call these functions inside the event loop they
run on: the Anthropic client is cached per event loop, and usage logging uses a NullPool engine.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
import weakref
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Self

import anthropic
from anthropic import AsyncAnthropic
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.ai.workspace import ProviderConfig, resolve_provider
from app.core.config import settings

log = logging.getLogger(__name__)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
TRUNCATION_NOTE = "\n\n_…the answer was cut off at the length limit._"

# Everything the AI layer can do, reported by GET /ai/status when enabled.
FEATURES = [
    "ask",
    "channel_summary",
    "thread_summary",
    "catch_up",
    "compose",
    "translate",
    "tasks",
    "agent",
    "call_summary",
]

# --- Errors ---------------------------------------------------------------------------------


class AIError(Exception):
    """Base class. `code` matches the SSE error event codes."""

    code = "failed"
    user_message = "Worklio AI couldn't finish that. Please try again."

    def __init__(self, message: str | None = None):
        super().__init__(message or self.user_message)
        self.message = message or self.user_message


class AINotConfigured(AIError):
    code = "ai_not_configured"
    user_message = (
        "Worklio AI isn't set up yet. A workspace admin can connect an AI provider in "
        "Workspace settings → Worklio AI."
    )


class AIRefused(AIError):
    code = "refusal"
    user_message = "Worklio AI can't help with this request."


class AIRateLimited(AIError):
    code = "rate_limited"
    user_message = "You're using Worklio AI a lot right now. Try again in a few minutes."

    def __init__(self, message: str | None = None, retry_after: int = 60):
        super().__init__(message)
        self.retry_after = retry_after


class AIFailed(AIError):
    code = "failed"


# --- Client ---------------------------------------------------------------------------------


def env_ai_enabled() -> bool:
    """Server-wide Anthropic key present (the fallback for workspaces without their own key)."""
    return bool(settings.anthropic_api_key)


async def ai_enabled(workspace_id: uuid.UUID | None = None) -> bool:
    """True when the workspace has a provider + key configured (or the env fallback exists)."""
    return await resolve_provider(workspace_id) is not None


async def provider_for(workspace_id: uuid.UUID | None) -> ProviderConfig:
    cfg = await resolve_provider(workspace_id)
    if cfg is None:
        raise AINotConfigured()
    return cfg


_clients: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[str, AsyncAnthropic]
] = weakref.WeakKeyDictionary()


def get_client(api_key: str | None = None) -> AsyncAnthropic:
    """The AsyncAnthropic client for the running event loop and key (tests monkeypatch this).

    Without `api_key` it is the server's env key client.
    """
    key = api_key or settings.anthropic_api_key
    if not key:
        raise AINotConfigured()
    loop = asyncio.get_running_loop()
    per_loop = _clients.setdefault(loop, {})
    client = per_loop.get(key)
    if client is None:
        client = AsyncAnthropic(api_key=key, timeout=settings.ai_request_timeout, max_retries=2)
        per_loop[key] = client
    return client


def _anthropic(cfg: ProviderConfig) -> Any:
    # The env client is fetched without arguments so test fakes can stay zero-argument.
    return get_client() if cfg.source == "env" else get_client(cfg.api_key)


def _request(
    system: str,
    messages: list[dict],
    *,
    effort: str,
    max_tokens: int,
    tools: list[dict] | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    if effort not in EFFORTS:
        raise ValueError(f"effort must be one of {EFFORTS}")
    kwargs: dict[str, Any] = {
        "model": model or settings.ai_model,
        "max_tokens": max_tokens,
        # Stable prefix first (tools, then this system block): cached across requests.
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "messages": messages,
        "output_config": {"effort": effort},
        "betas": [FALLBACK_BETA],
        "fallbacks": "default",
    }
    if tools:
        kwargs["tools"] = tools
        # Tool loops re-send a growing history: also cache up to the last block each turn.
        kwargs["cache_control"] = {"type": "ephemeral"}
    return kwargs


def _translate_error(exc: Exception) -> AIError:
    """Map SDK exceptions (most specific first) to AI errors with safe user-facing text."""
    if isinstance(exc, anthropic.RateLimitError):
        retry = 60
        try:
            retry = int(exc.response.headers.get("retry-after", "60"))
        except (TypeError, ValueError):
            pass
        return AIRateLimited("Worklio AI is busy right now. Try again in a minute.", retry)
    if isinstance(exc, anthropic.AuthenticationError):
        log.error("Anthropic rejected the API key: %s", exc)
        return AIFailed("Worklio AI is misconfigured (the API key was rejected).")
    if isinstance(exc, anthropic.PermissionDeniedError):
        log.error("Anthropic permission denied: %s", exc)
        return AIFailed("Worklio AI isn't allowed to use this model with the configured key.")
    if isinstance(exc, anthropic.BadRequestError):
        log.error("Anthropic rejected a request: %s", exc)
        return AIFailed()
    if isinstance(exc, anthropic.APIStatusError):
        log.warning("Anthropic API error %s: %s", exc.status_code, exc)
        if exc.status_code >= 500:
            return AIFailed("Claude is temporarily unavailable. Please try again shortly.")
        return AIFailed()
    if isinstance(exc, anthropic.APITimeoutError):
        return AIFailed("Worklio AI took too long to answer. Please try again.")
    if isinstance(exc, anthropic.APIConnectionError):
        log.warning("Could not reach Anthropic: %s", exc)
        return AIFailed("Worklio AI couldn't reach Claude. Please try again.")
    if isinstance(exc, AIError):
        return exc
    log.exception("Unexpected AI error", exc_info=exc)
    return AIFailed()


_SDK_ERRORS = (anthropic.APIError,)


# --- Usage ----------------------------------------------------------------------------------


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def add(self, other: Usage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens

    def as_dict(self) -> dict[str, int]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
        }


def _int(obj: Any, name: str) -> int:
    value = getattr(obj, name, 0)
    return value if isinstance(value, int) else 0


def usage_of(message: Any) -> Usage:
    """Token usage of a response. With fallbacks, `usage.iterations` lists every attempt."""
    usage = getattr(message, "usage", None)
    if usage is None:
        return Usage()
    entries = getattr(usage, "iterations", None) or [usage]
    out = Usage()
    for e in entries:
        out.add(
            Usage(
                _int(e, "input_tokens"),
                _int(e, "output_tokens"),
                _int(e, "cache_read_input_tokens"),
                _int(e, "cache_creation_input_tokens"),
            )
        )
    return out


_usage_engine: AsyncEngine | None = None


def _engine() -> AsyncEngine:
    # NullPool: works from any event loop (API process or Celery's per-task loops).
    global _usage_engine
    if _usage_engine is None:
        _usage_engine = create_async_engine(settings.database_url, poolclass=NullPool)
    return _usage_engine


async def record_usage(
    usage: Usage,
    *,
    feature: str,
    user_id: uuid.UUID | None,
    workspace_id: uuid.UUID | None,
    model: str | None = None,
) -> None:
    """Insert one ai_usage row. Never raises: accounting must not break a feature."""
    from app.models.ai import AIUsage

    try:
        async with AsyncSession(_engine()) as db:
            db.add(
                AIUsage(
                    user_id=user_id,
                    workspace_id=workspace_id,
                    feature=feature[:40],
                    model=(model or settings.ai_model)[:80],
                    **usage.as_dict(),
                )
            )
            await db.commit()
    except Exception:
        log.exception("Could not record AI usage")


# --- Rate limit -----------------------------------------------------------------------------


async def enforce_rate_limit(
    user_id: uuid.UUID,
    feature: str,
    *,
    workspace_id: uuid.UUID | None = None,
    redis_client: Any = None,
) -> None:
    """Count one AI request for the user; raise AIRateLimited past the per-user budget.

    One budget covers every feature: the workspace's `per_user_limit` (admin setting), else
    `settings.ai_rate_limit_requests`, per `ai_rate_limit_window_seconds` (10 minutes). Pass
    `redis_client` when calling from a different event loop than the API's (e.g. Celery).
    """
    from app.ai.workspace import load_config, per_user_limit

    if redis_client is None:
        from app.core.redis import redis as redis_client
    limit = settings.ai_rate_limit_requests
    if workspace_id is not None:
        limit = per_user_limit(await load_config(workspace_id))
    window = max(1, settings.ai_rate_limit_window_seconds)
    bucket = int(time.time()) // window
    scope = f"{workspace_id}:" if workspace_id is not None else ""
    key = f"rl:ai:{scope}{user_id}:{bucket}"
    async with redis_client.pipeline() as pipe:
        count, _ = await pipe.incr(key).expire(key, window).execute()
    if count > limit:
        retry_after = window - int(time.time()) % window
        log.info("AI rate limit hit by %s (%s)", user_id, feature)
        raise AIRateLimited(retry_after=retry_after)


# --- Response helpers -----------------------------------------------------------------------


def _text_of(message: Any) -> str:
    # Read blocks by type: responses can start with thinking or fallback blocks.
    return "".join(b.text for b in message.content if getattr(b, "type", None) == "text")


def _check_refusal(message: Any) -> None:
    # Branch on stop_reason (stop_details is informational and may be null).
    if getattr(message, "stop_reason", None) == "refusal":
        details = getattr(message, "stop_details", None)
        log.info("Claude declined a request (category=%s)", getattr(details, "category", None))
        raise AIRefused()


def _echo_content(content: list[Any]) -> list[Any]:
    """Assistant content to send back on the next turn.

    After a mid-output fallback, thinking and tool_use blocks that came *before* the last
    `fallback` block belong to the declined attempt and must not be echoed.
    """
    last_fallback = max(
        (i for i, b in enumerate(content) if getattr(b, "type", None) == "fallback"), default=-1
    )
    if last_fallback < 0:
        return list(content)
    drop = {"thinking", "redacted_thinking", "tool_use"}
    return [
        b for i, b in enumerate(content)
        if i >= last_fallback or getattr(b, "type", None) not in drop
    ]


class AIText(str):
    """A text result that also says whether it hit max_tokens."""

    truncated: bool = False

    def __new__(cls, value: str, truncated: bool = False) -> Self:
        obj = super().__new__(cls, value)
        obj.truncated = truncated
        return obj


# --- Public API -----------------------------------------------------------------------------


async def ai_text(
    system: str,
    messages: list[dict],
    *,
    effort: str = "low",
    max_tokens: int = 4000,
    user_id: uuid.UUID | None = None,
    feature: str,
    workspace_id: uuid.UUID | None = None,
) -> AIText:
    """One non-streaming request; returns the text (AIText.truncated on max_tokens)."""
    cfg = await provider_for(workspace_id)
    if cfg.provider != "anthropic":
        from app.ai import providers

        return await providers.oa_text(
            cfg, system, messages, effort=effort, max_tokens=max_tokens, user_id=user_id,
            feature=feature, workspace_id=workspace_id,
        )
    client = _anthropic(cfg)
    try:
        resp = await client.beta.messages.create(
            **_request(system, messages, effort=effort, max_tokens=max_tokens, model=cfg.model)
        )
    except _SDK_ERRORS as exc:
        raise _translate_error(exc) from exc
    await record_usage(
        usage_of(resp), feature=feature, user_id=user_id, workspace_id=workspace_id,
        model=getattr(resp, "model", None),
    )
    _check_refusal(resp)
    return AIText(_text_of(resp).strip(), truncated=resp.stop_reason == "max_tokens")


async def ai_stream(
    system: str,
    messages: list[dict],
    *,
    effort: str = "medium",
    max_tokens: int = 16000,
    user_id: uuid.UUID | None = None,
    feature: str,
    workspace_id: uuid.UUID | None = None,
) -> AsyncIterator[str]:
    """Stream text deltas. A refusal raises AIRefused after any partial text (discard it);
    hitting max_tokens yields TRUNCATION_NOTE as a last delta."""
    cfg = await provider_for(workspace_id)
    if cfg.provider != "anthropic":
        from app.ai import providers

        async for delta in providers.oa_stream(
            cfg, system, messages, effort=effort, max_tokens=max_tokens, user_id=user_id,
            feature=feature, workspace_id=workspace_id,
        ):
            yield delta
        return
    client = _anthropic(cfg)
    final = None
    try:
        async with client.beta.messages.stream(
            **_request(system, messages, effort=effort, max_tokens=max_tokens, model=cfg.model)
        ) as stream:
            async for text in stream.text_stream:
                yield text
            final = await stream.get_final_message()
    except _SDK_ERRORS as exc:
        raise _translate_error(exc) from exc
    finally:
        if final is not None:
            await record_usage(
                usage_of(final), feature=feature, user_id=user_id, workspace_id=workspace_id,
                model=getattr(final, "model", None),
            )
    _check_refusal(final)
    if final.stop_reason == "max_tokens":
        yield TRUNCATION_NOTE


async def ai_json[M: BaseModel](
    system: str,
    messages: list[dict],
    schema: type[M],
    *,
    effort: str = "low",
    max_tokens: int = 8000,
    user_id: uuid.UUID | None = None,
    feature: str,
    workspace_id: uuid.UUID | None = None,
) -> M:
    """Structured output validated against a Pydantic model (output_config.format)."""
    cfg = await provider_for(workspace_id)
    if cfg.provider != "anthropic":
        from app.ai import providers

        return await providers.oa_json(
            cfg, system, messages, schema, effort=effort, max_tokens=max_tokens,
            user_id=user_id, feature=feature, workspace_id=workspace_id,
        )
    client = _anthropic(cfg)
    try:
        resp = await client.beta.messages.parse(
            **_request(system, messages, effort=effort, max_tokens=max_tokens, model=cfg.model),
            output_format=schema,
        )
    except _SDK_ERRORS as exc:
        raise _translate_error(exc) from exc
    except ValueError as exc:  # the SDK could not validate the JSON against the schema
        log.warning("Structured output did not validate: %s", exc)
        raise AIFailed() from exc
    await record_usage(
        usage_of(resp), feature=feature, user_id=user_id, workspace_id=workspace_id,
        model=getattr(resp, "model", None),
    )
    _check_refusal(resp)
    if resp.stop_reason == "max_tokens":
        raise AIFailed("The result was too long to finish. Try a smaller selection.")
    parsed = getattr(resp, "parsed_output", None)
    if parsed is None:
        try:
            parsed = schema.model_validate(json.loads(_text_of(resp)))
        except (ValueError, TypeError) as exc:
            raise AIFailed() from exc
    return parsed


# --- Agentic tool loop ----------------------------------------------------------------------


class ToolError(Exception):
    """Raise from a tool handler to return an `is_error` result the model can recover from."""


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: dict
    handler: Callable[[dict], Awaitable[Any]]
    # Status line shown while the tool runs ("Searching messages…"); may depend on the input.
    status: str | Callable[[dict], str] | None = None

    def to_param(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }

    def status_for(self, args: dict) -> str | None:
        if callable(self.status):
            try:
                return self.status(args)
            except (TypeError, ValueError, AttributeError, KeyError):
                return None
        return self.status


@dataclass
class ToolCall:
    name: str
    input: dict
    output: str
    is_error: bool = False


@dataclass
class AILoopResult:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    truncated: bool = False


def _tool_output(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


async def _run_tool(spec: ToolSpec | None, block: Any) -> tuple[dict, ToolCall]:
    raw = block.input
    if isinstance(raw, str):  # defensive: inputs normally arrive as parsed JSON objects
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = None
    args = raw if isinstance(raw, dict) else None
    if spec is None:
        output, is_error = f"Unknown tool '{block.name}'.", True
    elif args is None:
        output, is_error = "Tool input must be a JSON object.", True
    else:
        try:
            output, is_error = _tool_output(await spec.handler(args)), False
        except ToolError as exc:
            output, is_error = str(exc) or "The tool failed.", True
        except Exception:
            log.exception("AI tool %s failed", block.name)
            output, is_error = "The tool failed unexpectedly. Try a different approach.", True
    result = {"type": "tool_result", "tool_use_id": block.id, "content": output}
    if is_error:
        result["is_error"] = True
    return result, ToolCall(block.name, args or {}, output, is_error)


async def ai_tool_loop(
    system: str,
    messages: list[dict],
    tools: list[ToolSpec],
    *,
    effort: str = "medium",
    max_tokens: int = 16000,
    user_id: uuid.UUID | None = None,
    feature: str,
    workspace_id: uuid.UUID | None = None,
    on_status: Callable[[str], Awaitable[None]] | None = None,
    on_text: Callable[[str], Awaitable[None]] | None = None,
    max_turns: int = 8,
) -> AILoopResult:
    """Manual agentic loop with our own async tool handlers.

    Streams every turn (text deltas go to `on_text`), runs all tool calls of a turn in
    parallel, returns failures as `is_error` results, passes assistant content (including
    thinking blocks) back unchanged, resumes `pause_turn`, and after `max_turns` asks for a
    final answer with tools disabled. `messages` is extended in place.
    """
    cfg = await provider_for(workspace_id)
    if cfg.provider != "anthropic":
        from app.ai import providers

        return await providers.oa_tool_loop(
            cfg, system, messages, tools, effort=effort, max_tokens=max_tokens,
            user_id=user_id, feature=feature, workspace_id=workspace_id,
            on_status=on_status, on_text=on_text, max_turns=max_turns,
        )
    client = _anthropic(cfg)
    by_name = {t.name: t for t in tools}
    tool_params = [t.to_param() for t in tools]
    texts: list[str] = []
    calls: list[ToolCall] = []
    total = Usage()
    truncated = False

    async def turn(force_answer: bool) -> Any:
        kwargs = _request(
            system, messages, effort=effort, max_tokens=max_tokens, tools=tool_params,
            model=cfg.model,
        )
        if force_answer:
            kwargs["tool_choice"] = {"type": "none"}
        final = None
        try:
            async with client.beta.messages.stream(**kwargs) as stream:
                async for event in stream:
                    if getattr(event, "type", None) == "text" and event.text:
                        texts.append(event.text)
                        if on_text is not None:
                            await on_text(event.text)
                final = await stream.get_final_message()
        except _SDK_ERRORS as exc:
            raise _translate_error(exc) from exc
        finally:
            if final is not None:
                u = usage_of(final)
                total.add(u)
                await record_usage(
                    u, feature=feature, user_id=user_id, workspace_id=workspace_id,
                    model=getattr(final, "model", None),
                )
        return final

    for i in range(max_turns + 1):
        resp = await turn(force_answer=i == max_turns)
        _check_refusal(resp)
        messages.append({"role": "assistant", "content": _echo_content(resp.content)})
        if resp.stop_reason == "pause_turn":
            continue
        tool_uses = [b for b in resp.content if getattr(b, "type", None) == "tool_use"]
        if resp.stop_reason == "max_tokens":
            # A truncated tool input parses as a partial object: never run it.
            truncated = True
            break
        if not tool_uses:
            break
        for b in tool_uses:
            spec = by_name.get(b.name)
            status = spec.status_for(b.input if isinstance(b.input, dict) else {}) if spec else None
            if status and on_status is not None:
                await on_status(status)
        pairs = await asyncio.gather(*(_run_tool(by_name.get(b.name), b) for b in tool_uses))
        calls.extend(c for _, c in pairs)
        content: list[dict] = [r for r, _ in pairs]
        if i + 1 == max_turns:
            content.append(
                {
                    "type": "text",
                    "text": "Tool budget reached. Answer now using only what you have found.",
                }
            )
        messages.append({"role": "user", "content": content})

    text = "".join(texts)
    if truncated:
        text += TRUNCATION_NOTE
        if on_text is not None:
            await on_text(TRUNCATION_NOTE)
    return AILoopResult(text=text, tool_calls=calls, usage=total, truncated=truncated)
