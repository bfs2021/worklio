## What and why

<!-- What does this PR change, and why? Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands run, and the live test you did (which flows, with two accounts where relevant). -->

## Screenshots

<!-- For UI changes: before/after, light and dark mode. Remove personal data. -->

## Checklist

- [ ] The PR does one thing; the title follows Conventional Commits (`feat: …`, `fix: …`).
- [ ] Backend: `ruff check app tests` and `make test` pass; new endpoints have tests, including tenant isolation (non-member gets 404).
- [ ] Migrations: generated file reviewed; `alembic heads` shows a single head.
- [ ] Frontend: `npx tsc --noEmit`, `npm run lint` and `npm run build` pass.
- [ ] Live-tested with two accounts where relevant; checked dark mode and a 360 px wide window; keyboard accessible.
- [ ] Docs updated where needed (README, docs/CONFIGURATION.md, `.env.example`, CHANGELOG "Unreleased").
- [ ] No secrets, real keys or personal data in code, tests, screenshots or logs.
