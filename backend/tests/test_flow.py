"""End-to-end smoke test against the running Postgres/Redis (run via `make test`)."""

import uuid

from tests.conftest import register as _register


async def test_health(client):
    r = await client.get("/health")
    assert r.json() == {"status": "ok"}


async def test_workspace_channel_message_flow(client):
    alice = await _register(client, "alice")
    bob = await _register(client, "bob")
    slug = f"acme-{uuid.uuid4().hex[:6]}"

    ws = (await client.post("/workspaces", json={"name": "Acme", "slug": slug}, headers=alice["headers"])).json()
    channels = (await client.get(f"/workspaces/{ws['id']}/channels", headers=alice["headers"])).json()
    general = next(c for c in channels if c["name"] == "general")

    # Tenant isolation: Bob is not a member yet.
    r = await client.get(f"/channels/{general['id']}/messages", headers=bob["headers"])
    assert r.status_code == 404

    r = await client.post(f"/workspaces/{ws['id']}/members", json={"email": bob["email"]}, headers=alice["headers"])
    assert r.status_code == 201, r.text
    members = (await client.get(f"/workspaces/{ws['id']}/members", headers=bob["headers"])).json()
    assert sorted(m["full_name"] for m in members) == ["alice", "bob"]

    r = await client.post(f"/channels/{general['id']}/messages", json={"body": "hello"}, headers=bob["headers"])
    assert r.status_code == 201, r.text
    msg = r.json()

    # Only the author can edit.
    r = await client.patch(f"/messages/{msg['id']}", json={"body": "hacked"}, headers=alice["headers"])
    assert r.status_code == 403

    r = await client.post(
        f"/channels/{general['id']}/messages", json={"body": "reply", "parent_id": msg["id"]}, headers=alice["headers"]
    )
    assert r.status_code == 201
    replies = (await client.get(f"/messages/{msg['id']}/replies", headers=bob["headers"])).json()
    assert [m["body"] for m in replies] == ["reply"]

    history = (await client.get(f"/channels/{general['id']}/messages", headers=alice["headers"])).json()
    assert [m["body"] for m in history] == ["hello"]
