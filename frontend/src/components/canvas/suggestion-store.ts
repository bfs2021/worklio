/**
 * A tiny external store that bridges TipTap's Suggestion plugin (imperative render callbacks)
 * to a React popup rendered with useSyncExternalStore. One store per popup kind.
 */
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";

export type SuggestionView<I> = {
  open: boolean;
  items: I[];
  index: number;
  query: string;
  /** Viewport rect of the trigger text; the popup anchors to it. */
  rect: { left: number; top: number; bottom: number } | null;
};

const CLOSED = { open: false, items: [], index: 0, query: "", rect: null };

export class SuggestionStore<I> {
  private view: SuggestionView<I> = CLOSED as SuggestionView<I>;
  private listeners = new Set<() => void>();
  private command: ((item: I) => void) | null = null;
  private clientRect: (() => DOMRect | null) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.view;
  getServerSnapshot = () => CLOSED as SuggestionView<I>;

  private set(next: SuggestionView<I>) {
    this.view = next;
    this.listeners.forEach((fn) => fn());
  }

  private rectNow() {
    const r = this.clientRect?.();
    return r ? { left: r.left, top: r.top, bottom: r.bottom } : null;
  }

  /** Re-measure the anchor (on scroll/resize while open). */
  reposition = () => {
    if (!this.view.open) return;
    const rect = this.rectNow();
    if (rect) this.set({ ...this.view, rect });
  };

  select = (index: number) => {
    if (!this.view.open || index === this.view.index) return;
    this.set({ ...this.view, index });
  };

  pick = (item: I) => {
    this.command?.(item);
  };

  close = () => {
    if (!this.view.open) return;
    this.command = null;
    this.clientRect = null;
    this.set(CLOSED as SuggestionView<I>);
  };

  /** The object returned from a Suggestion `render()` option. */
  renderer = () => ({
    onStart: (props: SuggestionProps<I, I>) => this.update(props, true),
    onUpdate: (props: SuggestionProps<I, I>) => this.update(props, false),
    onExit: () => this.close(),
    onKeyDown: ({ event }: SuggestionKeyDownProps) => this.keyDown(event),
  });

  private update(props: SuggestionProps<I, I>, start: boolean) {
    this.command = props.command;
    this.clientRect = props.clientRect ?? null;
    const sameQuery = !start && props.query === this.view.query;
    const index = sameQuery ? Math.min(this.view.index, Math.max(0, props.items.length - 1)) : 0;
    this.set({ open: true, items: props.items, index, query: props.query, rect: this.rectNow() });
  }

  private keyDown(event: KeyboardEvent): boolean {
    const v = this.view;
    if (!v.open) return false;
    if (event.key === "Escape") {
      this.close();
      return true;
    }
    if (!v.items.length) return false;
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      this.set({ ...v, index: (v.index + 1) % v.items.length });
      return true;
    }
    if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      this.set({ ...v, index: (v.index - 1 + v.items.length) % v.items.length });
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const item = v.items[v.index];
      if (item) this.pick(item);
      return true;
    }
    return false;
  }
}
