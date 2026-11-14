"use client";

import { AlertTriangle, Loader2, RotateCcw, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { SearchPanel } from "@/components/chat/search-panel";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

/** A full-page workspace view in the main pane; keeps the global search panel working beside it. */
export function ViewPage({ children, label }: { children: React.ReactNode; label: string }) {
  const ws = useWorkspace();
  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label={label} className="flex min-w-0 flex-1 flex-col">
        {children}
      </section>
      {ws.searchQuery && <SearchPanel key={ws.searchQuery} query={ws.searchQuery} onClose={() => ws.setSearchQuery(null)} />}
    </div>
  );
}

/** Page header: icon + title (+ count), actions on the right, optional tabs/filters below. */
export function ViewHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="shrink-0 border-b">
      <div className="flex min-h-[52px] items-center gap-2 px-3 py-1.5 sm:px-5">
        <Icon className="size-[18px] shrink-0" aria-hidden />
        <h1 className="min-w-0 truncate text-lg font-black">{title}</h1>
        {subtitle && <span className="hidden min-w-0 truncate text-[13px] text-muted-foreground sm:block">{subtitle}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
      {children}
    </header>
  );
}

export type TabDef<K extends string> = { key: K; label: string; count?: number; icon?: LucideIcon };

/** Underlined tab strip matching the channel header tabs; scrolls horizontally on phones. */
export function ViewTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  trailing,
}: {
  tabs: readonly TabDef<K>[];
  value: K;
  onChange: (k: K) => void;
  label: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-end gap-2 px-3 sm:px-5">
      <nav
        role="tablist"
        aria-label={label}
        className="-mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto text-[13px] [scrollbar-width:none]"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const i = tabs.findIndex((t) => t.key === value);
          const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
          onChange(next.key);
          (e.currentTarget.querySelector(`[data-tab="${next.key}"]`) as HTMLElement | null)?.focus();
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            data-tab={t.key}
            aria-selected={value === t.key}
            tabIndex={value === t.key ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-t-sm border-b-2 px-2 pt-1 pb-2.5 font-bold whitespace-nowrap outline-none focus-visible:bg-muted md:pb-2",
              value === t.key ? "border-tab" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.icon && <t.icon className="size-3.5" />}
            {t.label}
            {!!t.count && (
              <span className="rounded-full bg-badge px-1.5 text-[10.5px] leading-4 font-bold text-badge-foreground">
                {t.count > 99 ? "99+" : t.count}
              </span>
            )}
          </button>
        ))}
      </nav>
      {trailing && <div className="flex shrink-0 items-center gap-1 pb-1.5">{trailing}</div>}
    </div>
  );
}

/** A pill toggle used for filter chips. */
export function Chip({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        active
          ? "border-transparent bg-side-active text-side-active-foreground"
          : "bg-background text-foreground hover:bg-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mx-auto mt-14 max-w-sm px-6 pb-10 text-center">
      <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-mention text-mention-foreground">
        <Icon className="size-8" />
      </div>
      <p className="text-lg font-black">{title}</p>
      {children && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorBlock({ message, onRetry, compact }: { message: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div role="alert" className={cn("mx-auto max-w-sm px-6 text-center", compact ? "py-4" : "mt-14 pb-10")}>
      {!compact && (
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <AlertTriangle className="size-7" />
        </div>
      )}
      <p className="font-bold">{compact ? "Couldn't load more" : "Couldn't load this view"}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        <RotateCcw className="size-3.5" /> Try again
      </Button>
    </div>
  );
}

/** Skeleton rows while the first page loads. */
export function LoadingList({ rows = 6, variant = "row" }: { rows?: number; variant?: "row" | "card" }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={cn(variant === "card" ? "space-y-3 p-3 sm:p-5" : "")}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn(
            "flex animate-pulse gap-3",
            variant === "card" ? "rounded-xl border p-4" : "border-b px-4 py-3 sm:px-5",
          )}
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <div className="size-8 shrink-0 rounded-md bg-muted" />
          <div className="min-w-0 flex-1 space-y-2 py-0.5">
            <div className="h-3 w-1/3 rounded bg-muted" />
            <div className="h-3 rounded bg-muted" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Infinite-scroll sentinel: calls `onMore` when scrolled into view (and offers a button fallback). */
export function LoadMore({
  hasMore,
  loading,
  error,
  onMore,
}: {
  hasMore: boolean;
  loading: boolean;
  error: string;
  onMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onMore);
  useEffect(() => {
    cb.current = onMore;
  });
  useEffect(() => {
    const el = ref.current;
    // Re-observing after each page means a sentinel that's still on screen keeps loading.
    if (!el || !hasMore || error || loading) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), {
      rootMargin: "400px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, error, loading]);

  if (error) return <ErrorBlock compact message={error} onRetry={onMore} />;
  if (!hasMore) return null;
  return (
    <div ref={ref} className="flex justify-center py-4">
      {loading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading more" />
      ) : (
        <Button variant="ghost" size="sm" onClick={onMore}>
          Load more
        </Button>
      )}
    </div>
  );
}

/** Small "J/K to move · Enter to open" hint for desktop. */
export function KeyHint({ children }: { children?: React.ReactNode }) {
  return (
    <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:inline-flex">
      <kbd className="rounded border px-1 font-sans">J</kbd>
      <kbd className="rounded border px-1 font-sans">K</kbd> to move ·
      <kbd className="rounded border px-1 font-sans">Enter</kbd> {children ?? "to open"}
    </span>
  );
}
