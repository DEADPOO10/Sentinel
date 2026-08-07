import Link from "next/link";
import { Button } from "@/components/ui/button";

export function SelectRepositoryButton({ owner, repositoryName }: { owner: string; repositoryName: string }) {
  const href = `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`;

  return <Button asChild size="sm"><Link href={href} aria-label={`Select ${owner}/${repositoryName}`}>Select repository</Link></Button>;
}
