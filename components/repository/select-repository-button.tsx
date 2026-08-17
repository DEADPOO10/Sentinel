"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SelectRepositoryButton({
  owner,
  repositoryName,
}: {
  owner: string;
  repositoryName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function selectRepository() {
    startTransition(() => {
      router.push(
        `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`
      );
    });
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button
        type="button"
        size="sm"
        onClick={selectRepository}
        disabled={isPending}
        aria-label={`Open Sentinel for ${owner}/${repositoryName}`}
        className="bg-[#171817] text-white hover:bg-[#2a2b29]"
      >
        {isPending ? "Opening Sentinel…" : "Open Sentinel →"}
      </Button>
    </div>
  );
}
