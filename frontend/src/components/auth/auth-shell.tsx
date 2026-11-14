import { Headphones, Hash, PenTool, Sparkles } from "lucide-react";

import { BrandMark } from "@/components/ui/brand-mark";

const FEATURES = [
  { icon: Hash, title: "Channels, DMs & threads", text: "Every conversation organised and searchable." },
  { icon: Headphones, title: "Calls & huddles", text: "Ring a teammate or drop into a huddle, with screen share." },
  { icon: PenTool, title: "Canvases & whiteboards", text: "Write and sketch together in real time." },
  { icon: Sparkles, title: "Worklio AI", text: "Catch up, summarise and ask, using only what you can see." },
];

/** Brand panel beside the auth form on wide screens. Uses the active theme's frame colours,
 *  so it matches the app's window frame and sidebar (Classic plum by default). */
function BrandPanel() {
  return (
    <aside
      className="relative hidden overflow-hidden bg-chrome text-chrome-foreground lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16"
      style={{ backgroundImage: "var(--chrome-gradient)" }}
    >
      {/* A soft highlight for depth; colourless so it works with every theme. */}
      <div aria-hidden className="pointer-events-none absolute -top-40 -right-40 size-[36rem] rounded-full bg-white/[0.06] blur-3xl" />

      <div className="relative flex items-center gap-3">
        <BrandMark className="size-10" />
        <span className="text-xl font-black tracking-tight">Worklio</span>
      </div>

      <div className="relative max-w-lg space-y-8">
        <h2 className="text-4xl leading-tight font-black tracking-tight xl:text-5xl">Where your team talks, together.</h2>
        <ul className="space-y-5">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-chrome-hover ring-1 ring-white/10">
                <Icon className="size-5" />
              </span>
              <div>
                <p className="font-bold">{title}</p>
                <p className="text-sm text-chrome-muted">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-chrome-muted">Open source · Self-hostable · Your data stays yours</p>
    </aside>
  );
}

/** Two-column auth layout: form on the left, brand panel on the right (form only on small screens). */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <section className="flex flex-col px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-10">
        <div className="flex items-center gap-2.5 lg:invisible">
          <BrandMark className="size-9" />
          <span className="text-lg font-black tracking-tight">Worklio</span>
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[400px]">
            <h1 className="text-[28px] leading-tight font-black tracking-tight">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] text-muted-foreground">{subtitle}</p>}
            <div className="mt-8">{children}</div>
          </div>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          By continuing you agree to use Worklio responsibly with your team.
        </p>
      </section>
      <BrandPanel />
    </main>
  );
}
