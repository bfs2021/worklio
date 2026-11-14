"""Refresh-token sessions: rotation, reuse detection, logout, deactivated users."""

import uuid

from sqlalchemy import update

from app.core.db import SessionLocal
from app.models import User


async def _signup(client):
    email = f"sess-{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/auth/register", json={"email": email, "full_name": "Sess", "password": "password123"}
    )
    assert r.status_code == 201, r.text
    return email, r.json()


async def test_login_and_register_return_refresh_tokens(client):
    email, reg = await _signup(client)
    assert reg["refresh_token"] and reg["expires_in"] > 0
    r = await client.post("/auth/login", json={"email": email, "password": "password123"})
    assert r.status_code == 200
    assert r.json()["refresh_token"] and r.json()["refresh_token"] != reg["refresh_token"]


async def test_refresh_rotates_and_new_access_token_works(client):
    _, reg = await _signup(client)
    r = await client.post("/auth/refresh", json={"refresh_token": reg["refresh_token"]})
    assert r.status_code == 200, r.text
    pair = r.json()
    assert pair["refresh_token"] != reg["refresh_token"]
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {pair['access_token']}"})
    assert me.status_code == 200
    # The next refresh with the new token works too.
    r2 = await client.post("/auth/refresh", json={"refresh_token": pair["refresh_token"]})
    assert r2.status_code == 200


async def test_reusing_a_rotated_token_revokes_the_whole_session(client):
    _, reg = await _signup(client)
    new = (await client.post("/auth/refresh", json={"refresh_token": reg["refresh_token"]})).json()
    # Old token replayed (e.g. stolen): rejected, and the legitimate new token dies with it.
    replay = await client.post("/auth/refresh", json={"refresh_token": reg["refresh_token"]})
    assert replay.status_code == 401
    assert replay.json()["detail"] == "session_expired"
    after = await client.post("/auth/refresh", json={"refresh_token": new["refresh_token"]})
    assert after.status_code == 401


async def test_logout_revokes_and_other_devices_keep_working(client):
    email, reg = await _signup(client)
    other = (
        await client.post("/auth/login", json={"email": email, "password": "password123"})
    ).json()
    r = await client.post("/auth/logout", json={"refresh_token": reg["refresh_token"]})
    assert r.status_code == 204
    assert (
        await client.post("/auth/refresh", json={"refresh_token": reg["refresh_token"]})
    ).status_code == 401
    assert (
        await client.post("/auth/refresh", json={"refresh_token": other["refresh_token"]})
    ).status_code == 200
    # Unknown tokens are a quiet no-op.
    assert (
        await client.post("/auth/logout", json={"refresh_token": "x" * 43})
    ).status_code == 204


async def test_unknown_and_inactive_users_cannot_refresh(client):
    assert (
        await client.post("/auth/refresh", json={"refresh_token": "y" * 43})
    ).status_code == 401
    email, reg = await _signup(client)
    async with SessionLocal() as db:
        await db.execute(update(User).where(User.email == email).values(is_active=False))
        await db.commit()
    assert (
        await client.post("/auth/refresh", json={"refresh_token": reg["refresh_token"]})
    ).status_code == 401
