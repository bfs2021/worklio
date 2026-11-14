"use client";

import { useCallback, useState } from "react";

import { useWorkspaceEvents } from "@/components/workspace/provider";

import { useHuddles } from "../huddle-provider";
import { inviteToCallApi } from "./call-api";
import type { CallOut, CallUpdatedEvent } from "./types";

/** Fields the calls feature adds to the huddle context. Read defensively: they may not exist yet. */
type CallCtxExtension = {
  call?: CallOut | null;
  inviteToCall?: (...args: never[]) => unknown;
};

function asCall(v: unknown): CallOut | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<CallOut>;
  return typeof c.id === "string" && typeof c.channel_id === "string" ? (c as CallOut) : null;
}

/**
 * The call I'm in (from `useHuddles().call`), kept fresh with `call.updated` events even if the
 * provider doesn't apply them, plus an `invite(userIds)` that prefers the provider's
 * `inviteToCall` and falls back to POST /calls/{id}/invite.
 */
export function useCallInfo() {
  const ctx = useHuddles() as ReturnType<typeof useHuddles> & CallCtxExtension;
  const ctxCall = asCall(ctx.call);
  const base = ctxCall && ctxCall.channel_id === ctx.activeChannelId ? ctxCall : null;
  const providerInvite = typeof ctx.inviteToCall === "function" ? ctx.inviteToCall : null;

  const [latest, setLatest] = useState<{ base: CallOut; call: CallOut } | null>(null);

  useWorkspaceEvents((e) => {
    const ev = e as unknown as CallUpdatedEvent | { type: string };
    if (ev.type !== "call.updated" || !base) return;
    const next = asCall((ev as CallUpdatedEvent).call);
    if (next && next.id === base.id) setLatest({ base, call: next });
  });

  // Prefer the event copy only while the provider's object hasn't changed since we got it.
  const call = latest && base && latest.base === base ? latest.call : base;
  const callId = call?.id ?? null;

  const invite = useCallback(
    async (userIds: string[]) => {
      if (!userIds.length) return;
      if (providerInvite) {
        // Accept either `inviteToCall(userIds)` or `inviteToCall(callId, userIds)`.
        const fn = providerInvite as unknown as (...a: unknown[]) => unknown;
        await (fn.length >= 2 ? fn(callId, userIds) : fn(userIds));
        return;
      }
      if (!callId) throw new Error("There's no call to invite people to.");
      await inviteToCallApi(callId, userIds);
    },
    [providerInvite, callId],
  );

  return { call, invite, canInvite: !!providerInvite || !!callId };
}
