"""Seed a fictional "Worklio" demo workspace (used for the README screenshots).

Local development only. Creates five demo people with random passwords, a "Worklio" workspace,
channels, threads, reactions, a poll, a pinned message, a launch board and a DM, then writes the
IDs and demo logins to the JSON file you pass:

    python3 scripts/seed_demo.py /tmp/worklio-demo.json

The API must be running on http://localhost:8000 (`make up`).
"""
import json, secrets, sys, urllib.error, urllib.request

API = "http://localhost:8000"
OUT = sys.argv[1]


def call(path, body=None, tok=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{path}: {e.code} {e.read()[:300]!r}")


tag = secrets.token_hex(2)
people = {
    "maya": ("Maya Chen", "Head of Product", "🎯", "Launch week"),
    "leo": ("Leo Okafor", "Engineering Lead", "💻", "Shipping onboarding"),
    "sara": ("Sara Lindqvist", "Product Designer", "🎨", "In design reviews"),
    "diego": ("Diego Alvarez", "Developer Advocate", "📝", "Writing release notes"),
    "priya": ("Priya Nair", "Operations", "🌍", "Planning the offsite"),
}
U = {}
for key, (name, title, emoji, status) in people.items():
    email = f"{key}.{tag}@example.com"
    pw = secrets.token_urlsafe(14)
    tok = call("/auth/register", {"email": email, "full_name": name, "password": pw})["access_token"]
    me = call("/auth/me", tok=tok)
    call("/auth/me", {"title": title}, tok, "PATCH")
    call("/auth/me/status", {"emoji": emoji, "text": status}, tok, "PUT")
    U[key] = {"tok": tok, "id": me["id"], "email": email, "password": pw}

maya = U["maya"]["tok"]
ws = call("/workspaces", {"name": "Worklio"}, maya)
W = ws["id"]
for key in ("leo", "sara", "diego", "priya"):
    call(f"/workspaces/{W}/members", {"email": U[key]["email"]}, maya)

chans = {c["name"]: c for c in call(f"/workspaces/{W}/channels", tok=maya)}
general = chans["general"]["id"]
call(f"/channels/{general}", {"topic": "Company-wide announcements and work-based matters"}, maya, "PATCH")


def channel(name, topic, owner="maya"):
    c = call(f"/workspaces/{W}/channels", {"name": name, "topic": topic}, U[owner]["tok"])
    for k in U:
        if k != owner:
            call(f"/channels/{c['id']}/join", {}, U[k]["tok"])
    return c["id"]


eng = channel("engineering", "Builds, releases and incidents", "leo")
design = channel("design", "Critiques, mockups and the design system", "sara")
launch = channel("launch", "Everything for the v1 launch", "maya")
for cid in (general,):
    for k in U:
        call(f"/channels/{cid}/join", {}, U[k]["tok"])


def post(cid, who, body, parent=None):
    payload = {"body": body}
    if parent:
        payload["parent_id"] = parent
    return call(f"/channels/{cid}/messages", payload, U[who]["tok"])["id"]


def react(mid, who, emoji):
    call(f"/messages/{mid}/reactions", {"emoji": emoji}, U[who]["tok"])


m = post(general, "maya", "Welcome to *Worklio* 👋 This is where the team talks. Say hi and share what you're working on this week!")
for who, e in (("leo", "👋"), ("sara", "👋"), ("priya", "🎉"), ("diego", "🎉")):
    react(m, who, e)
m = post(general, "leo", f"Morning all! The new onboarding flow ships today 🚀 Huge thanks to <@{U['sara']['id']}> for the designs.")
react(m, "maya", "🚀"); react(m, "sara", "❤️"); react(m, "priya", "🚀")
post(general, "sara", "Thanks Leo! Walkthrough recording is in the thread 👇", m)
post(general, "diego", "Looks great. I'll add it to the release notes.", m)
post(general, "maya", "Love it. Let's demo it at Friday's all-hands.", m)
call(f"/channels/{general}/polls", {"question": "Where should we hold the Q1 offsite?", "options": ["Lisbon 🇵🇹", "Kyoto 🇯🇵", "Cape Town 🇿🇦"]}, U["priya"]["tok"])
poll = next(x for x in call(f"/channels/{general}/messages?limit=20", tok=maya) if x.get("poll"))["poll"]
for who, i in (("leo", 0), ("sara", 1), ("diego", 0), ("priya", 0)):
    call(f"/polls/{poll['id']}/vote", {"option_ids": [poll["options"][i]["id"]]}, U[who]["tok"])
notes = post(general, "diego", "📝 Release notes for v0.1 are ready for review. Please leave comments by Thursday.")
call(f"/messages/{notes}/pin", {}, maya)

post(eng, "leo", "Deploying `api` v0.1.4 to staging now. Changes:\n```\n- rotating refresh tokens\n- cursor pagination for history\n- workspace icons in the rail\n```")
m = post(eng, "diego", "Staging looks healthy ✅ p95 latency is down to 82 ms.")
react(m, "leo", "✅"); react(m, "maya", "🙌")
post(eng, "leo", "Nice. Promoting to production after lunch.", m)

post(design, "sara", "New dashboard mockups are up. Feedback welcome on the empty states especially 🎨")
m = post(design, "maya", "The onboarding checklist feels really clear now. Can we try a warmer illustration style?")
react(m, "sara", "👍")
post(design, "sara", "Yes! I'll share two directions tomorrow.", m)

post(launch, "maya", "Launch checklist lives on the *Board* tab. Grab a card and assign yourself 🙏")
post(launch, "priya", "Press kit and FAQ are drafted. Waiting on final screenshots.")

board = call(f"/channels/{launch}/board", tok=maya)
cols = board["columns"]
if not cols:
    cols = [call(f"/channels/{launch}/board/columns", {"name": t}, maya) for t in ("To do", "In progress", "Done")]
col = {c["name"]: c["id"] for c in cols}
names = list(col)
cards = [
    (names[0], "Final README screenshots", "diego"),
    (names[0], "Launch blog post", "priya"),
    (names[min(1, len(names) - 1)], "Onboarding flow QA", "leo"),
    (names[min(1, len(names) - 1)], "Dashboard empty states", "sara"),
    (names[-1], "Pricing page copy", "maya"),
]
extra = {
    "Final README screenshots": {"priority": "high", "labels": ["docs"]},
    "Launch blog post": {"priority": "medium", "labels": ["marketing"], "cover_color": "pink"},
    "Onboarding flow QA": {"priority": "urgent", "labels": ["engineering"]},
    "Dashboard empty states": {"priority": "medium", "labels": ["design"], "cover_color": "purple"},
    "Pricing page copy": {"priority": "low", "labels": ["marketing"]},
}
for column, title, who in cards:
    card = call(f"/channels/{launch}/board/cards", {"column_id": col[column], "title": title, "assignee_id": U[who]["id"]}, maya)
    call(f"/board/cards/{card['id']}", extra[title], maya, "PATCH")

dm = call(f"/workspaces/{W}/dms", {"user_ids": [U["leo"]["id"]]}, maya)["id"]
post(dm, "maya", "Hey Leo, do you have 10 minutes for a quick huddle about the launch timeline?")
post(dm, "leo", "Sure, give me 5 and I'll ring you 📞")

# Maya has read everything so far; newer posts by others show as unread in her sidebar.
for cid in (general, eng, design, launch, dm):
    call(f"/channels/{cid}/read", {}, maya)
post(design, "sara", "Two illustration directions are in the canvas ✨")
post(eng, "leo", "Production deploy done 🎉")

json.dump({"ws": W, "general": general, "eng": eng, "design": design, "launch": launch, "dm": dm, "users": U}, open(OUT, "w"))
print("Demo workspace ready:", W)
