import "server-only";

import { getCurrentGitHubUserId, getPersistedFindingIdentity } from "@/lib/db/finding-resolution";
import { resolvePersistedProposedFixForValidation, type ProposedFixPersistenceInput } from "@/lib/db/proposed-fixes";
import { getPrismaClient } from "@/lib/db/prisma";
import type { DraftPullRequestActionResult } from "@/lib/github/draft-pull-request";
import { isValidGitHubRepository } from "@/lib/github/package-json";

const MAX_RECENT_PULL_REQUESTS = 20;
const GIT_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const GIT_SHA_PATTERN = /^[a-f\d]{40,64}$/i;
const GITHUB_PULL_REQUEST_NUMBER_MAX = 2_147_483_647;

type ConfirmedDraftPullRequest = Extract<DraftPullRequestActionResult, { kind: "created" | "existing" }>;
type PullRequestPersistenceStage = "proposed_fix_resolved" | "pr_upsert" | "pr_reuse_lookup";
type PullRequestPersistenceUnavailableCategory = "invalid_input" | "repository_not_connected" | "latest_scan_unavailable" | "latest_scan_mismatch" | "finding_not_found_or_changed" | "proposed_fix_not_found_or_changed" | "database_error";

export type PullRequestPersistenceInput = ProposedFixPersistenceInput & {
  owner: string;
  repository: string;
  defaultBranch: string;
  pullRequest: ConfirmedDraftPullRequest;
};

export type PullRequestPersistenceResult =
  | { kind: "persisted"; pullRequestId: string }
  | { kind: "unavailable"; category: PullRequestPersistenceUnavailableCategory };

export type SavedPullRequest = {
  githubPrNumber: number;
  githubPrUrl: string;
  branchName: string;
  baseBranch: string;
  commitSha: string;
  draft: boolean;
  status: "draft" | "open" | "closed" | "merged";
  createdAt: Date;
};

/**
 * Records a confirmed GitHub pull request as product history. The live signed-ticket
 * checks and GitHub verification remain authoritative for all PR operations.
 */
export async function persistPullRequestForProposedFix(input: PullRequestPersistenceInput): Promise<PullRequestPersistenceResult> {
  const data = getPersistenceData(input);
  if (!data) return logUnavailable("proposed_fix_resolved", "invalid_input");

  console.info("[sentinel:pr-persistence] persistence_started", {});

  let stage: PullRequestPersistenceStage = "proposed_fix_resolved";
  try {
    const resolved = await resolvePersistedProposedFixForValidation(input);
    if (resolved.kind === "unavailable") {
      console.info("[sentinel:pr-persistence] proposed_fix_not_found", { stage, category: resolved.category });
      return { kind: "unavailable", category: resolved.category };
    }

    console.info("[sentinel:pr-persistence] proposed_fix_resolved", { stage });

    const client = getPrismaClient();
    stage = "pr_upsert";
    console.info("[sentinel:pr-persistence] pr_upsert", { stage });
    try {
      const saved = await client.pullRequest.upsert({
        where: { proposedFixId: resolved.proposedFixId },
        create: {
          proposedFixId: resolved.proposedFixId,
          githubPrNumber: data.githubPrNumber,
          githubPrUrl: data.githubPrUrl,
          branchName: data.branchName,
          baseBranch: data.baseBranch,
          commitSha: data.commitSha,
          draft: data.draft,
          status: data.status,
        },
        update: {
          githubPrNumber: data.githubPrNumber,
          githubPrUrl: data.githubPrUrl,
          branchName: data.branchName,
          baseBranch: data.baseBranch,
          commitSha: data.commitSha,
          draft: data.draft,
          status: data.status,
        },
        select: { id: true },
      });
      console.info("[sentinel:pr-persistence] pr_persisted", { stage });
      return { kind: "persisted", pullRequestId: saved.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      // Covers a concurrent create on the one-row-per-proposed-fix constraint.
      // Keep the recovery outside a failed transaction so PostgreSQL can serve it.
      stage = "pr_reuse_lookup";
      const existing = await client.pullRequest.findUnique({
        where: { proposedFixId: resolved.proposedFixId },
        select: { id: true },
      });
      if (!existing) throw error;

      const saved = await client.pullRequest.update({
        where: { proposedFixId: resolved.proposedFixId },
        data: {
          githubPrNumber: data.githubPrNumber,
          githubPrUrl: data.githubPrUrl,
          branchName: data.branchName,
          baseBranch: data.baseBranch,
          commitSha: data.commitSha,
          draft: data.draft,
          status: data.status,
        },
        select: { id: true },
      });
      console.info("[sentinel:pr-persistence] pr_persisted", { stage });
      return { kind: "persisted", pullRequestId: saved.id };
    }
  } catch (error) {
    logPersistenceFailure(stage, error);
    return { kind: "unavailable", category: "database_error" };
  }
}

/** Returns the current user's exact matching proposed fix's stored PR history record. */
export async function getPullRequestForProposedFix(input: ProposedFixPersistenceInput): Promise<SavedPullRequest | null> {
  try {
    const resolved = await resolvePersistedProposedFixForValidation(input);
    if (resolved.kind === "unavailable") return null;

    const pullRequest = await getPrismaClient().pullRequest.findUnique({
      where: { proposedFixId: resolved.proposedFixId },
      select: {
        githubPrNumber: true,
        githubPrUrl: true,
        branchName: true,
        baseBranch: true,
        commitSha: true,
        draft: true,
        status: true,
        createdAt: true,
      },
    });
    return pullRequest ? toSavedPullRequest(pullRequest) : null;
  } catch (error) {
    logPersistenceFailure("proposed_fix_resolved", error);
    return null;
  }
}

/** Returns recent Sentinel PR history only for a repository connected to the current user. */
export async function listRecentPullRequestsForRepository(githubRepositoryId: number | string, limit = 10): Promise<SavedPullRequest[]> {
  const repositoryId = getSafeGitHubRepositoryId(githubRepositoryId);
  if (!repositoryId) return [];

  try {
    const githubUserId = await getCurrentGitHubUserId();
    if (!githubUserId) return [];

    const client = getPrismaClient();
    const connection = await client.userRepository.findFirst({
      where: {
        user: { githubUserId },
        repository: { githubRepositoryId: repositoryId },
      },
      select: { repositoryId: true },
    });
    if (!connection) return [];

    const pullRequests = await client.pullRequest.findMany({
      where: {
        proposedFix: {
          finding: {
            scan: { repositoryId: connection.repositoryId },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: getSafeRecentLimit(limit),
      select: {
        githubPrNumber: true,
        githubPrUrl: true,
        branchName: true,
        baseBranch: true,
        commitSha: true,
        draft: true,
        status: true,
        createdAt: true,
      },
    });
    return pullRequests.flatMap((pullRequest) => {
      const saved = toSavedPullRequest(pullRequest);
      return saved ? [saved] : [];
    });
  } catch (error) {
    logPersistenceFailure("proposed_fix_resolved", error);
    return [];
  }
}

type PersistenceData = {
  githubPrNumber: number;
  githubPrUrl: string;
  branchName: string;
  baseBranch: string;
  commitSha: string;
  draft: boolean;
  status: "DRAFT" | "OPEN";
};

function getPersistenceData(input: PullRequestPersistenceInput): PersistenceData | null {
  if (!isValidGitHubRepository(input.owner, input.repository) || !getSafeGitReference(input.defaultBranch)) return null;

  const identity = getPersistedFindingIdentity(input);
  const baseCommitSha = input.baseCommitSha === null ? null : getSafeGitSha(input.baseCommitSha);
  if (!identity || !baseCommitSha) return null;

  const pullRequest = input.pullRequest;
  const githubPrNumber = getSafePullRequestNumber(pullRequest.prNumber);
  const githubPrUrl = getSafePullRequestUrl(pullRequest.prUrl, input.owner, input.repository, githubPrNumber);
  const branchName = getSafeGitReference(pullRequest.branchName);
  const baseBranch = getSafeGitReference(pullRequest.baseBranch);
  const commitSha = getSafeGitSha(pullRequest.commitSha);
  if (!githubPrNumber || !githubPrUrl || !branchName || !baseBranch || !commitSha
    || !branchName.startsWith("sentinel/")
    || baseBranch !== input.defaultBranch
    || pullRequest.dependencyName !== identity.dependency.packageName
    || pullRequest.declaredVersion !== identity.dependency.declaredVersion
    || pullRequest.targetVersion !== identity.dependency.latestVersion
    || typeof pullRequest.draft !== "boolean"
    || (pullRequest.kind === "created" && pullRequest.draft !== true)) return null;

  return {
    githubPrNumber,
    githubPrUrl,
    branchName,
    baseBranch,
    commitSha,
    draft: pullRequest.draft,
    status: pullRequest.draft ? "DRAFT" : "OPEN",
  };
}

function toSavedPullRequest(value: {
  githubPrNumber: number;
  githubPrUrl: string;
  branchName: string;
  baseBranch: string;
  commitSha: string;
  draft: boolean;
  status: "DRAFT" | "OPEN" | "CLOSED" | "MERGED";
  createdAt: Date;
}): SavedPullRequest | null {
  const githubPrNumber = getSafePullRequestNumber(value.githubPrNumber);
  const githubPrUrl = getSafeText(value.githubPrUrl, 2_048);
  const branchName = getSafeGitReference(value.branchName);
  const baseBranch = getSafeGitReference(value.baseBranch);
  const commitSha = getSafeGitSha(value.commitSha);
  const status = getSavedStatus(value.status);
  if (!githubPrNumber || !githubPrUrl || !branchName || !baseBranch || !commitSha || !status) return null;

  return { githubPrNumber, githubPrUrl, branchName, baseBranch, commitSha, draft: value.draft, status, createdAt: value.createdAt };
}

function getSafeGitHubRepositoryId(value: number | string) {
  const normalized = typeof value === "number" ? String(value) : value;
  return /^(?:0|[1-9]\d{0,18})$/.test(normalized) ? normalized : null;
}

function getSafePullRequestNumber(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= GITHUB_PULL_REQUEST_NUMBER_MAX ? value : null;
}

function getSafePullRequestUrl(value: unknown, owner: string, repository: string, prNumber: number | null) {
  if (typeof value !== "string" || !prNumber) return null;
  try {
    const url = new URL(value);
    const expectedPath = `/${owner}/${repository}/pull/${prNumber}`.toLowerCase();
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && url.pathname.toLowerCase() === expectedPath
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function getSafeGitReference(value: unknown) {
  return typeof value === "string"
    && GIT_REFERENCE_PATTERN.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/")
    ? value
    : null;
}

function getSafeGitSha(value: unknown) {
  return typeof value === "string" && GIT_SHA_PATTERN.test(value) ? value.toLowerCase() : null;
}

function getSafeText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}

function getSavedStatus(value: unknown): SavedPullRequest["status"] | null {
  if (value === "DRAFT") return "draft";
  if (value === "OPEN") return "open";
  if (value === "CLOSED") return "closed";
  if (value === "MERGED") return "merged";
  return null;
}

function getSafeRecentLimit(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_RECENT_PULL_REQUESTS) : 10;
}

function logUnavailable(stage: PullRequestPersistenceStage, category: PullRequestPersistenceUnavailableCategory): PullRequestPersistenceResult {
  console.info("[sentinel:pr-persistence] persistence_unavailable", { stage, category });
  return { kind: "unavailable", category };
}

function logPersistenceFailure(stage: PullRequestPersistenceStage, error: unknown) {
  const record = isRecord(error) ? error : null;
  const meta = record && isRecord(record.meta) ? record.meta : null;
  console.error("[sentinel:pr-persistence] persistence_failed", {
    stage,
    errorName: getSafeErrorName(error),
    prismaCode: getSafePrismaCode(record?.code),
    model: getSafeModelName(meta?.modelName),
    target: getSafeConstraintTarget(meta?.target),
    category: getSafeErrorCategory(record?.code),
  });
}

function isUniqueConstraintError(error: unknown) {
  return isRecord(error) && (error.code === "P2002" || error.code === "23505");
}

function getSafeErrorName(error: unknown) {
  return error instanceof Error && /^[A-Za-z][A-Za-z\d]{0,96}$/.test(error.name) ? error.name : "unknown_error";
}

function getSafePrismaCode(value: unknown) {
  return typeof value === "string" && /^(?:P\d{4}|\d{5})$/.test(value) ? value : null;
}

function getSafeModelName(value: unknown) {
  return value === "UserRepository" || value === "Scan" || value === "Finding" || value === "ProposedFix" || value === "PullRequest" ? value : null;
}

function getSafeConstraintTarget(value: unknown) {
  if (!Array.isArray(value)) return null;
  const target = value.filter((item): item is string => typeof item === "string" && /^[A-Za-z][A-Za-z\d_]{0,100}$/.test(item)).slice(0, 3);
  return target.length > 0 ? target.join(",") : null;
}

function getSafeErrorCategory(value: unknown) {
  if (value === "P2002" || value === "23505") return "unique_constraint";
  if (value === "P2003" || value === "23503") return "foreign_key_constraint";
  if (value === "P2028") return "transaction_closed";
  if (value === "P2034" || value === "40001") return "transaction_conflict";
  if (value === "P1001" || value === "P1002" || value === "P1008") return "database_connection_or_timeout";
  return "database_or_request_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
