# Worklio API (backend)

FastAPI + async SQLAlchemy 2 + Alembic, with Redis for realtime and Celery for background jobs.
For the big picture read [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md); for settings read
[docs/CONFIGURATION.md](../docs/CONFIGURATION.md).

## Running with Docker (recommended)

From the repository root:

```bash
cp .env.example .env
make up          # postgres, redis, s3, api, worker, beat, livekit
make logs        # tail api + worker
```

The `api` container mounts `backend/` and runs uvicorn with `--reload`, so code changes apply
immediately. It runs `alembic upgrade head` on every start. After changing Celery tasks, restart
the worker and beat: `docker compose restart worker beat`.

## Running outside Docker

Useful for debugging with an IDE. Keep the infrastructure in Docker and run the API on your host.

```bash
docker compose up -d postgres redis s3 livekit
cd backend
python3.13 -m venv .venv && source .venv/bin/activate   # Python 3.12+ works
pip install -e ".[dev]"
```

Settings are read from the environment and from a `.env` file in the **current directory**
(`backend/.env` when you run from `backend/`; it is git-ignored). Point them at the host ports:

```bash
DATABASE_URL=postgresql+asyncpg://worklio:worklio@localhost:5432/worklio
REDIS_URL=redis://localhost:6380/0
CELERY_BROKER_URL=redis://localhost:6380/1
S3_ENDPOINT_URL=http://localhost:8333
S3_PUBLIC_ENDPOINT_URL=http://localhost:8333
S3_ACCESS_KEY=worklio
S3_SECRET_KEY=worklio-secret
```

Then, from `backend/`:

```bash
alembic upgrade head
uvicorn app.main:app --reload --port 8000
celery -A app.workers.celery_app worker --loglevel=info
celery -A app.workers.celery_app beat --loglevel=info
```

Stop the `api`, `worker` and `beat` containers first if they are running, or they will compete
for port 8000 and for jobs.

## Tests

```bash
make test                                   # from the repo root: pytest -q inside the api container
docker compose exec api pytest -q tests/test_calls.py -k ring   # a subset
```

Tests run against the running stack's Postgres, Redis and S3 (they do not use a separate test
database), using httpx's `ASGITransport` against the app. Fixtures are in `tests/conftest.py`:
`client`, `register(client, name)` and `team` (a workspace owned by alice with bob and carol).
Every test creates its own users and workspaces with random suffixes, so tests do not depend on
each other. AI tests stub the provider; no real API key is needed.

Outside Docker, run `pytest -q` from `backend/` with the settings above. Make sure the S3 bucket
exists (the API creates it on start, or run
`python -c "from app.core import storage; storage.ensure_bucket()"`).

## Lint

```bash
docker compose exec api ruff check app tests
docker compose exec api ruff check app tests --fix
```

Line length is 100 (`pyproject.toml`).

## Migrations

```bash
make revision m="describe the change"   # autogenerate from models
make migrate                            # upgrade head
docker compose exec api alembic heads   # must print exactly one head
```

Review every generated migration. See [CONTRIBUTING.md](../CONTRIBUTING.md#database-migrations).

## Layout

```
app/
  main.py              app factory: lifespan (bucket, realtime hub, sweepers), body-size limits, CORS, routers
  core/                config, db session, redis, JWT and password hashing, rate limiting, S3 storage
  api/deps.py          current user + tenant isolation dependencies (use these everywhere)
  api/routes/          one module per area: auth, workspaces, channels, messages, uploads, users,
                       board, canvas, whiteboard, huddle, calls, productivity_*, messaging_extras,
                       ai, ai_agents, admin, invites, health
  models/              SQLAlchemy models (registered in models/__init__.py)
  schemas/, schemas_*.py   Pydantic request/response models
  realtime/            /ws endpoint (routes.py), Redis pub/sub hub (hub.py), huddle state (huddles.py)
  ai/                  providers, client, retrieval tools, agent, prompts, captions, key encryption
  workers/             Celery app with the beat schedule, tasks.py, ai_tasks.py
  admin.py             policies, audit log, member lifecycle
  calls.py             call lifecycle (ringing, accept/decline, timeouts, notes)
  canvas_collab.py     Yjs canvas access rules and persistence (pycrdt)
  messaging_extras.py  pins, forwards, polls, special mentions, scheduled sends, search filters,
                       SSRF-safe link unfurls
  productivity.py      threads inbox, activity feed, reminders, notifications, keyset pagination helpers
  services.py          batch serialisation of messages
alembic/versions/      migrations (single head)
tests/                 pytest suite
```

## Conventions

- **Tenant isolation:** scope every query through `api/deps.py` dependencies. Non-members get `404`.
- **Commit, then publish:** write to Postgres and commit before publishing realtime events
  (`publish_to_channel`, `publish_to_workspace`, `notify_user` in `realtime/hub.py`).
- **Policies and audit:** gate admin-controlled actions with `admin.require_policy` and record
  admin actions with `admin.record_audit`. Never log or store secrets in audit metadata.
- **Long or external work goes to Celery** (link fetches, AI agent runs, summaries).
- **New settings** go in `core/config.py` with a safe default, and in
  [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) and `.env.example`.
- **Tests for every endpoint**, including a non-member `404` test.
