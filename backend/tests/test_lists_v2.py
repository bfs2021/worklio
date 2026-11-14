"""Lists v2: card priority/cover/custom fields, field definitions, subtasks, card comments,
column reorder and the table view's sort/group/filter."""

import uuid
from datetime import date, timedelta

from sqlalchemy import select

from app import productivity
from app.api.routes import board as board_routes
from app.core.db import SessionLocal
from app.models import ActivityEvent
from tests.conftest import register
from tests.test_collab import _archive, _channel, _guest
from tests.test_hardening import Recorder


async def _board(client, ch, h):
    r = await client.get(f"/channels/{ch['id']}/board", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _card(client, ch, h, title="Card", **extra):
    col = extra.pop("column_id", None) or (await _board(client, ch, h))["columns"][0]["id"]
    r = await client.post(
        f"/channels/{ch['id']}/board/cards", json={"column_id": col, "title": title, **extra}, headers=h
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _field(client, ch, h, name, type_, options=()):
    r = await client.post(
        f"/channels/{ch['id']}/board/fields",
        json={"name": name, "type": type_, "options": list(options)},
        headers=h,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _mention_events(user_id: str) -> list[ActivityEvent]:
    async with SessionLocal() as db:
        return list(
            await db.scalars(
                select(ActivityEvent).where(
                    ActivityEvent.user_id == uuid.UUID(user_id), ActivityEvent.type == "card_mention"
                )
            )
        )


# --- Priority / cover ------------------------------------------------------------------------


async def test_card_priority_and_cover(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(board_routes, "publish_to_channel", published)
    ch, h = await _channel(client, team), team["alice"]["headers"]
    plain = await _card(client, ch, h, "Plain")
    assert plain["priority"] == "none" and plain["cover_color"] is None
    assert plain["fields"] == {} and plain["subtasks"] == [] and plain["comment_count"] == 0

    card = await _card(client, ch, h, "Hot", priority="urgent", cover_color="#ff0000")
    assert (card["priority"], card["cover_color"]) == ("urgent", "#ff0000")
    r = await client.patch(f"/board/cards/{card['id']}", json={"priority": "low", "cover_color": None}, headers=h)
    assert r.status_code == 200, r.text
    assert (r.json()["priority"], r.json()["cover_color"]) == ("low", None)

    for bad in ({"priority": "critical"}, {"priority": None}, {"cover_color": "red; x"}, {"fields": None}):
        assert (await client.patch(f"/board/cards/{card['id']}", json=bad, headers=h)).status_code == 422, bad
    col = (await _board(client, ch, h))["columns"][0]["id"]
    r = await client.post(
        f"/channels/{ch['id']}/board/cards", json={"column_id": col, "title": "x", "priority": "p0"}, headers=h
    )
    assert r.status_code == 422

    event = published.events[-1][1]
    assert event["type"] == "board.updated"
    snap = {c["id"]: c for c in event["board"]["cards"]}
    assert snap[card["id"]]["priority"] == "low" and "fields" in event["board"]


# --- Custom fields ---------------------------------------------------------------------------


async def test_field_definitions_crud_and_validation(client, team):
    ch, h = await _channel(client, team), team["alice"]["headers"]
    url = f"/channels/{ch['id']}/board/fields"
    status_f = await _field(
        client, ch, h, " Status ", "select",
        [{"label": "Open", "color": "#00ff00"}, {"id": "closed", "label": "Closed"}],
    )
    assert status_f["name"] == "Status" and status_f["type"] == "select"
    assert [o["label"] for o in status_f["options"]] == ["Open", "Closed"]
    assert status_f["options"][0]["id"] and status_f["options"][1]["id"] == "closed"
    text_f = await _field(client, ch, h, "Notes", "text")
    assert text_f["position"] > status_f["position"]

    for bad in (
        {"name": "", "type": "text"},
        {"name": "x" * 51, "type": "text"},
        {"name": "x", "type": "formula"},
        {"name": "x", "type": "text", "options": [{"label": "a"}]},
        {"name": "x", "type": "select", "options": [{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]},
        {"name": "x", "type": "select", "options": [{"id": "bad id!", "label": "A"}]},
        {"name": "x", "type": "select", "options": [{"label": ""}]},
        {"name": "x", "type": "text", "extra": 1},
    ):
        assert (await client.post(url, json=bad, headers=h)).status_code == 422, bad

    r = await client.patch(f"/board/fields/{text_f['id']}", json={"name": "Summary", "position": 0.5}, headers=h)
    assert r.status_code == 200 and r.json()["name"] == "Summary"
    board = await _board(client, ch, h)
    assert [f["name"] for f in board["fields"]] == ["Summary", "Status"]
    for bad in ({"name": None}, {"type": None}, {"options": [{"label": "a"}]}):
        assert (await client.patch(f"/board/fields/{text_f['id']}", json=bad, headers=h)).status_code == 422, bad

    assert (await client.delete(f"/board/fields/{text_f['id']}", headers=h)).status_code == 204
    assert (await client.delete(f"/board/fields/{text_f['id']}", headers=h)).status_code == 404
    assert [f["id"] for f in (await _board(client, ch, h))["fields"]] == [status_f["id"]]

    # Cap on the number of fields.
    for i in range(board_routes.MAX_FIELDS - 1):
        await _field(client, ch, h, f"f{i}", "checkbox")
    assert (await client.post(url, json={"name": "over", "type": "text"}, headers=h)).status_code == 400


async def test_field_values_are_type_validated_and_merged(client, team):
    ch, h = await _channel(client, team), team["alice"]["headers"]
    opts = [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}, {"id": "c", "label": "C"}]
    f = {
        t: await _field(client, ch, h, t, t, opts if t in ("select", "multi_select") else ())
        for t in ("text", "number", "select", "multi_select", "person", "date", "checkbox", "url")
    }
    good = {
        f["text"]["id"]: "  hello ",
        f["number"]["id"]: 3.5,
        f["select"]["id"]: "a",
        f["multi_select"]["id"]: ["b", "a", "b"],
        f["person"]["id"]: team["bob"]["id"],
        f["date"]["id"]: "2026-12-24",
        f["checkbox"]["id"]: False,
        f["url"]["id"]: "https://example.com/x?y=1",
    }
    card = await _card(client, ch, h, "Valued", fields=good)
    assert card["fields"] == {
        f["text"]["id"]: "hello",
        f["number"]["id"]: 3.5,
        f["select"]["id"]: "a",
        f["multi_select"]["id"]: ["b", "a"],
        f["person"]["id"]: team["bob"]["id"],
        f["date"]["id"]: "2026-12-24",
        f["checkbox"]["id"]: False,
        f["url"]["id"]: "https://example.com/x?y=1",
    }

    outsider = await register(client, "outsider")
    patch = f"/board/cards/{card['id']}"
    bad_values = [
        (f["text"]["id"], 5),
        (f["text"]["id"], "x" * 2001),
        (f["number"]["id"], "5"),
        (f["number"]["id"], True),
        (f["number"]["id"], 1e16),
        (f["select"]["id"], "zzz"),
        (f["select"]["id"], ["a"]),
        (f["multi_select"]["id"], "a"),
        (f["multi_select"]["id"], ["a", "zzz"]),
        (f["person"]["id"], outsider["id"]),
        (f["person"]["id"], "not-a-uuid"),
        (f["date"]["id"], "24/12/2026"),
        (f["date"]["id"], "2026-02-30"),
        (f["checkbox"]["id"], "yes"),
        (f["url"]["id"], "javascript:alert(1)"),
        (f["url"]["id"], "https://exa mple.com"),
        (str(uuid.uuid4()), "unknown field"),
        ("not-a-uuid", "x"),
    ]
    for fid, value in bad_values:
        r = await client.patch(patch, json={"fields": {fid: value}}, headers=h)
        assert r.status_code == 422, (fid, value, r.text)
    # A field of another board is unknown here.
    other = await _channel(client, team)
    foreign = await _field(client, other, h, "Foreign", "text")
    assert (await client.patch(patch, json={"fields": {foreign["id"]: "x"}}, headers=h)).status_code == 422

    # Partial merge: untouched keys stay; null and blank values clear.
    r = await client.patch(
        patch,
        json={"fields": {f["number"]["id"]: -2, f["text"]["id"]: None, f["url"]["id"]: " ", f["multi_select"]["id"]: []}},
        headers=h,
    )
    assert r.status_code == 200, r.text
    values = r.json()["fields"]
    assert values[f["number"]["id"]] == -2 and values[f["select"]["id"]] == "a"
    assert f["text"]["id"] not in values and f["url"]["id"] not in values and f["multi_select"]["id"] not in values

    # Removing options prunes values; retyping clears them; deleting the field strips them.
    await client.patch(patch, json={"fields": {f["multi_select"]["id"]: ["a", "c"]}}, headers=h)
    r = await client.patch(
        f"/board/fields/{f['multi_select']['id']}", json={"options": [{"id": "c", "label": "C2"}]}, headers=h
    )
    assert r.status_code == 200 and [o["label"] for o in r.json()["options"]] == ["C2"]
    r = await client.patch(f"/board/fields/{f['select']['id']}", json={"options": [{"id": "b", "label": "B"}]}, headers=h)
    assert r.status_code == 200
    values = (await client.patch(patch, json={}, headers=h)).json()["fields"]
    assert values[f["multi_select"]["id"]] == ["c"] and f["select"]["id"] not in values

    r = await client.patch(f"/board/fields/{f['number']['id']}", json={"type": "text"}, headers=h)
    assert r.status_code == 200 and r.json()["type"] == "text"
    r = await client.patch(f"/board/fields/{f['multi_select']['id']}", json={"type": "url"}, headers=h)
    assert r.json()["options"] == []
    assert (await client.delete(f"/board/fields/{f['person']['id']}", headers=h)).status_code == 204
    card_now = next(c for c in (await _board(client, ch, h))["cards"] if c["id"] == card["id"])
    for gone in ("number", "multi_select", "person"):
        assert f[gone]["id"] not in card_now["fields"]
    assert card_now["fields"][f["checkbox"]["id"]] is False


# --- Subtasks --------------------------------------------------------------------------------


async def test_subtasks_crud_and_ordering(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(board_routes, "publish_to_channel", published)
    ch, h = await _channel(client, team), team["alice"]["headers"]
    card = await _card(client, ch, h)
    url = f"/board/cards/{card['id']}/subtasks"

    async def add(title, **extra):
        r = await client.post(url, json={"title": title, **extra}, headers=h)
        assert r.status_code == 201, r.text
        return r.json()

    a = await add(" Write spec ", assignee_id=team["bob"]["id"])
    assert a["title"] == "Write spec" and a["done"] is False and a["assignee_id"] == team["bob"]["id"]
    b, c = await add("Review"), await add("Ship")
    assert a["position"] < b["position"] < c["position"]

    r = await client.patch(
        f"/board/subtasks/{c['id']}", json={"position": (a["position"] + b["position"]) / 2, "done": True}, headers=h
    )
    assert r.status_code == 200 and r.json()["done"] is True
    snap = published.events[-1][1]["board"]
    subtasks = next(x for x in snap["cards"] if x["id"] == card["id"])["subtasks"]
    assert [s["title"] for s in subtasks] == ["Write spec", "Ship", "Review"]

    # Crowded positions get renumbered.
    r = await client.patch(f"/board/subtasks/{b['id']}", json={"position": a["position"] + 1e-9}, headers=h)
    subtasks = next(x for x in (await _board(client, ch, h))["cards"] if x["id"] == card["id"])["subtasks"]
    assert [s["title"] for s in subtasks] == ["Write spec", "Review", "Ship"]
    assert [s["position"] for s in subtasks] == [1.0, 2.0, 3.0]

    r = await client.patch(f"/board/subtasks/{a['id']}", json={"assignee_id": None, "title": "Spec"}, headers=h)
    assert (r.json()["assignee_id"], r.json()["title"]) == (None, "Spec")

    outsider = await register(client, "outsider")
    for bad in ({"title": ""}, {"title": "x" * 201}, {}, {"title": "x", "nope": 1}):
        assert (await client.post(url, json=bad, headers=h)).status_code == 422, bad
    assert (await client.post(url, json={"title": "x", "assignee_id": outsider["id"]}, headers=h)).status_code == 400
    for bad in ({"title": None}, {"done": None}, {"position": "nan"}):
        assert (await client.patch(f"/board/subtasks/{a['id']}", json=bad, headers=h)).status_code == 422, bad
    assert (await client.patch(f"/board/subtasks/{a['id']}", json={"assignee_id": outsider["id"]}, headers=h)).status_code == 400

    assert (await client.delete(f"/board/subtasks/{b['id']}", headers=h)).status_code == 204
    assert (await client.delete(f"/board/subtasks/{b['id']}", headers=h)).status_code == 404
    subtasks = next(x for x in (await _board(client, ch, h))["cards"] if x["id"] == card["id"])["subtasks"]
    assert [s["title"] for s in subtasks] == ["Spec", "Ship"]

    # Deleting the card takes its subtasks with it.
    assert (await client.delete(f"/board/cards/{card['id']}", headers=h)).status_code == 204
    assert (await client.patch(f"/board/subtasks/{a['id']}", json={"done": True}, headers=h)).status_code == 404


async def test_subtask_cap(client, team, monkeypatch):
    monkeypatch.setattr(board_routes, "MAX_SUBTASKS", 2)
    ch, h = await _channel(client, team), team["alice"]["headers"]
    card = await _card(client, ch, h)
    for t in ("a", "b"):
        assert (await client.post(f"/board/cards/{card['id']}/subtasks", json={"title": t}, headers=h)).status_code == 201
    assert (await client.post(f"/board/cards/{card['id']}/subtasks", json={"title": "c"}, headers=h)).status_code == 400


# --- Comments --------------------------------------------------------------------------------


async def test_card_comments_crud_mentions_and_realtime(client, team, monkeypatch):
    published, notified = Recorder(), Recorder()
    monkeypatch.setattr(board_routes, "publish_to_channel", published)
    monkeypatch.setattr(board_routes, "notify_user", notified)
    monkeypatch.setattr(productivity, "notify_user", notified)
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, kind="private", members=("bob",))
    card = await _card(client, ch, alice["headers"], "Launch")
    url = f"/board/cards/{card['id']}/comments"

    # Bob mentions alice (a reader) and carol (not in the private channel).
    body = f"Ping <@{alice['id']}> and <@{carol['id']}> and myself <@{bob['id']}>"
    notified.events.clear()  # e.g. channel_invite activity from creating the channel
    r = await client.post(url, json={"body": f"  {body} "}, headers=bob["headers"])
    assert r.status_code == 201, r.text
    c1 = r.json()
    assert c1["body"] == body and c1["author_id"] == bob["id"] and c1["edited_at"] is None
    assert c1["card_id"] == card["id"]

    assert [e["type"] for _, e in published.events[-2:]] == ["board.comments.updated", "board.updated"]
    assert published.events[-2][1]["card_id"] == card["id"]
    snap = published.events[-1][1]["board"]
    assert next(x for x in snap["cards"] if x["id"] == card["id"])["comment_count"] == 1

    events = await _mention_events(alice["id"])
    assert len(events) == 1 and events[0].meta["card_id"] == card["id"]
    assert events[0].meta["comment_id"] == c1["id"] and events[0].actor_id == uuid.UUID(bob["id"])
    assert await _mention_events(carol["id"]) == [] and await _mention_events(bob["id"]) == []
    mention = next(e for target, e in notified.events if target == alice["id"])
    # card_mention is a first-class Activity item: it arrives as activity.new.
    assert mention["type"] == "activity.new" and mention["item"]["type"] == "card_mention"
    assert mention["item"]["meta"]["card_title"] == "Launch"
    assert mention["item"]["channel_id"] == ch["id"]
    for kind in ("all", "mentions"):
        feed = await client.get(
            f"/workspaces/{team['ws']['id']}/activity?type={kind}", headers=alice["headers"]
        )
        assert feed.status_code == 200, feed.text
        assert any(
            i["type"] == "card_mention" and i["meta"]["card_id"] == card["id"]
            for i in feed.json()["items"]
        )
    assert {t for t, _ in notified.events} == {alice["id"]}

    c2 = (await client.post(url, json={"body": "second"}, headers=alice["headers"])).json()
    listed = (await client.get(url, headers=bob["headers"])).json()
    assert [c["id"] for c in listed] == [c1["id"], c2["id"]]
    card_now = next(x for x in (await _board(client, ch, bob["headers"]))["cards"] if x["id"] == card["id"])
    assert card_now["comment_count"] == 2

    # Edit: author only; newly mentioned users are notified once.
    patch = f"/board/comments/{c2['id']}"
    assert (await client.patch(patch, json={"body": "hijack"}, headers=bob["headers"])).status_code == 403
    notified.events.clear()
    r = await client.patch(patch, json={"body": f"second, cc <@{bob['id']}>"}, headers=alice["headers"])
    assert r.status_code == 200 and r.json()["edited_at"] is not None
    assert published.events[-1][1]["type"] == "board.comments.updated"
    assert len(await _mention_events(bob["id"])) == 1 and [t for t, _ in notified.events] == [bob["id"]]
    await client.patch(patch, json={"body": f"second!, cc <@{bob['id']}>"}, headers=alice["headers"])
    assert len(await _mention_events(bob["id"])) == 1

    for bad in ({"body": ""}, {"body": "   "}, {"body": "x" * 4001}, {}):
        assert (await client.post(url, json=bad, headers=bob["headers"])).status_code == 422, bad
        assert (await client.patch(patch, json=bad, headers=alice["headers"])).status_code == 422, bad

    # Delete: authors, or workspace admins (alice owns the workspace); its mention goes too.
    await client.post(f"/channels/{ch['id']}/members", json={"user_id": carol["id"]}, headers=alice["headers"])
    assert (await client.delete(f"/board/comments/{c1['id']}", headers=carol["headers"])).status_code == 403
    assert (await client.delete(f"/board/comments/{c1['id']}", headers=alice["headers"])).status_code == 204
    assert await _mention_events(alice["id"]) == []
    assert (await client.delete(f"/board/comments/{c1['id']}", headers=alice["headers"])).status_code == 404
    assert (await client.delete(patch, headers=alice["headers"])).status_code == 204
    assert (await client.get(url, headers=bob["headers"])).json() == []

    # Deleting the card removes its comments and their mention activity.
    c3 = (await client.post(url, json={"body": f"<@{carol['id']}>"}, headers=bob["headers"])).json()
    assert len(await _mention_events(carol["id"])) == 1
    assert (await client.delete(f"/board/cards/{card['id']}", headers=bob["headers"])).status_code == 204
    assert await _mention_events(carol["id"]) == []
    assert (await client.patch(f"/board/comments/{c3['id']}", json={"body": "x"}, headers=bob["headers"])).status_code == 404


async def test_archived_board_is_read_only(client, team):
    ch, h = await _channel(client, team), team["alice"]["headers"]
    card = await _card(client, ch, h)
    sub = (await client.post(f"/board/cards/{card['id']}/subtasks", json={"title": "s"}, headers=h)).json()
    com = (await client.post(f"/board/cards/{card['id']}/comments", json={"body": "c"}, headers=h)).json()
    field = await _field(client, ch, h, "F", "text")
    await _archive(ch["id"])
    assert (await client.get(f"/board/cards/{card['id']}/comments", headers=h)).status_code == 200
    col_ids = [c["id"] for c in (await _board(client, ch, h))["columns"]]
    writes = [
        client.post(f"/board/cards/{card['id']}/comments", json={"body": "x"}, headers=h),
        client.patch(f"/board/comments/{com['id']}", json={"body": "x"}, headers=h),
        client.delete(f"/board/comments/{com['id']}", headers=h),
        client.post(f"/board/cards/{card['id']}/subtasks", json={"title": "x"}, headers=h),
        client.patch(f"/board/subtasks/{sub['id']}", json={"done": True}, headers=h),
        client.delete(f"/board/subtasks/{sub['id']}", headers=h),
        client.post(f"/channels/{ch['id']}/board/fields", json={"name": "x", "type": "text"}, headers=h),
        client.patch(f"/board/fields/{field['id']}", json={"name": "x"}, headers=h),
        client.delete(f"/board/fields/{field['id']}", headers=h),
        client.post("/board/columns/reorder", json={"column_ids": col_ids[::-1]}, headers=h),
        client.patch(f"/board/cards/{card['id']}", json={"priority": "high"}, headers=h),
    ]
    for req in writes:
        assert (await req).status_code == 403


# --- Columns reorder -------------------------------------------------------------------------


async def test_column_reorder(client, team, monkeypatch):
    published = Recorder()
    monkeypatch.setattr(board_routes, "publish_to_channel", published)
    ch, h = await _channel(client, team), team["alice"]["headers"]
    todo, doing, done = (await _board(client, ch, h))["columns"]
    r = await client.post("/board/columns/reorder", json={"column_ids": [done["id"], todo["id"], doing["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    assert [c["name"] for c in r.json()] == ["Done", "To do", "In progress"]
    assert [c["position"] for c in r.json()] == [1.0, 2.0, 3.0]
    assert [c["name"] for c in (await _board(client, ch, h))["columns"]] == ["Done", "To do", "In progress"]
    assert [c["name"] for c in published.events[-1][1]["board"]["columns"]] == ["Done", "To do", "In progress"]

    other_col = (await _board(client, await _channel(client, team), h))["columns"][0]
    for bad, code in (
        ([todo["id"], doing["id"]], 400),  # missing a column
        ([todo["id"], doing["id"], done["id"], other_col["id"]], 400),  # foreign column
        ([todo["id"], todo["id"], done["id"]], 422),  # duplicate
        ([], 422),
        ([str(uuid.uuid4())], 404),
    ):
        r = await client.post("/board/columns/reorder", json={"column_ids": bad}, headers=h)
        assert r.status_code == code, (bad, r.text)


# --- Table view: sort / group / filter -------------------------------------------------------


async def test_board_sort_group_and_filter(client, team):
    ch, h = await _channel(client, team), team["alice"]["headers"]
    todo, doing, _ = (await _board(client, ch, h))["columns"]
    today = date(2026, 6, 15)
    bob = team["bob"]["id"]
    a = await _card(client, ch, h, "A", column_id=todo["id"], priority="low", labels=["bug"], due_date=str(today - timedelta(days=2)))
    b = await _card(client, ch, h, "B", column_id=doing["id"], priority="urgent", assignee_id=bob, labels=["bug", "ui"], due_date=str(today + timedelta(days=3)))
    c = await _card(client, ch, h, "C", column_id=todo["id"], priority="high", due_date=str(today + timedelta(days=30)))
    d = await _card(client, ch, h, "D", column_id=doing["id"], assignee_id=bob)
    await client.patch(f"/board/cards/{c['id']}", json={}, headers=h)

    async def view(**params):
        r = await client.get(f"/channels/{ch['id']}/board", params=params, headers=h)
        assert r.status_code == 200, r.text
        return r.json()

    def titles(board):
        return [x["title"] for x in board["cards"]]

    full = await view()
    assert titles(full) == ["A", "C", "B", "D"] and full["groups"] is None
    assert titles(await view(sort="priority")) == ["B", "C", "A", "D"]
    assert titles(await view(sort="priority", order="desc")) == ["D", "A", "C", "B"]
    assert titles(await view(sort="due")) == ["A", "B", "C", "D"]
    assert titles(await view(sort="due", order="desc")) == ["C", "B", "A", "D"]
    assert titles(await view(sort="created")) == ["A", "B", "C", "D"]
    assert titles(await view(sort="created", order="desc")) == ["D", "C", "B", "A"]

    assert titles(await view(assignee_id=bob)) == ["B", "D"]
    assert titles(await view(assignee_id="none")) == ["A", "C"]
    assert titles(await view(priority=["urgent", "low"])) == ["A", "B"]
    assert titles(await view(label="ui")) == ["B"]
    assert titles(await view(due="overdue", today=str(today))) == ["A"]
    assert titles(await view(due="week", today=str(today))) == ["B"]
    await client.patch(f"/board/cards/{a['id']}", json={"completed": True}, headers=h)
    assert titles(await view(due="overdue", today=str(today))) == []
    # Filters narrow cards only; columns and fields stay complete.
    filtered = await view(label="ui")
    assert len(filtered["columns"]) == 3

    g = await view(group="column")
    assert [x["key"] for x in g["groups"]] == [c_["id"] for c_ in full["columns"]]
    assert g["groups"][0]["card_ids"] == [a["id"], c["id"]]
    g = await view(group="priority", sort="created")
    assert [x["key"] for x in g["groups"]] == ["urgent", "high", "medium", "low", "none"]
    assert g["groups"][0]["card_ids"] == [b["id"]] and g["groups"][4]["card_ids"] == [d["id"]]
    g = await view(group="assignee", sort="created")
    assert [(x["key"], x["card_ids"]) for x in g["groups"]] == [
        (bob, [b["id"], d["id"]]),
        ("none", [a["id"], c["id"]]),
    ]
    g = await view(group="label", sort="created")
    assert [(x["key"], x["card_ids"]) for x in g["groups"]] == [
        ("bug", [a["id"], b["id"]]),
        ("ui", [b["id"]]),
        ("none", [c["id"], d["id"]]),
    ]

    for bad in (
        {"sort": "random"}, {"group": "color"}, {"priority": "p0"}, {"due": "soon"},
        {"order": "up"}, {"assignee_id": "nobody"}, {"today": "yesterday"},
    ):
        r = await client.get(f"/channels/{ch['id']}/board", params=bad, headers=h)
        assert r.status_code == 422, bad


# --- Tenant isolation ------------------------------------------------------------------------


async def test_lists_v2_tenant_isolation(client, team):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    priv = await _channel(client, team, kind="private", owner="bob")
    card = await _card(client, priv, bob["headers"], "secret")
    sub = (await client.post(f"/board/cards/{card['id']}/subtasks", json={"title": "s"}, headers=bob["headers"])).json()
    com = (await client.post(f"/board/cards/{card['id']}/comments", json={"body": "c"}, headers=bob["headers"])).json()
    field = await _field(client, priv, bob["headers"], "F", "text")
    col_ids = [c["id"] for c in (await _board(client, priv, bob["headers"]))["columns"]]

    # Another workspace's owner, an outsider and a non-member of the private channel.
    other_owner = await register(client, "mallory")
    await client.post("/workspaces", json={"name": "Evil", "slug": f"evil-{uuid.uuid4().hex[:6]}"}, headers=other_owner["headers"])
    guest = await _guest(client, team, channels=(team["general"],))
    for who in (alice, carol, other_owner, guest):
        hh = who["headers"]
        reqs = [
            client.get(f"/board/cards/{card['id']}/comments", headers=hh),
            client.post(f"/board/cards/{card['id']}/comments", json={"body": "x"}, headers=hh),
            client.patch(f"/board/comments/{com['id']}", json={"body": "x"}, headers=hh),
            client.delete(f"/board/comments/{com['id']}", headers=hh),
            client.post(f"/board/cards/{card['id']}/subtasks", json={"title": "x"}, headers=hh),
            client.patch(f"/board/subtasks/{sub['id']}", json={"done": True}, headers=hh),
            client.delete(f"/board/subtasks/{sub['id']}", headers=hh),
            client.post(f"/channels/{priv['id']}/board/fields", json={"name": "x", "type": "text"}, headers=hh),
            client.patch(f"/board/fields/{field['id']}", json={"name": "x"}, headers=hh),
            client.delete(f"/board/fields/{field['id']}", headers=hh),
            client.post("/board/columns/reorder", json={"column_ids": col_ids}, headers=hh),
            client.patch(f"/board/cards/{card['id']}", json={"priority": "high"}, headers=hh),
            client.get(f"/channels/{priv['id']}/board", params={"group": "label"}, headers=hh),
        ]
        for req in reqs:
            assert (await req).status_code == 404
    assert (await client.get(f"/board/cards/{card['id']}/comments")).status_code == 401

    # Admin rights don't reach into a private channel the admin isn't in.
    assert (await client.delete(f"/board/comments/{com['id']}", headers=alice["headers"])).status_code == 404
    # Person fields only accept members of this workspace.
    pf = await _field(client, priv, bob["headers"], "Owner", "person")
    r = await client.patch(f"/board/cards/{card['id']}", json={"fields": {pf["id"]: other_owner["id"]}}, headers=bob["headers"])
    assert r.status_code == 422
    # Nothing leaked or changed.
    board = await _board(client, priv, bob["headers"])
    assert [s["title"] for s in board["cards"][0]["subtasks"]] == ["s"]
    assert [f["name"] for f in board["fields"]] == ["F", "Owner"] and board["cards"][0]["comment_count"] == 1
