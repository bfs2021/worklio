# Worklio web app (frontend)

Next.js 16 (App Router) with React 19, TypeScript, Tailwind CSS v4 and shadcn/ui on Base UI.
Rich text and docs use TipTap v3 with Yjs, the whiteboard uses Excalidraw, and calls use
`livekit-client` and `@livekit/components-react`.

> This uses Next.js 16, which differs from older versions. Read [AGENTS.md](AGENTS.md) and the
> guides in `node_modules/next/dist/docs/` before relying on older Next.js habits.

## Run

The web app needs the backend running (see the root [README](../README.md): `make up`).

```bash
npm install
npm run dev        # http://localhost:3000
```

By default the app talks to `http://localhost:8000` and `ws://localhost:8000`. To change that:

```bash
cp .env.example .env.local
# edit NEXT_PUBLIC_API_URL and NEXT_PUBLIC_WS_URL
```

`NEXT_PUBLIC_*` values are inlined at build time, so rebuild after changing them.

## Checks

```bash
npx tsc --noEmit   # strict type-check
npm run lint       # ESLint (eslint-config-next, incl. React Hooks / React Compiler rules)
npm run build      # production build; catches Suspense and prerender errors
npm run start      # serve the production build
```

All three must pass before a pull request. There is no unit or e2e test runner yet; test flows in
the browser with two accounts (see
[CONTRIBUTING.md](../CONTRIBUTING.md#testing-with-two-accounts-in-one-browser)).

## Layout

```
src/
  app/                       routes
    layout.tsx               fonts, AppearanceScript (pre-paint), AppearanceProvider
    login/, new/, invite/[token]/
    w/[workspaceId]/         workspace shell (layout.tsx) and views:
                             c/[channelId], activity, threads, unreads, drafts, later, files,
                             directory, huddles, canvas, settings
  components/
    ui/                      shadcn/ui primitives on Base UI
    workspace/               WorkspaceProvider (state + event bus), shell, sidebar, rail, switcher
    chat/                    message list and item, composer, thread and search panels, avatars
    messaging/               pins, bookmarks, polls, forward, slash commands, read receipts
    calls/, huddle/          ringing calls, huddle provider, call window, pre-join
    canvas/                  TipTap editor, Yjs provider, comments, templates
    whiteboard/              Excalidraw board and live sync
    board/                   Kanban and table views, fields, subtasks, comments
    ai/                      Ask Worklio, catch-up, summaries, composer assistant, captions
    admin/                   workspace settings tabs (members, permissions, AI, audit, invites)
    recording/, voice/, annotate/, effects/   clips, voice messages, annotation, camera effects
    preferences/, profile/, views/            appearance dialog, profile, shared view helpers
  hooks/
    use-realtime.ts          one reconnecting WebSocket per tab, auth frame, heartbeat, resync
    use-message-jump.ts      jump to a message in history
  lib/
    api.ts                   typed API client, token storage, realtime event types
    messages.ts              pure reducers applying realtime events to message lists
    appearance.ts            themes, fonts, tokens and the pre-paint script
    toast.ts, drafts.ts, …   small external stores and helpers
```

Import with the `@/` alias (`@/components/...`, `@/lib/...`).

## Conventions

- **Server and client components.** Pages are thin server components. Interactive views are
  client components (`"use client"`). Wrap views that use `useSearchParams` or other
  request-time hooks in `<Suspense>` (required by `cacheComponents: true`).
- **Base UI, not Radix.** Compose triggers with `render={<Button … />}`, not `asChild`. Put
  `DropdownMenuLabel` inside `DropdownMenuGroup`. Do not nest buttons.
- **Realtime.** Subscribe to workspace events with `useWorkspaceEvents` from
  `components/workspace/provider.tsx`. Handle `resync` by refetching. Keep event reducers pure.
- **External stores.** With `useSyncExternalStore`, `getSnapshot` and `getServerSnapshot` must
  return stable references (see `lib/toast.ts`).
- **No hydration warnings.** Render defaults until hydrated when a value only exists in the browser.
- **Styling.** Tailwind v4 with theme tokens defined as CSS variables in `src/app/globals.css` and
  `lib/appearance.ts`. Check every change in light and dark mode and at 360 px wide.
- **Accessibility.** Every control must work with a keyboard and have an accessible name.

More pitfalls and their fixes: [docs/LESSONS_LEARNED.md](../docs/LESSONS_LEARNED.md).
