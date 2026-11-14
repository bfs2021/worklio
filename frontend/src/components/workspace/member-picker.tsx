"use client";

import { Check } from "lucide-react";
import { useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { useWorkspace } from "./provider";

export function MemberPicker({
  selected,
  onChange,
  exclude = [],
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
}) {
  const { members, online } = useWorkspace();
  const [q, setQ] = useState("");
  const options = members.filter(
    (m) =>
      !exclude.includes(m.user_id) &&
      (m.full_name.toLowerCase().includes(q.toLowerCase()) || m.email?.toLowerCase().includes(q.toLowerCase())),
  );
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="space-y-2">
      <Input placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-60 overflow-y-auto rounded-md border">
        {options.length === 0 && <p className="p-3 text-sm text-muted-foreground">No one to add.</p>}
        {options.map((m) => {
          const on = selected.includes(m.user_id);
          return (
            <button
              type="button"
              key={m.user_id}
              onClick={() => toggle(m.user_id)}
              className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted", on && "bg-muted")}
            >
              <UserAvatar id={m.user_id} name={m.full_name} size="sm" online={online.has(m.user_id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{m.full_name}</span>
                <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
              </span>
              {on && <Check className="size-4 text-primary" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
