"""Celery tasks for the @worklio agent and the AI call summary.

Each run gets a fresh event loop (asyncio.run), so the API's engine/redis connections opened
during the run are dropped at the end (`_with_api_stack`).
"""

import asyncio
import logging
import uuid

from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)


async def _with_api_stack(fn):
    from app.core.db import engine
    from app.core.redis import redis

    try:
        return await fn()
    finally:
        await engine.dispose()
        await redis.connection_pool.disconnect()


@celery_app.task(soft_time_limit=240, time_limit=300)
def run_agent(message_id: str, user_id: str) -> str | None:
    """Answer one @worklio mention (or DM to the bot) as the bot, with the user's permissions."""
    from app.ai import agent

    async def go():
        return await agent.run_agent(uuid.UUID(message_id), uuid.UUID(user_id))

    run = asyncio.run(_with_api_stack(go))
    return run.outcome if run else None


@celery_app.task(soft_time_limit=240, time_limit=300)
def summarize_call(call_id: str) -> bool:
    """After a call ended: post the AI summary under its card (if there is enough material)."""
    from app.ai import captions
    from app.ai import client as ai
    from app.core.db import SessionLocal
    from app.models import Call

    async def go() -> bool:
        async with SessionLocal() as db:
            call = await db.get(Call, uuid.UUID(call_id))
            if call is None or not await captions.summaries_enabled(call.workspace_id):
                return False
            try:
                return await captions.summarize_call(db, uuid.UUID(call_id)) is not None
            except ai.AIError as exc:  # refused / rate limited / failed: no summary, no retry
                log.info("No AI summary for call %s: %s", call_id, exc.code)
                return False

    return asyncio.run(_with_api_stack(go))
