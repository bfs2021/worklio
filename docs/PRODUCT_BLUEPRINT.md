# Worklio — Product Blueprint

> What's next: [ROADMAP.md](ROADMAP.md) · How to help: [CONTRIBUTING.md](../CONTRIBUTING.md)

Worklio is a team communication platform: Slack-class messaging, calls and collaboration, with AI built in from the start rather than bolted on. This document is the source of truth for what we build and in what order. Each wave ships only after it passes automated checks **and** a live two-account browser test.

Status legend: ✅ shipped & live-tested · 🟡 shipped, partially tested · ⏳ planned

---

## 1. Messaging core
| Feature | Status |
|---|---|
| Channels (public/private), DMs, group DMs, threads, reactions, edit/delete, typing, presence | ✅ |
| Rich text (bold/italic/strike/code/blocks/quotes/links), @mentions, emoji picker, jumbo emoji | ✅ |
| File uploads, voice messages, video clips, screen recordings | 🟡 |
| Drafts per channel, Up-arrow edit, unread divider, jump-to-message, search | ✅ |
| **Pinned messages & channel bookmarks bar** | ⏳ A2 |
| **Forward / share message, copy link, permalinks** | ⏳ A2 |
| **Scheduled send** ("Send tomorrow 9:00") | ⏳ A2 |
| **Polls** (single/multi choice, anonymous option, live results) | ✅ |
| **Slash commands**: /remind /poll /dnd /mute /status /away /shrug /giphy-free /topic /invite /leave /ai | ⏳ A2 |
| **Link unfurls** (OpenGraph preview, SSRF-safe server fetch) | ⏳ A2 |
| **@here / @channel / @everyone, user groups (@design)** | ⏳ A2 |
| **Edit history, "seen by" read receipts in DMs** | ⏳ A2 |
| **Code snippets with syntax highlighting** | ⏳ A2 |
| Custom emoji upload | ⏳ D |
| Advanced search filters (from: in: has: before: after:, saved searches) | ⏳ A2 |

## 2. Navigation & personal productivity
| Feature | Status |
|---|---|
| Workspace rail, ⌘K switcher, multi-workspace | ✅ |
| **Threads inbox** (all threads you follow, unread first, reply inline) | 🟡 |
| **Activity v2** (mentions, reactions to you, thread replies, invites; tabs; unread) | ⏳ A1 |
| **Later / To-do** (save message, to-dos with due dates, reminders, In progress/Completed/Archived) | ✅ |
| **Reminders** ("remind me in 20 min / tomorrow"), delivered as notification + Worklio bot DM | ✅ |
| **Drafts & sent** | ⏳ A1 |
| **Huddles history** (past calls, duration, people, notes, recordings) | ⏳ A1 |
| **Files browser** (all workspace files, type/person filters, search) | ✅ |
| **Directories** (people with status/title/local time; channels with join) | ⏳ A1 |
| **Unreads view** with mark-all-read | ⏳ A1 |
| **Sidebar customisation**: show/hide workspace switcher (auto-hide with one workspace), custom sections, drag channels, starred, hide nav items, compact mode | ⏳ A1 |
| **Per-channel notification prefs & mute, DND / notification schedule** | ⏳ A1 |

## 3. Calls & meetings
| Feature | Status |
|---|---|
| Ringing audio/video calls (incoming modal, ringtone, missed/declined/cancelled) | ✅ |
| Call cards in chat, live state, duration | ✅ |
| Meeting window: grid, stage switcher (Video/Whiteboard/Board/Screen), "Bring everyone" | ✅ |
| Sidebar huddle dock | 🟡 (fix overflow) |
| Screen share + annotation (pen, arrow, shapes, laser) | 🟡 |
| Call notes → thread, in-call chat, raise hand, reactions | 🟡 |
| **Live captions & transcript** (AI) | ⏳ B |
| **AI meeting summary + action items → Board cards** | ⏳ B |
| **Huddle notifications**: "X started a huddle" banner + chime + desktop notification for channel members (respects mute/DND/notify level), join/leave knock sounds, sidebar live badge | ✅ |
| Web push for calls/huddles when the browser is closed | ⏳ pulled forward to A.5/D |
| Huddle recording (LiveKit egress → Files) | ⏳ D |
| Scheduled meetings & calendar (ICS invite) | ⏳ D |

## 4. Collaboration surfaces
| Feature | Status |
|---|---|
| Whiteboard (Excalidraw, live multi-cursor, persisted, in calls) | ✅ |
| Camera effects: background blur, virtual backgrounds, pre-join camera check | ✅ (blur live-tested) |
| Canvas (TipTap docs, autosave, conflict handling, templates) | 🟡 |
| **Canvas v2**: live co-editing (Yjs CRDT over our WebSocket), slash menu, tables, images, @mentions, comments, Canvases list | ⏳ C |
| Board (Kanban, DnD, assignees, due dates, labels) | 🟡 |
| **Lists v2**: table view, custom fields (status, priority, people, date, number, select), subtasks, card comments, column drag, sort/group/filter | ⏳ C |
| Clips: screen + camera bubble recording with drawing, trim | 🟡 |

## 5. Worklio AI (built in, permission-aware)
All AI respects channel access: Claude retrieves context only through tools that call Worklio's existing permission-checked search, so it can never surface a message the asking user can't read. Model: `claude-opus-5-5` (configurable via `AI_MODEL`), with effort tuned per feature (low for rewrites/translation, medium for Ask/summaries/agent) and server-side refusal fallbacks. Tool-based retrieval was chosen over a vector index for v1 (always fresh, no embedding infra, permission-safe by construction); pgvector embeddings can be added later to improve recall. Live captions use the browser's built-in speech recognition (no extra key). AI is off until `ANTHROPIC_API_KEY` is set; the UI explains how to enable it.
| Feature | Wave |
|---|---|
| **Ask Worklio** — Q&A over your workspace with cited sources (RAG on pgvector) | B |
| **Catch me up** — channel / thread / unread digest summaries | B |
| **Composer assistant** — rewrite (shorter, clearer, friendlier, formal), fix grammar, translate | B |
| **Smart search** — semantic + keyword hybrid | B |
| **Huddle AI** — captions, transcript, summary, action items → To-do/Board | B |
| **Task extraction** — "turn this thread into tasks" | B |
| **@worklio agent** in channels (answers, summarises, creates reminders/cards via tools) | B |
| Message translation on demand | B |

## 6. Workspace admin & trust
| Feature | Wave |
|---|---|
| Workspace settings (name, icon, URL, invite links, allowed email domains) | D |
| Member management (roles, deactivate, guests), channel management | D |
| Email invitations (Celery + SMTP; Mailpit locally) | D |
| Audit log, data export, retention policies | D |
| SSO/SAML, SCIM | later |
| Billing (Stripe), plans & usage limits | later (Phase 4) |

## 7. Platform
| Feature | Wave |
|---|---|
| Web push notifications (service worker + VAPID) and email digests | D |
| Installable PWA, offline shell | D |
| Desktop app (Tauri) — native screen annotation overlay, global shortcuts | later |
| Mobile apps (React Native) | later |
| Incoming/outgoing webhooks, bot tokens, app framework | later |
| i18n | later |

## 8. Quality bar (applies to every wave)
- Live two-account browser test of every user-facing flow before a wave is called done.
- Backend: pytest for every endpoint incl. tenant isolation; ruff; Alembic in sync.
- Frontend: strict TypeScript, React Compiler lint clean, no hydration warnings, dark mode, 360 px mobile, keyboard & screen-reader accessible.
- Wave E: Playwright end-to-end suite, virtualised message list for performance, Lighthouse/accessibility pass.

---

## Delivery waves
| Wave | Scope |
|---|---|
| **A1** | Fixes from live tests + Navigation & productivity (section 2) |
| **A2** | Messaging core additions (section 1) |
| **B** | Worklio AI (section 5) + live captions |
| **C** | Canvas v2 (Yjs) + Lists v2 |
| **D** | Admin, invitations, notifications, PWA, recordings, calendar |
| **E** | E2E tests, performance, accessibility, full QA fleet, release |
