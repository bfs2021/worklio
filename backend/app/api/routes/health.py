from fastapi import APIRouter
from sqlalchemy import text

from app.api.deps import DB
from app.core.redis import redis

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(db: DB) -> dict[str, str]:
    await db.execute(text("SELECT 1"))
    await redis.ping()
    return {"status": "ok"}
