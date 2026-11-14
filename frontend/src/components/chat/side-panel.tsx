import { X } from "lucide-react";

/** Portalled overlays whose own Escape handling must not close the panel behind them. */
const OVERLAY_SELECTOR =
  "[data-slot=popover-content],[data-slot=dropdown-menu-content],[data-slot=dialog-content],[data-slot=sheet-content],[role=dialog],[role=menu],[role=listbox]";

/**
 * Right-hand panel (thread, search).
 *   < md   full-screen overlay
 *   md–lg  slide-over drawer with a backdrop, so the conversation keeps its width on tablets
 *   ≥ lg   docked column beside the conversation
 */
export function SidePanel({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div aria-hidden className="fixed inset-0 z-30 hidden bg-black/20 md:block lg:hidden" onClick={onClose} />
      <aside
        className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:inset-y-0 md:pt-0 md:pb-0 md:right-0 md:left-auto md:w-[min(400px,90vw)] md:border-l md:shadow-2xl lg:static lg:z-auto lg:w-[360px] lg:shrink-0 lg:shadow-none xl:w-[400px]"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
          // React events bubble through portals: ignore Escape meant for a popover, menu,
          // emoji picker or dialog opened from inside the panel.
          const target = e.target as HTMLElement;
          if (target.closest?.(OVERLAY_SELECTOR)) return;
          onClose();
        }}
      >
        <header className="flex h-[52px] shrink-0 items-center justify-between border-b px-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-lg font-black">{title}</span>
            {subtitle && <span className="truncate text-[13px] text-muted-foreground">{subtitle}</span>}
          </div>
          <button onClick={onClose} className="rounded-md p-2 hover:bg-muted md:p-1.5" aria-label="Close panel">
            <X className="size-5" />
          </button>
        </header>
        {children}
      </aside>
    </>
  );
}
