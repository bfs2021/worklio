import { cn } from "@/lib/utils";

/**
 * Worklio's logo mark, "Huddle": three teammates (red, blue, green) gathered behind one shared
 * chat bubble (yellow). Flat colours on a white tile, crisp at every size. Matches app/icon.svg.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 128 128"
      aria-hidden
      className={cn("size-10 shrink-0", className)}
    >
      <rect
        x=".75"
        y=".75"
        width="126.5"
        height="126.5"
        rx="27.5"
        fill="#fff"
        stroke="#000"
        strokeOpacity=".08"
        strokeWidth="1.5"
      />
      <circle cx="64" cy="28" r="11" fill="#2fb3e8" />
      <path d="M46 58a18 18 0 0 1 36 0z" fill="#2fb3e8" />
      <circle cx="34" cy="40" r="10" fill="#e5375f" />
      <path
        d="M17 74v-6a14 14 0 0 1 14-14h6a14 14 0 0 1 14 14v6z"
        fill="#e5375f"
      />
      <circle cx="94" cy="40" r="10" fill="#27b07a" />
      <path
        d="M77 74v-6a14 14 0 0 1 14-14h6a14 14 0 0 1 14 14v6z"
        fill="#27b07a"
      />
      <path
        d="M43 64h42a17 17 0 0 1 17 17v5a17 17 0 0 1-17 17H62l-13 11a2 2 0 0 1-3.3-1.5V103A17 17 0 0 1 26 86v-5a17 17 0 0 1 17-17z"
        fill="#f0b030"
        stroke="#fff"
        strokeWidth="4"
      />
      <g fill="#fff">
        <circle cx="50" cy="84" r="4.5" />
        <circle cx="64" cy="84" r="4.5" />
        <circle cx="78" cy="84" r="4.5" />
      </g>
    </svg>
  );
}

/** Mark + wordmark, for the signed-out pages. */
export function BrandLockup({
  tagline,
  className,
}: {
  tagline?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 text-center text-chrome-foreground",
        className,
      )}
    >
      <BrandMark className="size-14 drop-shadow-lg" />
      <div>
        <div className="text-2xl font-black tracking-tight">Worklio</div>
        {tagline && <p className="text-sm text-chrome-muted">{tagline}</p>}
      </div>
    </div>
  );
}
