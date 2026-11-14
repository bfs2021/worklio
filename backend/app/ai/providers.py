"""Gemini and DeepSeek through their OpenAI-compatible Chat Completions endpoints, plus live
model listing / connection tests for every provider.

Same contract as the Anthropic path in app/ai/client.py:
- `oa_text` / `oa_stream` / `oa_json` / `oa_tool_loop` mirror `ai_text` / `ai_stream` /
  `ai_json` / `ai_tool_loop` (text, streamed deltas, validated structured output, an agentic
  tool loop with our async handlers);
- refusals (finish_reason "content_filter", safety blocks) raise AIRefused, hitting the length
  limit is reported as truncation, SDK errors map to AIRateLimited / AIFailed;
- every response's token usage is logged to `ai_usage`.

Callers' messages are Anthropic-shaped ({"role", "content": str | blocks}); they are converted
here. Keys are never logged and are scrubbed from any error text.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
import weakref
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import anthropic
import openai
from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from app.ai.client import (
    TRUNCATION_NOTE,
    AIError,
    AIFailed,
    AILoopResult,
    AIRateLimited,
    AIRefused,
    AIText,
    ToolCall,
    ToolSpec,
    Usage,
    _request,
    _run_tool,
    _translate_error,
    get_client,
    record_usage,
)
from app.ai.workspace import (
    DEFAULT_DEEPSEEK_MODEL,
    DEFAULT_GEMINI_MODEL,
    PROVIDER_LABELS,
    ProviderConfig,
)
from app.core.config import settings

log = logging.getLogger(__name__)

BASE_URLS = {
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "deepseek": "https://api.deepseek.com",
}
# DeepSeek caps completion tokens per model; larger values are rejected with a 400.
DEEPSEEK_MAX_TOKENS = {"deepseek-chat": 8192, "deepseek-reasoner": 65536}
GEMINI_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}
# Keys Gemini's function-declaration schema subset accepts (others are stripped).
GEMINI_SCHEMA_KEYS = {
    "type", "format", "description", "nullable", "enum", "properties", "required", "items",
    "minItems", "maxItems", "minimum", "maximum", "anyOf", "title", "minLength", "maxLength",
}
_NON_CHAT_GEMINI = ("embedding", "aqa", "imagen", "image-generation", "tts", "veo", "learnlm")


# --- Clients ---------------------------------------------------------------------------------

_clients: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[tuple[str, str], AsyncOpenAI]
] = weakref.WeakKeyDictionary()


def get_openai_client(provider: str, api_key: str) -> AsyncOpenAI:
    """The AsyncOpenAI client for this provider/key on the running loop (tests patch this)."""
    loop = asyncio.get_running_loop()
    per_loop = _clients.setdefault(loop, {})
    client = per_loop.get((provider, api_key))
    if client is None:
        client = AsyncOpenAI(
            api_key=api_key,
            base_url=BASE_URLS[provider],
            timeout=settings.ai_request_timeout,
            max_retries=2,
        )
        per_loop[(provider, api_key)] = client
    return client


def _client(cfg: ProviderConfig) -> Any:
    return get_openai_client(cfg.provider, cfg.api_key)


# --- Errors ----------------------------------------------------------------------------------


def _scrub(text: str, api_key: str | None) -> str:
    if api_key and len(api_key) >= 6:
        text = text.replace(api_key, "…")
    return text


def _looks_like_safety_block(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(w in text for w in ("content exists risk", "safety", "blocked", "prohibited"))


def translate_openai_error(exc: Exception, provider: str) -> AIError:
    label = PROVIDER_LABELS.get(provider, "The AI provider")
    if isinstance(exc, openai.RateLimitError):
        retry = 60
        try:
            retry = int(exc.response.headers.get("retry-after", "60"))
        except (TypeError, ValueError, AttributeError):
            pass
        return AIRateLimited("Worklio AI is busy right now. Try again in a minute.", retry)
    if isinstance(exc, openai.AuthenticationError):
        log.error("%s rejected the workspace API key (status %s)", label, exc.status_code)
        return AIFailed("Worklio AI is misconfigured (the API key was rejected).")
    if isinstance(exc, openai.PermissionDeniedError):
        log.error("%s permission denied (status %s)", label, exc.status_code)
        return AIFailed(f"The configured key isn't allowed to use this {label} model.")
    if isinstance(exc, openai.NotFoundError):
        log.error("%s model or endpoint not found", label)
        return AIFailed(f"The configured {label} model wasn't found. An admin can pick another.")
    if isinstance(exc, openai.BadRequestError):
        if _looks_like_safety_block(exc):
            return AIRefused()
        log.error("%s rejected a request (status %s)", label, exc.status_code)
        return AIFailed()
    if isinstance(exc, openai.APIStatusError):
        log.warning("%s API error %s", label, exc.status_code)
        if exc.status_code == 402:
            return AIFailed(f"The {label} account has no remaining balance.")
        if exc.status_code >= 500:
            return AIFailed(f"{label} is temporarily unavailable. Please try again shortly.")
        return AIFailed()
    if isinstance(exc, openai.APITimeoutError):
        return AIFailed("Worklio AI took too long to answer. Please try again.")
    if isinstance(exc, openai.APIConnectionError):
        log.warning("Could not reach %s", label)
        return AIFailed(f"Worklio AI couldn't reach {label}. Please try again.")
    if isinstance(exc, AIError):
        return exc
    log.exception("Unexpected AI error", exc_info=exc)
    return AIFailed()


# --- Request building ------------------------------------------------------------------------


def _block_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif getattr(b, "type", None) == "text":
            parts.append(b.text)
    return "".join(parts)


def to_openai_messages(system: str, messages: list[dict]) -> list[dict]:
    """Anthropic-shaped history -> Chat Completions messages (system first)."""
    out: list[dict] = [{"role": "system", "content": system}]
    for m in messages:
        role, content = m["role"], m["content"]
        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue
        blocks = [b if isinstance(b, dict) else b.model_dump() for b in content]
        if role == "assistant":
            calls = [
                {
                    "id": b["id"],
                    "type": "function",
                    "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {})},
                }
                for b in blocks
                if b.get("type") == "tool_use"
            ]
            msg: dict = {"role": "assistant", "content": _block_text(blocks) or None}
            if calls:
                msg["tool_calls"] = calls
            out.append(msg)
            continue
        for b in blocks:
            if b.get("type") == "tool_result":
                text = _block_text(b.get("content")) if not isinstance(b.get("content"), str) else b["content"]
                if b.get("is_error"):
                    text = f"Error: {text}"
                out.append({"role": "tool", "tool_call_id": b["tool_use_id"], "content": text})
        text = _block_text([b for b in blocks if b.get("type") == "text"])
        if text:
            out.append({"role": "user", "content": text})
    return out


def sanitize_schema(schema: Any, provider: str) -> Any:
    """Gemini accepts an OpenAPI subset for function parameters: drop what it rejects."""
    if provider != "gemini":
        return schema
    if isinstance(schema, list):
        return [sanitize_schema(s, provider) for s in schema]
    if not isinstance(schema, dict):
        return schema
    out: dict = {}
    for key, value in schema.items():
        if key not in GEMINI_SCHEMA_KEYS:
            continue
        if key == "properties" and isinstance(value, dict):
            out[key] = {k: sanitize_schema(v, provider) for k, v in value.items()}
        elif key == "type" and isinstance(value, list):
            # ["string", "null"] -> "string" + nullable
            kinds = [v for v in value if v != "null"]
            out["type"] = kinds[0] if kinds else "string"
            if "null" in value:
                out["nullable"] = True
        else:
            out[key] = sanitize_schema(value, provider)
    return out


def _tool_params(tools: list[ToolSpec], provider: str) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": sanitize_schema(t.input_schema, provider),
            },
        }
        for t in tools
    ]


def _max_tokens(cfg: ProviderConfig, max_tokens: int) -> int:
    if cfg.provider == "deepseek":
        return min(max_tokens, DEEPSEEK_MAX_TOKENS.get(cfg.model, 8192))
    return max_tokens


def _base_kwargs(cfg: ProviderConfig, messages: list[dict], effort: str, max_tokens: int) -> dict:
    kwargs: dict[str, Any] = {
        "model": cfg.model,
        "messages": messages,
        "max_tokens": _max_tokens(cfg, max_tokens),
    }
    if cfg.provider == "gemini":
        kwargs["reasoning_effort"] = GEMINI_EFFORT.get(effort, "medium")
    return kwargs


async def _call(cfg: ProviderConfig, fn: Callable[[dict], Awaitable[Any]], kwargs: dict) -> Any:
    """Run a request; retry once without `reasoning_effort` if the model rejects it."""
    try:
        return await fn(kwargs)
    except openai.BadRequestError as exc:
        if "reasoning_effort" in kwargs and "reason" in str(exc).lower():
            retry = {k: v for k, v in kwargs.items() if k != "reasoning_effort"}
            try:
                return await fn(retry)
            except openai.APIError as exc2:
                raise translate_openai_error(exc2, cfg.provider) from exc2
        raise translate_openai_error(exc, cfg.provider) from exc
    except openai.APIError as exc:
        raise translate_openai_error(exc, cfg.provider) from exc


# --- Usage -----------------------------------------------------------------------------------


def _extra(obj: Any, name: str) -> Any:
    value = getattr(obj, name, None)
    if value is None:
        extra = getattr(obj, "model_extra", None) or {}
        value = extra.get(name)
    return value


def usage_of(usage: Any) -> Usage:
    if usage is None:
        return Usage()
    prompt = getattr(usage, "prompt_tokens", 0) or 0
    completion = getattr(usage, "completion_tokens", 0) or 0
    details = getattr(usage, "prompt_tokens_details", None)
    cached = (getattr(details, "cached_tokens", 0) if details else 0) or _extra(
        usage, "prompt_cache_hit_tokens"
    ) or 0
    cached = cached if isinstance(cached, int) else 0
    return Usage(max(0, prompt - cached), completion, cached, 0)


async def _record(cfg: ProviderConfig, usage: Usage, **kw: Any) -> None:
    await record_usage(usage, model=cfg.model, **kw)


def _check_finish(cfg: ProviderConfig, finish: str | None, refusal: str | None = None) -> None:
    if refusal or (finish and finish.lower() in ("content_filter", "safety", "prohibited_content")):
        log.info("%s declined a request (finish=%s)", cfg.label, finish)
        raise AIRefused()


# --- Text / stream / JSON --------------------------------------------------------------------


async def oa_text(
    cfg: ProviderConfig,
    system: str,
    messages: list[dict],
    *,
    effort: str,
    max_tokens: int,
    user_id: uuid.UUID | None,
    feature: str,
    workspace_id: uuid.UUID | None,
) -> AIText:
    client = _client(cfg)
    kwargs = _base_kwargs(cfg, to_openai_messages(system, messages), effort, max_tokens)
    resp = await _call(cfg, lambda kw: client.chat.completions.create(**kw), kwargs)
    await _record(
        cfg, usage_of(getattr(resp, "usage", None)), feature=feature, user_id=user_id,
        workspace_id=workspace_id,
    )
    choice = resp.choices[0] if resp.choices else None
    if choice is None:
        raise AIFailed()
    _check_finish(cfg, choice.finish_reason, getattr(choice.message, "refusal", None))
    return AIText((choice.message.content or "").strip(), truncated=choice.finish_reason == "length")


async def oa_stream(
    cfg: ProviderConfig,
    system: str,
    messages: list[dict],
    *,
    effort: str,
    max_tokens: int,
    user_id: uuid.UUID | None,
    feature: str,
    workspace_id: uuid.UUID | None,
) -> AsyncIterator[str]:
    client = _client(cfg)
    kwargs = _base_kwargs(cfg, to_openai_messages(system, messages), effort, max_tokens)
    kwargs |= {"stream": True, "stream_options": {"include_usage": True}}
    stream = await _call(cfg, lambda kw: client.chat.completions.create(**kw), kwargs)
    usage = None
    finish: str | None = None
    refusal: str | None = None
    try:
        async for chunk in stream:
            if getattr(chunk, "usage", None):
                usage = chunk.usage
            for choice in chunk.choices or []:
                delta = choice.delta
                if delta is not None:
                    if getattr(delta, "refusal", None):
                        refusal = delta.refusal
                    if delta.content:
                        yield delta.content
                if choice.finish_reason:
                    finish = choice.finish_reason
    except openai.APIError as exc:
        raise translate_openai_error(exc, cfg.provider) from exc
    finally:
        await _record(
            cfg, usage_of(usage), feature=feature, user_id=user_id, workspace_id=workspace_id
        )
    _check_finish(cfg, finish, refusal)
    if finish == "length":
        yield TRUNCATION_NOTE


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _json_text(text: str) -> str:
    return _FENCE_RE.sub("", text.strip()).strip()


async def oa_json[M: BaseModel](
    cfg: ProviderConfig,
    system: str,
    messages: list[dict],
    schema: type[M],
    *,
    effort: str,
    max_tokens: int,
    user_id: uuid.UUID | None,
    feature: str,
    workspace_id: uuid.UUID | None,
) -> M:
    """JSON mode + Pydantic validation; one corrective retry when the JSON doesn't validate."""
    client = _client(cfg)
    instructions = (
        f"{system}\n\nRespond with only a JSON object (no markdown, no commentary) that "
        "matches this JSON Schema:\n"
        f"{json.dumps(schema.model_json_schema(), ensure_ascii=False)}"
    )
    history = to_openai_messages(instructions, messages)
    last_error = ""
    for attempt in range(2):
        kwargs = _base_kwargs(cfg, history, effort, max_tokens)
        kwargs["response_format"] = {"type": "json_object"}
        resp = await _call(cfg, lambda kw: client.chat.completions.create(**kw), kwargs)
        await _record(
            cfg, usage_of(getattr(resp, "usage", None)), feature=feature, user_id=user_id,
            workspace_id=workspace_id,
        )
        choice = resp.choices[0] if resp.choices else None
        if choice is None:
            raise AIFailed()
        _check_finish(cfg, choice.finish_reason, getattr(choice.message, "refusal", None))
        if choice.finish_reason == "length":
            raise AIFailed("The result was too long to finish. Try a smaller selection.")
        raw = choice.message.content or ""
        try:
            return schema.model_validate_json(_json_text(raw))
        except (ValidationError, ValueError) as exc:
            last_error = str(exc)[:500]
            log.info("%s JSON output did not validate (attempt %d)", cfg.label, attempt + 1)
            history = [
                *history,
                {"role": "assistant", "content": raw},
                {
                    "role": "user",
                    "content": (
                        "That JSON did not match the schema: "
                        f"{last_error}\nReply with only the corrected JSON object."
                    ),
                },
            ]
    log.warning("%s structured output failed validation twice", cfg.label)
    raise AIFailed()


# --- Tool loop -------------------------------------------------------------------------------


class _Block:
    """A tool call in the shape `_run_tool` expects (name, id, input)."""

    def __init__(self, call_id: str, name: str, arguments: str):
        self.type = "tool_use"
        self.id = call_id
        self.name = name
        try:
            self.input = json.loads(arguments) if arguments.strip() else {}
        except json.JSONDecodeError:
            self.input = None


class _ToolCallAcc:
    def __init__(self) -> None:
        self.slots: list[dict] = []
        self._by_index: dict[int, dict] = {}

    def add(self, tc: Any) -> None:
        index = getattr(tc, "index", None)
        call_id = getattr(tc, "id", None)
        slot = None
        if index is not None:
            slot = self._by_index.get(index)
        elif call_id is None and self.slots:
            slot = self.slots[-1]
        if slot is not None and call_id and slot["id"] and slot["id"] != call_id:
            slot = None  # some servers reuse index 0 for every call: a new id is a new call
        if slot is None:
            slot = {"id": None, "name": "", "arguments": "", "extra": None}
            self.slots.append(slot)
            if index is not None:
                self._by_index[index] = slot
        if call_id:
            slot["id"] = call_id
        fn = getattr(tc, "function", None)
        if fn is not None:
            if getattr(fn, "name", None):
                slot["name"] = fn.name
            if getattr(fn, "arguments", None):
                slot["arguments"] += fn.arguments
        # Gemini returns thought signatures in `extra_content`; they must be echoed back.
        extra = _extra(tc, "extra_content")
        if extra:
            slot["extra"] = extra

    def calls(self) -> list[dict]:
        out = []
        for s in self.slots:
            if not s["name"]:
                continue
            out.append({**s, "id": s["id"] or f"call_{uuid.uuid4().hex[:16]}"})
        return out


async def oa_tool_loop(
    cfg: ProviderConfig,
    system: str,
    messages: list[dict],
    tools: list[ToolSpec],
    *,
    effort: str,
    max_tokens: int,
    user_id: uuid.UUID | None,
    feature: str,
    workspace_id: uuid.UUID | None,
    on_status: Callable[[str], Awaitable[None]] | None,
    on_text: Callable[[str], Awaitable[None]] | None,
    max_turns: int,
) -> AILoopResult:
    """The same loop as client.ai_tool_loop over Chat Completions function calling.

    `messages` (Anthropic-shaped) gets the final assistant text appended.
    """
    client = _client(cfg)
    by_name = {t.name: t for t in tools}
    tool_params = _tool_params(tools, cfg.provider)
    history = to_openai_messages(system, messages)
    texts: list[str] = []
    calls: list[ToolCall] = []
    total = Usage()
    truncated = False

    async def turn(force_answer: bool) -> tuple[str, list[dict], str | None]:
        kwargs = _base_kwargs(cfg, history, effort, max_tokens)
        kwargs |= {
            "stream": True,
            "stream_options": {"include_usage": True},
            "tools": tool_params,
            "tool_choice": "none" if force_answer else "auto",
        }
        stream = await _call(cfg, lambda kw: client.chat.completions.create(**kw), kwargs)
        acc = _ToolCallAcc()
        parts: list[str] = []
        usage = None
        finish: str | None = None
        refusal: str | None = None
        try:
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    usage = chunk.usage
                for choice in chunk.choices or []:
                    delta = choice.delta
                    if delta is not None:
                        if getattr(delta, "refusal", None):
                            refusal = delta.refusal
                        if delta.content:
                            parts.append(delta.content)
                            texts.append(delta.content)
                            if on_text is not None:
                                await on_text(delta.content)
                        for tc in getattr(delta, "tool_calls", None) or []:
                            acc.add(tc)
                    if choice.finish_reason:
                        finish = choice.finish_reason
        except openai.APIError as exc:
            raise translate_openai_error(exc, cfg.provider) from exc
        finally:
            u = usage_of(usage)
            total.add(u)
            await _record(cfg, u, feature=feature, user_id=user_id, workspace_id=workspace_id)
        _check_finish(cfg, finish, refusal)
        return "".join(parts), acc.calls(), finish

    for i in range(max_turns + 1):
        text, tool_calls, finish = await turn(force_answer=i == max_turns)
        assistant: dict[str, Any] = {"role": "assistant", "content": text or None}
        if tool_calls:
            assistant["tool_calls"] = [
                {
                    "id": c["id"],
                    "type": "function",
                    "function": {"name": c["name"], "arguments": c["arguments"] or "{}"},
                    **({"extra_content": c["extra"]} if c["extra"] else {}),
                }
                for c in tool_calls
            ]
        history.append(assistant)
        if finish == "length":
            truncated = True  # a truncated tool call is partial JSON: never run it
            break
        if not tool_calls or i == max_turns:
            break
        blocks = [_Block(c["id"], c["name"], c["arguments"]) for c in tool_calls]
        for b in blocks:
            spec = by_name.get(b.name)
            status = spec.status_for(b.input if isinstance(b.input, dict) else {}) if spec else None
            if status and on_status is not None:
                await on_status(status)
        pairs = await asyncio.gather(*(_run_tool(by_name.get(b.name), b) for b in blocks))
        calls.extend(c for _, c in pairs)
        for result, _ in pairs:
            content = result["content"]
            if result.get("is_error"):
                content = f"Error: {content}"
            history.append({"role": "tool", "tool_call_id": result["tool_use_id"], "content": content})
        if i + 1 == max_turns:
            history.append(
                {
                    "role": "user",
                    "content": "Tool budget reached. Answer now using only what you have found.",
                }
            )

    text = "".join(texts)
    if truncated:
        text += TRUNCATION_NOTE
        if on_text is not None:
            await on_text(TRUNCATION_NOTE)
    messages.append({"role": "assistant", "content": text})
    return AILoopResult(text=text, tool_calls=calls, usage=total, truncated=truncated)


# --- Model listing & connection test ---------------------------------------------------------


def _gemini_version(model_id: str) -> float:
    m = re.search(r"gemini-(\d+(?:\.\d+)?)", model_id)
    return float(m.group(1)) if m else 0.0


def suggested_model(provider: str, models: list[str]) -> str | None:
    if provider == "anthropic":
        return settings.ai_model if settings.ai_model in models or not models else models[0]
    if provider == "deepseek":
        return DEFAULT_DEEPSEEK_MODEL if DEFAULT_DEEPSEEK_MODEL in models or not models else models[0]
    candidates = [m for m in models if "pro" in m or "flash" in m]
    if not candidates:
        return models[0] if models else DEFAULT_GEMINI_MODEL
    # Newest first; prefer stable over preview/experimental builds.
    return max(
        candidates,
        key=lambda m: (_gemini_version(m), "preview" not in m and "exp" not in m, "pro" in m),
    )


def _sort_models(provider: str, ids: list[str]) -> list[str]:
    ids = list(dict.fromkeys(ids))
    if provider == "gemini":
        return sorted(ids, key=lambda m: (-_gemini_version(m), m))
    if provider == "deepseek":
        return sorted(ids)
    return ids  # Anthropic lists newest first


async def list_models(provider: str, api_key: str) -> list[str]:
    """Model ids the key can use, live from the provider (raises AIError on failure)."""
    ids: list[str] = []
    if provider == "anthropic":
        try:
            async for m in get_client(api_key).models.list(limit=100):
                ids.append(m.id)
        except anthropic.APIError as exc:
            raise _translate_error(exc) from exc
        return _sort_models(provider, ids)
    client = get_openai_client(provider, api_key)
    try:
        async for m in client.models.list():
            ids.append(m.id)
    except openai.APIError as exc:
        raise translate_openai_error(exc, provider) from exc
    if provider == "gemini":
        ids = [i.removeprefix("models/") for i in ids]
        ids = [i for i in ids if "gemini" in i and not any(x in i for x in _NON_CHAT_GEMINI)]
    return _sort_models(provider, ids)


async def _ping(provider: str, api_key: str, model: str) -> None:
    """One tiny request proving the model answers with this key."""
    prompt = [{"role": "user", "content": "Reply with the word OK."}]
    if provider == "anthropic":
        try:
            await get_client(api_key).beta.messages.create(
                **_request("You are a connection test.", prompt, effort="low", max_tokens=64, model=model)
            )
        except anthropic.APIError as exc:
            raise _translate_error(exc) from exc
        return
    cfg = ProviderConfig(provider, model, api_key, "workspace")
    client = get_openai_client(provider, api_key)
    kwargs = _base_kwargs(cfg, to_openai_messages("You are a connection test.", prompt), "low", 64)
    await _call(cfg, lambda kw: client.chat.completions.create(**kw), kwargs)


async def check_connection(provider: str, api_key: str, model: str | None) -> dict:
    """{ok, latency_ms, models, suggested_model, error?}. Never raises; never echoes the key."""
    started = time.perf_counter()
    models: list[str] = []
    try:
        models = await list_models(provider, api_key)
        if model:
            await _ping(provider, api_key, model)
        ok, error = True, None
    except AIError as exc:
        ok, error = False, _scrub(exc.message, api_key)
    except Exception:
        log.exception("AI connection test failed unexpectedly (%s)", provider)
        ok, error = False, "The connection test failed unexpectedly."
    out = {
        "ok": ok,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "models": models,
        "suggested_model": suggested_model(provider, models) if ok or models else None,
    }
    if error:
        out["error"] = error
    return out
