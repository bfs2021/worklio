"""Encryption of workspace AI provider keys at rest.

Fernet (AES-128-CBC + HMAC-SHA256) with a key derived from `settings.secret_key` via
HKDF-SHA256 (fixed salt/info "worklio-ai-keys"), so no extra secret has to be configured.
Rotating SECRET_KEY makes stored keys undecryptable: `decrypt_key` then returns None and the
workspace falls back to "not configured" until an admin re-enters its key.

Plaintext keys are never logged, never returned by the API and never stored.
"""

from __future__ import annotations

import base64
import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import settings

log = logging.getLogger(__name__)

_CONTEXT = b"worklio-ai-keys"


@lru_cache(maxsize=4)
def _fernet(secret: str) -> Fernet:
    raw = HKDF(algorithm=hashes.SHA256(), length=32, salt=_CONTEXT, info=_CONTEXT).derive(
        secret.encode()
    )
    return Fernet(base64.urlsafe_b64encode(raw))


def encrypt_key(plaintext: str) -> bytes:
    return _fernet(settings.secret_key).encrypt(plaintext.encode())


def decrypt_key(token: bytes | None) -> str | None:
    if not token:
        return None
    try:
        return _fernet(settings.secret_key).decrypt(bytes(token)).decode()
    except (InvalidToken, ValueError, TypeError):
        # Never log the token or any part of the key.
        log.warning("A stored workspace AI key could not be decrypted (was SECRET_KEY rotated?)")
        return None


def key_hint(plaintext: str) -> str:
    """'…abcd': enough to tell keys apart, never enough to use one."""
    tail = plaintext.strip()[-4:]
    return f"…{tail}"
