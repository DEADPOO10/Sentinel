"use server";

import { requireUser } from "@/lib/auth/session";
import { getRepositoryDependencyUsage, type RepositoryUsageContext } from "@/lib/github/dependency-usage";
import { getProposedFixContext } from "@/lib/github/proposed-fix-context";
import { getGitHubPackageJson, isValidGitHubRepository } from "@/lib/github/package-json";
import { createImpactAnalysisTicket, getImpactAnalysisSnapshot, verifyImpactAnalysisTicket } from "@/lib/impact-analysis-ticket";
import { generateProposedFix, type ProposedFixResult } from "@/lib/openai/proposed-fix";
import { analyzeDependencyImpact, type DependencyImpactAnalysis } from "@/lib/openai/impact-analysis";
import { getReleaseInformation, type ReleaseInformationContext } from "@/lib/release-information";

const dependencyTypes = new Set(["dependency", "devDependency", "peerDependency", "optionalDependency"]);

export type DependencyImpactAnalysisActionResult = { analysis: DependencyImpactAnalysis & { risk: "low" | "medium" | "high"; repositoryUsage: RepositoryUsageContext; releaseInformation: ReleaseInformationContext }; analysisTicket: string } | { error: string };

export async function requestDependencyImpactAnalysis(input: { owner: string; repository: string; dependencyName: string; dependencyType: string }): Promise<DependencyImpactAnalysisActionResult> {
  const user = await requireUser();

  if (!isValidGitHubRepository(input.owner, input.repository) || !isSafeDependencyName(input.dependencyName) || !dependencyTypes.has(input.dependencyType)) {
    return { error: "This dependency cannot be analyzed." };
  }

  const result = await getGitHubPackageJson(input.owner, input.repository);
  if (result.kind !== "ready") return { error: "Repository dependency data is unavailable. Please reload and try again." };

  const dependency = result.manifest.dependencies.find((item) => item.name === input.dependencyName && item.type === input.dependencyType);
  if (!dependency || dependency.status !== "update-available" || !dependency.latestVersion || !dependency.changeType || !dependency.risk) {
    return { error: "AI analysis is available only for dependencies with an update available." };
  }

  const [repositoryUsageResult, releaseInformationResult] = await Promise.allSettled([
    getRepositoryDependencyUsage(result.repository.owner, result.repository.name, dependency.name),
    getReleaseInformation({
      packageName: dependency.name,
      declaredVersionRange: dependency.version,
      latestVersion: dependency.latestVersion,
      changeType: dependency.changeType,
      latestPublishedAt: dependency.publishedAt,
    }),
  ]);
  const repositoryUsage = repositoryUsageResult.status === "fulfilled"
    ? repositoryUsageResult.value
    : getUnavailableRepositoryUsageContext();
  const releaseInformation = releaseInformationResult.status === "fulfilled"
    ? releaseInformationResult.value
    : getUnavailableReleaseInformation({
      packageName: dependency.name,
      declaredVersionRange: dependency.version,
      latestVersion: dependency.latestVersion,
      changeType: dependency.changeType,
      latestPublishedAt: dependency.publishedAt,
    });

  if (repositoryUsageResult.status === "rejected") {
    logSafeAiActionEvent("context_unavailable", { stage: "repository_usage", category: getFailureCategory(repositoryUsageResult.reason) });
  }
  if (releaseInformationResult.status === "rejected") {
    logSafeAiActionEvent("context_unavailable", { stage: "release_information", category: getFailureCategory(releaseInformationResult.reason) });
  }

  const analysisResult = await analyzeDependencyImpact({
    repository: {
      owner: result.repository.owner,
      name: result.repository.name,
      defaultBranch: result.repository.defaultBranch,
      packageName: result.manifest.name,
      packageVersion: result.manifest.version,
    },
    dependency: {
      name: dependency.name,
      currentVersion: dependency.version,
      latestVersion: dependency.latestVersion,
      changeType: dependency.changeType,
      risk: dependency.risk,
      dependencyType: dependency.type,
    },
    repositoryUsage,
    releaseInformation,
  });

  if ("error" in analysisResult) return analysisResult;
  const analysis = { ...analysisResult.analysis, risk: dependency.risk, repositoryUsage, releaseInformation };
  const analysisTicket = createImpactAnalysisTicket({ userId: user.id, owner: result.repository.owner, repository: result.repository.name, dependencyName: dependency.name, dependencyType: dependency.type, analysis });
  if (!analysisTicket) return { error: "Fix generation could not be enabled for this environment." };

  return { analysis, analysisTicket };
}

export async function requestProposedFix(input: { owner: string; repository: string; dependencyName: string; dependencyType: string; analysis: unknown; analysisTicket: string }): Promise<ProposedFixResult> {
  const user = await requireUser();
  const impactAnalysis = getImpactAnalysisSnapshot(input.analysis);
  if (!impactAnalysis || !isValidGitHubRepository(input.owner, input.repository) || !isSafeDependencyName(input.dependencyName) || !dependencyTypes.has(input.dependencyType) || !verifyImpactAnalysisTicket(input.analysisTicket, { userId: user.id, owner: input.owner, repository: input.repository, dependencyName: input.dependencyName, dependencyType: input.dependencyType, analysis: impactAnalysis })) {
    return { kind: "error", error: "Generate a fresh AI impact analysis before requesting a proposed fix." };
  }

  const result = await getGitHubPackageJson(input.owner, input.repository);
  if (result.kind !== "ready") return { kind: "error", error: "Repository dependency data is unavailable. Please reload and try again." };

  const dependency = result.manifest.dependencies.find((item) => item.name === input.dependencyName && item.type === input.dependencyType);
  if (!dependency || dependency.status !== "update-available" || !dependency.latestVersion || !dependency.changeType || !dependency.risk) {
    return { kind: "error", error: "A proposed fix is available only for dependencies with an update available." };
  }

  const [repositoryUsage, releaseInformation] = await Promise.all([
    getRepositoryDependencyUsage(result.repository.owner, result.repository.name, dependency.name),
    getReleaseInformation({ packageName: dependency.name, declaredVersionRange: dependency.version, latestVersion: dependency.latestVersion, changeType: dependency.changeType, latestPublishedAt: dependency.publishedAt }),
  ]);
  const fixContext = await getProposedFixContext(result.repository.owner, result.repository.name, dependency, repositoryUsage);

  return generateProposedFix({
    repository: result.repository,
    dependency: {
      name: dependency.name,
      currentVersion: dependency.version,
      latestVersion: dependency.latestVersion,
      changeType: dependency.changeType,
      risk: dependency.risk,
      dependencyType: dependency.type,
    },
    impactAnalysis,
    repositoryUsage,
    releaseInformation,
    fixContext,
  });
}

function isSafeDependencyName(value: string) {
  return value.length > 0 && value.length <= 214 && /^[a-zA-Z0-9@._/-]+$/.test(value);
}

function getUnavailableRepositoryUsageContext(): RepositoryUsageContext {
  return { inspectionStatus: "unavailable", filesInspected: 0, matchingFiles: 0, usages: [] };
}

function getUnavailableReleaseInformation(input: {
  packageName: string;
  declaredVersionRange: string;
  latestVersion: string;
  changeType: "major" | "minor" | "patch";
  latestPublishedAt: string | null;
}): ReleaseInformationContext {
  return {
    availability: "unavailable",
    source: "unavailable",
    packageName: input.packageName,
    declaredVersionRange: input.declaredVersionRange,
    baseVersion: null,
    latestVersion: input.latestVersion,
    changeType: input.changeType,
    latestPublishedAt: input.latestPublishedAt,
    releasesExamined: 0,
    breakingChangeIndicators: 0,
    migrationIndicators: 0,
    evidence: [],
  };
}

function getFailureCategory(error: unknown) {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "external_context_error";
}

function logSafeAiActionEvent(event: string, details: Record<string, string>) {
  console.error("[sentinel:ai-analysis-action]", event, details);
}
