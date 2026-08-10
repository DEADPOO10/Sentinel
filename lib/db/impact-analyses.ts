import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { requireUser } from "@/lib/auth/session";
import { getPrismaClient } from "@/lib/db/prisma";

const GITHUB_REPOSITORY_ID_PATTERN = /^(?:0|[1-9]\d{0,18})$/;
const GIT_SHA_PATTERN = /^[a-f\d]{40,64}$/i;
const DEPENDENCY_TYPES = new Map([
  ["dependency", "DEPENDENCY"],
  ["devDependency", "DEV_DEPENDENCY"],
  ["peerDependency", "PEER_DEPENDENCY"],
  ["optionalDependency", "OPTIONAL_DEPENDENCY"],
] as const);
const RISK_LEVELS = new Map([
  ["low", "LOW"],
  ["medium", "MEDIUM"],
  ["high", "HIGH"],
] as const);

type ImpactPersistenceStage = "membership_verification" | "latest_scan_lookup" | "finding_resolution" | "impact_analysis_upsert";
type ImpactPersistenceUnavailableCategory = "invalid_input" | "repository_not_connected" | "latest_scan_unavailable" | "latest_scan_mismatch" | "finding_not_found_or_changed" | "database_error";

export type ImpactAnalysisPersistenceInput = {
  githubRepositoryId: number | string;
  baseCommitSha: string | null;
  dependency: {
    packageName: string;
    dependencyType: "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
    declaredVersion: string;
    latestVersion: string;
  };
  analysis: {
    risk: "low" | "medium" | "high";
    confidence: number;
    summary: string;
    potentialImpact: string;
    riskExplanation: string;
    recommendedNextStep: string;
  };
};

export type SavedImpactAnalysis = {
  risk: "low" | "medium" | "high";
  confidence: number;
  summary: string;
  potentialImpact: string;
  riskExplanation: string;
  recommendedNextStep: string;
  createdAt: Date;
};

export type ImpactAnalysisPersistenceResult =
  | { kind: "persisted"; findingId: string }
  | { kind: "unavailable"; category: ImpactPersistenceUnavailableCategory };

/** Persists only a successful server-generated analysis for the current user's latest matching finding. */
export async function persistImpactAnalysisForFinding(input: ImpactAnalysisPersistenceInput): Promise<ImpactAnalysisPersistenceResult> {
  const data = getPersistenceData(input);
  if (!data) return logUnavailable("finding_resolution", "invalid_input");

  const githubUserId = await getCurrentGitHubUserId();
  if (!githubUserId) return logUnavailable("membership_verification", "repository_not_connected");

  let stage: ImpactPersistenceStage = "membership_verification";
  try {
    return await getPrismaClient().$transaction(async (transaction) => {
      const finding = await resolveLatestFindingForCurrentUser(transaction, githubUserId, data, (nextStage) => {
        stage = nextStage;
      });
      if ("kind" in finding) return logUnavailable(stage, finding.category);

      stage = "impact_analysis_upsert";
      const saved = await transaction.impactAnalysis.upsert({
        where: { findingId: finding.id },
        create: {
          findingId: finding.id,
          risk: data.analysis.risk,
          confidence: data.analysis.confidence,
          summary: data.analysis.summary,
          potentialImpact: data.analysis.potentialImpact,
          riskExplanation: data.analysis.riskExplanation,
          recommendation: data.analysis.recommendedNextStep,
          createdAt: new Date(),
        },
        update: {
          risk: data.analysis.risk,
          confidence: data.analysis.confidence,
          summary: data.analysis.summary,
          potentialImpact: data.analysis.potentialImpact,
          riskExplanation: data.analysis.riskExplanation,
          recommendation: data.analysis.recommendedNextStep,
          createdAt: new Date(),
        },
        select: { findingId: true },
      });

      return { kind: "persisted", findingId: saved.findingId };
    });
  } catch (error) {
    logPersistenceFailure(stage, error);
    return { kind: "unavailable", category: "database_error" };
  }
}

/** Returns a persisted analysis only when its finding belongs to the current user's latest matching scan. */
export async function getImpactAnalysisForFinding(input: Omit<ImpactAnalysisPersistenceInput, "analysis">): Promise<SavedImpactAnalysis | null> {
  const data = getFindingIdentity(input);
  if (!data) return null;

  const githubUserId = await getCurrentGitHubUserId();
  if (!githubUserId) return null;

  let stage: ImpactPersistenceStage = "membership_verification";
  try {
    return await getPrismaClient().$transaction(async (transaction) => {
      const finding = await resolveLatestFindingForCurrentUser(transaction, githubUserId, data, (nextStage) => {
        stage = nextStage;
      });
      if ("kind" in finding) return null;

      stage = "finding_resolution";
      const analysis = await transaction.impactAnalysis.findUnique({
        where: { findingId: finding.id },
        select: {
          risk: true,
          confidence: true,
          summary: true,
          potentialImpact: true,
          riskExplanation: true,
          recommendation: true,
          createdAt: true,
        },
      });
      return analysis ? toSavedImpactAnalysis(analysis) : null;
    });
  } catch (error) {
    logPersistenceFailure(stage, error);
    return null;
  }
}

type PersistenceData = {
  githubRepositoryId: string;
  baseCommitSha: string | null;
  dependency: {
    packageName: string;
    dependencyType: "DEPENDENCY" | "DEV_DEPENDENCY" | "PEER_DEPENDENCY" | "OPTIONAL_DEPENDENCY";
    declaredVersion: string;
    latestVersion: string;
  };
  analysis: {
    risk: "LOW" | "MEDIUM" | "HIGH";
    confidence: number;
    summary: string;
    potentialImpact: string;
    riskExplanation: string;
    recommendedNextStep: string;
  };
};

type FindingIdentity = Omit<PersistenceData, "analysis">;

function getPersistenceData(input: ImpactAnalysisPersistenceInput): PersistenceData | null {
  const identity = getFindingIdentity(input);
  const risk = RISK_LEVELS.get(input.analysis.risk);
  const confidence = getSafeConfidence(input.analysis.confidence);
  const summary = getSafeText(input.analysis.summary, 1_000);
  const potentialImpact = getSafeText(input.analysis.potentialImpact, 1_000);
  const riskExplanation = getSafeText(input.analysis.riskExplanation, 1_000);
  const recommendedNextStep = getSafeText(input.analysis.recommendedNextStep, 1_000);
  if (!identity || !risk || confidence === null || !summary || !potentialImpact || !riskExplanation || !recommendedNextStep) return null;

  return {
    ...identity,
    analysis: { risk, confidence, summary, potentialImpact, riskExplanation, recommendedNextStep },
  };
}

function getFindingIdentity(input: Omit<ImpactAnalysisPersistenceInput, "analysis">): FindingIdentity | null {
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

async function resolveLatestFindingForCurrentUser(
  transaction: Prisma.TransactionClient,
  githubUserId: string,
  identity: FindingIdentity,
  setStage: (stage: ImpactPersistenceStage) => void,
) {
  setStage("membership_verification");
  const connection = await transaction.userRepository.findFirst({
    where: {
      user: { githubUserId },
      repository: { githubRepositoryId: identity.githubRepositoryId },
    },
    select: { repositoryId: true },
  });
  if (!connection) return { kind: "unavailable" as const, category: "repository_not_connected" as const };

  setStage("latest_scan_lookup");
  const latestScan = await transaction.scan.findFirst({
    where: {
      repositoryId: connection.repositoryId,
      status: "COMPLETED",
      completedAt: { not: null },
    },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, baseCommitSha: true },
  });
  if (!latestScan) return { kind: "unavailable" as const, category: "latest_scan_unavailable" as const };
  if (latestScan.baseCommitSha !== identity.baseCommitSha) return { kind: "unavailable" as const, category: "latest_scan_mismatch" as const };

  setStage("finding_resolution");
  const finding = await transaction.finding.findUnique({
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
    return { kind: "unavailable" as const, category: "finding_not_found_or_changed" as const };
  }

  return finding;
}

function toSavedImpactAnalysis(analysis: {
  risk: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  summary: string;
  potentialImpact: string;
  riskExplanation: string;
  recommendation: string;
  createdAt: Date;
}): SavedImpactAnalysis {
  return {
    risk: analysis.risk.toLowerCase() as SavedImpactAnalysis["risk"],
    confidence: analysis.confidence,
    summary: analysis.summary,
    potentialImpact: analysis.potentialImpact,
    riskExplanation: analysis.riskExplanation,
    recommendedNextStep: analysis.recommendation,
    createdAt: analysis.createdAt,
  };
}

async function getCurrentGitHubUserId() {
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

function getSafeText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}

function getSafeConfidence(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function logUnavailable(stage: ImpactPersistenceStage, category: ImpactPersistenceUnavailableCategory): ImpactAnalysisPersistenceResult {
  console.info("[sentinel:impact-persistence] persistence_unavailable", { stage, category });
  return { kind: "unavailable", category };
}

function logPersistenceFailure(stage: ImpactPersistenceStage, error: unknown) {
  const record = isRecord(error) ? error : null;
  const meta = record && isRecord(record.meta) ? record.meta : null;
  console.error("[sentinel:impact-persistence] persistence_failed", {
    stage,
    errorName: getSafeErrorName(error),
    prismaCode: getSafePrismaCode(record?.code),
    model: getSafeModelName(meta?.modelName),
    target: getSafeConstraintTarget(meta?.target),
    category: getSafeErrorCategory(record?.code),
  });
}

function getSafeErrorName(error: unknown) {
  return error instanceof Error && /^[A-Za-z][A-Za-z\d]{0,96}$/.test(error.name) ? error.name : "unknown_error";
}

function getSafePrismaCode(value: unknown) {
  return typeof value === "string" && /^(?:P\d{4}|\d{5})$/.test(value) ? value : null;
}

function getSafeModelName(value: unknown) {
  return value === "UserRepository" || value === "Scan" || value === "Finding" || value === "ImpactAnalysis" ? value : null;
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
