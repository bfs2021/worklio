"use client";

import { Moon, Sun } from "lucide-react";

import { useAppearance } from "@/components/appearance-provider";

export function ThemeToggle({ className }: { className?: string }) {
  const { dark, update } = useAppearance();
  return (
    <button
      onClick={() => update({ mode: dark ? "light" : "dark" })}
      className={className}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
