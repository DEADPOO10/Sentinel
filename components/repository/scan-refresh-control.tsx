"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { refreshRepositoryScan } from "@/actions/scans";
import { Button } from "@/components/ui/button";

type Props = { owner: string; repository: string; automaticallyRefresh: boolean; hasCachedScan: boolean };

export function ScanRefreshControl({ owner, repository, automaticallyRefresh, hasCachedScan }: Props) {
  const router = useRouter();
  const didStartAutomaticRefresh = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function startRefresh(automatic = false) {
    startTransition(async () => {
      setMessage(automatic ? "Refreshing scan in the background…" : "Refreshing scan…");
      const result = await refreshRepositoryScan({ owner, repository });
      if (result.kind === "completed") {
        setMessage("Scan refreshed.");
        router.refresh();
      } else if (result.kind === "no-package-json") {
        setMessage("No package.json was found on the default branch.");
        router.refresh();
      } else if ("error" in result) {
        setMessage(result.error);
      }
    });
  }

  useEffect(() => {
    if (!automaticallyRefresh || didStartAutomaticRefresh.current) return;
    didStartAutomaticRefresh.current = true;
    startRefresh(true);
  // Start once after hydration; revisiting a fresh scan never reaches this branch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automaticallyRefresh]);

  return <div className="mt-5 flex flex-wrap items-center gap-3" aria-live="polite">
    <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => startRefresh(false)}>
      <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
      {isPending ? "Refreshing scan…" : "Refresh scan"}
    </Button>
    <p className="text-xs text-[#696b66]">{message ?? (hasCachedScan ? "Saved results stay visible while a new scan runs." : "The first scan begins after this page becomes interactive.")}</p>
  </div>;
}
