/**
 * Minimal toast store. Call `toast.error(msg)` / `toast.success(msg)` from anywhere;
 * a single <Toaster /> (components/chat/toaster.tsx) renders them.
 */

export type ToastKind = "error" | "success" | "info";
export type Toast = { id: number; kind: ToastKind; message: string };

const DURATION_MS = 4000;
const MAX_VISIBLE = 3;

const EMPTY: Toast[] = [];
let toasts: Toast[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

export function dismissToast(id: number) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

function push(kind: ToastKind, message: string) {
  // Collapse identical messages fired in quick succession (e.g. several failed reactions).
  const existing = toasts.find((t) => t.kind === kind && t.message === message);
  if (existing) return existing.id;
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }].slice(-MAX_VISIBLE);
  emit();
  if (typeof window !== "undefined") window.setTimeout(() => dismissToast(id), DURATION_MS);
  return id;
}

/** Turn anything thrown into a readable message. */
export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}

export const toast = {
  error: (message: string) => push("error", message),
  success: (message: string) => push("success", message),
  info: (message: string) => push("info", message),
};

export const toastStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: () => toasts,
  // Must return the same reference every call, or React warns about an infinite loop.
  getServerSnapshot: (): Toast[] => EMPTY,
};
