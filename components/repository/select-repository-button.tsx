"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { selectRepositoryForCurrentUser } from "@/actions/repositories";
import { Button } from "@/components/ui/button";

export function SelectRepositoryButton({ owner, repositoryName }: { owner: string; repositoryName: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function selectRepository() {
    startTransition(async () => {
      setError(null);
      const result = await selectRepositoryForCurrentUser({ owner, repository: repositoryName });
      if (result.kind === "error") {
        setError(result.error);
        return;
      }

      router.push(`/repositories/${encodeURIComponent(result.owner)}/${encodeURIComponent(result.repository)}`);
    });
  }

  return <div className="flex flex-col items-start gap-2 sm:items-end"><Button type="button" size="sm" onClick={selectRepository} disabled={isPending} aria-label={`Select ${owner}/${repositoryName}`}>{isPending ? "Saving repository…" : "Select repository"}</Button>{error ? <p className="max-w-64 text-xs text-[#343633]" role="alert">{error}</p> : null}</div>;
}
