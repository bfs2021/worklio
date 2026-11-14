"use client";

import { Loader2 } from "lucide-react";
import { useId } from "react";

import { cn } from "@/lib/utils";

/** Card-like settings section: title, optional description and actions, then content. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("rounded-xl border bg-background shadow-xs", className)}>
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-black tracking-[-0.01em]">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children !== undefined && <div className="px-4 py-4 sm:px-5">{children}</div>}
    </section>
  );
}

/** Label + hint + control in a responsive two-column row. */
export function FieldRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-6">
      <div>
        <label htmlFor={htmlFor} className="text-sm font-bold">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Accessible on/off switch. */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
  className,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  /** Accessible name when no visible <label htmlFor> points at it. */
  label?: string;
  id?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        checked ? "bg-send" : "bg-muted-foreground/30",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform motion-reduce:transition-none",
          checked ? "translate-x-[17px]" : "translate-x-px",
        )}
      />
    </button>
  );
}

/** Segmented radio control (e.g. Everyone / Admins only). */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  size = "md",
  className,
}: {
  value: V;
  options: readonly { value: V; label: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }[];
  onChange: (v: V) => void;
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex max-w-full rounded-lg bg-muted p-0.5", disabled && "opacity-60", className)}
      onKeyDown={(e) => {
        if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        const i = options.findIndex((o) => o.value === value);
        const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        const next = options[(i + step + options.length) % options.length];
        onChange(next.value);
        (e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            name={name}
            data-value={o.value}
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => !active && onChange(o.value)}
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
              active ? "bg-background text-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.icon && <o.icon className="size-3.5" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Styled native select (keeps native a11y + mobile pickers). */
export function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function RoleBadge({ role, className }: { role: string; className?: string }) {
  const styles: Record<string, string> = {
    owner: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    admin: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    manager: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    member: "bg-muted text-muted-foreground",
    guest: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
    bot: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    deactivated: "bg-destructive/10 text-destructive",
  };
  const label: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    manager: "Channel manager",
    member: "Member",
    guest: "Guest",
    bot: "App",
    deactivated: "Deactivated",
  };
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-bold whitespace-nowrap",
        styles[role] ?? styles.member,
        className,
      )}
    >
      {label[role] ?? role}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn("size-4 animate-spin", className)} />;
}

/** Blocks of shimmering placeholder lines. */
export function SkeletonBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={cn("space-y-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  );
}

/** Small square workspace icon: the uploaded image, or initials on the brand color. */
export function WorkspaceIcon({
  name,
  url,
  size = "md",
  className,
}: {
  name: string;
  url: string | null | undefined;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const dims = { sm: "size-7 text-[11px] rounded-md", md: "size-10 text-sm rounded-lg", lg: "size-14 text-lg rounded-xl", xl: "size-20 text-2xl rounded-2xl" }[size];
  const letters =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className={cn(dims, "shrink-0 object-cover", className)} />;
  }
  return (
    <span
      aria-hidden
      className={cn(dims, "flex shrink-0 items-center justify-center bg-side-active font-black text-side-active-foreground", className)}
    >
      {letters}
    </span>
  );
}
