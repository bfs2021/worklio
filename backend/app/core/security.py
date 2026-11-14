import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from pwdlib import PasswordHash

from app.core.config import settings

ALGORITHM = "HS256"
_hasher = PasswordHash.recommended()
# Verified against when the email is unknown, so login takes the same time either way.
_DUMMY_HASH = _hasher.hash("worklio-timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return _hasher.verify(password, hashed)


def burn_password_check(password: str) -> None:
    """Spend the same time as a real verify (for unknown accounts)."""
    _hasher.verify(password, _DUMMY_HASH)


def create_access_token(user_id: uuid.UUID) -> str:
    expire = datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode({"sub": str(user_id), "exp": expire}, settings.secret_key, ALGORITHM)


@dataclass(frozen=True)
class TokenClaims:
    user_id: uuid.UUID
    expires_at: datetime


def decode_access_token_claims(token: str) -> TokenClaims | None:
    try:
        payload = jwt.decode(
            token, settings.secret_key, algorithms=[ALGORITHM], options={"require": ["exp", "sub"]}
        )
        return TokenClaims(
            user_id=uuid.UUID(payload["sub"]),
            expires_at=datetime.fromtimestamp(payload["exp"], UTC),
        )
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        return None


def decode_access_token(token: str) -> uuid.UUID | None:
    claims = decode_access_token_claims(token)
    return claims.user_id if claims else None
