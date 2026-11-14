/**
 * Tiny event bus connecting a Composer to the MessageList beside it, for the
 * Slack shortcut "↑ in an empty composer edits your last message".
 *
 * Scope = channel id + parent id (null for the channel timeline), so a thread's
 * composer only ever edits replies in that thread.
 */

type Scope = { channelId: string; parentId: string | null };
type EditRequest = Scope & { kind: "request" };
type EditDone = Scope & { kind: "done" };
type Listener = (e: EditRequest | EditDone) => void;

const listeners = new Set<Listener>();

function emit(e: EditRequest | EditDone) {
  listeners.forEach((fn) => fn(e));
}

export const sameScope = (a: Scope, b: Scope) => a.channelId === b.channelId && (a.parentId ?? null) === (b.parentId ?? null);

export const editLast = {
  /** Composer → list: start editing my most recent message in this scope. */
  request: (channelId: string, parentId: string | null) => emit({ kind: "request", channelId, parentId }),
  /** List → composer: the edit was saved or cancelled; hand focus back. */
  done: (channelId: string, parentId: string | null) => emit({ kind: "done", channelId, parentId }),
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
