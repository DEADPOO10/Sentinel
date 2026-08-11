"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SelectRepositoryButton({ owner, repositoryName }: { owner: string; repositoryName: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function selectRepository() {
    // The destination authenticates with GitHub before it connects or scans a
    // repository. Starting navigation here lets Next display its route loading
    // state instead of holding the click behind a separate server round trip.
    startTransition(() => {
      router.push(`/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`);
    });
  }

  return <div className="flex flex-col items-start gap-2 sm:items-end"><Button type="button" size="sm" onClick={selectRepository} disabled={isPending} aria-label={`Select ${owner}/${repositoryName}`}>{isPending ? "Opening repository…" : "Select repository"}</Button></div>;
}
