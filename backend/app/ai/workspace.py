"""Workspace-level Worklio AI: which provider/key/model a workspace uses, its feature
toggles and per-user budget, the `use_ai` policy, agent installs and audit records.

Provider resolution (`resolve_provider`):
1. the workspace's own provider + encrypted key (source "workspace"), else
2. the server's ANTHROPIC_API_KEY (source "env"), else
3. None: AI is not configured for that workspace.

Settings rows are read through a short-lived per-process cache (`CACHE_TTL_SECONDS`) using a
NullPool engine, so every event loop (API process, Celery's per-task loops) can resolve them.
Writes through the API invalidate the cache of the process that handled them; other processes
pick changes up within the TTL.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import admin
from app.ai.keys import decrypt_key
from app.core.config import settings
from app.models import Channel, ChannelKind, Workspace, WorkspaceMember, WorkspaceRole
from app.models.ai_settings import AIAgentInstall, WorkspaceAISettings

log = logging.getLogger(__name__)

PROVIDERS = ("anthropic", "gemini", "deepseek")
PROVIDER_LABELS = {"anthropic": "Claude", "gemini": "Gemini", "deepseek": "DeepSeek"}
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_DEEPSEEK_MODEL = "deepseek-chat"

# Admin-facing feature toggles (all on by default).
FEATURE_KEYS = ("ask", "summaries", "composer", "translate", "tasks", "agent", "captions_summary")
# Internal feature names (usage rows, rate-limit labels) -> the toggle that governs them.
FEATURE_TOGGLE = {
    "ask": "ask",
    "channel_summary": "summaries",
    "thread_summary": "summaries",
    "catch_up": "summaries",
    "compose": "composer",
    "translate": "translate",
    "tasks": "tasks",
    "agent": "agent",
    "agent_summarize_channel": "agent",
    "call_summary": "captions_summary",
}
USE_AI_POLICY = "use_ai"
INSTALL_APPS_POLICY = "install_apps"
CACHE_TTL_SECONDS = 10.0
PER_USER_LIMIT_MAX = 10_000


def default_model(provider: str) -> str:
    if provider == "anthropic":
        return settings.ai_model
    if provider == "deepseek":
        return DEFAULT_DEEPSEEK_MODEL
    return DEFAULT_GEMINI_MODEL


@dataclass(frozen=True)
class WorkspaceAIConfig:
    """A snapshot of one workspace_ai_settings row (the key stays encrypted)."""

    workspace_id: uuid.UUID
    provider: str | None = None
    model: str | None = None
    api_key_encrypted: bytes | None = field(default=None, repr=False)
    key_hint: str | None = None
    features: dict = field(default_factory=dict)
    per_user_limit: int | None = None
    updated_at: datetime | None = None
    updated_by: uuid.UUID | None = None

    @classmethod
    def of(cls, row: WorkspaceAISettings) -> WorkspaceAIConfig:
        return cls(
            workspace_id=row.workspace_id,
            provider=row.provider,
            model=row.model,
            api_key_encrypted=bytes(row.api_key_encrypted) if row.api_key_encrypted else None,
            key_hint=row.key_hint,
            features=dict(row.features or {}),
            per_user_limit=row.per_user_limit,
            updated_at=row.updated_at,
            updated_by=row.updated_by,
        )

    @property
    def key_set(self) -> bool:
        return bool(self.api_key_encrypted)


@dataclass(frozen=True)
class ProviderConfig:
    provider: str  # "anthropic" | "gemini" | "deepseek"
    model: str
    api_key: str = field(repr=False)
    source: str  # "workspace" | "env"

    @property
    def label(self) -> str:
        return PROVIDER_LABELS.get(self.provider, "the AI provider")


def env_provider() -> ProviderConfig | None:
    if not settings.anthropic_api_key:
        return None
    return ProviderConfig("anthropic", settings.ai_model, settings.anthropic_api_key, "env")


# --- Loading (cached) ------------------------------------------------------------------------

_cache: dict[uuid.UUID, tuple[float, WorkspaceAIConfig | None]] = {}


def invalidate(workspace_id: uuid.UUID | None = None) -> None:
    if workspace_id is None:
        _cache.clear()
    else:
        _cache.pop(workspace_id, None)


async def load_config(
    workspace_id: uuid.UUID, db: AsyncSession | None = None
) -> WorkspaceAIConfig | None:
    """The workspace's AI settings (None when an admin never saved any)."""
    hit = _cache.get(workspace_id)
    now = time.monotonic()
    if hit is not None and hit[0] > now:
        return hit[1]
    if db is not None:
        row = await db.get(WorkspaceAISettings, workspace_id, populate_existing=True)
        cfg = WorkspaceAIConfig.of(row) if row else None
    else:
        from app.ai.client import _engine  # NullPool engine: usable from any event loop

        async with AsyncSession(_engine()) as s:
            row = await s.get(WorkspaceAISettings, workspace_id)
            cfg = WorkspaceAIConfig.of(row) if row else None
    _cache[workspace_id] = (now + CACHE_TTL_SECONDS, cfg)
    return cfg


def provider_from(cfg: WorkspaceAIConfig | None) -> ProviderConfig | None:
    if cfg is not None and cfg.provider in PROVIDERS and cfg.key_set:
        key = decrypt_key(cfg.api_key_encrypted)
        if key:
            return ProviderConfig(
                cfg.provider, cfg.model or default_model(cfg.provider), key, "workspace"
            )
    return env_provider()


async def resolve_provider(
    workspace_id: uuid.UUID | None, db: AsyncSession | None = None
) -> ProviderConfig | None:
    if workspace_id is None:
        return env_provider()
    return provider_from(await load_config(workspace_id, db))


def features_of(cfg: WorkspaceAIConfig | None) -> dict[str, bool]:
    stored = cfg.features if cfg else {}
    return {k: bool(stored.get(k, True)) for k in FEATURE_KEYS}


def feature_on(cfg: WorkspaceAIConfig | None, feature: str) -> bool:
    toggle = FEATURE_TOGGLE.get(feature, feature)
    if toggle not in FEATURE_KEYS:
        return True
    return features_of(cfg)[toggle]


def per_user_limit(cfg: WorkspaceAIConfig | None) -> int:
    if cfg is not None and cfg.per_user_limit:
        return cfg.per_user_limit
    return settings.ai_rate_limit_requests


# --- Policies --------------------------------------------------------------------------------


async def policy_value(db: AsyncSession, workspace_id: uuid.UUID, name: str) -> str:
    """'everyone' | 'admins' for a workspace policy, using the admin console's defaults."""
    ws = await db.get(Workspace, workspace_id)
    policies = admin.policies_of(ws) if ws is not None else dict(admin.DEFAULT_POLICIES)
    return policies.get(name, "everyone")


def role_allowed(role: WorkspaceRole | str | None, value: str) -> bool:
    """Guests never get policy-governed abilities; 'admins' means owners and admins.

    Same rule as `app.admin.role_allows`, for callers that already resolved the value.
    """
    if role is None or role == WorkspaceRole.guest:
        return False
    if value == "admins":
        return admin.is_admin_role(role)
    return True


async def member_role(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> WorkspaceRole | None:
    return await db.scalar(
        select(WorkspaceMember.role).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )


async def policy_allows(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, name: str
) -> bool:
    member = await db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )
    return member is not None and await admin.policy_allows(db, member, name)


is_admin_role = admin.is_admin_role


# --- Request gating --------------------------------------------------------------------------


async def require_ai(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, feature: str
) -> ProviderConfig:
    """Gate one AI request. Raises 404 (not a member), 503 ai_not_configured,
    403 ai_feature_disabled or 403 policy:use_ai."""
    role = await member_role(db, workspace_id, user_id)
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    cfg = await load_config(workspace_id, db)
    provider = provider_from(cfg)
    if provider is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "ai_not_configured")
    if not feature_on(cfg, feature):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "ai_feature_disabled")
    if not role_allowed(role, await policy_value(db, workspace_id, USE_AI_POLICY)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"policy:{USE_AI_POLICY}")
    return provider


async def require_policy(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, name: str
) -> None:
    """403 {"detail": "policy:<name>"} via the shared `app.admin.require_policy_for`."""
    await admin.require_policy_for(db, workspace_id, user_id, name)


# --- Agent installs --------------------------------------------------------------------------


async def agent_installed(db: AsyncSession, channel: Channel) -> bool:
    """DMs always; otherwise a per-channel install, or the everywhere install for public ones."""
    if channel.kind == ChannelKind.dm:
        return True
    conds = [AIAgentInstall.channel_id == channel.id]
    if channel.kind == ChannelKind.public:
        conds.append(AIAgentInstall.channel_id.is_(None))
    found = await db.scalar(
        select(AIAgentInstall.id)
        .where(AIAgentInstall.workspace_id == channel.workspace_id, or_(*conds))
        .limit(1)
    )
    return found is not None


async def installs_of(db: AsyncSession, workspace_id: uuid.UUID) -> tuple[list[uuid.UUID], bool]:
    rows = list(
        await db.scalars(
            select(AIAgentInstall.channel_id).where(AIAgentInstall.workspace_id == workspace_id)
        )
    )
    return [r for r in rows if r is not None], any(r is None for r in rows)


# --- Audit -----------------------------------------------------------------------------------


async def audit(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    actor_id: uuid.UUID | None,
    action: str,
    *,
    target_type: str | None = None,
    target_id: Any = None,
    meta: dict | None = None,
) -> None:
    """Add an audit_events row to the caller's transaction via the shared
    `app.admin.record_audit` (never a secret in `meta`)."""
    admin.record_audit(
        db, workspace_id, actor_id, action, target_type=target_type, target_id=target_id, meta=meta
    )
