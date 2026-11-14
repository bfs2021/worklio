import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.config import settings
from app.main import app


@pytest.fixture(autouse=True)
def generous_rate_limits(monkeypatch):
    """The suite registers many users from one address; tests that need limits lower them."""
    for name in (
        "login_rate_limit_per_ip",
        "login_rate_limit_per_email",
        "register_rate_limit_per_ip",
        "refresh_rate_limit_per_ip",
    ):
        monkeypatch.setattr(settings, name, 100_000)


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def register(client, name: str) -> dict:
    email = f"{name}-{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/auth/register", json={"email": email, "full_name": name, "password": "password123"}
    )
    assert r.status_code == 201, r.text
    me = (await client.get("/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})).json()
    return {"id": me["id"], "email": email, "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}


@pytest.fixture
async def team(client):
    """Workspace owned by alice with bob and carol as members."""
    alice, bob, carol = [await register(client, n) for n in ("alice", "bob", "carol")]
    ws = (
        await client.post(
            "/workspaces",
            json={"name": "Acme", "slug": f"acme-{uuid.uuid4().hex[:6]}"},
            headers=alice["headers"],
        )
    ).json()
    for u in (bob, carol):
        r = await client.post(
            f"/workspaces/{ws['id']}/members", json={"email": u["email"]}, headers=alice["headers"]
        )
        assert r.status_code == 201, r.text
    channels = (await client.get(f"/workspaces/{ws['id']}/channels", headers=alice["headers"])).json()
    general = next(c for c in channels if c["name"] == "general")
    return {"ws": ws, "general": general, "alice": alice, "bob": bob, "carol": carol}
