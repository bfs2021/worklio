"use client";

import { useSyncExternalStore } from "react";

import type { Message } from "@/lib/api";
import { ai, aiErrorCode, aiErrorMessage, aiGateMessage, aiGateReason, peekAIStatus, type AIGateReason } from "@/lib/ai";

/**
 * Global UI state for Worklio AI surfaces that are opened from far away (top bar, message
 * menus, keyboard): the Ask panel, per-message translations, the thread-summary sheet and the
 * create-tasks dialog. Snapshots are replaced immutably so useSyncExternalStore stays stable.
 */

export type Translation = {
  lang: string;
  status: "loading" | "ready" | "error";
  text: string;
  detected: string | null;
  error: string | null;
  /** The reader collapsed it back to the original. */
  hidden: boolean;
  /** Set when AI isn't available (not set up, admins only, translation off) instead of a retryable error. */
  gate?: AIGateReason | null;
};

type AIUIState = {
  askOpen: boolean;
  /** Question to pre-fill (or send, when `askSend`) the next time the panel opens. */
  askPrompt: { text: string; send: boolean; nonce: number } | null;
  translations: Record<string, Translation>;
  threadSummary: { message: Message; nonce: number } | null;
  tasks: { message: Message; nonce: number } | null;
  /** Translation shown in a dialog (when the message has no inline <MessageTranslation/> slot). */
  translateDialog: Message | null;
};

let state: AIUIState = { askOpen: false, askPrompt: null, translations: {}, threadSummary: null, tasks: null, translateDialog: null };
const listeners = new Set<() => void>();
let nonce = 0;

function set(patch: Partial<AIUIState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

const SERVER = state;

export function useAIUI<T>(select: (s: AIUIState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(SERVER),
  );
}

// --- Ask panel ---
export function openAsk(prompt?: string, send = false) {
  if (prompt && promptListeners.size) {
    set({ askOpen: true });
    promptListeners.forEach((fn) => fn({ text: prompt, send }));
    return;
  }
  set({ askOpen: true, askPrompt: prompt ? { text: prompt, send, nonce: ++nonce } : state.askPrompt });
}
export function closeAsk() {
  if (state.askOpen) set({ askOpen: false });
}
export function toggleAsk() {
  set({ askOpen: !state.askOpen });
}
const promptListeners = new Set<(p: { text: string; send: boolean }) => void>();
/** The mounted Ask panel receives prompts here (consuming them). */
export function onAskPrompt(fn: (p: { text: string; send: boolean }) => void) {
  promptListeners.add(fn);
  // A prompt queued before the panel mounted is delivered once, asynchronously.
  const pending = state.askPrompt;
  if (pending) {
    state = { ...state, askPrompt: null };
    queueMicrotask(() => {
      const target = [...promptListeners].at(-1);
      if (target) target({ text: pending.text, send: pending.send });
      else state = { ...state, askPrompt: pending };
    });
  }
  return () => {
    promptListeners.delete(fn);
  };
}

// --- Translations ---
let translateSeq = 0;
const latest: Record<string, number> = {};

function patchTranslation(id: string, patch: Partial<Translation> | null) {
  const next = { ...state.translations };
  if (patch === null) delete next[id];
  else next[id] = { ...(next[id] ?? { lang: "", status: "loading", text: "", detected: null, error: null, hidden: false }), ...patch };
  set({ translations: next });
}

/** Translate a message into `lang`; renders inline under the message (see <MessageTranslation/>). */
export function translateMessage(messageId: string, lang: string) {
  const seq = ++translateSeq;
  latest[messageId] = seq;
  const status = peekAIStatus();
  const gate = aiGateReason(status, "translate");
  if (gate) {
    patchTranslation(messageId, { lang, status: "error", text: "", error: aiGateMessage(gate, !!status?.can_configure), gate, hidden: false });
    return;
  }
  patchTranslation(messageId, { lang, status: "loading", text: "", error: null, gate: null, hidden: false });
  ai.translate(messageId, lang)
    .then((r) => {
      if (latest[messageId] !== seq) return;
      patchTranslation(messageId, { status: "ready", text: r.text, detected: r.detected_language ?? null });
    })
    .catch((err) => {
      if (latest[messageId] !== seq) return;
      const code = aiErrorCode(err);
      const gate: AIGateReason | null =
        code === "ai_not_configured" ? "not_configured" : code === "policy" ? "policy" : code === "feature_disabled" ? "feature_off" : null;
      patchTranslation(messageId, { status: "error", error: aiErrorMessage(err), gate });
    });
}

export function setTranslationHidden(messageId: string, hidden: boolean) {
  if (state.translations[messageId]) patchTranslation(messageId, { hidden });
}

export function clearTranslation(messageId: string) {
  delete latest[messageId];
  patchTranslation(messageId, null);
}

/** Message ids whose <MessageTranslation/> is on screen; others get a dialog fallback. */
const mountedTranslations = new Map<string, number>();
export function registerTranslationSlot(messageId: string) {
  mountedTranslations.set(messageId, (mountedTranslations.get(messageId) ?? 0) + 1);
  return () => {
    const n = (mountedTranslations.get(messageId) ?? 1) - 1;
    if (n <= 0) mountedTranslations.delete(messageId);
    else mountedTranslations.set(messageId, n);
  };
}
export const hasTranslationSlot = (messageId: string) => mountedTranslations.has(messageId);

/** Translate inline when the message renders a slot, otherwise in a dialog. */
export function requestTranslation(message: Message, lang: string) {
  translateMessage(message.id, lang);
  if (!hasTranslationSlot(message.id)) set({ translateDialog: message });
}
export function closeTranslateDialog() {
  if (state.translateDialog) set({ translateDialog: null });
}

// --- Thread summary / tasks ---
export function openThreadSummary(message: Message) {
  set({ threadSummary: { message, nonce: ++nonce } });
}
export function closeThreadSummary() {
  if (state.threadSummary) set({ threadSummary: null });
}
export function openCreateTasks(message: Message) {
  set({ tasks: { message, nonce: ++nonce } });
}
export function closeCreateTasks() {
  if (state.tasks) set({ tasks: null });
}

// --- Languages ---
export const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Arabic",
  "Hindi",
  "Urdu",
  "Turkish",
  "Russian",
] as const;

/** The reader's language, as an English name ("German"), for "Translate to my language". */
export function preferredLanguage(): string {
  if (typeof navigator === "undefined") return "English";
  try {
    const code = (navigator.language || "en").split("-")[0];
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? "English";
  } catch {
    return "English";
  }
}
