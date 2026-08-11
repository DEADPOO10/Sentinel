"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { connectRepositoryToCurrentSentinelUser } from "@/lib/db/repositories";
import { createCompletedScanWithFindings } from "@/lib/db/scans";
import { getGitHubPackageManifestForRepository, getGitHubRepositoryDetails, isValidGitHubRepository } from "@/lib/github/package-json";
import { checkDependencyVersions } from "@/lib/npm/dependency-versions";

export type RefreshRepositoryScanResult = { kind: "completed" | "no-package-json" } | { kind: "error"; error: string };

/** Runs as its own authenticated request, never as work left after rendering. */
export async function refreshRepositoryScan(input: { owner: string; repository: string }): Promise<RefreshRepositoryScanResult> {
  await requireUser();
  if (!isValidGitHubRepository(input.owner, input.repository)) return { kind: "error", error: "This repository selection is invalid." };

  const repositoryResult = await getGitHubRepositoryDetails(input.owner, input.repository);
  if (repositoryResult.kind !== "ready") return { kind: "error", error: repositoryResult.kind === "not-found" ? "This repository is no longer available to your GitHub account." : repositoryResult.error };

  try {
    await connectRepositoryToCurrentSentinelUser(repositoryResult.repository);
  } catch {
    return { kind: "error", error: "Sentinel could not connect this repository to your workspace." };
  }

  const startedAt = new Date();
  const manifestResult = await getGitHubPackageManifestForRepository(repositoryResult.repository);
  if (manifestResult.kind === "not-found") return { kind: "error", error: "This repository is no longer available to your GitHub account." };
  if (manifestResult.kind === "error") return { kind: "error", error: manifestResult.error };
  if (manifestResult.kind !== "ready") {
    revalidatePath(`/repositories/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`);
    return { kind: "no-package-json" };
  }

  const manifest = await checkDependencyVersions(manifestResult.manifest);
  try {
    const persisted = await createCompletedScanWithFindings({
      githubRepositoryId: manifestResult.repository.githubRepositoryId,
      baseCommitSha: manifestResult.repository.baseCommitSha,
      startedAt,
      completedAt: new Date(),
      findings: manifest.dependencies,
    });
    if (persisted.kind === "not-connected" || persisted.kind === "invalid") return { kind: "error", error: "Sentinel could not save this scan snapshot." };
  } catch {
    return { kind: "error", error: "Sentinel completed the dependency check but could not save its snapshot." };
  }

  revalidatePath(`/repositories/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`);
  revalidatePath("/dashboard");
  return { kind: "completed" };
}
