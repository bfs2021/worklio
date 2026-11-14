"""Workspace URLs are generated from the name when the client doesn't send one."""

import uuid

from tests.conftest import register


async def test_slug_generated_from_name_and_made_unique(client):
    owner = await register(client, "slugowner")
    name = f"Café Ünïcode & Co {uuid.uuid4().hex[:4]}"
    first = await client.post("/workspaces", json={"name": name}, headers=owner["headers"])
    assert first.status_code == 201, first.text
    slug = first.json()["slug"]
    assert slug.startswith("cafe-unicode-co-") and slug == slug.lower()
    second = await client.post("/workspaces", json={"name": name}, headers=owner["headers"])
    assert second.status_code == 201
    assert second.json()["slug"] == f"{slug}-2"


async def test_symbol_only_name_falls_back(client):
    owner = await register(client, "slugowner2")
    r = await client.post("/workspaces", json={"name": "🚀🚀"}, headers=owner["headers"])
    assert r.status_code == 201
    assert r.json()["slug"].startswith("workspace")


async def test_workspace_list_includes_icon_url(client, team):
    ws = (await client.get("/workspaces", headers=team["alice"]["headers"])).json()
    assert "icon_url" in ws[0] and ws[0]["icon_url"] is None
