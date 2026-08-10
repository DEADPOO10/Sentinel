"use server";

import { requireUser } from "@/lib/auth/session";
import { persistImpactAnalysisForFinding } from "@/lib/db/impact-analyses";
import { persistProposedFixForFinding } from "@/lib/db/proposed-fixes";
import { getRepositoryDependencyUsage, type RepositoryUsageContext } from "@/lib/github/dependency-usage";
import { createDraftPullRequestFromVerifiedChanges, getGitHubRepositoryBaseForCurrentUser, type DraftPullRequestActionResult as GitHubDraftPullRequestActionResult } from "@/lib/github/draft-pull-request";
import { getProposedFixContext } from "@/lib/github/proposed-fix-context";
import { getGitHubPackageJson, isValidGitHubRepository } from "@/lib/github/package-json";
import { createCompletedValidationPrTicket, createImpactAnalysisTicket, createProposedFixValidationTicket, getCompletedValidationResultSnapshot, getImpactAnalysisSnapshot, getProposedFixValidationSnapshot, verifyCompletedValidationPrTicket, verifyImpactAnalysisTicket, verifyProposedFixValidationTicket } from "@/lib/impact-analysis-ticket";
import { generateProposedFix, isProposedFixVerifiedForValidation, type ProposedFixResult } from "@/lib/openai/proposed-fix";
import { analyzeDependencyImpact, type DependencyImpactAnalysis } from "@/lib/openai/impact-analysis";
import { getReleaseInformation, type ReleaseInformationContext } from "@/lib/release-information";
import { createUnableToValidateResult, isProposedFixValidationEligibleForDraftPullRequest, validateProposedFixInTemporaryWorkspace, type ProposedFixValidationResult } from "@/lib/validation/proposed-fix-validation";

const dependencyTypes = new Set(["dependency", "devDependency", "peerDependency", "optionalDependency"]);

export type DependencyImpactAnalysisActionResult = { analysis: DependencyImpactAnalysis & { risk: "low" | "medium" | "high"; repositoryUsage: RepositoryUsageContext; releaseInformation: ReleaseInformationContext }; analysisTicket: string } | { error: string };
export type ProposedFixValidationActionResult = { validation: ProposedFixValidationResult; validationTicket?: string };
export type DraftPullRequestActionResult = GitHubDraftPullRequestActionResult;

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
  await persistImpactAnalysisForFinding({
    githubRepositoryId: result.repository.githubRepositoryId,
    baseCommitSha: result.repository.baseCommitSha,
    dependency: {
      packageName: dependency.name,
      dependencyType: dependency.type,
      declaredVersion: dependency.version,
      latestVersion: dependency.latestVersion,
    },
    analysis,
  });
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

  // Persistence is intentionally best-effort. A verified proposal and its signed
  // validation ticket must remain usable if Neon is temporarily unavailable.
  await persistProposedFixForFinding({
    githubRepositoryId: result.repository.githubRepositoryId,
    baseCommitSha: result.repository.baseCommitSha,
    dependency: {
      packageName: dependency.name,
      dependencyType: dependency.type,
      declaredVersion: dependency.version,
      latestVersion,
    },
    proposal: proposedFixResult.proposal,
  });

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

export async function requestProposedFixValidation(input: unknown): Promise<ProposedFixValidationActionResult> {
  const user = await requireUser();
  if (!isProposedFixValidationRequest(input)) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "invalid_request" });
    return validationActionResult(createUnableToValidateResult("A fresh proposed fix is required before validation can run."));
  }

  const impactAnalysis = getImpactAnalysisSnapshot(input.analysis);
  const proposedFix = getProposedFixValidationSnapshot(input.proposal);
  if (!impactAnalysis || !proposedFix) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "invalid_client_snapshot" });
    return validationActionResult(createUnableToValidateResult("A fresh proposed fix is required before validation can run."));
  }
  if (!isValidGitHubRepository(input.owner, input.repository) || !isSafeDependencyName(input.dependencyName) || !dependencyTypes.has(input.dependencyType)) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "invalid_repository_or_dependency" });
    return validationActionResult(createUnableToValidateResult("This proposed fix cannot be validated."));
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
    return validationActionResult(createUnableToValidateResult("Generate a fresh AI impact analysis before validating this proposal."));
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
    return validationActionResult(createUnableToValidateResult("Generate a fresh proposed fix before validation can run."));
  }

  let packageJsonResult;
  try {
    packageJsonResult = await getGitHubPackageJson(input.owner, input.repository);
  } catch {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "repository_access_request_failed" });
    return validationActionResult(createUnableToValidateResult("Repository access could not be revalidated for this proposal."));
  }
  if (packageJsonResult.kind !== "ready") {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "repository_dependency_data_unavailable" });
    return validationActionResult(createUnableToValidateResult("Repository dependency data could not be revalidated for this proposal."));
  }

  const dependency = packageJsonResult.manifest.dependencies.find((item) => item.name === input.dependencyName && item.type === input.dependencyType);
  if (!dependency || dependency.status !== "update-available" || !dependency.latestVersion || !dependency.changeType || !dependency.risk) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "dependency_not_eligible" });
    return validationActionResult(createUnableToValidateResult("This dependency no longer has a validated update available."));
  }

  const repositoryBase = await getGitHubRepositoryBaseForCurrentUser(packageJsonResult.repository.owner, packageJsonResult.repository.name);
  if (repositoryBase.kind !== "ready" || repositoryBase.repository.defaultBranch !== packageJsonResult.repository.defaultBranch) {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: repositoryBase.kind === "error" ? `base_commit_${repositoryBase.category}` : "base_branch_changed" });
    return validationActionResult(createUnableToValidateResult("The repository changed while Sentinel prepared validation. Run analysis again before validating this proposal."));
  }

  let repositoryUsage: RepositoryUsageContext;
  try {
    repositoryUsage = await getRepositoryDependencyUsage(packageJsonResult.repository.owner, packageJsonResult.repository.name, dependency.name, repositoryBase.repository.baseCommitSha);
  } catch {
    repositoryUsage = getUnavailableRepositoryUsageContext();
    logSafeProposedFixActionEvent("validation_context_unavailable", { category: "repository_usage" });
  }

  let fixContext;
  try {
    fixContext = await getProposedFixContext(packageJsonResult.repository.owner, packageJsonResult.repository.name, dependency, repositoryUsage, repositoryBase.repository.baseCommitSha);
  } catch {
    logSafeProposedFixActionEvent("validation_preflight_failed", { category: "verified_context_request_failed" });
    return validationActionResult(createUnableToValidateResult("Verified repository context could not be prepared for this proposal."));
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
    return validationActionResult(createUnableToValidateResult("Sentinel could not verify the proposed changes against the current repository context."));
  }

  const validation = await validateProposedFixInTemporaryWorkspace({
    owner: repositoryBase.repository.owner,
    repository: repositoryBase.repository.repository,
    defaultBranch: repositoryBase.repository.defaultBranch,
    baseCommitSha: repositoryBase.repository.baseCommitSha,
    dependencyType: dependency.type,
    proposedFix,
  });
  if (!isProposedFixValidationEligibleForDraftPullRequest(validation) || !isPullRequestCreationEnabled()) return validationActionResult(validation);
  if (validation.baseBranch !== repositoryBase.repository.defaultBranch || validation.baseCommitSha !== repositoryBase.repository.baseCommitSha) {
    logSafeProposedFixActionEvent("validation_ticket_unavailable", { category: "validation_base_binding_mismatch" });
    return validationActionResult(validation);
  }

  const validationTicket = createCompletedValidationPrTicket({
    userId: user.id,
    owner: repositoryBase.repository.owner,
    repository: repositoryBase.repository.repository,
    dependencyName: dependency.name,
    dependencyType: dependency.type,
    defaultBranch: repositoryBase.repository.defaultBranch,
    baseCommitSha: repositoryBase.repository.baseCommitSha,
    analysis: impactAnalysis,
    proposedFix,
    validationResult: getValidationTicketSnapshotInput(validation),
  });
  if (!validationTicket) {
    logSafeProposedFixActionEvent("validation_ticket_unavailable", { category: "completed_validation_ticket_unavailable" });
    return validationActionResult(validation);
  }
  return validationActionResult(validation, validationTicket);
}

const draftPullRequestRequests = new Map<string, Promise<DraftPullRequestActionResult>>();

export async function requestDraftPullRequest(input: unknown): Promise<DraftPullRequestActionResult> {
  const user = await requireUser();
  if (!isPullRequestCreationEnabled()) {
    return { kind: "error", error: "Draft pull request creation is disabled in this environment." };
  }
  if (!isDraftPullRequestRequest(input)) {
    logSafePrActionEvent("creation_preflight_failed", { category: "invalid_request" });
    return { kind: "error", error: "A fresh validated proposal is required before creating a draft PR." };
  }
  if (!isValidGitHubRepository(input.owner, input.repository) || !isSafeDependencyName(input.dependencyName) || !dependencyTypes.has(input.dependencyType)) {
    logSafePrActionEvent("creation_preflight_failed", { category: "invalid_repository_or_dependency" });
    return { kind: "error", error: "A fresh validated proposal is required before creating a draft PR." };
  }

  const impactAnalysis = getImpactAnalysisSnapshot(input.analysis);
  const proposedFix = getProposedFixValidationSnapshot(input.proposal);
  const validation = getDraftPullRequestValidationResult(input.validation);
  if (!impactAnalysis || !proposedFix || !validation) {
    logSafePrActionEvent("creation_preflight_failed", { category: "invalid_client_snapshot" });
    return { kind: "error", error: "A fresh validated proposal is required before creating a draft PR." };
  }
  if (!verifyImpactAnalysisTicket(input.analysisTicket, {
    userId: user.id,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    analysis: impactAnalysis,
  }) || !verifyProposedFixValidationTicket(input.proposedFixTicket, {
    userId: user.id,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    proposedFix,
  })) {
    logSafePrActionEvent("creation_preflight_failed", { category: "invalid_analysis_or_proposal_ticket" });
    return { kind: "error", error: "Generate and validate a fresh proposed fix before creating a draft PR." };
  }

  const validationBinding = verifyCompletedValidationPrTicket(input.validationTicket, {
    userId: user.id,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    analysis: impactAnalysis,
    proposedFix,
    validationResult: getValidationTicketSnapshotInput(validation),
  });
  if (!validationBinding || !isProposedFixValidationEligibleForDraftPullRequest(validation)) {
    logSafePrActionEvent("creation_preflight_failed", { category: "invalid_or_ineligible_validation_ticket" });
    return { kind: "error", error: "Run a fresh eligible validation before creating a draft PR." };
  }
  if (validation.baseBranch !== validationBinding.defaultBranch || validation.baseCommitSha !== validationBinding.baseCommitSha) {
    logSafePrActionEvent("creation_preflight_failed", { category: "validation_base_binding_mismatch" });
    return { kind: "error", error: "The repository changed after validation. Run analysis and validation again before creating a PR." };
  }

  const packageJsonResult = await getGitHubPackageJson(input.owner, input.repository).catch(() => null);
  if (!packageJsonResult || packageJsonResult.kind !== "ready") {
    logSafePrActionEvent("creation_preflight_failed", { category: "repository_dependency_data_unavailable" });
    return { kind: "error", error: "Repository dependency data could not be revalidated before creating a draft PR." };
  }
  const dependency = packageJsonResult.manifest.dependencies.find((item) => item.name === input.dependencyName && item.type === input.dependencyType);
  if (!dependency || dependency.status !== "update-available" || !dependency.latestVersion || !dependency.changeType || !dependency.risk
    || dependency.version !== proposedFix.packageJsonChange.from
    || dependency.latestVersion !== proposedFix.packageJsonChange.to
    || proposedFix.packageJsonChange.dependency !== dependency.name) {
    logSafePrActionEvent("creation_preflight_failed", { category: "dependency_changed" });
    return { kind: "error", error: "This dependency no longer has the expected update. Run analysis and validation again." };
  }

  const repositoryBase = await getGitHubRepositoryBaseForCurrentUser(input.owner, input.repository, true);
  if (repositoryBase.kind !== "ready") {
    logSafePrActionEvent("creation_preflight_failed", { category: `repository_${repositoryBase.category}` });
    return { kind: "error", error: getRepositoryWritePreflightError(repositoryBase.category) };
  }
  if (repositoryBase.repository.defaultBranch !== validationBinding.defaultBranch || repositoryBase.repository.baseCommitSha !== validationBinding.baseCommitSha) {
    logSafePrActionEvent("creation_preflight_failed", { category: "stale_base_commit" });
    return { kind: "error", error: "The repository changed after validation. Run analysis and validation again before creating a PR." };
  }

  const draftPullRequestInput = {
    owner: repositoryBase.repository.owner,
    repository: repositoryBase.repository.repository,
    defaultBranch: validationBinding.defaultBranch,
    baseCommitSha: validationBinding.baseCommitSha,
    dependency: {
      name: dependency.name,
      declaredVersion: dependency.version,
      latestVersion: dependency.latestVersion,
      changeType: dependency.changeType,
      risk: dependency.risk,
      dependencyType: dependency.type,
    },
    proposedFix,
    validation,
    impactAnalysis,
    proposedChangeIdentifier: validationBinding.proposedChangeIdentifier,
  };

  return runDraftPullRequestIdempotently(input.validationTicket, () => createDraftPullRequestFromVerifiedChanges(draftPullRequestInput));
}

function validationActionResult(validation: ProposedFixValidationResult, validationTicket?: string): ProposedFixValidationActionResult {
  return validationTicket ? { validation, validationTicket } : { validation };
}

function getValidationTicketSnapshotInput(validation: ProposedFixValidationResult) {
  return {
    overallStatus: validation.overallStatus,
    install: validation.install,
    checks: validation.checks,
    warnings: validation.warnings,
    partialReasons: validation.partialReasons,
  };
}

function getDraftPullRequestValidationResult(value: unknown): ProposedFixValidationResult | null {
  if (!isRecord(value) || typeof value.baseBranch !== "string" || !isSafeGitReference(value.baseBranch) || typeof value.baseCommitSha !== "string" || !isSafeGitCommitSha(value.baseCommitSha) || !Array.isArray(value.partialReasons)) return null;
  const snapshot = getCompletedValidationResultSnapshot({
    overallStatus: value.overallStatus,
    install: value.install,
    checks: value.checks,
    warnings: value.warnings,
    partialReasons: value.partialReasons,
  });
  if (!snapshot) return null;

  return {
    ...snapshot,
    baseBranch: value.baseBranch,
    baseCommitSha: value.baseCommitSha.toLowerCase(),
  };
}

function isDraftPullRequestRequest(value: unknown): value is {
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  analysis: unknown;
  analysisTicket: string;
  proposal: unknown;
  proposedFixTicket: string;
  validation: unknown;
  validationTicket: string;
} {
  return isRecord(value)
    && typeof value.owner === "string"
    && typeof value.repository === "string"
    && typeof value.dependencyName === "string"
    && typeof value.dependencyType === "string"
    && typeof value.analysisTicket === "string"
    && typeof value.proposedFixTicket === "string"
    && typeof value.validationTicket === "string";
}

function runDraftPullRequestIdempotently(ticket: string, create: () => Promise<DraftPullRequestActionResult>) {
  const activeRequest = draftPullRequestRequests.get(ticket);
  if (activeRequest) return activeRequest;

  const request = create().finally(() => {
    draftPullRequestRequests.delete(ticket);
  });
  draftPullRequestRequests.set(ticket, request);
  return request;
}

function getRepositoryWritePreflightError(category: string) {
  if (category === "write_access" || category === "repository_restricted") return "GitHub write access could not be verified for this repository.";
  if (category === "github_authorization") return "GitHub authorization is unavailable. Reconnect GitHub and try again.";
  return "GitHub could not revalidate this repository before creating a draft PR.";
}

function isSafeGitReference(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/");
}

function isSafeGitCommitSha(value: string) {
  return /^[a-f\d]{40,64}$/i.test(value);
}

function isPullRequestCreationEnabled() {
  return process.env.SENTINEL_PR_CREATION_ENABLED === "true";
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

function logSafePrActionEvent(event: string, details: Record<string, string>) {
  console.error("[sentinel:pr]", event, details);
}
