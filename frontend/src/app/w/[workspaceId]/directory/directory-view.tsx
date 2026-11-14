"use client";

import { AtSign, BookUser, Clock, Hash, Loader2, Lock, MessageCircle, Pencil, Plus, Search, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ProfilePopover } from "@/components/chat/profile-popover";
import { UserAvatar } from "@/components/chat/user-avatar";
import { activeStatus, timeIn, useNow } from "@/components/profile/profile-utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useListNav } from "@/components/views/use-list-nav";
import { Chip, EmptyState, KeyHint, LoadingList, ViewHeader, ViewPage, ViewTabs } from "@/components/views/view-shell";
import { NewChannelDialog } from "@/components/workspace/dialogs";
import { useWorkspace } from "@/components/workspace/provider";
import { UserGroupsPanel } from "@/components/workspace/user-groups";
import { useUserGroups } from "@/components/messaging/use-groups";
import { api, type Channel, type Member } from "@/lib/api";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Tab = "people" | "channels" | "groups";
type PeopleFilter = "all" | "active" | "admins" | "guests";
type ChannelFilter = "all" | "joined" | "other";
type ChannelSort = "name" | "members";

const norm = (s: string) => s.toLocaleLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "");

export function DirectoryView() {
  const [tab, setTab] = useState<Tab>("people");
  const [query, setQuery] = useState("");
  const ws = useWorkspace();
  const publicCount = ws.channels.filter((c) => c.kind !== "dm").length;
  const groupCount = useUserGroups(ws.workspaceId).length;

  return (
    <ViewPage label="Directory">
      <ViewHeader icon={BookUser} title="Directory" subtitle={ws.workspace?.name}>
        <ViewTabs
          label="Directory"
          tabs={[
            { key: "people", label: "People", icon: Users, count: ws.members.filter((m) => !m.is_bot).length || undefined },
            { key: "channels", label: "Channels", icon: Hash, count: publicCount || undefined },
            { key: "groups", label: "Groups", icon: AtSign, count: groupCount || undefined },
          ]}
          value={tab}
          onChange={setTab}
          trailing={tab === "groups" ? undefined : <KeyHint>{tab === "people" ? "to message" : "to open"}</KeyHint>}
        />
      </ViewHeader>
      <div className="shrink-0 border-b px-3 py-2.5 sm:px-5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === "people"
                ? "Search by name, title or email"
                : tab === "groups"
                  ? "Search groups by name or handle"
                  : "Search channels by name or topic"
            }
            aria-label={tab === "people" ? "Search people" : tab === "groups" ? "Search groups" : "Search channels"}
            className="pl-8"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "people" ? <People query={query} /> : tab === "groups" ? <UserGroupsPanel query={query} /> : <Channels query={query} />}
      </div>
    </ViewPage>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function People({ query }: { query: string }) {
  const ws = useWorkspace();
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const [opening, setOpening] = useState<string | null>(null);
  const q = norm(query.trim());

  const people = ws.members
    .filter((m) => {
      if (m.is_bot) return false;
      if (filter === "active" && !ws.online.has(m.user_id)) return false;
      if (filter === "admins" && m.role !== "admin" && m.role !== "owner") return false;
      if (filter === "guests" && m.role !== "guest") return false;
      if (!q) return true;
      return [m.full_name, m.title, m.email, m.status_text].some((v) => v && norm(v).includes(q));
    })
    .sort((a, b) => {
      // You first, then people who are online, then alphabetical.
      if (a.user_id === ws.me?.id) return -1;
      if (b.user_id === ws.me?.id) return 1;
      const oa = ws.online.has(a.user_id) ? 0 : 1;
      const ob = ws.online.has(b.user_id) ? 0 : 1;
      return oa - ob || a.full_name.localeCompare(b.full_name);
    });

  const message = (m: Member) => {
    if (m.user_id === ws.me?.id) {
      ws.setProfileOpen(true);
      return;
    }
    setOpening(m.user_id);
    ws.openDM([m.user_id])
      .catch((err) => toast.error(`Couldn't open a DM: ${errorMessage(err)}`))
      .finally(() => setOpening(null));
  };

  const nav = useListNav({ scope: "people", count: people.length, onOpen: (i) => people[i] && message(people[i]) });

  const counts = {
    active: ws.members.filter((m) => !m.is_bot && ws.online.has(m.user_id)).length,
    guests: ws.members.filter((m) => m.role === "guest").length,
  };

  return (
    <>
      <div className="flex gap-1.5 overflow-x-auto px-3 pt-3 [scrollbar-width:none] sm:px-5">
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          Everyone
        </Chip>
        <Chip active={filter === "active"} onClick={() => setFilter("active")}>
          <span className="size-2 rounded-full bg-emerald-500" /> Active now · {counts.active}
        </Chip>
        <Chip active={filter === "admins"} onClick={() => setFilter("admins")}>
          Admins
        </Chip>
        {counts.guests > 0 && (
          <Chip active={filter === "guests"} onClick={() => setFilter("guests")}>
            Guests · {counts.guests}
          </Chip>
        )}
      </div>
      {!ws.members.length ? (
        <LoadingList variant="card" rows={4} />
      ) : !people.length ? (
        <EmptyState icon={Search} title="No one found">
          {q ? `Nobody matches “${query.trim()}”.` : "No one matches this filter."}
        </EmptyState>
      ) : (
        <ul role="list" className="grid gap-2 p-3 sm:grid-cols-2 sm:gap-3 sm:p-5 lg:grid-cols-3 2xl:grid-cols-4">
          {people.map((m, i) => (
            <li key={m.user_id}>
              <PersonCard
                member={m}
                navProps={nav.rowProps(i)}
                onFocus={() => nav.setIndex(i)}
                busy={opening === m.user_id}
                onMessage={() => message(m)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PersonCard({
  member: m,
  navProps,
  onFocus,
  busy,
  onMessage,
}: {
  member: Member;
  navProps: Record<string, unknown>;
  onFocus: () => void;
  busy: boolean;
  onMessage: () => void;
}) {
  const ws = useWorkspace();
  const now = useNow();
  const isMe = m.user_id === ws.me?.id;
  const online = ws.online.has(m.user_id);
  const status = activeStatus(m, now);
  const local = timeIn(m.timezone, now);

  return (
    <div
      {...navProps}
      onFocusCapture={onFocus}
      className="flex h-full gap-3 rounded-xl border bg-background p-3 transition-shadow hover:shadow-md data-[selected]:ring-2 data-[selected]:ring-tab"
    >
      <ProfilePopover userId={m.user_id} className="shrink-0 self-start rounded-lg">
        <UserAvatar id={m.user_id} name={m.full_name} size="lg" online={online} />
      </ProfilePopover>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="grid min-w-0 [&>*]:min-w-0">
          <ProfilePopover userId={m.user_id} className="rounded-sm">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate font-black hover:underline">{m.full_name}</span>
              {status?.emoji && <span className="shrink-0 text-[15px] leading-none">{status.emoji}</span>}
              {isMe && <span className="shrink-0 text-xs font-normal text-muted-foreground">(you)</span>}
            </span>
          </ProfilePopover>
        </div>
        {(m.title || m.pronouns) && (
          <p className="truncate text-[13px] text-muted-foreground">{[m.title, m.pronouns].filter(Boolean).join(" · ")}</p>
        )}
        {status?.text && <p className="truncate text-[13px]">{status.text}</p>}
        <div className="mt-auto flex items-center gap-2 pt-2">
          <span className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
            {local ? (
              <>
                <Clock className="size-3 shrink-0" />
                <span className="truncate">{local} local time</span>
              </>
            ) : (
              <span className="truncate">{online ? "Active" : "Away"}</span>
            )}
          </span>
          {m.role !== "member" && (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-px text-[10.5px] font-bold uppercase",
                m.role === "guest" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground",
              )}
            >
              {m.role}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={onMessage} disabled={busy} className="shrink-0">
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : isMe ? (
              <Pencil className="size-3.5" />
            ) : (
              <MessageCircle className="size-3.5" />
            )}
            {isMe ? "Edit profile" : "Message"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

function Channels({ query }: { query: string }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<ChannelFilter>("all");
  const [sort, setSort] = useState<ChannelSort>("name");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** Optimistic membership flips until the channel list reloads. */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const q = norm(query.trim());
  const isGuest = ws.memberById[ws.me?.id ?? ""]?.role === "guest";

  const joined = (c: Channel) => overrides[c.id] ?? c.is_member;
  const list = ws.channels
    .filter((c) => c.kind !== "dm")
    .filter((c) => (filter === "joined" ? joined(c) : filter === "other" ? !joined(c) : true))
    .filter((c) => !q || norm(c.name).includes(q) || (c.topic && norm(c.topic).includes(q)))
    .sort((a, b) =>
      sort === "members" ? b.member_ids.length - a.member_ids.length || a.name.localeCompare(b.name) : a.name.localeCompare(b.name),
    );

  const settle = (id: string) =>
    ws
      .reloadChannels()
      .catch(() => {})
      .finally(() => {
        setOverrides((o) => {
          const next = { ...o };
          delete next[id];
          return next;
        });
        setBusy(null);
      });

  const join = (c: Channel) => {
    setBusy(c.id);
    setOverrides((o) => ({ ...o, [c.id]: true }));
    api(`/channels/${c.id}/join`, { method: "POST" })
      .then(() => {
        toast.success(`Joined #${c.name}`);
        return settle(c.id);
      })
      .catch((err) => {
        setOverrides((o) => ({ ...o, [c.id]: false }));
        setBusy(null);
        toast.error(`Couldn't join #${c.name}: ${errorMessage(err)}`);
      });
  };

  const leave = (c: Channel) => {
    setBusy(c.id);
    setOverrides((o) => ({ ...o, [c.id]: false }));
    api(`/channels/${c.id}/members/me`, { method: "DELETE" })
      .then(() => {
        toast.success(`Left #${c.name}`);
        return settle(c.id);
      })
      .catch((err) => {
        setOverrides((o) => ({ ...o, [c.id]: true }));
        setBusy(null);
        toast.error(`Couldn't leave #${c.name}: ${errorMessage(err)}`);
      });
  };

  const nav = useListNav({
    scope: "channels",
    count: list.length,
    onOpen: (i) => {
      const c = list[i];
      if (!c) return;
      if (joined(c)) router.push(`/w/${ws.workspaceId}/c/${c.id}`);
      else join(c);
    },
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3 sm:px-5">
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </Chip>
        <Chip active={filter === "joined"} onClick={() => setFilter("joined")}>
          Joined
        </Chip>
        <Chip active={filter === "other"} onClick={() => setFilter("other")}>
          Not joined
        </Chip>
        <label className="ml-auto flex items-center gap-1.5 text-[13px] text-muted-foreground">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as ChannelSort)}
            className="h-7 rounded-md border bg-background px-1.5 text-[13px] font-semibold text-foreground"
          >
            <option value="name">Name</option>
            <option value="members">Most members</option>
          </select>
        </label>
        {!isGuest && (
          <Button size="sm" onClick={() => setCreating(true)} className="bg-send text-white hover:bg-send/90">
            <Plus className="size-3.5" /> Create channel
          </Button>
        )}
      </div>
      {!ws.channelsLoaded ? (
        <LoadingList rows={5} />
      ) : !list.length ? (
        <EmptyState
          icon={Hash}
          title={q ? "No channels found" : "No channels here"}
          action={
            !isGuest ? (
              <Button variant="outline" onClick={() => setCreating(true)}>
                <Plus className="size-4" /> Create a channel
              </Button>
            ) : undefined
          }
        >
          {q ? `Nothing matches “${query.trim()}”.` : "Channels are where your team talks about a project, topic or team."}
        </EmptyState>
      ) : (
        <ul role="list" className="mt-3 border-t">
          {list.map((c, i) => {
            const member = joined(c);
            return (
              <li key={c.id}>
                <div
                  {...nav.rowProps(i)}
                  className="group flex items-center gap-3 border-b px-4 py-3 hover:bg-muted/40 data-[selected]:bg-muted/70 data-[selected]:shadow-[inset_2px_0_0_var(--tab)] sm:px-5"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                    {c.kind === "private" ? <Lock className="size-4" /> : <Hash className="size-4" />}
                  </span>
                  <Link
                    href={`/w/${ws.workspaceId}/c/${c.id}`}
                    onFocus={() => nav.setIndex(i)}
                    className="min-w-0 flex-1 outline-none focus-visible:underline"
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate font-bold">{c.name}</span>
                      {member && (
                        <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 text-[10.5px] font-bold text-emerald-700 dark:text-emerald-400">
                          Joined
                        </span>
                      )}
                      {c.is_archived && (
                        <span className="shrink-0 rounded bg-muted px-1.5 text-[10.5px] font-bold text-muted-foreground">Archived</span>
                      )}
                    </span>
                    <span className="block truncate text-[13px] text-muted-foreground">
                      <Users className="mr-1 inline size-3 align-[-1px]" />
                      {c.member_ids.length} {c.member_ids.length === 1 ? "member" : "members"}
                      {c.topic && ` · ${c.topic}`}
                    </span>
                  </Link>
                  {member ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === c.id || c.name === "general"}
                        onClick={() => leave(c)}
                        className="hidden shrink-0 text-muted-foreground sm:group-focus-within:inline-flex sm:group-hover:inline-flex"
                      >
                        Leave
                      </Button>
                      <Link
                        href={`/w/${ws.workspaceId}/c/${c.id}`}
                        className={buttonVariants({ size: "sm", variant: "outline", className: "shrink-0" })}
                      >
                        Open
                      </Link>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy === c.id || c.is_archived}
                      onClick={() => join(c)}
                      className="shrink-0 bg-send text-white hover:bg-send/90"
                    >
                      {busy === c.id && <Loader2 className="size-3.5 animate-spin" />} Join
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <NewChannelDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
