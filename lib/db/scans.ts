import "server-only";

import { createHash } from "node:crypto";
import { requireUser } from "@/lib/auth/session";
import { getPrismaClient } from "@/lib/db/prisma";
import type { CheckedPackageDependency } from "@/lib/npm/dependency-versions";

const SCAN_IDEMPOTENCY_WINDOW_MS = 60_000;
const RECENT_SCAN_LIMIT = 10;
const MAX_FINDINGS_PER_SCAN = 5_000;
// Prisma defaults interactive transactions to a 2s acquisition window and a
// 5s lifetime. A cold or briefly contended database connection can exceed
// those limits before the first membership query begins, producing P2028.
// Keep the transaction bounded while giving this short persistence operation
// enough time to acquire a connection and atomically verify ownership.
const SCAN_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
const GITHUB_REPOSITORY_ID_PATTERN = /^(?:0|[1-9]\d{0,18})$/;
const GIT_SHA_PATTERN = /^[a-f\d]{40,64}$/i;
const DEPENDENCY_TYPES = new Map([
  ["dependency", "DEPENDENCY"],
  ["devDependency", "DEV_DEPENDENCY"],
  ["peerDependency", "PEER_DEPENDENCY"],
  ["optionalDependency", "OPTIONAL_DEPENDENCY"],
] as const);
const FINDING_STATUSES = new Map([
  ["up-to-date", "UP_TO_DATE"],
  ["update-available", "UPDATE_AVAILABLE"],
  ["ahead-of-npm-latest", "AHEAD_OF_NPM_LATEST"],
  ["unknown", "UNKNOWN"],
] as const);
const CHANGE_TYPES = new Map([
  ["major", "MAJOR"],
  ["minor", "MINOR"],
  ["patch", "PATCH"],
] as const);
const RISK_LEVELS = new Map([
  ["low", "LOW"],
  ["medium", "MEDIUM"],
  ["high", "HIGH"],
] as const);

type PersistedFinding = {
  packageName: string;
  dependencyType: "DEPENDENCY" | "DEV_DEPENDENCY" | "PEER_DEPENDENCY" | "OPTIONAL_DEPENDENCY";
  declaredVersion: string;
  latestVersion: string | null;
  changeType: "MAJOR" | "MINOR" | "PATCH" | null;
  risk: "LOW" | "MEDIUM" | "HIGH" | null;
  status: "UP_TO_DATE" | "UPDATE_AVAILABLE" | "AHEAD_OF_NPM_LATEST" | "UNKNOWN";
};

type ScanPersistenceStage = "membership_verification" | "existing_scan_lookup" | "scan_insert" | "scan_reuse_lookup" | "findings_insert" | "transaction_commit";

export type CompletedScanInput = {
  githubRepositoryId: number | string;
  baseCommitSha: string | null;
  startedAt: Date;
  completedAt: Date;
  findings: CheckedPackageDependency[];
};

export type CompletedScanPersistenceResult =
  | { kind: "created"; scanId: string }
  | { kind: "existing"; scanId: string }
  | { kind: "not-connected" }
  | { kind: "invalid" };

export type DashboardMaintenanceMetrics = {
  connectedRepositories: number;
  updatesAvailable: number;
  highRiskUpdates: number;
};

/**
 * Creates one immutable completed scan snapshot plus a batched set of findings.
 * The authenticated user must already be connected to the scanned repository.
 */
export async function createCompletedScanWithFindings(input: CompletedScanInput): Promise<CompletedScanPersistenceResult> {
  let stage: ScanPersistenceStage = "membership_verification";
  let client: ReturnType<typeof getPrismaClient> | null = null;
  let scan: ReturnType<typeof getCompletedScanData> = null;
  let githubUserId: string | null = null;
  try {
    scan = getCompletedScanData(input);
    if (!scan) return { kind: "invalid" };

    githubUserId = await getCurrentGithubUserId();
    if (!githubUserId) return { kind: "not-connected" };

    const scanData = scan;
    const currentGithubUserId = githubUserId;
    client = getPrismaClient();
    return await client.$transaction(async (transaction) => {
      stage = "membership_verification";
      const connection = await transaction.userRepository.findFirst({
        where: {
          user: { githubUserId: currentGithubUserId },
          repository: { githubRepositoryId: scanData.githubRepositoryId },
        },
        select: { repositoryId: true },
      });
      if (!connection) {
        stage = "transaction_commit";
        return { kind: "not-connected" };
      }

      stage = "existing_scan_lookup";
      const existing = await transaction.scan.findUnique({
        where: { idempotencyKey: scanData.idempotencyKey },
        select: { id: true, repositoryId: true, status: true, completedAt: true },
      });
      if (isReusableCompletedScan(existing, connection.repositoryId)) {
        logSafeScanPersistenceEvent("idempotency_reused", { source: "existing_lookup" });
        stage = "transaction_commit";
        return { kind: "existing", scanId: existing.id };
      }
      if (existing) throw new ScanPersistenceError("idempotency_key_mismatch");

      stage = "scan_insert";
      const insertedScan = await transaction.scan.createMany({
        data: {
          repositoryId: connection.repositoryId,
          idempotencyKey: scanData.idempotencyKey,
          status: "COMPLETED",
          baseCommitSha: scanData.baseCommitSha,
          dependencyCount: scanData.findings.length,
          updatesAvailable: scanData.findings.filter((finding) => finding.status === "UPDATE_AVAILABLE").length,
          highRiskCount: scanData.findings.filter((finding) => finding.status === "UPDATE_AVAILABLE" && finding.risk === "HIGH").length,
          startedAt: scanData.startedAt,
          completedAt: scanData.completedAt,
        },
        skipDuplicates: true,
      });

      if (insertedScan.count === 0) {
        stage = "scan_reuse_lookup";
        const reusedScan = await transaction.scan.findUnique({
          where: { idempotencyKey: scanData.idempotencyKey },
          select: { id: true, repositoryId: true, status: true, completedAt: true },
        });
        if (isReusableCompletedScan(reusedScan, connection.repositoryId)) {
          logSafeScanPersistenceEvent("idempotency_reused", { source: "conflict_safe_insert" });
          stage = "transaction_commit";
          return { kind: "existing", scanId: reusedScan.id };
        }

        throw new ScanPersistenceError("idempotency_lookup_after_conflict");
      }

      stage = "scan_reuse_lookup";
      const createdScan = await transaction.scan.findUnique({
        where: { idempotencyKey: scanData.idempotencyKey },
        select: { id: true, repositoryId: true, status: true, completedAt: true },
      });
      if (!isReusableCompletedScan(createdScan, connection.repositoryId)) {
        throw new ScanPersistenceError("created_scan_lookup_failed");
      }

      if (scanData.findings.length > 0) {
        stage = "findings_insert";
        await transaction.finding.createMany({
          data: scanData.findings.map((finding) => ({
            scanId: createdScan.id,
            ...finding,
            releaseEvidenceAvailable: false,
            repositoryUsageCount: 0,
          })),
        });
      }

      stage = "transaction_commit";
      return { kind: "created", scanId: createdScan.id };
    }, SCAN_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isUniqueConstraintError(error) && client && scan && githubUserId) {
      stage = "scan_reuse_lookup";
      try {
        const existing = await client.scan.findFirst({
          where: {
            idempotencyKey: scan.idempotencyKey,
            status: "COMPLETED",
            completedAt: { not: null },
            repository: {
              githubRepositoryId: scan.githubRepositoryId,
              users: { some: { user: { githubUserId } } },
            },
          },
          select: { id: true },
        });
        if (existing) {
          logSafeScanPersistenceEvent("idempotency_reused", { source: "unique_conflict_recovery" });
          return { kind: "existing", scanId: existing.id };
        }
      } catch (recoveryError) {
        logSafeScanFailure(stage, recoveryError);
        throw recoveryError;
      }
    }

    logSafeScanFailure(stage, error);
    throw error;
  }
}

/** Returns the latest successful scan visible to the authenticated connected user. */
export async function getLatestRepositoryScan(githubRepositoryId: number | string) {
  const repository = await getConnectedRepositoryForCurrentUser(githubRepositoryId);
  if (!repository) return null;

  return getPrismaClient().scan.findFirst({
    where: { repositoryId: repository.id, status: "COMPLETED", completedAt: { not: null } },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      baseCommitSha: true,
      dependencyCount: true,
      updatesAvailable: true,
      highRiskCount: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  });
}

/**
 * Returns the complete latest successful snapshot for the connected user.
 * This is deliberately a database-only read: callers must verify GitHub access
 * for the current request before using it to render a repository page.
 */
export async function getLatestRepositoryScanWithFindings(githubRepositoryId: number | string) {
  const repository = await getConnectedRepositoryForCurrentUser(githubRepositoryId);
  if (!repository) return null;

  return getPrismaClient().scan.findFirst({
    where: { repositoryId: repository.id, status: "COMPLETED", completedAt: { not: null } },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      baseCommitSha: true,
      dependencyCount: true,
      updatesAvailable: true,
      highRiskCount: true,
      completedAt: true,
      findings: {
        orderBy: [{ packageName: "asc" }, { dependencyType: "asc" }],
        select: {
          packageName: true,
          dependencyType: true,
          declaredVersion: true,
          latestVersion: true,
          changeType: true,
          risk: true,
          status: true,
        },
      },
    },
  });
}

/** Returns up to ten recent completed scans for repositories connected to the current user. */
export async function listRecentRepositoryScans(limit = 5) {
  const githubUserId = await getCurrentGithubUserId();
  if (!githubUserId) return [];

  return getPrismaClient().scan.findMany({
    where: {
      status: "COMPLETED",
      completedAt: { not: null },
      repository: { users: { some: { user: { githubUserId } } } },
    },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    take: getSafeRecentScanLimit(limit),
    select: {
      id: true,
      baseCommitSha: true,
      dependencyCount: true,
      updatesAvailable: true,
      highRiskCount: true,
      completedAt: true,
      repository: { select: { owner: true, name: true, fullName: true } },
    },
  });
}

/** Aggregates only the latest successful scan for each connected repository. */
export async function getDashboardMaintenanceMetricsForCurrentUser(): Promise<DashboardMaintenanceMetrics> {
  const githubUserId = await getCurrentGithubUserId();
  if (!githubUserId) return emptyDashboardMetrics();

  const connections = await getPrismaClient().userRepository.findMany({
    where: { user: { githubUserId } },
    select: {
      repository: {
        select: {
          scans: {
            where: { status: "COMPLETED", completedAt: { not: null } },
            orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
            take: 1,
            select: { updatesAvailable: true, highRiskCount: true },
          },
        },
      },
    },
  });

  return connections.reduce<DashboardMaintenanceMetrics>((metrics, connection) => {
    const latestScan = connection.repository.scans[0];
    return {
      connectedRepositories: metrics.connectedRepositories + 1,
      updatesAvailable: metrics.updatesAvailable + (latestScan?.updatesAvailable ?? 0),
      highRiskUpdates: metrics.highRiskUpdates + (latestScan?.highRiskCount ?? 0),
    };
  }, emptyDashboardMetrics());
}

function getCompletedScanData(input: CompletedScanInput) {
  const githubRepositoryId = getSafeGitHubRepositoryId(input.githubRepositoryId);
  const startedAt = getSafeDate(input.startedAt);
  const completedAt = getSafeDate(input.completedAt);
  const baseCommitSha = input.baseCommitSha === null ? null : getSafeGitSha(input.baseCommitSha);
  const findings = getPersistedFindings(input.findings);
  if (!githubRepositoryId || !startedAt || !completedAt || completedAt < startedAt || !findings || (input.baseCommitSha !== null && !baseCommitSha)) return null;

  return {
    githubRepositoryId,
    baseCommitSha,
    startedAt,
    completedAt,
    findings,
    idempotencyKey: createScanIdempotencyKey(githubRepositoryId, baseCommitSha, startedAt),
  };
}

function getPersistedFindings(value: CheckedPackageDependency[]) {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS_PER_SCAN) return null;

  const findingKeys = new Set<string>();
  const findings: PersistedFinding[] = [];
  for (const dependency of value) {
    const finding = getPersistedFinding(dependency);
    if (!finding) return null;

    const key = `${finding.dependencyType}:${finding.packageName}`;
    if (findingKeys.has(key)) return null;
    findingKeys.add(key);
    findings.push(finding);
  }

  return findings;
}

function getPersistedFinding(value: CheckedPackageDependency): PersistedFinding | null {
  const packageName = getSafeText(value.name, 214);
  const declaredVersion = getSafeText(value.version, 256);
  const latestVersion = value.latestVersion === null ? null : getSafeText(value.latestVersion, 64);
  const dependencyType = DEPENDENCY_TYPES.get(value.type);
  const status = FINDING_STATUSES.get(value.status);
  const changeType = value.changeType === null ? null : CHANGE_TYPES.get(value.changeType) ?? null;
  const risk = value.risk === null ? null : RISK_LEVELS.get(value.risk) ?? null;
  if (!packageName || !declaredVersion || !dependencyType || !status || (value.latestVersion !== null && !latestVersion)) return null;

  const isUpdate = status === "UPDATE_AVAILABLE";
  if ((isUpdate && (!latestVersion || !changeType || !risk)) || (!isUpdate && (changeType || risk))) return null;

  return { packageName, declaredVersion, latestVersion, dependencyType, status, changeType, risk };
}

function createScanIdempotencyKey(githubRepositoryId: string, baseCommitSha: string | null, startedAt: Date) {
  const window = Math.floor(startedAt.getTime() / SCAN_IDEMPOTENCY_WINDOW_MS);
  return createHash("sha256").update(`dependency-scan-v1:${githubRepositoryId}:${baseCommitSha ?? "unknown"}:${window}`).digest("base64url");
}

async function getConnectedRepositoryForCurrentUser(githubRepositoryId: number | string) {
  const safeRepositoryId = getSafeGitHubRepositoryId(githubRepositoryId);
  const githubUserId = await getCurrentGithubUserId();
  if (!safeRepositoryId || !githubUserId) return null;

  const connection = await getPrismaClient().userRepository.findFirst({
    where: {
      user: { githubUserId },
      repository: { githubRepositoryId: safeRepositoryId },
    },
    select: { repository: { select: { id: true } } },
  });
  return connection?.repository ?? null;
}

async function getCurrentGithubUserId() {
  const user = await requireUser();
  return getSafeText(user.id, 128);
}

function getSafeGitHubRepositoryId(value: number | string) {
  const normalized = typeof value === "number" ? String(value) : value;
  return GITHUB_REPOSITORY_ID_PATTERN.test(normalized) ? normalized : null;
}

function getSafeGitSha(value: string) {
  return GIT_SHA_PATTERN.test(value) ? value : null;
}

function getSafeDate(value: Date) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function getSafeText(value: string, maximumLength: number) {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}

function getSafeRecentScanLimit(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, RECENT_SCAN_LIMIT) : 5;
}

function emptyDashboardMetrics(): DashboardMaintenanceMetrics {
  return { connectedRepositories: 0, updatesAvailable: 0, highRiskUpdates: 0 };
}

function isReusableCompletedScan(scan: { id: string; repositoryId: string; status: string; completedAt: Date | null } | null, repositoryId: string): scan is { id: string; repositoryId: string; status: "COMPLETED"; completedAt: Date } {
  return scan?.repositoryId === repositoryId && scan.status === "COMPLETED" && scan.completedAt instanceof Date;
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

class ScanPersistenceError extends Error {
  constructor(readonly category: string) {
    super(category);
    this.name = "ScanPersistenceError";
  }
}

function logSafeScanPersistenceEvent(event: "idempotency_reused", details: { source: "existing_lookup" | "conflict_safe_insert" | "unique_conflict_recovery" }) {
  console.info("[sentinel:scan-persistence]", event, details);
}

function logSafeScanFailure(stage: ScanPersistenceStage, error: unknown) {
  const details = getSafePrismaErrorDetails(error);
  console.error("[sentinel:scan-persistence] persistence_failed", { stage, ...details });
}

function getSafePrismaErrorDetails(error: unknown) {
  const record = isRecord(error) ? error : null;
  const meta = record && isRecord(record.meta) ? record.meta : null;
  return {
    errorName: getSafeErrorName(error),
    prismaCode: getSafePrismaCode(record?.code),
    model: getSafeModelName(meta?.modelName),
    target: getSafeConstraintTarget(meta?.target),
    failureCategory: getSafePersistenceFailureCategory(error),
    messageCategory: getSafeErrorCategory(record?.code),
  };
}

function getSafeErrorName(error: unknown) {
  if (!(error instanceof Error) || !/^[A-Za-z][A-Za-z\d]{0,96}$/.test(error.name)) return "unknown_error";
  return error.name;
}

function getSafePrismaCode(value: unknown) {
  return typeof value === "string" && /^(?:P\d{4}|\d{5})$/.test(value) ? value : null;
}

function getSafeModelName(value: unknown) {
  return value === "UserRepository" || value === "Scan" || value === "Finding" ? value : null;
}

function getSafeConstraintTarget(value: unknown) {
  if (!Array.isArray(value)) return null;
  const target = value.filter((item): item is string => typeof item === "string" && /^[A-Za-z][A-Za-z\d_]{0,100}$/.test(item)).slice(0, 3);
  return target.length > 0 ? target.join(",") : null;
}

function getSafeErrorCategory(value: unknown) {
  if (value === "P2002" || value === "23505") return "unique_constraint";
  if (value === "P2003" || value === "23503") return "foreign_key_constraint";
  if (value === "P2011" || value === "23502") return "null_constraint";
  if (value === "P2028") return "transaction_closed";
  if (value === "P2034" || value === "40001") return "transaction_conflict";
  if (value === "P1001" || value === "P1002" || value === "P1008") return "database_connection_or_timeout";
  return "database_or_request_error";
}

function getSafePersistenceFailureCategory(error: unknown) {
  if (!(error instanceof ScanPersistenceError)) return null;

  return error.category === "idempotency_key_mismatch" || error.category === "idempotency_lookup_after_conflict" || error.category === "created_scan_lookup_failed"
    ? error.category
    : "unexpected_scan_persistence_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
