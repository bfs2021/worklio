"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { lastWorkspace } from "@/components/workspace/provider";
import { api, auth, type Workspace } from "@/lib/api";

/** Entry point: send people to their last workspace, or onboarding. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    if (!auth.get()) {
      router.replace("/login");
      return;
    }
    api<Workspace[]>("/workspaces")
      .then((list) => {
        const last = list.find((w) => w.id === lastWorkspace.get()) ?? list[0];
        router.replace(last ? `/w/${last.id}` : "/new");
      })
      .catch(() => router.replace("/login"));
  }, [router]);
  return null;
}
