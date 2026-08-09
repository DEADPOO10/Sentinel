"use server";

import { requireUser } from "@/lib/auth/session";
import { getRepositoryDependencyUsage, type RepositoryUsageContext } from "@/lib/github/dependency-usage";
import { getProposedFixContext } from "@/lib/github/proposed-fix-context";
import { getGitHubPackageJson, isValidGitHubRepository } from "@/lib/github/package-json";
import { createImpactAnalysisTicket, createProposedFixValidationTicket, getImpactAnalysisSnapshot, getProposedFixValidationSnapshot, verifyImpactAnalysisTicket, verifyProposedFixValidationTicket } from "@/lib/impact-analysis-ticket";
import { generateProposedFix, isProposedFixVerifiedForValidation, type ProposedFixResult } from "@/lib/openai/proposed-fix";
import { analyzeDependencyImpact, type DependencyImpactAnalysis } from "@/lib/openai/impact-analysis";
import { getReleaseInformation, type ReleaseInformationContext } from "@/lib/release-information";
import { createUnableToValidateResult, validateProposedFixInTemporaryWorkspace, type ProposedFixValidationResult } from "@/lib/validation/proposed-fix-validation";

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
  if (!impactAnalysis) {
    logSafeProposedFixActionEvent("ticket_validation_failed", { category: "invalid_analysis_snapshot" });
    return { kind: "error", error: "Generate a fresh AI impact analysis before requesting a proposed fix." };
  }
  if (!isValidGitHubRepository(input.owner, input.repository) || !isSafeDependencyName(input.dependencyName) || !dependencyTypes.has(input.dependencyType)) {
    logSafeProposedFixActionEvent("ticket_validation_failed", { category: "invalid_request" });
    return { kind: "error", error: "Generate a fresh AI impact analysis before requesting a proposed fix." };
  }
  if (!verifyImpactAnalysisTicket(input.analysisTicket, { userId: user.id, owner: input.owner, repository: input.repository, dependencyName: input.dependencyName, dependencyType: input.dependencyType, analysis: impactAnalysis })) {
    logSafeProposedFixActionEvent("ticket_validation_failed", { category: "invalid_or_expired_ticket" });
    return { kind: "error", error: "Generate a fresh AI impact analysis before requesting a proposed fix." };
  }

  const result = await getGitHubPackageJson(input.owner, input.repository).catch((error: unknown) => {
    logSafeProposedFixActionEvent("context_gathering_failed", { category: "package_json_request_error" });
    throw error;
  });
  if (result.kind !== "ready") {
    logSafeProposedFixActionEvent("context_gathering_failed", { category: "package_json_unavailable" });
    return { kind: "error", error: "Repository dependency data is unavailable. Please reload and try again." };
  }

  const dependency = result.manifest.dependencies.find((item) => item.name === input.dependencyName && item.type === input.dependencyType);
  if (!dependency || dependency.status !== "update-available" || !dependency.latestVersion || !dependency.changeType || !dependency.risk) {
    logSafeProposedFixActionEvent("pre_openai_failure", { category: "dependency_not_eligible" });
    return { kind: "error", error: "A proposed fix is available only for dependencies with an update available." };
  }
  const latestVersion = dependency.latestVersion;
  const changeType = dependency.changeType;
  const risk = dependency.risk;

  const proposedFixContext = await (async () => {
    const [repositoryUsage, releaseInformation] = await Promise.all([
      getRepositoryDependencyUsage(result.repository.owner, result.repository.name, dependency.name),
      getReleaseInformation({ packageName: dependency.name, declaredVersionRange: dependency.version, latestVersion, changeType, latestPublishedAt: dependency.publishedAt }),
    ]);
    const fixContext = await getProposedFixContext(result.repository.owner, result.repository.name, dependency, repositoryUsage);
    return { repositoryUsage, releaseInformation, fixContext };
  })().catch((error: unknown) => {
    logSafeProposedFixActionEvent("context_gathering_failed", { category: "unexpected_pre_openai_error" });
    throw error;
  });

  const proposedFixResult = await generateProposedFix({
    repository: result.repository,
    dependency: {
      name: dependency.name,
      currentVersion: dependency.version,
      latestVersion,
      changeType,
      risk,
      dependencyType: dependency.type,
    },
    impactAnalysis,
    repositoryUsage: proposedFixContext.repositoryUsage,
    releaseInformation: proposedFixContext.releaseInformation,
    fixContext: proposedFixContext.fixContext,
  });

  if (proposedFixResult.kind !== "proposal") return proposedFixResult;

  const validationTicket = createProposedFixValidationTicket({
    userId: user.id,
    owner: result.repository.owner,
    repository: result.repository.name,
    dependencyName: dependency.name,
    dependencyType: dependency.type,
    proposedFix: proposedFixResult.proposal,
  });
  if (!validationTicket) {
    logSafeProposedFixActionEvent("validation_ticket_unavailable", { category: "missing_ticket_secret" });
    return proposedFixResult;
  }

  return { ...proposedFixResult, validationTicket };
}

export async function requestProposedFixValidation(input: unknown): Promise<ProposedFixValidationResult> {
  const user = await requireUser();
  if (!isProposedFixValidationRequest(input)) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "invalid_request" });
    return createUnableToValidateResult("A fresh proposed fix is required before validation can run.");
  }

  const impactAnalysis = getImpactAnalysisSnapshot(input.analysis);
  const proposedFix = getProposedFixValidationSnapshot(input.proposal);
  if (!impactAnalysis || !proposedFix) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "invalid_client_snapshot" });
    return createUnableToValidateResult("A fresh proposed fix is required before validation can run.");
  }
  if (!isValidGitHubRepository(input.owner, input.repository) || !isSafeDependencyName(input.dependencyName) || !dependencyTypes.has(input.dependencyType)) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "invalid_repository_or_dependency" });
    return createUnableToValidateResult("This proposed fix cannot be validated.");
  }
  if (!verifyImpactAnalysisTicket(input.analysisTicket, {
    userId: user.id,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    analysis: impactAnalysis,
  })) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "invalid_or_expired_analysis_ticket" });
    return createUnableToValidateResult("Generate a fresh AI impact analysis before validating this proposal.");
  }
  if (!verifyProposedFixValidationTicket(input.proposedFixTicket, {
    userId: user.id,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    proposedFix,
  })) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "invalid_or_expired_proposed_fix_ticket" });
    return createUnableToValidateResult("Generate a fresh proposed fix before validation can run.");
  }

  let packageJsonResult;
  try {
    packageJsonResult = await getGitHubPackageJson(input.owner, input.repository);
  } catch {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "repository_access_request_failed" });
    return createUnableToValidateResult("Repository access could not be revalidated for this proposal.");
  }
  if (packageJsonResult.kind !== "ready") {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "repository_dependency_data_unavailable" });
    return createUnableToValidateResult("Repository dependency data could not be revalidated for this proposal.");
  }

  const dependency = packageJsonResult.manifest.dependencies.find((item) => item.name === input.dependencyName && item.type === input.dependencyType);
  if (!dependency || dependency.status !== "update-available" || !dependency.latestVersion || !dependency.changeType || !dependency.risk) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "dependency_not_eligible" });
    return createUnableToValidateResult("This dependency no longer has a validated update available.");
  }

  let repositoryUsage: RepositoryUsageContext;
  try {
    repositoryUsage = await getRepositoryDependencyUsage(packageJsonResult.repository.owner, packageJsonResult.repository.name, dependency.name);
  } catch {
    repositoryUsage = getUnavailableRepositoryUsageContext();
    logSafeProposedFixActionEvent("validation_context_unavailable", { category: "repository_usage" });
  }

  let fixContext;
  try {
    fixContext = await getProposedFixContext(packageJsonResult.repository.owner, packageJsonResult.repository.name, dependency, repositoryUsage);
  } catch {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "verified_context_request_failed" });
    return createUnableToValidateResult("Verified repository context could not be prepared for this proposal.");
  }

  const dependencyForValidation = {
    name: dependency.name,
    currentVersion: dependency.version,
    latestVersion: dependency.latestVersion,
    changeType: dependency.changeType,
    risk: dependency.risk,
    dependencyType: dependency.type,
  };
  if (!isProposedFixVerifiedForValidation({ proposal: proposedFix, dependency: dependencyForValidation, fixContext })) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "proposed_changes_not_verified" });
    return createUnableToValidateResult("Sentinel could not verify the proposed changes against the current repository context.");
  }

  return validateProposedFixInTemporaryWorkspace({
    owner: packageJsonResult.repository.owner,
    repository: packageJsonResult.repository.name,
    defaultBranch: packageJsonResult.repository.defaultBranch,
    dependencyType: dependency.type,
    proposedFix,
  });
}

function isSafeDependencyName(value: string) {
  return value.length > 0 && value.length <= 214 && /^[a-zA-Z0-9@._/-]+$/.test(value);
}

function isProposedFixValidationRequest(value: unknown): value is {
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  analysis: unknown;
  analysisTicket: string;
  proposal: unknown;
  proposedFixTicket: string;
} {
  return isRecord(value)
    && typeof value.owner === "string"
    && typeof value.repository === "string"
    && typeof value.dependencyName === "string"
    && typeof value.dependencyType === "string"
    && typeof value.analysisTicket === "string"
    && typeof value.proposedFixTicket === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function logSafeProposedFixActionEvent(event: string, details: Record<string, string>) {
  console.error("[sentinel:proposed-fix-action]", event, details);
}
