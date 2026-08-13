import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TICKET_LIFETIME_MS = 15 * 60 * 1_000;
const COMPLETED_VALIDATION_PR_TICKET_PURPOSE = "completed_validation_pr";
const VALIDATION_CHECK_NAMES = ["typecheck", "lint", "test", "build"] as const;
const VALIDATION_CHECK_STATUSES = ["passed", "failed", "skipped", "timed_out"] as const;
const VALIDATION_OVERALL_STATUSES = ["passed", "failed", "partial", "unable_to_validate"] as const;
const VALIDATION_INSTALL_STATUSES = ["passed", "failed", "skipped"] as const;
const VALIDATION_PARTIAL_REASONS = ["skipped_checks", "no_lockfile_fallback", "cleanup_unconfirmed", "validation_timeout"] as const;
const MAX_VALIDATION_SUMMARY_LENGTH = 1_000;
const MAX_VALIDATION_WARNINGS = 12;
const MAX_VALIDATION_DURATION_MS = 5 * 60 * 1_000;
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z\d][A-Za-z\d._-]{0,99}$/;
const DEPENDENCY_NAME_PATTERN = /^[a-zA-Z0-9@._/-]+$/;

export type ImpactAnalysisSnapshot = {
  summary: string;
  potentialImpact: string;
  riskExplanation: string;
  recommendedNextStep: string;
  confidence: number;
};

type TicketPayload = {
  version: 1;
  userId: string;
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  expiresAt: number;
  analysisHash: string;
};

export type ProposedFixValidationSnapshot = {
  title: string;
  summary: string;
  confidence: number;
  files: Array<{
    path: string;
    reason: string;
    originalSnippet: string;
    proposedSnippet: string;
  }>;
  packageJsonChange: {
    required: boolean;
    dependency: string;
    from: string;
    to: string;
  };
  validationSteps: string[];
  warnings: string[];
};

type ProposedFixTicketPayload = {
  version: 1;
  userId: string;
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  expiresAt: number;
  proposedFixHash: string;
};

type CompletedValidationPrTicketPayload = {
  purpose: typeof COMPLETED_VALIDATION_PR_TICKET_PURPOSE;
  version: 1;
  userId: string;
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  defaultBranch: string;
  baseCommitSha: string;
  validationRunId: string;
  expiresAt: number;
  analysisHash: string;
  proposedFixHash: string;
  validationResultHash: string;
};

export type ValidationResultSnapshot = {
  overallStatus: (typeof VALIDATION_OVERALL_STATUSES)[number];
  install: {
    status: (typeof VALIDATION_INSTALL_STATUSES)[number];
    summary: string;
  };
  checks: Array<{
    name: (typeof VALIDATION_CHECK_NAMES)[number];
    status: (typeof VALIDATION_CHECK_STATUSES)[number];
    durationMs: number;
    summary: string;
  }>;
  warnings: string[];
};

export type CompletedValidationResultSnapshot = ValidationResultSnapshot & {
  partialReasons: Array<(typeof VALIDATION_PARTIAL_REASONS)[number]>;
};

export type CompletedValidationPrTicketInput = {
  userId: string;
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  defaultBranch: string;
  baseCommitSha: string;
  validationRunId: string;
  analysis: unknown;
  proposedFix: unknown;
  validationResult: unknown;
};

export type CompletedValidationPrTicketVerificationInput = Omit<CompletedValidationPrTicketInput, "defaultBranch" | "baseCommitSha" | "validationRunId">;

export type CompletedValidationPrTicketBinding = {
  defaultBranch: string;
  baseCommitSha: string;
  validationRunId: string;
  expiresAt: number;
  proposedChangeIdentifier: string;
};

export function createImpactAnalysisTicket(input: Omit<TicketPayload, "version" | "expiresAt" | "analysisHash"> & { analysis: ImpactAnalysisSnapshot }) {
  const secret = getTicketSecret();
  if (!secret) return null;

  const payload: TicketPayload = {
    version: 1,
    userId: input.userId,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    expiresAt: Date.now() + TICKET_LIFETIME_MS,
    analysisHash: getAnalysisHash(input.analysis),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifyImpactAnalysisTicket(ticket: string, input: Omit<TicketPayload, "version" | "expiresAt" | "analysisHash"> & { analysis: ImpactAnalysisSnapshot }) {
  const secret = getTicketSecret();
  if (!secret || ticket.length > 4_096) return false;

  const [encodedPayload, signature, ...extraParts] = ticket.split(".");
  if (!encodedPayload || !signature || extraParts.length > 0 || !isValidSignature(signature, sign(encodedPayload, secret))) return false;

  try {
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!isTicketPayload(payload) || payload.expiresAt < Date.now()) return false;

    return payload.userId === input.userId
      && payload.owner === input.owner
      && payload.repository === input.repository
      && payload.dependencyName === input.dependencyName
      && payload.dependencyType === input.dependencyType
      && payload.analysisHash === getAnalysisHash(input.analysis);
  } catch {
    return false;
  }
}

export function getImpactAnalysisSnapshot(value: unknown): ImpactAnalysisSnapshot | null {
  if (!isRecord(value) || !isSafeText(value.summary) || !isSafeText(value.potentialImpact) || !isSafeText(value.riskExplanation) || !isSafeText(value.recommendedNextStep) || !isConfidence(value.confidence)) return null;

  return {
    summary: value.summary,
    potentialImpact: value.potentialImpact,
    riskExplanation: value.riskExplanation,
    recommendedNextStep: value.recommendedNextStep,
    confidence: value.confidence,
  };
}

export function createProposedFixValidationTicket(input: Omit<ProposedFixTicketPayload, "version" | "expiresAt" | "proposedFixHash"> & { proposedFix: ProposedFixValidationSnapshot }) {
  const secret = getTicketSecret();
  if (!secret) return null;

  const payload: ProposedFixTicketPayload = {
    version: 1,
    userId: input.userId,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    expiresAt: Date.now() + TICKET_LIFETIME_MS,
    proposedFixHash: getProposedFixHash(input.proposedFix),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifyProposedFixValidationTicket(ticket: string, input: Omit<ProposedFixTicketPayload, "version" | "expiresAt" | "proposedFixHash"> & { proposedFix: ProposedFixValidationSnapshot }) {
  const secret = getTicketSecret();
  if (!secret || ticket.length > 4_096) return false;

  const [encodedPayload, signature, ...extraParts] = ticket.split(".");
  if (!encodedPayload || !signature || extraParts.length > 0 || !isValidSignature(signature, sign(encodedPayload, secret))) return false;

  try {
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!isProposedFixTicketPayload(payload) || payload.expiresAt < Date.now()) return false;

    return payload.userId === input.userId
      && payload.owner === input.owner
      && payload.repository === input.repository
      && payload.dependencyName === input.dependencyName
      && payload.dependencyType === input.dependencyType
      && payload.proposedFixHash === getProposedFixHash(input.proposedFix);
  } catch {
    return false;
  }
}

/**
 * Creates a short-lived attestation after a proposal has actually completed
 * validation. Unlike the existing proposed-fix ticket, this ticket is only
 * intended to authorize the later write operation.
 */
export function createCompletedValidationPrTicket(input: CompletedValidationPrTicketInput) {
  const data = getCompletedValidationTicketData(input);
  const baseCommitSha = normalizeCommitSha(input?.baseCommitSha);
  if (!data || !isSafeGitRefName(input?.defaultBranch) || !baseCommitSha || !isSafeValidationRunId(input?.validationRunId)) return null;

  const secret = getTicketSecret();
  if (!secret) return null;

  const payload: CompletedValidationPrTicketPayload = {
    purpose: COMPLETED_VALIDATION_PR_TICKET_PURPOSE,
    version: 1,
    userId: data.userId,
    owner: data.owner,
    repository: data.repository,
    dependencyName: data.dependencyName,
    dependencyType: data.dependencyType,
    defaultBranch: input.defaultBranch,
    baseCommitSha,
    validationRunId: input.validationRunId,
    expiresAt: Date.now() + TICKET_LIFETIME_MS,
    analysisHash: getAnalysisHash(data.analysis),
    proposedFixHash: getCanonicalProposedFixHash(data.proposedFix),
    validationResultHash: getValidationResultHash(data.validationResult),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

/**
 * Verifies the caller's identity and all supplied snapshots. The pinned branch
 * and commit are deliberately returned from the signed payload rather than
 * accepted from the caller.
 */
export function verifyCompletedValidationPrTicket(ticket: string, input: CompletedValidationPrTicketVerificationInput): CompletedValidationPrTicketBinding | null {
  const secret = getTicketSecret();
  const data = getCompletedValidationTicketData(input);
  if (!secret || !data || typeof ticket !== "string" || ticket.length > 4_096) return null;

  const [encodedPayload, signature, ...extraParts] = ticket.split(".");
  if (!encodedPayload || !signature || extraParts.length > 0 || !isValidSignature(signature, sign(encodedPayload, secret))) return null;

  try {
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!isCompletedValidationPrTicketPayload(payload) || payload.expiresAt < Date.now()) return null;
    if (payload.userId !== data.userId
      || payload.owner !== data.owner
      || payload.repository !== data.repository
      || payload.dependencyName !== data.dependencyName
      || payload.dependencyType !== data.dependencyType
      || payload.analysisHash !== getAnalysisHash(data.analysis)
      || payload.proposedFixHash !== getCanonicalProposedFixHash(data.proposedFix)
      || payload.validationResultHash !== getValidationResultHash(data.validationResult)) return null;

    return {
      defaultBranch: payload.defaultBranch,
      baseCommitSha: payload.baseCommitSha,
      validationRunId: payload.validationRunId,
      expiresAt: payload.expiresAt,
      proposedChangeIdentifier: getProposedChangeIdentifierFromValidatedData({
        owner: payload.owner,
        repository: payload.repository,
        dependencyName: payload.dependencyName,
        dependencyType: payload.dependencyType,
        baseCommitSha: payload.baseCommitSha,
        proposedFix: data.proposedFix,
      }),
    };
  } catch {
    return null;
  }
}

/**
 * Converts the public validation response into a small, canonical snapshot.
 * This intentionally accepts only the shape emitted by the validation runner.
 */
export function getValidationResultSnapshot(value: unknown): ValidationResultSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ["overallStatus", "install", "checks", "warnings"]) || !isOneOf(value.overallStatus, VALIDATION_OVERALL_STATUSES)) return null;
  if (!isRecord(value.install) || !hasExactKeys(value.install, ["status", "summary"]) || !isOneOf(value.install.status, VALIDATION_INSTALL_STATUSES)) return null;
  const installSummary = getSafeValidationText(value.install.summary, MAX_VALIDATION_SUMMARY_LENGTH);
  if (!installSummary || !Array.isArray(value.checks) || value.checks.length !== VALIDATION_CHECK_NAMES.length || !Array.isArray(value.warnings) || value.warnings.length > MAX_VALIDATION_WARNINGS) return null;

  const checksByName = new Map<ValidationResultSnapshot["checks"][number]["name"], ValidationResultSnapshot["checks"][number]>();
  for (const check of value.checks) {
    const parsedCheck = getValidationCheckSnapshot(check);
    if (!parsedCheck || checksByName.has(parsedCheck.name)) return null;
    checksByName.set(parsedCheck.name, parsedCheck);
  }
  const checks = VALIDATION_CHECK_NAMES.map((name) => checksByName.get(name)).filter((check): check is ValidationResultSnapshot["checks"][number] => check !== undefined);
  if (checks.length !== VALIDATION_CHECK_NAMES.length) return null;

  const warnings: string[] = [];
  for (const warning of value.warnings) {
    const parsedWarning = getSafeValidationText(warning, MAX_VALIDATION_SUMMARY_LENGTH);
    if (!parsedWarning) return null;
    warnings.push(parsedWarning);
  }

  return {
    overallStatus: value.overallStatus,
    install: { status: value.install.status, summary: installSummary },
    checks,
    warnings,
  };
}

/**
 * The completed-validation PR ticket binds the eligibility-relevant partial
 * reasons in addition to the deterministic validation result itself.
 */
export function getCompletedValidationResultSnapshot(value: unknown): CompletedValidationResultSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ["overallStatus", "install", "checks", "warnings", "partialReasons"]) || !Array.isArray(value.partialReasons) || value.partialReasons.length > VALIDATION_PARTIAL_REASONS.length) return null;
  if (!value.partialReasons.every((reason) => isOneOf(reason, VALIDATION_PARTIAL_REASONS))) return null;

  const partialReasons = [...new Set(value.partialReasons)];
  if (partialReasons.length !== value.partialReasons.length) return null;

  const validationResult = getValidationResultSnapshot({
    overallStatus: value.overallStatus,
    install: value.install,
    checks: value.checks,
    warnings: value.warnings,
  });
  return validationResult ? { ...validationResult, partialReasons } : null;
}

/**
 * Stable, URL-safe identifier for GitHub-side idempotency checks. Call this
 * only with a proposal whose integrity was established by a signed ticket.
 */
export function getProposedChangeIdentifier(input: {
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  baseCommitSha: string;
  proposedFix: unknown;
}) {
  if (!isRecord(input) || !isSafeRepositoryIdentity(input)) return null;
  const baseCommitSha = normalizeCommitSha(input.baseCommitSha);
  if (!baseCommitSha) return null;
  const proposedFix = getProposedFixValidationSnapshot(input.proposedFix);
  if (!proposedFix) return null;

  return getProposedChangeIdentifierFromValidatedData({
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    baseCommitSha,
    proposedFix,
  });
}

export function getProposedFixValidationSnapshot(value: unknown): ProposedFixValidationSnapshot | null {
  if (!isRecord(value) || !isSafeText(value.title) || !isSafeText(value.summary) || !isConfidence(value.confidence) || !Array.isArray(value.files) || !isPackageJsonChange(value.packageJsonChange) || !isSafeTextList(value.validationSteps, 8, 400) || !isSafeTextList(value.warnings, 8, 400)) return null;

  const files = value.files.flatMap((file) => {
    if (!isRecord(file) || !isSafeText(file.path, 1_000) || !isSafeText(file.reason) || !isSafeText(file.originalSnippet, 2_000) || !isSafeText(file.proposedSnippet, 2_000)) return [];
    return [{ path: file.path, reason: file.reason, originalSnippet: file.originalSnippet, proposedSnippet: file.proposedSnippet }];
  });
  if (files.length !== value.files.length || files.length > 3) return null;

  return {
    title: value.title,
    summary: value.summary,
    confidence: value.confidence,
    files,
    packageJsonChange: value.packageJsonChange,
    validationSteps: value.validationSteps,
    warnings: value.warnings,
  };
}

function getAnalysisHash(analysis: ImpactAnalysisSnapshot) {
  return createHash("sha256").update(JSON.stringify({
    summary: analysis.summary,
    potentialImpact: analysis.potentialImpact,
    riskExplanation: analysis.riskExplanation,
    recommendedNextStep: analysis.recommendedNextStep,
    confidence: analysis.confidence,
  })).digest("base64url");
}

function getProposedFixHash(proposedFix: ProposedFixValidationSnapshot) {
  return createHash("sha256").update(JSON.stringify(proposedFix)).digest("base64url");
}

function getCanonicalProposedFixHash(proposedFix: ProposedFixValidationSnapshot) {
  return createHash("sha256").update(JSON.stringify({
    title: proposedFix.title,
    summary: proposedFix.summary,
    confidence: proposedFix.confidence,
    files: proposedFix.files.map((file) => ({
      path: file.path,
      reason: file.reason,
      originalSnippet: file.originalSnippet,
      proposedSnippet: file.proposedSnippet,
    })),
    packageJsonChange: {
      required: proposedFix.packageJsonChange.required,
      dependency: proposedFix.packageJsonChange.dependency,
      from: proposedFix.packageJsonChange.from,
      to: proposedFix.packageJsonChange.to,
    },
    validationSteps: proposedFix.validationSteps,
    warnings: proposedFix.warnings,
  })).digest("base64url");
}

function getValidationResultHash(validationResult: CompletedValidationResultSnapshot) {
  return createHash("sha256").update(JSON.stringify({
    overallStatus: validationResult.overallStatus,
    install: {
      status: validationResult.install.status,
      summary: validationResult.install.summary,
    },
    checks: validationResult.checks.map((check) => ({
      name: check.name,
      status: check.status,
      durationMs: check.durationMs,
      summary: check.summary,
    })),
    warnings: validationResult.warnings,
    partialReasons: validationResult.partialReasons,
  })).digest("base64url");
}

type CompletedValidationTicketData = {
  userId: string;
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  analysis: ImpactAnalysisSnapshot;
  proposedFix: ProposedFixValidationSnapshot;
  validationResult: CompletedValidationResultSnapshot;
};

type SafeRepositoryIdentity = {
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
};

function getCompletedValidationTicketData(value: unknown): CompletedValidationTicketData | null {
  if (!isRecord(value) || !isSafeRepositoryIdentity(value) || !isSafeTicketUserId(value.userId)) return null;

  const analysis = getImpactAnalysisSnapshot(value.analysis);
  const proposedFix = getProposedFixValidationSnapshot(value.proposedFix);
  const validationResult = getCompletedValidationResultSnapshot(value.validationResult);
  if (!analysis || !proposedFix || !validationResult) return null;

  return {
    userId: value.userId,
    owner: value.owner,
    repository: value.repository,
    dependencyName: value.dependencyName,
    dependencyType: value.dependencyType,
    analysis,
    proposedFix,
    validationResult,
  };
}

function getValidationCheckSnapshot(value: unknown): ValidationResultSnapshot["checks"][number] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "status", "durationMs", "summary"]) || !isOneOf(value.name, VALIDATION_CHECK_NAMES) || !isOneOf(value.status, VALIDATION_CHECK_STATUSES) || typeof value.durationMs !== "number" || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > MAX_VALIDATION_DURATION_MS) return null;
  const summary = getSafeValidationText(value.summary, MAX_VALIDATION_SUMMARY_LENGTH);
  return summary ? { name: value.name, status: value.status, durationMs: value.durationMs, summary } : null;
}

function getProposedChangeIdentifierFromValidatedData(input: {
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  baseCommitSha: string;
  proposedFix: ProposedFixValidationSnapshot;
}) {
  return createHash("sha256").update(JSON.stringify({
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    baseCommitSha: input.baseCommitSha,
    proposedFixHash: getCanonicalProposedFixHash(input.proposedFix),
  })).digest("base64url");
}

function isCompletedValidationPrTicketPayload(value: unknown): value is CompletedValidationPrTicketPayload {
  return isRecord(value)
    && value.purpose === COMPLETED_VALIDATION_PR_TICKET_PURPOSE
    && value.version === 1
    && isSafeTicketUserId(value.userId)
    && isSafeRepositoryIdentity(value)
    && isSafeGitRefName(value.defaultBranch)
    && normalizeCommitSha(value.baseCommitSha) === value.baseCommitSha
    && isSafeValidationRunId(value.validationRunId)
    && typeof value.expiresAt === "number"
    && Number.isFinite(value.expiresAt)
    && isSafeHash(value.analysisHash)
    && isSafeHash(value.proposedFixHash)
    && isSafeHash(value.validationResultHash);
}

function isSafeRepositoryIdentity(value: Record<string, unknown>): value is Record<string, unknown> & SafeRepositoryIdentity {
  return typeof value.owner === "string"
    && GITHUB_OWNER_PATTERN.test(value.owner)
    && typeof value.repository === "string"
    && GITHUB_REPOSITORY_PATTERN.test(value.repository)
    && typeof value.dependencyName === "string"
    && value.dependencyName.length > 0
    && value.dependencyName.length <= 214
    && DEPENDENCY_NAME_PATTERN.test(value.dependencyName)
    && typeof value.dependencyType === "string"
    && ["dependency", "devDependency", "peerDependency", "optionalDependency"].includes(value.dependencyType);
}

function isSafeTicketUserId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001F\u007F]/.test(value);
}

function isSafeGitRefName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || value === "@" || value.startsWith("/") || value.endsWith("/") || value.includes("..") || value.includes("@{") || /[\u0000-\u001F\u007F ~^:?*\\[\\]/.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith(".") && !segment.endsWith(".") && !segment.endsWith(".lock"));
}

function normalizeCommitSha(value: unknown) {
  if (typeof value !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value)) return null;
  return value.toLowerCase();
}

function isSafeHash(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isSafeValidationRunId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z\d_-]{1,64}$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]) {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length && actualKeys.every((key) => expectedKeys.includes(key));
}

function isOneOf<T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function getSafeValidationText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !normalized.includes("\u0000") ? normalized : null;
}

function getTicketSecret() {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? null;
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function isValidSignature(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isTicketPayload(value: unknown): value is TicketPayload {
  return isRecord(value)
    && value.version === 1
    && typeof value.userId === "string"
    && typeof value.owner === "string"
    && typeof value.repository === "string"
    && typeof value.dependencyName === "string"
    && typeof value.dependencyType === "string"
    && typeof value.expiresAt === "number"
    && Number.isFinite(value.expiresAt)
    && typeof value.analysisHash === "string";
}

function isProposedFixTicketPayload(value: unknown): value is ProposedFixTicketPayload {
  return isRecord(value)
    && value.version === 1
    && typeof value.userId === "string"
    && typeof value.owner === "string"
    && typeof value.repository === "string"
    && typeof value.dependencyName === "string"
    && typeof value.dependencyType === "string"
    && typeof value.expiresAt === "number"
    && Number.isFinite(value.expiresAt)
    && typeof value.proposedFixHash === "string";
}

function isPackageJsonChange(value: unknown): value is ProposedFixValidationSnapshot["packageJsonChange"] {
  return isRecord(value)
    && typeof value.required === "boolean"
    && isSafeText(value.dependency, 214)
    && isSafeText(value.from, 1_000)
    && isSafeText(value.to, 1_000);
}

function isSafeTextList(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => isSafeText(item, maximumLength));
}

function isSafeText(value: unknown, maximumLength = 1_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
