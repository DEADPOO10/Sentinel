import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { getCurrentGitHubUserId } from "@/lib/db/finding-resolution";
import { getPrismaClient } from "@/lib/db/prisma";

const DEFAULT_ACTIVITY_LIMIT = 10;
const MAX_ACTIVITY_LIMIT = 10;

type ActivityScope =
  | { kind: "current_user"; githubUserId: string }
  | { kind: "repository"; repositoryId: string };

export type MaintenanceActivity = {
  key: string;
  kind: "scan" | "analysis" | "proposed_fix" | "validation" | "pull_request";
  repository: string;
  dependencyName?: string;
  action: string;
  status: string;
  tone: "default" | "success" | "warning" | "danger" | "info";
  occurredAt: Date;
  details?: string[];
  pullRequest?: { number: number; url: string };
};

/** Returns the newest persisted Sentinel activity visible to the authenticated user. */
export async function listRecentMaintenanceActivityForCurrentUser(limit = DEFAULT_ACTIVITY_LIMIT): Promise<MaintenanceActivity[]> {
  try {
    const githubUserId = await getCurrentGitHubUserId();
    if (!githubUserId) return [];

    return listRecentMaintenanceActivity({ kind: "current_user", githubUserId }, limit);
  } catch {
    logHistoryUnavailable("dashboard");
    return [];
  }
}

/** Returns activity only after confirming that the requested repository is connected to the current user. */
export async function listRecentMaintenanceActivityForRepository(githubRepositoryId: number | string, limit = 8): Promise<MaintenanceActivity[]> {
  const safeGitHubRepositoryId = getSafeGitHubRepositoryId(githubRepositoryId);
  if (!safeGitHubRepositoryId) return [];

  try {
    const githubUserId = await getCurrentGitHubUserId();
    if (!githubUserId) return [];

    const client = getPrismaClient();
    const connection = await client.userRepository.findFirst({
      where: {
        user: { githubUserId },
        repository: { githubRepositoryId: safeGitHubRepositoryId },
      },
      select: { repositoryId: true },
    });
    if (!connection) return [];

    return listRecentMaintenanceActivity({ kind: "repository", repositoryId: connection.repositoryId }, limit);
  } catch {
    logHistoryUnavailable("repository");
    return [];
  }
}

async function listRecentMaintenanceActivity(scope: ActivityScope, limit: number): Promise<MaintenanceActivity[]> {
  const take = getSafeLimit(limit);
  const client = getPrismaClient();
  const scanWhere = getScanWhere(scope);
  const findingWhere = getFindingWhere(scope);

  const [scans, analyses, proposedFixes, validations, pullRequests] = await Promise.all([
    client.scan.findMany({
      where: { ...scanWhere, status: "COMPLETED", completedAt: { not: null } },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
      take,
      select: {
        completedAt: true,
        repository: { select: { fullName: true } },
      },
    }),
    client.impactAnalysis.findMany({
      where: { finding: findingWhere },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        createdAt: true,
        finding: {
          select: {
            packageName: true,
            scan: { select: { repository: { select: { fullName: true } } } },
          },
        },
      },
    }),
    client.proposedFix.findMany({
      where: { finding: findingWhere },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        status: true,
        createdAt: true,
        finding: {
          select: {
            packageName: true,
            scan: { select: { repository: { select: { fullName: true } } } },
          },
        },
      },
    }),
    client.validationRun.findMany({
      where: { proposedFix: { finding: findingWhere } },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        overallStatus: true,
        typecheckStatus: true,
        lintStatus: true,
        testStatus: true,
        buildStatus: true,
        createdAt: true,
        proposedFix: {
          select: {
            finding: {
              select: {
                packageName: true,
                scan: { select: { repository: { select: { fullName: true } } } },
              },
            },
          },
        },
      },
    }),
    client.pullRequest.findMany({
      where: { proposedFix: { finding: findingWhere } },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        githubPrNumber: true,
        githubPrUrl: true,
        draft: true,
        status: true,
        createdAt: true,
        proposedFix: {
          select: {
            finding: {
              select: {
                packageName: true,
                scan: { select: { repository: { select: { fullName: true } } } },
              },
            },
          },
        },
      },
    }),
  ]);

  const activity = [
    ...scans.flatMap((scan) => scan.completedAt ? [createScanActivity(scan.repository.fullName, scan.completedAt)] : []),
    ...analyses.map((analysis) => createAnalysisActivity(analysis.finding.scan.repository.fullName, analysis.finding.packageName, analysis.createdAt)),
    ...proposedFixes.map((proposedFix) => createProposedFixActivity(proposedFix.finding.scan.repository.fullName, proposedFix.finding.packageName, proposedFix.status, proposedFix.createdAt)),
    ...validations.map((validation) => createValidationActivity(validation.proposedFix.finding.scan.repository.fullName, validation.proposedFix.finding.packageName, validation)),
    ...pullRequests.flatMap((pullRequest) => createPullRequestActivity(pullRequest.proposedFix.finding.scan.repository.fullName, pullRequest.proposedFix.finding.packageName, pullRequest)),
  ];

  return activity.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime()).slice(0, take);
}

function getScanWhere(scope: ActivityScope): Prisma.ScanWhereInput {
  return scope.kind === "repository"
    ? { repositoryId: scope.repositoryId }
    : { repository: { users: { some: { user: { githubUserId: scope.githubUserId } } } } };
}

function getFindingWhere(scope: ActivityScope): Prisma.FindingWhereInput {
  return { scan: getScanWhere(scope) };
}

function createScanActivity(repository: string, occurredAt: Date): MaintenanceActivity {
  return createActivity({
    kind: "scan",
    repository,
    action: "Repository scanned",
    status: "COMPLETED",
    tone: "success",
    occurredAt,
  });
}

function createAnalysisActivity(repository: string, dependencyName: string, occurredAt: Date): MaintenanceActivity {
  return createActivity({
    kind: "analysis",
    repository,
    dependencyName,
    action: "AI analysis completed",
    status: "COMPLETED",
    tone: "info",
    occurredAt,
  });
}

function createProposedFixActivity(repository: string, dependencyName: string, status: "PROPOSED" | "INSUFFICIENT_CONTEXT", occurredAt: Date): MaintenanceActivity {
  const proposalReady = status === "PROPOSED";
  return createActivity({
    kind: "proposed_fix",
    repository,
    dependencyName,
    action: proposalReady ? "Proposed fix generated" : "More fix context needed",
    status: proposalReady ? "PROPOSED" : "NEEDS CONTEXT",
    tone: proposalReady ? "info" : "warning",
    occurredAt,
  });
}

function createValidationActivity(
  repository: string,
  dependencyName: string,
  validation: {
    overallStatus: "PASSED" | "FAILED" | "PARTIAL" | "UNABLE_TO_VALIDATE";
    typecheckStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
    lintStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
    testStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
    buildStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
    createdAt: Date;
  },
): MaintenanceActivity {
  const status = getValidationStatus(validation.overallStatus);
  return createActivity({
    kind: "validation",
    repository,
    dependencyName,
    action: "Validation completed",
    status: status.label,
    tone: status.tone,
    occurredAt: validation.createdAt,
    details: getValidationDetails(validation),
  });
}

function createPullRequestActivity(
  repository: string,
  dependencyName: string,
  pullRequest: {
    githubPrNumber: number;
    githubPrUrl: string;
    draft: boolean;
    status: "DRAFT" | "OPEN" | "CLOSED" | "MERGED";
    createdAt: Date;
  },
): MaintenanceActivity[] {
  const url = getSafePullRequestUrl(pullRequest.githubPrUrl);
  if (!url || !Number.isSafeInteger(pullRequest.githubPrNumber) || pullRequest.githubPrNumber <= 0) return [];

  const isDraft = pullRequest.draft || pullRequest.status === "DRAFT";
  return [createActivity({
    kind: "pull_request",
    repository,
    dependencyName,
    action: `${isDraft ? "Draft PR" : "Pull request"} #${pullRequest.githubPrNumber} created`,
    status: isDraft ? "DRAFT" : pullRequest.status,
    tone: isDraft || pullRequest.status === "OPEN" ? "info" : "default",
    occurredAt: pullRequest.createdAt,
    pullRequest: { number: pullRequest.githubPrNumber, url },
  })];
}

function createActivity(activity: Omit<MaintenanceActivity, "key">): MaintenanceActivity {
  return {
    ...activity,
    key: [activity.kind, activity.repository, activity.dependencyName ?? "", activity.action, activity.occurredAt.getTime()].join(":"),
  };
}

function getValidationStatus(status: "PASSED" | "FAILED" | "PARTIAL" | "UNABLE_TO_VALIDATE") {
  if (status === "PASSED") return { label: "PASSED", tone: "success" as const };
  if (status === "FAILED") return { label: "FAILED", tone: "danger" as const };
  if (status === "PARTIAL") return { label: "PARTIAL", tone: "warning" as const };
  return { label: "UNABLE", tone: "default" as const };
}

function getValidationDetails(validation: {
  typecheckStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
  lintStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
  testStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
  buildStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
}) {
  const stages = [
    ["Typecheck", validation.typecheckStatus],
    ["Lint", validation.lintStatus],
    ["Tests", validation.testStatus],
    ["Build", validation.buildStatus],
  ] as const;
  return stages.flatMap(([name, status]) => status ? [`${name} ${getValidationStageLabel(status)}`] : []);
}

function getValidationStageLabel(status: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT") {
  if (status === "PASSED") return "✓";
  if (status === "FAILED") return "failed";
  if (status === "SKIPPED") return "skipped";
  return "timed out";
}

function getSafeGitHubRepositoryId(value: number | string) {
  const normalized = typeof value === "number" ? String(value) : value;
  return /^(?:0|[1-9]\d{0,18})$/.test(normalized) ? normalized : null;
}

function getSafePullRequestUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function getSafeLimit(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_ACTIVITY_LIMIT) : DEFAULT_ACTIVITY_LIMIT;
}

function logHistoryUnavailable(scope: "dashboard" | "repository") {
  console.error("[sentinel:activity] history_unavailable", { scope, category: "database_or_request_error" });
}
