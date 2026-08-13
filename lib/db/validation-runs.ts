import "server-only";

import { createHash } from "node:crypto";
import { resolvePersistedProposedFixForValidation, type ProposedFixPersistenceInput } from "@/lib/db/proposed-fixes";
import { getPrismaClient } from "@/lib/db/prisma";
import type { ProposedFixValidationResult } from "@/lib/validation/proposed-fix-validation";
import { isNpmPackageLockValidationBindingCurrent, verifyNpmPackageLockArtifact, type VerifiedNpmPackageLockArtifact } from "@/lib/validation/npm-package-lock-artifact";

const VALIDATION_ATTEMPT_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const MAX_WARNINGS = 12;
const MAX_WARNING_LENGTH = 1_000;
const VALIDATION_CHECK_NAMES = ["typecheck", "lint", "test", "build"] as const;
const OVERALL_STATUSES = new Map([
  ["passed", "PASSED"],
  ["failed", "FAILED"],
  ["partial", "PARTIAL"],
  ["unable_to_validate", "UNABLE_TO_VALIDATE"],
] as const);
const STAGE_STATUSES = new Map([
  ["passed", "PASSED"],
  ["failed", "FAILED"],
  ["skipped", "SKIPPED"],
  ["timed_out", "TIMED_OUT"],
] as const);

type ValidationPersistenceStage = "proposed_fix_resolved" | "validation_insert" | "validation_reuse_lookup";
type ValidationPersistenceUnavailableCategory = "invalid_input" | "repository_not_connected" | "latest_scan_unavailable" | "latest_scan_mismatch" | "finding_not_found_or_changed" | "proposed_fix_not_found_or_changed" | "validation_artifact_mismatch" | "database_error";

export type ValidationRunPersistenceInput = ProposedFixPersistenceInput & {
  validation: ProposedFixValidationResult;
  validationAttemptId: string;
  validatedPackageLockArtifact: VerifiedNpmPackageLockArtifact | null;
};

export type ValidationRunPersistenceResult =
  | { kind: "created"; validationRunId: string }
  | { kind: "existing"; validationRunId: string }
  | { kind: "unavailable"; category: ValidationPersistenceUnavailableCategory };

export type SavedValidationRun = {
  overallStatus: "passed" | "failed" | "partial" | "unable_to_validate";
  baseCommitSha: string;
  installStatus: "passed" | "failed" | "skipped" | "timed_out";
  typecheckStatus: "passed" | "failed" | "skipped" | "timed_out" | null;
  lintStatus: "passed" | "failed" | "skipped" | "timed_out" | null;
  testStatus: "passed" | "failed" | "skipped" | "timed_out" | null;
  buildStatus: "passed" | "failed" | "skipped" | "timed_out" | null;
  warnings: string[];
  createdAt: Date;
};

export type ValidatedPackageLockLookup =
  | { kind: "ready"; artifact: VerifiedNpmPackageLockArtifact | null }
  | { kind: "unavailable"; category: ValidationPersistenceUnavailableCategory | "validation_run_mismatch" };

/** Persists one real validation completion for a current, exactly matching proposed fix. */
export async function persistValidationRun(input: ValidationRunPersistenceInput): Promise<ValidationRunPersistenceResult> {
  const data = getPersistenceData(input);
  if (!data) return logUnavailable("proposed_fix_resolved", "invalid_input");

  let stage: ValidationPersistenceStage = "proposed_fix_resolved";
  try {
    const resolved = await resolvePersistedProposedFixForValidation(input);
    if (resolved.kind === "unavailable") return logUnavailable(stage, resolved.category);

    const client = getPrismaClient();
    const idempotencyKey = getIdempotencyKey(resolved.proposedFixId, data.validation.baseCommitSha, data.validationAttemptId);
    stage = "validation_insert";
    try {
      const created = await client.validationRun.create({
        data: {
          proposedFixId: resolved.proposedFixId,
          idempotencyKey,
          overallStatus: data.validation.overallStatus,
          baseCommitSha: data.validation.baseCommitSha,
          installStatus: data.validation.installStatus,
          typecheckStatus: data.validation.checkStatuses.typecheck,
          lintStatus: data.validation.checkStatuses.lint,
          testStatus: data.validation.checkStatuses.test,
          buildStatus: data.validation.checkStatuses.build,
          warningsJson: data.validation.warnings,
          npmPackageLockContent: data.artifact ? Buffer.from(data.artifact.bytes) : null,
          npmPackageLockByteLength: data.artifact?.byteLength ?? null,
          npmPackageLockSha256: data.artifact?.sha256 ?? null,
        },
        select: { id: true },
      });
      console.info("[sentinel:validation-persistence] validation_inserted", { stage });
      return { kind: "created", validationRunId: created.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      stage = "validation_reuse_lookup";
      const existing = await client.validationRun.findUnique({
        where: { idempotencyKey },
        select: { id: true, proposedFixId: true, baseCommitSha: true, npmPackageLockContent: true, npmPackageLockByteLength: true, npmPackageLockSha256: true },
      });
      if (existing && existing.proposedFixId === resolved.proposedFixId && existing.baseCommitSha === data.validation.baseCommitSha && storedArtifactMatches(existing, data.artifact)) {
        console.info("[sentinel:validation-persistence] validation_reused", { stage });
        return { kind: "existing", validationRunId: existing.id };
      }
      throw error;
    }
  } catch (error) {
    logPersistenceFailure(stage, error);
    return { kind: "unavailable", category: "database_error" };
  }
}

/** Reloads one exact validation-bound artifact after resolving the current user and proposal. */
export async function getValidatedPackageLockArtifactForDraftPr(
  validationRunId: string,
  input: Omit<ValidationRunPersistenceInput, "validation" | "validationAttemptId" | "validatedPackageLockArtifact">,
): Promise<ValidatedPackageLockLookup> {
  const expectedBaseCommitSha = normalizeCommitSha(input.baseCommitSha);
  if (!isSafeValidationRunId(validationRunId) || !expectedBaseCommitSha) return { kind: "unavailable", category: "validation_run_mismatch" };
  try {
    const resolved = await resolvePersistedProposedFixForValidation(input);
    if (resolved.kind === "unavailable") return { kind: "unavailable", category: resolved.category };
    const run = await getPrismaClient().validationRun.findUnique({
      where: { id: validationRunId },
      select: {
        id: true,
        proposedFixId: true,
        baseCommitSha: true,
        overallStatus: true,
        installStatus: true,
        typecheckStatus: true,
        lintStatus: true,
        testStatus: true,
        buildStatus: true,
        npmPackageLockContent: true,
        npmPackageLockByteLength: true,
        npmPackageLockSha256: true,
      },
    });
    if (!run
      || !isNpmPackageLockValidationBindingCurrent({
        validationRunId: run.id,
        proposedFixId: run.proposedFixId,
        baseCommitSha: run.baseCommitSha,
      }, {
        validationRunId,
        proposedFixId: resolved.proposedFixId,
        baseCommitSha: expectedBaseCommitSha,
      })
      || run.installStatus !== "PASSED"
      || !["PASSED", "PARTIAL"].includes(run.overallStatus)
      || [run.typecheckStatus, run.lintStatus, run.testStatus, run.buildStatus].some((status) => status === "FAILED" || status === "TIMED_OUT")) {
      return { kind: "unavailable", category: "validation_run_mismatch" };
    }
    if (run.npmPackageLockContent === null && run.npmPackageLockByteLength === null && run.npmPackageLockSha256 === null) {
      return { kind: "ready", artifact: null };
    }
    const artifact = verifyStoredArtifact(run, input);
    return artifact ? { kind: "ready", artifact } : { kind: "unavailable", category: "validation_artifact_mismatch" };
  } catch (error) {
    logPersistenceFailure("validation_reuse_lookup", error);
    return { kind: "unavailable", category: "database_error" };
  }
}

/** Returns recent historical validation runs only after re-verifying the current user and exact proposal. */
export async function listValidationRunsForProposedFix(input: Omit<ValidationRunPersistenceInput, "validation" | "validationAttemptId" | "validatedPackageLockArtifact">): Promise<SavedValidationRun[]> {
  try {
    const resolved = await resolvePersistedProposedFixForValidation(input);
    if (resolved.kind === "unavailable") return [];

    const runs = await getPrismaClient().validationRun.findMany({
      where: { proposedFixId: resolved.proposedFixId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        overallStatus: true,
        baseCommitSha: true,
        installStatus: true,
        typecheckStatus: true,
        lintStatus: true,
        testStatus: true,
        buildStatus: true,
        warningsJson: true,
        createdAt: true,
      },
    });
    return runs.flatMap((run) => {
      const saved = toSavedValidationRun(run);
      return saved ? [saved] : [];
    });
  } catch (error) {
    logPersistenceFailure("proposed_fix_resolved", error);
    return [];
  }
}

/** Returns the newest safely parsed validation record, without granting any PR authority. */
export async function getLatestValidationRunForProposedFix(input: Omit<ValidationRunPersistenceInput, "validation" | "validationAttemptId" | "validatedPackageLockArtifact">): Promise<SavedValidationRun | null> {
  const runs = await listValidationRunsForProposedFix(input);
  return runs[0] ?? null;
}

type PersistenceData = {
  validationAttemptId: string;
  validation: {
    overallStatus: "PASSED" | "FAILED" | "PARTIAL" | "UNABLE_TO_VALIDATE";
    baseCommitSha: string;
    installStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT";
    checkStatuses: Record<(typeof VALIDATION_CHECK_NAMES)[number], "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT">;
    warnings: string[];
  };
  artifact: VerifiedNpmPackageLockArtifact | null;
};

function getPersistenceData(input: ValidationRunPersistenceInput): PersistenceData | null {
  if (!VALIDATION_ATTEMPT_ID_PATTERN.test(input.validationAttemptId)) return null;

  const baseCommitSha = normalizeCommitSha(input.baseCommitSha);
  const resultBaseCommitSha = normalizeCommitSha(input.validation.baseCommitSha);
  const overallStatus = OVERALL_STATUSES.get(input.validation.overallStatus);
  const installStatus = STAGE_STATUSES.get(input.validation.install.status);
  const checkStatuses = getCheckStatuses(input.validation.checks);
  const warnings = getSafeWarnings(input.validation.warnings);
  if (!baseCommitSha || resultBaseCommitSha !== baseCommitSha || !overallStatus || !installStatus || !checkStatuses || !warnings) return null;

  const artifact = input.validatedPackageLockArtifact;
  if (artifact && verifyNpmPackageLockArtifact(toArtifactTransport(artifact), artifactExpectation(input)).kind !== "valid") return null;
  return {
    validationAttemptId: input.validationAttemptId.toLowerCase(),
    validation: { overallStatus, baseCommitSha, installStatus, checkStatuses, warnings },
    artifact,
  };
}

function verifyStoredArtifact(value: { npmPackageLockContent: Uint8Array | null; npmPackageLockByteLength: number | null; npmPackageLockSha256: string | null }, input: ProposedFixPersistenceInput) {
  if (!value.npmPackageLockContent || value.npmPackageLockByteLength === null || value.npmPackageLockSha256 === null) return null;
  const verified = verifyNpmPackageLockArtifact({
    kind: "npm_package_lock",
    path: "package-lock.json",
    encoding: "base64",
    content: Buffer.from(value.npmPackageLockContent).toString("base64"),
    byteLength: value.npmPackageLockByteLength,
    sha256: value.npmPackageLockSha256,
  }, artifactExpectation(input));
  return verified.kind === "valid" ? verified.artifact : null;
}

function storedArtifactMatches(value: { npmPackageLockContent: Uint8Array | null; npmPackageLockByteLength: number | null; npmPackageLockSha256: string | null }, artifact: VerifiedNpmPackageLockArtifact | null) {
  if (!artifact) return value.npmPackageLockContent === null && value.npmPackageLockByteLength === null && value.npmPackageLockSha256 === null;
  return value.npmPackageLockByteLength === artifact.byteLength
    && value.npmPackageLockSha256 === artifact.sha256
    && value.npmPackageLockContent !== null
    && Buffer.from(value.npmPackageLockContent).equals(Buffer.from(artifact.bytes));
}

function toArtifactTransport(artifact: VerifiedNpmPackageLockArtifact) {
  return {
    kind: artifact.kind,
    path: artifact.path,
    encoding: "base64" as const,
    content: Buffer.from(artifact.bytes).toString("base64"),
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
  };
}

function artifactExpectation(input: ProposedFixPersistenceInput) {
  return {
    dependencyName: input.dependency.packageName,
    dependencyType: input.dependency.dependencyType,
    targetVersion: input.dependency.latestVersion,
  };
}

function isSafeValidationRunId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z\d_-]{1,64}$/.test(value);
}

function getIdempotencyKey(proposedFixId: string, baseCommitSha: string, validationAttemptId: string) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    proposedFixId,
    baseCommitSha,
    validationAttemptId,
  })).digest("base64url");
}

function getCheckStatuses(checks: ProposedFixValidationResult["checks"]): PersistenceData["validation"]["checkStatuses"] | null {
  if (!Array.isArray(checks) || checks.length !== VALIDATION_CHECK_NAMES.length) return null;
  const statuses = new Map<(typeof VALIDATION_CHECK_NAMES)[number], "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT">();
  for (const check of checks) {
    if (!VALIDATION_CHECK_NAMES.includes(check.name) || statuses.has(check.name)) return null;
    const status = STAGE_STATUSES.get(check.status);
    if (!status) return null;
    statuses.set(check.name, status);
  }
  const [typecheck, lint, test, build] = VALIDATION_CHECK_NAMES.map((name) => statuses.get(name));
  return typecheck && lint && test && build ? { typecheck, lint, test, build } : null;
}

function toSavedValidationRun(value: {
  overallStatus: "PASSED" | "FAILED" | "PARTIAL" | "UNABLE_TO_VALIDATE";
  baseCommitSha: string;
  installStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT";
  typecheckStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
  lintStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
  testStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
  buildStatus: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null;
  warningsJson: unknown;
  createdAt: Date;
}): SavedValidationRun | null {
  const baseCommitSha = normalizeCommitSha(value.baseCommitSha);
  const warnings = getSafeWarnings(value.warningsJson);
  if (!baseCommitSha || !warnings) return null;

  return {
    overallStatus: value.overallStatus.toLowerCase() as SavedValidationRun["overallStatus"],
    baseCommitSha,
    installStatus: value.installStatus.toLowerCase() as SavedValidationRun["installStatus"],
    typecheckStatus: toSavedStageStatus(value.typecheckStatus),
    lintStatus: toSavedStageStatus(value.lintStatus),
    testStatus: toSavedStageStatus(value.testStatus),
    buildStatus: toSavedStageStatus(value.buildStatus),
    warnings,
    createdAt: value.createdAt,
  };
}

function toSavedStageStatus(value: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | null) {
  return value ? value.toLowerCase() as SavedValidationRun["installStatus"] : null;
}

function getSafeWarnings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) return null;
  const warnings = value.map((warning) => getSafeText(warning, MAX_WARNING_LENGTH));
  return warnings.every((warning): warning is string => warning !== null) ? warnings : null;
}

function normalizeCommitSha(value: unknown) {
  return typeof value === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value) ? value.toLowerCase() : null;
}

function getSafeText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !normalized.includes("\u0000") ? normalized : null;
}

function logUnavailable(stage: ValidationPersistenceStage, category: ValidationPersistenceUnavailableCategory): ValidationRunPersistenceResult {
  console.info("[sentinel:validation-persistence] persistence_unavailable", { stage, category });
  return { kind: "unavailable", category };
}

function logPersistenceFailure(stage: ValidationPersistenceStage, error: unknown) {
  const record = isRecord(error) ? error : null;
  const meta = record && isRecord(record.meta) ? record.meta : null;
  console.error("[sentinel:validation-persistence] persistence_failed", {
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
  return value === "UserRepository" || value === "Scan" || value === "Finding" || value === "ProposedFix" || value === "ValidationRun" ? value : null;
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
