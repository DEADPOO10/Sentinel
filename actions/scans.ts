"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { connectRepositoryToCurrentSentinelUser } from "@/lib/db/repositories";
import { getRateLimitMessage, reserveCostlyOperation } from "@/lib/db/rate-limits";
import { createCompletedScanWithFindings } from "@/lib/db/scans";
import { getGitHubPackageManifestForRepository, getGitHubRepositoryDetails, isValidGitHubRepository } from "@/lib/github/package-json";
import { logger } from "@/lib/logger";
import { checkDependencyVersions } from "@/lib/npm/dependency-versions";
import { createOperationId, getOperationId, withOperationId } from "@/lib/observability/context";

export type RefreshRepositoryScanResult = { kind: "completed" | "no-package-json" } | { kind: "error"; error: string };

/** Runs as its own authenticated request, never as work left after rendering. */
export async function refreshRepositoryScan(input: { owner: string; repository: string }): Promise<RefreshRepositoryScanResult> {
  const operationId = getOperationId() ?? createOperationId();
  return withOperationId(operationId, () => refreshRepositoryScanWithContext(input));
}

async function refreshRepositoryScanWithContext(input: { owner: string; repository: string }): Promise<RefreshRepositoryScanResult> {
  const user = await requireUser();
  const requestedAt = Date.now();
  const repositoryIdentifier = `${input.owner}/${input.repository}`;
  const logContext = (metadata: Record<string, unknown>, startedAt = requestedAt) => ({
    service: "sentinel-repository-scan",
    userIdentifier: user.id,
    repositoryIdentifier,
    durationMs: Date.now() - startedAt,
    metadata,
  });

  logger.info("repository_scan.requested", logContext({ outcome: "requested" }));

  if (!isValidGitHubRepository(input.owner, input.repository)) {
    logger.warn("repository_scan.failed", logContext({
      outcome: "rejected",
      category: "invalid_repository_identifier",
    }));
    return { kind: "error", error: "This repository selection is invalid." };
  }

  const repositoryResult = await getGitHubRepositoryDetails(input.owner, input.repository);
  if (repositoryResult.kind !== "ready") {
    logger.error("repository_scan.failed", logContext({
      outcome: "failed",
      category: repositoryResult.kind === "not-found" ? "repository_not_found" : "repository_fetch_failed",
    }));
    return { kind: "error", error: repositoryResult.kind === "not-found" ? "This repository is no longer available to your GitHub account." : repositoryResult.error };
  }

  try {
    await connectRepositoryToCurrentSentinelUser(repositoryResult.repository);
  } catch {
    logger.error("repository_scan.failed", logContext({
      outcome: "failed",
      category: "repository_connection_failed",
    }));
    return { kind: "error", error: "Sentinel could not connect this repository to your workspace." };
  }

  const rateLimit = await reserveCostlyOperation({
    operation: "REPOSITORY_SCAN",
    userId: user.id,
    githubRepositoryId: repositoryResult.repository.githubRepositoryId,
  });
  if (rateLimit.kind !== "allowed") {
    logger.warn("repository_scan.rate_limit_rejected", logContext({
      outcome: "rejected",
      category: rateLimit.kind === "limited" ? "limit_exceeded" : "limiter_unavailable",
      ...(rateLimit.kind === "limited" ? {
        scope: rateLimit.scope,
        window: rateLimit.window,
      } : {}),
    }));
    return { kind: "error", error: getRateLimitMessage("REPOSITORY_SCAN", rateLimit) };
  }

  const startedAt = new Date();
  logger.info("repository_scan.started", logContext({ outcome: "started" }, startedAt.getTime()));
  const manifestResult = await getGitHubPackageManifestForRepository(repositoryResult.repository);
  if (manifestResult.kind === "not-found") {
    logger.error("repository_scan.failed", logContext({
      outcome: "failed",
      category: "repository_not_found",
    }, startedAt.getTime()));
    return { kind: "error", error: "This repository is no longer available to your GitHub account." };
  }
  if (manifestResult.kind === "error") {
    logger.error("repository_scan.failed", logContext({
      outcome: "failed",
      category: "package_manifest_fetch_failed",
    }, startedAt.getTime()));
    return { kind: "error", error: manifestResult.error };
  }
  if (manifestResult.kind !== "ready") {
    logger.info("repository_scan.completed", logContext({
      outcome: "no_package_json",
    }, startedAt.getTime()));
    revalidatePath(`/repositories/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`);
    return { kind: "no-package-json" };
  }

  const manifest = await checkDependencyVersions(manifestResult.manifest).catch((error: unknown) => {
    logger.error("repository_scan.failed", logContext({
      outcome: "failed",
      category: "dependency_intelligence_failed",
    }, startedAt.getTime()));
    throw error;
  });
  try {
    const persisted = await createCompletedScanWithFindings({
      githubRepositoryId: manifestResult.repository.githubRepositoryId,
      baseCommitSha: manifestResult.repository.baseCommitSha,
      startedAt,
      completedAt: new Date(),
      findings: manifest.dependencies,
    });
    if (persisted.kind === "not-connected" || persisted.kind === "invalid") {
      logger.error("repository_scan.failed", logContext({
        outcome: "failed",
        category: persisted.kind === "not-connected" ? "repository_not_connected" : "scan_snapshot_invalid",
      }, startedAt.getTime()));
      return { kind: "error", error: "Sentinel could not save this scan snapshot." };
    }
  } catch {
    logger.error("repository_scan.failed", logContext({
      outcome: "failed",
      category: "scan_persistence_failed",
    }, startedAt.getTime()));
    return { kind: "error", error: "Sentinel completed the dependency check but could not save its snapshot." };
  }

  revalidatePath(`/repositories/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`);
  revalidatePath("/dashboard");
  logger.info("repository_scan.completed", logContext({
    outcome: "completed",
    dependencyCount: manifest.dependencies.length,
  }, startedAt.getTime()));
  return { kind: "completed" };
}
