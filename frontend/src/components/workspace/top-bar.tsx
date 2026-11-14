"use client";

import { Menu, Search, Settings2 } from "lucide-react";

import { AskWorklioButton } from "@/components/ai/ask-worklio";
import { ThemeToggle } from "@/components/theme-toggle";

import { useWorkspace } from "./provider";

export function TopBar() {
  const ws = useWorkspace();
  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 px-2 text-chrome-foreground md:h-11 md:gap-2">
      <button
        onClick={() => ws.setSidebarOpen(true)}
        className="flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-chrome-hover md:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-5" />
      </button>
      {/* Desktop: lines the search up with the content column. Sidebar hide/show is ⌘. + hover-to-peek only (no button, by product decision). */}
      <div className="hidden w-[62px] shrink-0 md:block" />
      <div className="flex min-w-0 flex-1 justify-center">
        <button
          onClick={() => ws.setSwitcherOpen(true)}
          className="flex h-9 w-full max-w-2xl items-center gap-2 rounded-md bg-chrome-hover px-3 text-sm text-chrome-muted ring-1 ring-white/10 hover:bg-white/15 md:h-7"
        >
          <Search className="size-3.5" />
          <span className="truncate">Search {ws.workspace?.name ?? ""}</span>
          <kbd className="ml-auto hidden rounded border border-white/20 px-1 text-[10px] sm:inline">⌘K</kbd>
        </button>
      </div>
      <AskWorklioButton />
      <ThemeToggle className="flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-chrome-hover md:size-8" />
      <button
        onClick={() => ws.setPreferencesOpen(true)}
        className="flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-chrome-hover md:size-8"
        aria-label="Preferences"
        title="Preferences (⌘,)"
      >
        <Settings2 className="size-4" />
      </button>
    </header>
  );
}
