"use client";

import { compactNumber, type AIUsageReport } from "@/lib/admin";
import { cn } from "@/lib/utils";

type Day = { date: string; requests: number; input_tokens: number; output_tokens: number };

/** The last `days` UTC dates (oldest first), with zeros for days the report doesn't mention. */
export function fillDays(report: AIUsageReport | null, days: number, now = Date.now()): Day[] {
  const byDate = new Map((report?.by_day ?? []).map((d) => [d.date.slice(0, 10), d]));
  const out: Day[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const d = byDate.get(date);
    out.push({ date, requests: d?.requests ?? 0, input_tokens: d?.input_tokens ?? 0, output_tokens: d?.output_tokens ?? 0 });
  }
  return out;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * exp;
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Inline-SVG bar chart of AI usage per day. "requests" draws one series; "tokens" stacks input and
 * output tokens. Each bar has a native tooltip (<title>) and the chart has a text summary for screen readers.
 */
export function UsageChart({ data, metric, className }: { data: Day[]; metric: "requests" | "tokens"; className?: string }) {
  const W = 640;
  const H = 190;
  const pad = { l: 40, r: 8, t: 10, b: 24 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const values = data.map((d) => (metric === "requests" ? d.requests : d.input_tokens + d.output_tokens));
  const max = niceMax(Math.max(0, ...values));
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(28, slot * 0.68));
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const total = values.reduce((a, b) => a + b, 0);
  const ticks = [0, max / 2, max];
  const labelIdx = new Set([0, Math.floor((data.length - 1) / 2), data.length - 1]);

  return (
    <figure className={cn("w-full", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${metric === "requests" ? "AI requests" : "Tokens"} per day over the last ${data.length} days: ${compactNumber(total)} in total.`}
        className="h-auto w-full overflow-visible"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="stroke-border" strokeDasharray={t === 0 ? undefined : "3 4"} />
            <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
              {compactNumber(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + slot * i + (slot - barW) / 2;
          const label = dayLabel(d.date);
          if (metric === "requests") {
            const h = d.requests > 0 ? Math.max(1.5, (d.requests / max) * innerH) : 0;
            return (
              <g key={d.date} className="transition-opacity hover:opacity-75">
                <title>{`${label}: ${d.requests.toLocaleString()} request${d.requests === 1 ? "" : "s"}`}</title>
                <rect x={pad.l + slot * i} y={pad.t} width={slot} height={innerH} fill="transparent" />
                {h > 0 && <rect x={x} y={pad.t + innerH - h} width={barW} height={h} rx={Math.min(3, barW / 3)} className="fill-chart-1" />}
                {labelIdx.has(i) && (
                  <text x={x + barW / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px]">
                    {label}
                  </text>
                )}
              </g>
            );
          }
          const hIn = (d.input_tokens / max) * innerH;
          const hOut = (d.output_tokens / max) * innerH;
          return (
            <g key={d.date} className="transition-opacity hover:opacity-75">
              <title>{`${label}: ${d.input_tokens.toLocaleString()} input · ${d.output_tokens.toLocaleString()} output tokens`}</title>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={innerH} fill="transparent" />
              {hIn > 0 && <rect x={x} y={pad.t + innerH - hIn} width={barW} height={Math.max(1, hIn)} className="fill-chart-1" />}
              {hOut > 0 && <rect x={x} y={pad.t + innerH - hIn - hOut} width={barW} height={Math.max(1, hOut)} className="fill-chart-3" />}
              {labelIdx.has(i) && (
                <text x={x + barW / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px]">
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {metric === "tokens" && (
        <figcaption className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-chart-1" aria-hidden /> Input
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-chart-3" aria-hidden /> Output
          </span>
        </figcaption>
      )}
    </figure>
  );
}

/** Horizontal "top N" list with proportional bars. */
export function TopList({
  rows,
  empty,
}: {
  rows: { key: string; label: React.ReactNode; value: number; sub?: string }[];
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-3 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ol className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">{r.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={r.sub}>
              {r.value.toLocaleString()}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-chart-1" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}
