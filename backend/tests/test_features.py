"""DMs, private channels, reactions, unread counts, search, uploads."""

import uuid

from tests.conftest import register


async def test_dm_is_find_or_create_and_private(client, team):
    alice, bob, carol, ws = team["alice"], team["bob"], team["carol"], team["ws"]
    r1 = await client.post(f"/workspaces/{ws['id']}/dms", json={"user_ids": [bob["id"]]}, headers=alice["headers"])
    r2 = await client.post(f"/workspaces/{ws['id']}/dms", json={"user_ids": [alice["id"]]}, headers=bob["headers"])
    assert r1.status_code == r2.status_code == 200
    dm = r1.json()
    assert dm["id"] == r2.json()["id"] and dm["kind"] == "dm"
    assert sorted(dm["member_ids"]) == sorted([alice["id"], bob["id"]])

    # Carol can't read it or see it in her channel list.
    assert (await client.get(f"/channels/{dm['id']}/messages", headers=carol["headers"])).status_code == 404
    carol_channels = (await client.get(f"/workspaces/{ws['id']}/channels", headers=carol["headers"])).json()
    assert dm["id"] not in {c["id"] for c in carol_channels}

    # Outsiders can't be DM'd.
    stranger = await register(client, "stranger")
    r = await client.post(f"/workspaces/{ws['id']}/dms", json={"user_ids": [stranger["id"]]}, headers=alice["headers"])
    assert r.status_code == 400


async def test_private_channel_membership(client, team):
    alice, bob, carol, ws = team["alice"], team["bob"], team["carol"], team["ws"]
    r = await client.post(
        f"/workspaces/{ws['id']}/channels",
        json={"name": f"secret-{uuid.uuid4().hex[:4]}", "kind": "private", "member_ids": [bob["id"]]},
        headers=alice["headers"],
    )
    assert r.status_code == 201, r.text
    ch = r.json()
    assert (await client.get(f"/channels/{ch['id']}", headers=bob["headers"])).status_code == 200
    assert (await client.get(f"/channels/{ch['id']}", headers=carol["headers"])).status_code == 404
    assert (await client.post(f"/channels/{ch['id']}/join", headers=carol["headers"])).status_code == 404

    r = await client.post(f"/channels/{ch['id']}/members", json={"user_id": carol["id"]}, headers=bob["headers"])
    assert r.status_code == 204
    assert (await client.get(f"/channels/{ch['id']}", headers=carol["headers"])).status_code == 200


async def test_reactions_toggle(client, team):
    alice, bob, general = team["alice"], team["bob"], team["general"]
    msg = (await client.post(f"/channels/{general['id']}/messages", json={"body": "ship it"}, headers=alice["headers"])).json()
    url = f"/messages/{msg['id']}/reactions"
    await client.post(url, json={"emoji": "👍"}, headers=alice["headers"])
    r = await client.post(url, json={"emoji": "👍"}, headers=bob["headers"])
    assert r.json() == [{"emoji": "👍", "user_ids": [alice["id"], bob["id"]]}]
    r = await client.post(url, json={"emoji": "👍"}, headers=alice["headers"])  # toggle off
    assert r.json() == [{"emoji": "👍", "user_ids": [bob["id"]]}]


async def test_unread_counts_and_threads(client, team):
    alice, bob, ws, general = team["alice"], team["bob"], team["ws"], team["general"]

    async def unread(user):
        chans = (await client.get(f"/workspaces/{ws['id']}/channels", headers=user["headers"])).json()
        return next(c for c in chans if c["id"] == general["id"])["unread_count"]

    await client.post(f"/channels/{general['id']}/read", headers=bob["headers"])
    parent = (await client.post(f"/channels/{general['id']}/messages", json={"body": "one"}, headers=alice["headers"])).json()
    await client.post(f"/channels/{general['id']}/messages", json={"body": "two"}, headers=alice["headers"])
    # Thread replies don't count toward channel unread.
    await client.post(
        f"/channels/{general['id']}/messages", json={"body": "r", "parent_id": parent["id"]}, headers=alice["headers"]
    )
    assert await unread(bob) == 2
    assert await unread(alice) == 0  # own messages never unread

    history = (await client.get(f"/channels/{general['id']}/messages", headers=bob["headers"])).json()
    assert next(m for m in history if m["id"] == parent["id"])["reply_count"] == 1

    await client.post(f"/channels/{general['id']}/read", headers=bob["headers"])
    assert await unread(bob) == 0


async def test_search_respects_access(client, team):
    alice, carol, ws, general = team["alice"], team["carol"], team["ws"], team["general"]
    word = f"zebra{uuid.uuid4().hex[:6]}"
    await client.post(f"/channels/{general['id']}/messages", json={"body": f"public {word}"}, headers=alice["headers"])
    priv = (
        await client.post(
            f"/workspaces/{ws['id']}/channels",
            json={"name": f"p-{uuid.uuid4().hex[:4]}", "kind": "private"},
            headers=alice["headers"],
        )
    ).json()
    await client.post(f"/channels/{priv['id']}/messages", json={"body": f"private {word}"}, headers=alice["headers"])

    alice_hits = (await client.get(f"/workspaces/{ws['id']}/search", params={"q": word}, headers=alice["headers"])).json()
    carol_hits = (await client.get(f"/workspaces/{ws['id']}/search", params={"q": word}, headers=carol["headers"])).json()
    assert len(alice_hits) == 2
    assert [h["body"] for h in carol_hits] == [f"public {word}"]


async def test_upload_and_attach(client, team):
    alice, bob, ws, general = team["alice"], team["bob"], team["ws"], team["general"]
    r = await client.post(
        f"/workspaces/{ws['id']}/uploads",
        files={"file": ("notes v1.txt", b"hello file", "text/plain")},
        headers=alice["headers"],
    )
    assert r.status_code == 201, r.text
    att = r.json()
    assert att["filename"] == "notes_v1.txt" and att["size"] == 10 and att["url"].startswith("http")

    # Someone else can't attach Alice's upload.
    r = await client.post(
        f"/channels/{general['id']}/messages", json={"attachment_ids": [att["id"]]}, headers=bob["headers"]
    )
    assert r.status_code == 400

    r = await client.post(
        f"/channels/{general['id']}/messages", json={"attachment_ids": [att["id"]]}, headers=alice["headers"]
    )
    assert r.status_code == 201, r.text
    assert [a["id"] for a in r.json()["attachments"]] == [att["id"]]

    # Empty message with no attachment is rejected.
    r = await client.post(f"/channels/{general['id']}/messages", json={"body": "  "}, headers=alice["headers"])
    assert r.status_code == 422


async def test_topic_leave_files_mentions_and_repliers(client, team):
    alice, bob, ws, general = team["alice"], team["bob"], team["ws"], team["general"]
    ch = (
        await client.post(
            f"/workspaces/{ws['id']}/channels", json={"name": f"t-{uuid.uuid4().hex[:4]}"}, headers=alice["headers"]
        )
    ).json()
    r = await client.patch(f"/channels/{ch['id']}", json={"topic": "  Launch plans  "}, headers=alice["headers"])
    assert r.json()["topic"] == "Launch plans"
    assert (await client.patch(f"/channels/{ch['id']}", json={"topic": "x"}, headers=bob["headers"])).status_code == 403

    assert (await client.delete(f"/channels/{general['id']}/members/me", headers=alice["headers"])).status_code == 400
    assert (await client.delete(f"/channels/{ch['id']}/members/me", headers=alice["headers"])).status_code == 204
    chans = (await client.get(f"/workspaces/{ws['id']}/channels", headers=alice["headers"])).json()
    assert next(c for c in chans if c["id"] == ch["id"])["is_member"] is False

    att = (
        await client.post(
            f"/workspaces/{ws['id']}/uploads", files={"file": ("a.png", b"\x89PNG", "image/png")}, headers=bob["headers"]
        )
    ).json()
    parent = (
        await client.post(
            f"/channels/{general['id']}/messages",
            json={"body": f"hey <@{alice['id']}> see this", "attachment_ids": [att["id"]]},
            headers=bob["headers"],
        )
    ).json()
    files = (await client.get(f"/channels/{general['id']}/files", headers=alice["headers"])).json()
    assert files[0]["id"] == att["id"] and files[0]["message_id"] == parent["id"]

    mentions = (await client.get(f"/workspaces/{ws['id']}/mentions", headers=alice["headers"])).json()
    assert [m["id"] for m in mentions] == [parent["id"]]

    for who in (alice, bob, alice):
        await client.post(
            f"/channels/{general['id']}/messages", json={"body": "r", "parent_id": parent["id"]}, headers=who["headers"]
        )
    history = (await client.get(f"/channels/{general['id']}/messages", headers=alice["headers"])).json()
    p = next(m for m in history if m["id"] == parent["id"])
    assert p["reply_count"] == 3 and sorted(p["reply_user_ids"]) == sorted([alice["id"], bob["id"]])


async def test_preferences_merge_and_validate(client):
    u = await register(client, "prefs")
    r = await client.patch("/auth/me/preferences", json={"theme": "ocean", "font_size": "lg"}, headers=u["headers"])
    assert r.status_code == 200 and r.json()["preferences"] == {"theme": "ocean", "font_size": "lg"}
    r = await client.patch("/auth/me/preferences", json={"accent": "#ff00aa", "font_size": None}, headers=u["headers"])
    assert r.json()["preferences"] == {"theme": "ocean", "accent": "#ff00aa"}
    assert (await client.get("/auth/me", headers=u["headers"])).json()["preferences"]["accent"] == "#ff00aa"
    for bad in ({"accent": "red"}, {"mode": "neon"}, {"sidebar_width": 9000}):
        assert (await client.patch("/auth/me/preferences", json=bad, headers=u["headers"])).status_code == 422


async def test_update_profile_name(client):
    u = await register(client, "rename")
    r = await client.patch("/auth/me", json={"full_name": "  New Name  "}, headers=u["headers"])
    assert r.status_code == 200 and r.json()["full_name"] == "New Name"
    assert (await client.patch("/auth/me", json={"full_name": ""}, headers=u["headers"])).status_code == 422
