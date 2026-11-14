"""Tiny Redis fixed-window rate limiter (shared by every API process)."""

import time

from fastapi import HTTPException, Request, status

from app.core.redis import redis

WINDOW_SECONDS = 60


def client_ip(request: Request) -> str:
    # Run uvicorn with --proxy-headers behind a proxy so this is the real client address.
    return request.client.host if request.client else "unknown"


async def hit(scope: str, ident: str, limit: int, window: int = WINDOW_SECONDS) -> None:
    """Count one attempt; raise 429 once `limit` attempts happened in the current window."""
    bucket = int(time.time()) // window
    key = f"rl:{scope}:{ident}:{bucket}"
    async with redis.pipeline() as pipe:
        count, _ = await pipe.incr(key).expire(key, window).execute()
    if count > limit:
        retry_after = window - int(time.time()) % window
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many attempts, try again in a minute",
            headers={"Retry-After": str(retry_after)},
        )
