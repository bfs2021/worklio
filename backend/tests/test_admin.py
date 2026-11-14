"""Wave D1 workspace administration: settings & policies, member lifecycle (roles, deactivate,
remove, ownership), invite links, channel managers / rename / archive and the audit log."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select, update

from app.api.routes import admin as admin_routes
from app.core.db import SessionLocal
from app.models import AuditEvent, InviteLink, Workspace, WorkspaceMember, WorkspaceRole
from tests.conftest import register
from tests.test_hardening import Recorder

pytestmark = pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def revoked(monkeypatch):
    rec = Recorder()

    async def revoke(user_id):
        await rec(user_id, {"type": "session.revoked"})

    monkeypatch.setattr(admin_routes, "revoke_sessions", revoke)
    return rec


def _ws(team) -> str:
    return team["ws"]["id"]


async def _set_policies(client, team, **policies):
    r = await client.patch(
        f"/workspaces/{_ws(team)}/settings", json={"policies": policies}, headers=team["alice"]["headers"]
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _channel(client, team, who="alice", *, kind="public", members=()) -> dict:
    body = {"name": f"c-{uuid.uuid4().hex[:8]}", "kind": kind, "member_ids": [team[m]["id"] for m in members]}
    r = await client.post(f"/workspaces/{_ws(team)}/channels", json=body, headers=team[who]["headers"])
    assert r.status_code == 201, r.text
    return r.json()


async def _role(client, team, who: str, role: str, actor="alice"):
    return await client.patch(
        f"/workspaces/{_ws(team)}/members/{team[who]['id']}", json={"role": role}, headers=team[actor]["headers"]
    )


async def _audit(client, team, **params) -> list[dict]:
    r = await client.get(f"/workspaces/{_ws(team)}/audit-log", params=params, headers=team["alice"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def _add_guest(client, team, channels=()) -> dict:
    guest = await register(client, "guest")
    link = await client.post(
        f"/workspaces/{_ws(team)}/invite-links",
        json={"role": "guest", "channel_ids": [c["id"] for c in channels]},
        headers=team["alice"]["headers"],
    )
    assert link.status_code == 201, link.text
    r = await client.post(f"/invites/{link.json()['token']}/accept", headers=guest["headers"])
    assert r.status_code == 200, r.text
    return guest


# --- Settings & policies --------------------------------------------------------------------


async def test_settings_read_by_members_and_updated_by_admins(client, team):
    ws, alice, bob = _ws(team), team["alice"], team["bob"]
    s = (await client.get(f"/workspaces/{ws}/settings", headers=bob["headers"])).json()
    assert s["name"] == "Acme" and s["icon_url"] is None and s["description"] is None
    assert s["policies"]["invite_members"] == "admins" and s["policies"]["create_public_channels"] == "everyone"
    assert s["viewer_role"] == "member" and s["viewer_can"]["invite_members"] is False
    assert s["viewer_can"]["create_public_channels"] is True

    r = await client.patch(f"/workspaces/{ws}/settings", json={"name": "Nope"}, headers=bob["headers"])
    assert r.status_code == 403
    r = await client.patch(
        f"/workspaces/{ws}/settings",
        json={"name": "Acme Inc", "description": "  We build things  ", "policies": {"use_ai": "admins"}},
        headers=alice["headers"],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Acme Inc" and body["description"] == "We build things"
    assert body["policies"]["use_ai"] == "admins" and body["policies"]["invite_members"] == "admins"
    # Unknown policies and values are rejected.
    bad = await client.patch(f"/workspaces/{ws}/settings", json={"policies": {"nope": "everyone"}}, headers=alice["headers"])
    assert bad.status_code == 422
    bad = await client.patch(f"/workspaces/{ws}/settings", json={"policies": {"use_ai": "guests"}}, headers=alice["headers"])
    assert bad.status_code == 422

    actions = [e["action"] for e in await _audit(client, team)]
    assert "workspace.settings_updated" in actions and "workspace.policy_changed" in actions
    policy = next(e for e in await _audit(client, team, action="workspace.policy_changed"))
    assert policy["target_id"] == "use_ai" and policy["meta"] == {"from": "everyone", "to": "admins"}


async def test_slug_conflict_and_default_channels(client, team):
    ws, alice = _ws(team), team["alice"]
    other = await register(client, "other")
    taken = f"taken-{uuid.uuid4().hex[:6]}"
    await client.post("/workspaces", json={"name": "Other", "slug": taken}, headers=other["headers"])
    r = await client.patch(f"/workspaces/{ws}/settings", json={"slug": taken}, headers=alice["headers"])
    assert r.status_code == 409

    pub = await _channel(client, team)
    priv = await _channel(client, team, kind="private")
    r = await client.patch(f"/workspaces/{ws}/settings", json={"default_channel_ids": [priv["id"]]}, headers=alice["headers"])
    assert r.status_code == 400
    r = await client.patch(f"/workspaces/{ws}/settings", json={"default_channel_ids": [pub["id"]]}, headers=alice["headers"])
    assert r.status_code == 200 and r.json()["default_channel_ids"] == [pub["id"]]

    dave = await register(client, "dave")
    r = await client.post(f"/workspaces/{ws}/members", json={"email": dave["email"]}, headers=alice["headers"])
    assert r.status_code == 201
    mine = {c["id"] for c in (await client.get(f"/workspaces/{ws}/channels", headers=dave["headers"])).json() if c["is_member"]}
    assert {team["general"]["id"], pub["id"]} <= mine


async def test_icon_upload_and_delete(client, team):
    ws, alice, bob = _ws(team), team["alice"], team["bob"]
    files = {"file": ("i.png", PNG, "image/png")}
    assert (await client.post(f"/workspaces/{ws}/icon", files=files, headers=bob["headers"])).status_code == 403
    r = await client.post(f"/workspaces/{ws}/icon", files=files, headers=alice["headers"])
    assert r.status_code == 200, r.text
    assert f"/workspaces/{ws}/icon?v=" in r.json()["icon_url"]
    got = await client.get(f"/workspaces/{ws}/icon")
    assert got.status_code == 302
    r = await client.post(f"/workspaces/{ws}/icon", files={"file": ("x.txt", b"hello", "text/plain")}, headers=alice["headers"])
    assert r.status_code == 415
    big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (2 * 1024 * 1024 + 10)
    r = await client.post(f"/workspaces/{ws}/icon", files={"file": ("b.png", big, "image/png")}, headers=alice["headers"])
    assert r.status_code == 413
    r = await client.delete(f"/workspaces/{ws}/icon", headers=alice["headers"])
    assert r.status_code == 200 and r.json()["icon_url"] is None
    assert (await client.get(f"/workspaces/{ws}/icon")).status_code == 404


async def test_channel_creation_policies(client, team):
    ws, bob = _ws(team), team["bob"]
    await _set_policies(client, team, create_public_channels="admins", create_private_channels="admins")
    for kind in ("public", "private"):
        r = await client.post(f"/workspaces/{ws}/channels", json={"name": f"p-{uuid.uuid4().hex[:6]}", "kind": kind}, headers=bob["headers"])
        assert r.status_code == 403 and r.json()["detail"] == f"policy:create_{kind}_channels"
    await _channel(client, team)  # alice (owner) still can
    await _set_policies(client, team, create_private_channels="everyone")
    await _channel(client, team, "bob", kind="private")


async def test_invite_policy(client, team):
    ws, bob = _ws(team), team["bob"]
    dave, erin = await register(client, "dave"), await register(client, "erin")
    r = await client.post(f"/workspaces/{ws}/members", json={"email": dave["email"]}, headers=bob["headers"])
    assert r.status_code == 403 and r.json()["detail"] == "policy:invite_members"
    assert (await client.post(f"/workspaces/{ws}/invite-links", json={}, headers=bob["headers"])).status_code == 403

    await _set_policies(client, team, invite_members="everyone")
    r = await client.post(f"/workspaces/{ws}/members", json={"email": dave["email"]}, headers=bob["headers"])
    assert r.status_code == 201
    # Members never invite guests or admins.
    r = await client.post(f"/workspaces/{ws}/members", json={"email": erin["email"], "role": "guest"}, headers=bob["headers"])
    assert r.status_code == 403
    r = await client.post(f"/workspaces/{ws}/members", json={"email": erin["email"], "role": "admin"}, headers=bob["headers"])
    assert r.status_code == 403
    gen = team["general"]["id"]
    r = await client.post(f"/workspaces/{ws}/invite-links", json={"role": "guest", "channel_ids": [gen]}, headers=bob["headers"])
    assert r.status_code == 403
    assert (await client.post(f"/workspaces/{ws}/invite-links", json={}, headers=bob["headers"])).status_code == 201


async def test_group_policy(client, team):
    ws, bob = _ws(team), team["bob"]
    await _set_policies(client, team, create_user_groups="admins")
    r = await client.post(f"/workspaces/{ws}/groups", json={"handle": f"g{uuid.uuid4().hex[:6]}", "name": "G"}, headers=bob["headers"])
    assert r.status_code == 403 and r.json()["detail"] == "policy:create_user_groups"
    r = await client.post(f"/workspaces/{ws}/groups", json={"handle": f"g{uuid.uuid4().hex[:6]}", "name": "G"}, headers=team["alice"]["headers"])
    assert r.status_code == 201


async def test_huddle_policy_blocks_start_not_join(client, team, monkeypatch):
    from app import calls

    for name in ("publish_to_channel", "notify_user"):
        monkeypatch.setattr(calls, name, Recorder())
    monkeypatch.setattr(calls, "schedule_ring_timeout", lambda *_: None)
    ch = await _channel(client, team, members=("bob",))
    await _set_policies(client, team, start_huddles="admins")
    r = await client.post(f"/channels/{ch['id']}/calls", json={}, headers=team["bob"]["headers"])
    assert r.status_code == 403 and r.json()["detail"] == "policy:start_huddles"
    assert (await client.post(f"/channels/{ch['id']}/huddle/join", headers=team["bob"]["headers"])).status_code == 403
    # An admin starts it; then members may join.
    assert (await client.post(f"/channels/{ch['id']}/calls", json={}, headers=team["alice"]["headers"])).status_code == 200
    assert (await client.post(f"/channels/{ch['id']}/calls", json={}, headers=team["bob"]["headers"])).status_code == 200
    # DMs are calls, not huddles: unaffected.
    dm = (await client.post(f"/workspaces/{_ws(team)}/dms", json={"user_ids": [team["carol"]["id"]]}, headers=team["bob"]["headers"])).json()
    assert (await client.post(f"/channels/{dm['id']}/calls", json={}, headers=team["bob"]["headers"])).status_code == 200


# --- Roles ----------------------------------------------------------------------------------


async def test_role_changes_and_owner_protections(client, team):
    ws, alice, bob, carol = _ws(team), team["alice"], team["bob"], team["carol"]
    # Members can't change roles; nobody changes their own.
    assert (await _role(client, team, "carol", "guest", actor="bob")).status_code == 403
    assert (await _role(client, team, "alice", "admin", actor="alice")).status_code == 403

    assert (await _role(client, team, "bob", "admin")).status_code == 200
    # Admins manage members/guests, but not admins/owners, and can't grant admin.
    assert (await _role(client, team, "carol", "guest", actor="bob")).status_code == 200
    assert (await _role(client, team, "carol", "member", actor="bob")).status_code == 200
    assert (await _role(client, team, "carol", "admin", actor="bob")).status_code == 403
    assert (await _role(client, team, "alice", "member", actor="bob")).status_code == 403

    # A second owner can't demote the primary owner (transfer first)...
    assert (await _role(client, team, "carol", "owner")).status_code == 200
    r = await _role(client, team, "alice", "member", actor="carol")
    assert r.status_code == 400
    # ...but the primary owner can demote another owner.
    assert (await _role(client, team, "carol", "member")).status_code == 200

    members = {m["user_id"]: m for m in (await client.get(f"/workspaces/{ws}/admin/members", headers=alice["headers"])).json()}
    assert members[bob["id"]]["role"] == "admin" and members[carol["id"]]["role"] == "member"
    assert members[alice["id"]]["role"] == "owner" and members[alice["id"]]["status"] == "active"
    changes = await _audit(client, team, action="member.role_changed")
    assert len(changes) == 5 and changes[0]["meta"] == {"from": "owner", "to": "member"}


async def test_last_owner_guard(client, team):
    """Defence in depth behind the API rules: the last owner can never lose the role."""
    ws_id, alice_id = uuid.UUID(_ws(team)), uuid.UUID(team["alice"]["id"])
    async with SessionLocal() as db:
        alice = await db.scalar(
            select(WorkspaceMember).where(WorkspaceMember.workspace_id == ws_id, WorkspaceMember.user_id == alice_id)
        )
        with pytest.raises(HTTPException) as exc:
            await admin_routes._ensure_not_last_owner(db, ws_id, alice)
        assert exc.value.detail == "last_owner"
    # With a second owner the guard lets go.
    assert (await _role(client, team, "bob", "owner")).status_code == 200
    async with SessionLocal() as db:
        alice = await db.scalar(
            select(WorkspaceMember).where(WorkspaceMember.workspace_id == ws_id, WorkspaceMember.user_id == alice_id)
        )
        await admin_routes._ensure_not_last_owner(db, ws_id, alice)


async def test_sole_owner_cannot_leave_ownership(client, team, revoked):
    ws, alice, bob = _ws(team), team["alice"], team["bob"]
    assert (await _role(client, team, "bob", "admin")).status_code == 200
    # The sole owner can't demote, deactivate or remove themselves...
    assert (await _role(client, team, "alice", "member")).status_code == 403
    assert (await client.post(f"/workspaces/{ws}/members/{alice['id']}/deactivate", headers=alice["headers"])).status_code == 403
    assert (await client.delete(f"/workspaces/{ws}/members/{alice['id']}", headers=alice["headers"])).status_code == 403
    # ...and admins can't touch owners.
    assert (await client.post(f"/workspaces/{ws}/members/{alice['id']}/deactivate", headers=bob["headers"])).status_code == 403
    assert (await client.delete(f"/workspaces/{ws}/members/{alice['id']}", headers=bob["headers"])).status_code == 403
    async with SessionLocal() as db:
        owners = await db.scalar(
            select(WorkspaceMember.id).where(
                WorkspaceMember.workspace_id == uuid.UUID(ws), WorkspaceMember.role == WorkspaceRole.owner
            )
        )
        assert owners is not None


async def test_transfer_ownership(client, team):
    ws, alice, bob, carol = _ws(team), team["alice"], team["bob"], team["carol"]
    r = await client.post(f"/workspaces/{ws}/transfer-ownership", json={"user_id": carol["id"]}, headers=bob["headers"])
    assert r.status_code == 403
    guest = await _add_guest(client, team, [team["general"]])
    r = await client.post(f"/workspaces/{ws}/transfer-ownership", json={"user_id": guest["id"]}, headers=alice["headers"])
    assert r.status_code == 400
    r = await client.post(f"/workspaces/{ws}/transfer-ownership", json={"user_id": bob["id"]}, headers=alice["headers"])
    assert r.status_code == 204
    assert (await client.get(f"/workspaces/{ws}", headers=bob["headers"])).json()["owner_id"] == bob["id"]
    members = {m["user_id"]: m["role"] for m in (await client.get(f"/workspaces/{ws}/admin/members", headers=bob["headers"])).json()}
    assert members[bob["id"]] == "owner" and members[alice["id"]] == "admin"
    # The former owner (now admin) can't demote the new one.
    assert (await _role(client, team, "bob", "member", actor="alice")).status_code == 403
    assert (await client.get(f"/workspaces/{ws}/audit-log", headers=bob["headers"])).json()["items"][0]["action"] == "workspace.ownership_transferred"


# --- Deactivate / reactivate / remove -------------------------------------------------------


async def test_deactivate_and_reactivate(client, team, revoked):
    ws, alice, bob, carol = _ws(team), team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, kind="private", members=("bob",))
    dm = (await client.post(f"/workspaces/{ws}/dms", json={"user_ids": [bob["id"]]}, headers=alice["headers"])).json()
    await client.post(f"/channels/{ch['id']}/messages", json={"body": "hi"}, headers=bob["headers"])

    # Members can't deactivate people.
    assert (await client.post(f"/workspaces/{ws}/members/{bob['id']}/deactivate", headers=carol["headers"])).status_code == 403
    r = await client.post(f"/workspaces/{ws}/members/{bob['id']}/deactivate", headers=alice["headers"])
    assert r.status_code == 204
    assert bob["id"] in [t for t, _ in revoked.events]

    # Locked out of every workspace route; channels 404.
    r = await client.get(f"/workspaces/{ws}/channels", headers=bob["headers"])
    assert r.status_code == 403 and r.json()["detail"] == "account_deactivated"
    assert (await client.get(f"/channels/{ch['id']}/messages", headers=bob["headers"])).status_code == 404
    assert (await client.get(f"/channels/{team['general']['id']}", headers=bob["headers"])).status_code == 404
    assert ws not in {w["id"] for w in (await client.get("/workspaces", headers=bob["headers"])).json()}
    # Not in the people directory, but listed (deactivated) for admins, and still shown in DMs.
    assert bob["id"] not in {m["user_id"] for m in (await client.get(f"/workspaces/{ws}/members", headers=alice["headers"])).json()}
    listed = (await client.get(f"/workspaces/{ws}/admin/members", params={"status": "deactivated"}, headers=alice["headers"])).json()
    assert [m["user_id"] for m in listed] == [bob["id"]] and listed[0]["last_active_at"] is not None
    dms = {c["id"]: c for c in (await client.get(f"/workspaces/{ws}/channels", headers=alice["headers"])).json()}
    assert bob["id"] in dms[dm["id"]]["member_ids"]
    # Can't be re-added directly while deactivated.
    r = await client.post(f"/workspaces/{ws}/members", json={"email": bob["email"]}, headers=alice["headers"])
    assert r.status_code == 409

    r = await client.post(f"/workspaces/{ws}/members/{bob['id']}/reactivate", headers=alice["headers"])
    assert r.status_code == 204
    assert (await client.get(f"/channels/{ch['id']}/messages", headers=bob["headers"])).status_code == 200
    mine = {c["id"] for c in (await client.get(f"/workspaces/{ws}/channels", headers=bob["headers"])).json() if c["is_member"]}
    assert {ch["id"], dm["id"], team["general"]["id"]} <= mine
    assert (await client.post(f"/workspaces/{ws}/members/{bob['id']}/reactivate", headers=alice["headers"])).status_code == 404
    actions = [e["action"] for e in await _audit(client, team, action="member.")]
    assert actions[:2] == ["member.reactivated", "member.deactivated"]


async def test_admin_cannot_deactivate_admin(client, team, revoked):
    ws = _ws(team)
    assert (await _role(client, team, "bob", "admin")).status_code == 200
    assert (await _role(client, team, "carol", "admin")).status_code == 200
    r = await client.post(f"/workspaces/{ws}/members/{team['carol']['id']}/deactivate", headers=team["bob"]["headers"])
    assert r.status_code == 403
    r = await client.post(f"/workspaces/{ws}/members/{team['carol']['id']}/deactivate", headers=team["alice"]["headers"])
    assert r.status_code == 204
    # Reactivating an admin needs an owner too.
    r = await client.post(f"/workspaces/{ws}/members/{team['carol']['id']}/reactivate", headers=team["bob"]["headers"])
    assert r.status_code == 403


async def test_remove_member(client, team, revoked):
    ws, alice, bob, carol = _ws(team), team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, members=("bob",))
    group = await client.post(f"/workspaces/{ws}/groups", json={"handle": f"g{uuid.uuid4().hex[:6]}", "name": "G", "member_ids": [bob["id"]]}, headers=alice["headers"])
    assert group.status_code == 201
    assert (await client.delete(f"/workspaces/{ws}/members/{bob['id']}", headers=carol["headers"])).status_code == 403
    assert (await client.delete(f"/workspaces/{ws}/members/{bob['id']}", headers=alice["headers"])).status_code == 204
    assert (await client.get(f"/workspaces/{ws}/channels", headers=bob["headers"])).status_code == 404
    groups = (await client.get(f"/workspaces/{ws}/groups", headers=alice["headers"])).json()
    assert all(bob["id"] not in g.get("member_ids", []) for g in groups)
    assert (await client.delete(f"/workspaces/{ws}/members/{bob['id']}", headers=alice["headers"])).status_code == 404
    # They can be added back fresh.
    assert (await client.post(f"/workspaces/{ws}/members", json={"email": bob["email"]}, headers=alice["headers"])).status_code == 201
    members = (await client.get(f"/channels/{ch['id']}/members", headers=alice["headers"])).json()
    assert bob["id"] not in members
    # Deactivated people can be removed too.
    assert (await client.post(f"/workspaces/{ws}/members/{carol['id']}/deactivate", headers=alice["headers"])).status_code == 204
    assert (await client.delete(f"/workspaces/{ws}/members/{carol['id']}", headers=alice["headers"])).status_code == 204
    r = await client.get(f"/workspaces/{ws}/admin/members", params={"status": "deactivated"}, headers=alice["headers"])
    assert r.json() == []


async def test_admin_member_list_filters(client, team):
    ws, alice = _ws(team), team["alice"]
    assert (await client.get(f"/workspaces/{ws}/admin/members", headers=team["bob"]["headers"])).status_code == 403
    r = await client.get(f"/workspaces/{ws}/admin/members", params={"q": "car"}, headers=alice["headers"])
    assert [m["full_name"] for m in r.json()] == ["carol"]
    r = await client.get(f"/workspaces/{ws}/admin/members", params={"role": "owner"}, headers=alice["headers"])
    assert [m["user_id"] for m in r.json()] == [alice["id"]]
    assert r.json()[0]["email"] == alice["email"]


# --- Invite links ---------------------------------------------------------------------------


async def test_invite_link_lifecycle(client, team):
    ws, alice = _ws(team), team["alice"]
    pub = await _channel(client, team)
    r = await client.post(f"/workspaces/{ws}/invite-links", json={"max_uses": 1, "channel_ids": [pub["id"]]}, headers=alice["headers"])
    assert r.status_code == 201, r.text
    link = r.json()
    assert link["role"] == "member" and link["valid"] and link["uses"] == 0 and link["expires_at"]

    preview = (await client.get(f"/invites/{link['token']}")).json()  # no auth
    assert preview == {
        "workspace_name": "Acme",
        "workspace_icon_url": None,
        "inviter_name": "alice",
        "role": "member",
        "valid": True,
        "reason": None,
    }
    assert (await client.get("/invites/nope")).status_code == 404
    dave, erin = await register(client, "dave"), await register(client, "erin")
    assert (await client.post(f"/invites/{link['token']}/accept")).status_code == 401
    r = await client.post(f"/invites/{link['token']}/accept", headers=dave["headers"])
    assert r.status_code == 200 and r.json()["workspace_id"] == ws
    mine = {c["id"] for c in (await client.get(f"/workspaces/{ws}/channels", headers=dave["headers"])).json() if c["is_member"]}
    assert {team["general"]["id"], pub["id"]} <= mine
    # Accepting again is a no-op for members.
    r = await client.post(f"/invites/{link['token']}/accept", headers=dave["headers"])
    assert r.status_code == 200 and r.json()["already_member"] is True
    # Used up.
    r = await client.post(f"/invites/{link['token']}/accept", headers=erin["headers"])
    assert r.status_code == 410 and r.json()["detail"] == "invite_used_up"
    assert (await client.get(f"/invites/{link['token']}")).json()["reason"] == "used_up"

    # Expired.
    link2 = (await client.post(f"/workspaces/{ws}/invite-links", json={"expires_in_hours": None}, headers=alice["headers"])).json()
    assert link2["expires_at"] is None
    async with SessionLocal() as db:
        await db.execute(
            update(InviteLink).where(InviteLink.id == uuid.UUID(link2["id"])).values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await db.commit()
    r = await client.post(f"/invites/{link2['token']}/accept", headers=erin["headers"])
    assert r.status_code == 410 and r.json()["detail"] == "invite_expired"

    # Revoked.
    link3 = (await client.post(f"/workspaces/{ws}/invite-links", json={}, headers=alice["headers"])).json()
    assert (await client.delete(f"/invite-links/{link3['id']}", headers=team["bob"]["headers"])).status_code == 403
    assert (await client.delete(f"/invite-links/{link3['id']}", headers=alice["headers"])).status_code == 204
    r = await client.post(f"/invites/{link3['token']}/accept", headers=erin["headers"])
    assert r.status_code == 410 and r.json()["detail"] == "invite_revoked"

    listed = {l["id"]: l for l in (await client.get(f"/workspaces/{ws}/invite-links", headers=alice["headers"])).json()}
    assert listed[link3["id"]]["revoked"] and not listed[link3["id"]]["valid"]
    assert listed[link["id"]]["uses"] == 1
    actions = [e["action"] for e in await _audit(client, team)]
    assert {"invite_link.created", "invite_link.revoked", "member.joined_via_invite"} <= set(actions)


async def test_guest_invite_is_restricted_to_its_channels(client, team):
    ws, alice = _ws(team), team["alice"]
    pub, other = await _channel(client, team), await _channel(client, team)
    r = await client.post(f"/workspaces/{ws}/invite-links", json={"role": "guest"}, headers=alice["headers"])
    assert r.status_code == 422  # guests need channels
    guest = await _add_guest(client, team, [pub])
    listed = {c["id"] for c in (await client.get(f"/workspaces/{ws}/channels", headers=guest["headers"])).json()}
    assert listed == {pub["id"]}
    assert (await client.get(f"/channels/{other['id']}", headers=guest["headers"])).status_code == 404
    assert (await client.get(f"/channels/{team['general']['id']}", headers=guest["headers"])).status_code == 404
    # Guests never pass a policy.
    r = await client.post(f"/workspaces/{ws}/invite-links", json={}, headers=guest["headers"])
    assert r.status_code == 403
    s = (await client.get(f"/workspaces/{ws}/settings", headers=guest["headers"])).json()
    assert s["viewer_role"] == "guest" and not any(s["viewer_can"].values())


async def test_deactivated_user_cannot_accept_invite(client, team, revoked):
    ws, alice, bob = _ws(team), team["alice"], team["bob"]
    assert (await client.post(f"/workspaces/{ws}/members/{bob['id']}/deactivate", headers=alice["headers"])).status_code == 204
    link = (await client.post(f"/workspaces/{ws}/invite-links", json={}, headers=alice["headers"])).json()
    r = await client.post(f"/invites/{link['token']}/accept", headers=bob["headers"])
    assert r.status_code == 403 and r.json()["detail"] == "account_deactivated"


async def test_private_channel_invites_need_membership(client, team):
    ws = _ws(team)
    await _set_policies(client, team, invite_members="everyone")
    priv = await _channel(client, team, kind="private")
    r = await client.post(f"/workspaces/{ws}/invite-links", json={"channel_ids": [priv["id"]]}, headers=team["bob"]["headers"])
    assert r.status_code == 403
    # Members only see their own links.
    mine = (await client.post(f"/workspaces/{ws}/invite-links", json={}, headers=team["bob"]["headers"])).json()
    await client.post(f"/workspaces/{ws}/invite-links", json={}, headers=team["alice"]["headers"])
    listed = (await client.get(f"/workspaces/{ws}/invite-links", headers=team["bob"]["headers"])).json()
    assert [l["id"] for l in listed] == [mine["id"]]
    assert (await client.delete(f"/invite-links/{mine['id']}", headers=team["bob"]["headers"])).status_code == 204


# --- Channel managers, rename, archive ------------------------------------------------------


async def test_channel_managers_and_rename(client, team):
    alice, bob, carol = team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, "bob", members=("carol",))
    roles =(await client.get(f"/channels/{ch['id']}/roles", headers=bob["headers"])).json()
    assert roles["manager_ids"] == [bob["id"]] and roles["can_manage"] and roles["can_archive"]
    assert (await client.get(f"/channels/{ch['id']}/roles", headers=carol["headers"])).json()["can_manage"] is False

    # Topic: any member. Name: managers/admins only.
    assert (await client.patch(f"/channels/{ch['id']}", json={"topic": "t"}, headers=carol["headers"])).status_code == 200
    new = f"n-{uuid.uuid4().hex[:6]}"
    assert (await client.patch(f"/channels/{ch['id']}", json={"name": new}, headers=carol["headers"])).status_code == 403
    r = await client.patch(f"/channels/{ch['id']}", json={"name": new}, headers=bob["headers"])
    assert r.status_code == 200 and r.json()["name"] == new and r.json()["topic"] == "t"
    other = await _channel(client, team)
    assert (await client.patch(f"/channels/{ch['id']}", json={"name": other["name"]}, headers=bob["headers"])).status_code == 409
    assert (await client.patch(f"/channels/{ch['id']}", json={"name": "Bad Name"}, headers=bob["headers"])).status_code == 422
    gen = team["general"]["id"]
    assert (await client.patch(f"/channels/{gen}", json={"name": "lobby"}, headers=alice["headers"])).status_code == 400

    # Promote carol; she can now remove people (but not admins, nor herself via this route).
    r = await client.patch(f"/channels/{ch['id']}/members/{carol['id']}", json={"role": "manager"}, headers=carol["headers"])
    assert r.status_code == 403
    assert (await client.patch(f"/channels/{ch['id']}/members/{carol['id']}", json={"role": "manager"}, headers=bob["headers"])).status_code == 204
    await client.post(f"/channels/{ch['id']}/join", headers=alice["headers"])
    assert (await client.delete(f"/channels/{ch['id']}/members/{alice['id']}", headers=carol["headers"])).status_code == 403
    assert (await client.delete(f"/channels/{ch['id']}/members/{carol['id']}", headers=carol["headers"])).status_code == 400
    assert (await client.delete(f"/channels/{ch['id']}/members/{bob['id']}", headers=carol["headers"])).status_code == 204
    assert bob["id"] not in (await client.get(f"/channels/{ch['id']}/members", headers=alice["headers"])).json()
    # Workspace admins can manage any channel they can see.
    assert (await client.delete(f"/channels/{ch['id']}/members/{carol['id']}", headers=alice["headers"])).status_code == 204
    # Leaving yourself still works through /members/me.
    assert (await client.delete(f"/channels/{ch['id']}/members/me", headers=alice["headers"])).status_code == 204

    audit = [e["action"] for e in await _audit(client, team, action="channel.")]
    assert {"channel.renamed", "channel.member_role_changed", "channel.member_removed"} <= set(audit)


async def test_channel_payload_carries_my_role(client, team):
    bob, carol = team["bob"], team["carol"]
    ch = await _channel(client, team, "bob", members=("carol",))
    assert ch["my_role"] == "manager"

    def mine(listing):
        return next(c for c in listing if c["id"] == ch["id"])["my_role"]

    listed = (await client.get(f"/workspaces/{_ws(team)}/channels", headers=carol["headers"])).json()
    assert mine(listed) == "member"
    assert (await client.get(f"/channels/{ch['id']}", headers=bob["headers"])).json()["my_role"] == "manager"
    await client.patch(f"/channels/{ch['id']}/members/{carol['id']}", json={"role": "manager"}, headers=bob["headers"])
    listed = (await client.get(f"/workspaces/{_ws(team)}/channels", headers=carol["headers"])).json()
    assert mine(listed) == "manager"
    # Not a member: no channel role.
    alice_view = (await client.get(f"/channels/{ch['id']}", headers=team["alice"]["headers"])).json()
    assert alice_view["my_role"] is None and alice_view["is_member"] is False


async def test_ai_policy_helpers_share_admin_policies(client, team):
    from app.ai import workspace as ai_ws

    ws_id = uuid.UUID(_ws(team))
    bob_id = uuid.UUID(team["bob"]["id"])
    async with SessionLocal() as db:
        # Defaults come from app.admin (install_apps/use_ai: everyone; invite_members: admins).
        assert await ai_ws.policy_allows(db, ws_id, bob_id, "use_ai")
        assert not await ai_ws.policy_allows(db, ws_id, bob_id, "invite_members")
    await _set_policies(client, team, use_ai="admins")
    async with SessionLocal() as db:
        assert await ai_ws.policy_value(db, ws_id, "use_ai") == "admins"
        with pytest.raises(HTTPException) as exc:
            await ai_ws.require_policy(db, ws_id, bob_id, "use_ai")
        assert exc.value.status_code == 403 and exc.value.detail == "policy:use_ai"
        assert await ai_ws.policy_allows(db, ws_id, uuid.UUID(team["alice"]["id"]), "use_ai")


async def test_guests_cannot_be_channel_managers(client, team):
    ch = await _channel(client, team)
    guest = await _add_guest(client, team, [ch])
    r = await client.patch(f"/channels/{ch['id']}/members/{guest['id']}", json={"role": "manager"}, headers=team["alice"]["headers"])
    assert r.status_code == 400


async def test_archive_and_unarchive(client, team):
    ws, alice, bob, carol = _ws(team), team["alice"], team["bob"], team["carol"]
    ch = await _channel(client, team, "bob", members=("carol",))
    assert (await client.post(f"/channels/{ch['id']}/archive", headers=carol["headers"])).status_code == 403
    r = await client.post(f"/channels/{ch['id']}/archive", headers=bob["headers"])
    assert r.status_code == 200 and r.json()["is_archived"] is True
    assert (await client.post(f"/channels/{ch['id']}/messages", json={"body": "x"}, headers=bob["headers"])).status_code == 403
    r = await client.post(f"/channels/{ch['id']}/unarchive", headers=bob["headers"])
    assert r.status_code == 200 and r.json()["is_archived"] is False
    assert (await client.post(f"/channels/{ch['id']}/messages", json={"body": "x"}, headers=bob["headers"])).status_code == 201

    await _set_policies(client, team, archive_channels="admins")
    r = await client.post(f"/channels/{ch['id']}/archive", headers=bob["headers"])
    assert r.status_code == 403 and r.json()["detail"] == "policy:archive_channels"
    assert (await client.get(f"/channels/{ch['id']}/roles", headers=bob["headers"])).json()["can_archive"] is False
    await client.post(f"/channels/{ch['id']}/join", headers=alice["headers"])
    assert (await client.post(f"/channels/{ch['id']}/archive", headers=alice["headers"])).status_code == 200
    gen = team["general"]["id"]
    assert (await client.post(f"/channels/{gen}/archive", headers=alice["headers"])).status_code == 400
    dm = (await client.post(f"/workspaces/{ws}/dms", json={"user_ids": [bob["id"]]}, headers=alice["headers"])).json()
    assert (await client.post(f"/channels/{dm['id']}/archive", headers=alice["headers"])).status_code == 400
    actions = [e["action"] for e in await _audit(client, team, action="channel.")]
    assert actions.count("channel.archived") == 2 and actions.count("channel.unarchived") == 1


async def test_creator_of_new_workspace_manages_general(client):
    owner = await register(client, "owner")
    ws = (await client.post("/workspaces", json={"name": "W", "slug": f"w-{uuid.uuid4().hex[:6]}"}, headers=owner["headers"])).json()
    general = next(c for c in (await client.get(f"/workspaces/{ws['id']}/channels", headers=owner["headers"])).json() if c["name"] == "general")
    roles = (await client.get(f"/channels/{general['id']}/roles", headers=owner["headers"])).json()
    assert owner["id"] in roles["manager_ids"] and roles["can_archive"] is False


# --- Audit log ------------------------------------------------------------------------------


async def test_audit_log_pagination_and_access(client, team):
    ws = _ws(team)
    for i in range(5):
        await client.patch(f"/workspaces/{ws}/settings", json={"description": f"d{i}"}, headers=team["alice"]["headers"])
    assert (await client.get(f"/workspaces/{ws}/audit-log", headers=team["bob"]["headers"])).status_code == 403
    page1 = (await client.get(f"/workspaces/{ws}/audit-log", params={"limit": 3}, headers=team["alice"]["headers"])).json()
    assert len(page1["items"]) == 3 and page1["next_cursor"]
    assert page1["items"][0]["actor_name"] == "alice"
    assert page1["items"][0]["meta"]["changes"]["description"]["to"] == "d4"
    page2 = (
        await client.get(f"/workspaces/{ws}/audit-log", params={"limit": 3, "cursor": page1["next_cursor"]}, headers=team["alice"]["headers"])
    ).json()
    ids1, ids2 = {e["id"] for e in page1["items"]}, {e["id"] for e in page2["items"]}
    assert ids2 and not ids1 & ids2
    assert (await client.get(f"/workspaces/{ws}/audit-log", params={"cursor": "!!"}, headers=team["alice"]["headers"])).status_code == 400
    async with SessionLocal() as db:
        n = await db.scalar(select(AuditEvent.id).where(AuditEvent.workspace_id == uuid.UUID(ws)).limit(1))
        assert n is not None
        assert (await db.get(Workspace, uuid.UUID(ws))).description == "d4"
