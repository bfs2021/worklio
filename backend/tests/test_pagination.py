"""Pagination v2: (created_at, id) cursors for history, replies and search."""

from datetime import UTC, datetime

from sqlalchemy import update

from app.core.db import SessionLocal
from app.models import Message


async def _post(client, team, n, body="msg"):
    ids = []
    for i in range(n):
        r = await client.post(
            f"/channels/{team['general']['id']}/messages",
            json={"body": f"{body} {i}"},
            headers=team["alice"]["headers"],
        )
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    return ids


def _ids(r):
    assert r.status_code == 200, r.text
    return [m["id"] for m in r.json()]


async def test_before_id_never_skips_messages_with_equal_timestamps(client, team):
    ids = await _post(client, team, 9)
    # Force identical timestamps: the old timestamp-only cursor would lose messages here.
    same = datetime(2026, 1, 1, tzinfo=UTC)
    async with SessionLocal() as db:
        await db.execute(update(Message).where(Message.id.in_(ids)).values(created_at=same))
        await db.commit()
    url = f"/channels/{team['general']['id']}/messages"
    h = team["alice"]["headers"]
    seen, cursor = [], None
    while True:
        q = f"?limit=4&before_id={cursor}" if cursor else "?limit=4"
        page = _ids(await client.get(url + q, headers=h))
        page = [i for i in page if i in ids]
        if not page:
            break
        seen += page
        cursor = page[-1]
    assert sorted(seen) == sorted(ids) and len(seen) == len(set(seen))


async def test_around_and_after(client, team):
    ids = await _post(client, team, 11)
    url = f"/channels/{team['general']['id']}/messages"
    h = team["alice"]["headers"]
    around = _ids(await client.get(f"{url}?limit=4&around_id={ids[5]}", headers=h))
    assert around == [ids[7], ids[6], ids[5], ids[4], ids[3]]  # newest-first, target in the middle
    after = _ids(await client.get(f"{url}?limit=3&after_id={ids[5]}", headers=h))
    assert after == [ids[8], ids[7], ids[6]]
    assert _ids(await client.get(f"{url}?after_id={ids[-1]}", headers=h)) == []


async def test_cursor_from_another_channel_is_404(client, team):
    ids = await _post(client, team, 1)
    dm = await client.post(
        f"/workspaces/{team['ws']['id']}/dms",
        json={"user_ids": [team["bob"]["id"]]},
        headers=team["alice"]["headers"],
    )
    if dm.status_code in (200, 201):
        r = await client.get(
            f"/channels/{dm.json()['id']}/messages?before_id={ids[0]}", headers=team["alice"]["headers"]
        )
        assert r.status_code == 404


async def test_replies_are_paged(client, team):
    parent = (await _post(client, team, 1))[0]
    h = team["alice"]["headers"]
    reply_ids = []
    for i in range(5):
        r = await client.post(
            f"/channels/{team['general']['id']}/messages",
            json={"body": f"reply {i}", "parent_id": parent},
            headers=h,
        )
        assert r.status_code == 201, r.text
        reply_ids.append(r.json()["id"])
    first = _ids(await client.get(f"/messages/{parent}/replies?limit=2", headers=h))
    assert first == reply_ids[:2]
    rest = _ids(await client.get(f"/messages/{parent}/replies?limit=10&after_id={first[-1]}", headers=h))
    assert rest == reply_ids[2:]


async def test_search_offset(client, team):
    await _post(client, team, 5, body="zebracorn")
    url = f"/workspaces/{team['ws']['id']}/search?q=zebracorn&limit=3"
    h = team["alice"]["headers"]
    p1 = _ids(await client.get(url, headers=h))
    p2 = _ids(await client.get(url + "&offset=3", headers=h))
    assert len(p1) == 3 and len(p2) == 2 and not set(p1) & set(p2)
