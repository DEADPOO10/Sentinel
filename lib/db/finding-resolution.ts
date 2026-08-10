import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { requireUser } from "@/lib/auth/session";

const GITHUB_REPOSITORY_ID_PATTERN = /^(?:0|[1-9]\d{0,18})$/;
const GIT_SHA_PATTERN = /^[a-f\d]{40,64}$/i;
const DEPENDENCY_TYPES = new Map([
  ["dependency", "DEPENDENCY"],
  ["devDependency", "DEV_DEPENDENCY"],
  ["peerDependency", "PEER_DEPENDENCY"],
  ["optionalDependency", "OPTIONAL_DEPENDENCY"],
] as const);

export type PersistedFindingIdentityInput = {
  githubRepositoryId: number | string;
  baseCommitSha: string | null;
  dependency: {
    packageName: string;
    dependencyType: "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
    declaredVersion: string;
    latestVersion: string;
  };
};

export type PersistedFindingIdentity = {
  githubRepositoryId: string;
  baseCommitSha: string | null;
  dependency: {
    packageName: string;
    dependencyType: "DEPENDENCY" | "DEV_DEPENDENCY" | "PEER_DEPENDENCY" | "OPTIONAL_DEPENDENCY";
    declaredVersion: string;
    latestVersion: string;
  };
};

export type FindingResolutionStage = "membership_verification" | "latest_scan_lookup" | "finding_resolution";
export type FindingResolutionUnavailableCategory = "repository_not_connected" | "latest_scan_unavailable" | "latest_scan_mismatch" | "finding_not_found_or_changed";
export type FindingResolutionClient = Pick<Prisma.TransactionClient, "userRepository" | "scan" | "finding">;

export function getPersistedFindingIdentity(input: PersistedFindingIdentityInput): PersistedFindingIdentity | null {
  const githubRepositoryId = getSafeGitHubRepositoryId(input.githubRepositoryId);
  const baseCommitSha = input.baseCommitSha === null ? null : getSafeGitSha(input.baseCommitSha);
  const dependencyType = DEPENDENCY_TYPES.get(input.dependency.dependencyType);
  const packageName = getSafeText(input.dependency.packageName, 214);
  const declaredVersion = getSafeText(input.dependency.declaredVersion, 256);
  const latestVersion = getSafeText(input.dependency.latestVersion, 64);
  if (!githubRepositoryId || !dependencyType || !packageName || !declaredVersion || !latestVersion || (input.baseCommitSha !== null && !baseCommitSha)) return null;

  return {
    githubRepositoryId,
    baseCommitSha,
    dependency: { packageName, dependencyType, declaredVersion, latestVersion },
  };
}

export async function getCurrentGitHubUserId() {
  const user = await requireUser();
  return getSafeText(user.id, 128);
}

/** Resolves only the current user's latest completed, unchanged update finding. */
export async function resolveLatestFindingForCurrentUser(
  client: FindingResolutionClient,
  githubUserId: string,
  identity: PersistedFindingIdentity,
  setStage: (stage: FindingResolutionStage) => void,
): Promise<{ findingId: string } | { kind: "unavailable"; category: FindingResolutionUnavailableCategory }> {
  setStage("membership_verification");
  const connection = await client.userRepository.findFirst({
    where: {
      user: { githubUserId },
      repository: { githubRepositoryId: identity.githubRepositoryId },
    },
    select: { repositoryId: true },
  });
  if (!connection) return { kind: "unavailable", category: "repository_not_connected" };

  setStage("latest_scan_lookup");
  const latestScan = await client.scan.findFirst({
    where: {
      repositoryId: connection.repositoryId,
      status: "COMPLETED",
      completedAt: { not: null },
    },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, baseCommitSha: true },
  });
  if (!latestScan) return { kind: "unavailable", category: "latest_scan_unavailable" };
  if (latestScan.baseCommitSha !== identity.baseCommitSha) return { kind: "unavailable", category: "latest_scan_mismatch" };

  setStage("finding_resolution");
  const finding = await client.finding.findUnique({
    where: {
      scanId_packageName_dependencyType: {
        scanId: latestScan.id,
        packageName: identity.dependency.packageName,
        dependencyType: identity.dependency.dependencyType,
      },
    },
    select: {
      id: true,
      declaredVersion: true,
      latestVersion: true,
      status: true,
    },
  });
  if (!finding || finding.declaredVersion !== identity.dependency.declaredVersion || finding.latestVersion !== identity.dependency.latestVersion || finding.status !== "UPDATE_AVAILABLE") {
    return { kind: "unavailable", category: "finding_not_found_or_changed" };
  }

  return { findingId: finding.id };
}

function getSafeGitHubRepositoryId(value: number | string) {
  const normalized = typeof value === "number" ? String(value) : value;
  return GITHUB_REPOSITORY_ID_PATTERN.test(normalized) ? normalized : null;
}

function getSafeGitSha(value: string) {
  return GIT_SHA_PATTERN.test(value) ? value : null;
}

function getSafeText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}
