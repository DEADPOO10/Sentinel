import "server-only";

import type { ProposedFix } from "@/lib/openai/proposed-fix";
import { isDraftPrValidationEligible } from "@/lib/github/draft-pull-request-policy";
import { logger } from "@/lib/logger";
import { createOperationId, getOperationId, withOperationId } from "@/lib/observability/context";
import { parseSignedWorkerResponse, readBoundedWorkerResponseText, verifiedWorkerPackageLockArtifact, workerResponseBindingFailure } from "@/lib/validation/worker-response";
import type { VerifiedNpmPackageLockArtifact } from "@/lib/validation/npm-package-lock-artifact";
import {
  MAX_WORKER_RESPONSE_BYTES,
  VALIDATION_WORKER_MAX_DURATION_MS,
  VALIDATION_WORKER_POLICY,
  signWorkerMessageSignature,
  workerHttpErrorDiagnostics,
  verifyWorkerMessageSignature,
  type ValidationWorkerRequest,
  type ValidationWorkerResult,
} from "@/lib/validation/worker-contract";

export const PROPOSED_FIX_VALIDATION_LIMITS = {
  maxTotalDurationMs: VALIDATION_WORKER_MAX_DURATION_MS,
  maxCommandDurationMs: 120 * 1_000,
  maxCommandOutputBytes: 24 * 1_024,
  maxCommands: 5,
} as const;

type OverallValidationStatus = "passed" | "failed" | "partial" | "unable_to_validate";
type InstallStatus = "passed" | "failed" | "skipped";
type CheckName = "typecheck" | "lint" | "test" | "build";
type CheckStatus = "passed" | "failed" | "skipped" | "timed_out";
export type ProposedFixValidationPartialReason = "skipped_checks" | "no_lockfile_fallback" | "cleanup_unconfirmed" | "validation_timeout";
const CHECK_NAMES: CheckName[] = ["typecheck", "lint", "test", "build"];

export type ProposedFixValidationResult = {
  overallStatus: OverallValidationStatus;
  baseBranch: string | null;
  baseCommitSha: string | null;
  install: { status: InstallStatus; summary: string };
  checks: Array<{ name: CheckName; status: CheckStatus; durationMs: number; summary: string }>;
  warnings: string[];
  partialReasons: ProposedFixValidationPartialReason[];
};

type ValidationInput = {
  owner: string;
  repository: string;
  defaultBranch: string;
  baseCommitSha: string;
  dependencyType: "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
  proposedFix: ProposedFix;
};

export type ProposedFixValidationExecution = {
  validation: ProposedFixValidationResult;
  validatedPackageLockArtifact: VerifiedNpmPackageLockArtifact | null;
};

/**
 * The web application never executes, downloads, extracts, or patches customer
 * code. Validation is fail-closed unless a separately deployed isolated worker
 * is explicitly configured. The worker must own its restricted GitHub identity;
 * OAuth tokens and any Sentinel application secret are never sent to it.
 */
export async function validateProposedFixInTemporaryWorkspace(input: ValidationInput): Promise<ProposedFixValidationExecution> {
  const operationId = getOperationId() ?? createOperationId();
  return withOperationId(
    operationId,
    () => validateProposedFixWithContext(input),
  );
}

async function validateProposedFixWithContext(input: ValidationInput): Promise<ProposedFixValidationExecution> {
  const startedAt = Date.now();
  const jobId = createOperationId();
  const logContext = (metadata: Record<string, unknown>) => ({
    service: "sentinel-validation",
    repositoryIdentifier: `${input.owner}/${input.repository}`,
    durationMs: Date.now() - startedAt,
    metadata: { jobId, ...metadata },
  });

  logger.info("validation.started", logContext({ stage: "preflight" }));

  if (!isSafeGitCommitSha(input.baseCommitSha)) {
    logger.warn("validation.rejected", logContext({ reason: "invalid_base_commit" }));
    return execution(withBase(createUnableToValidateResult("The repository base commit could not be safely prepared for validation."), input));
  }

  const configResult = getWorkerConfig();
  if (configResult.kind === "invalid") {
    logger.warn("validation.config_invalid", logContext({ reason: configResult.reason }));
    return execution(withBase(createUnableToValidateResult("Production validation is unavailable until a dedicated isolated validation worker is configured."), input));
  }

  const request: ValidationWorkerRequest = {
    version: 1,
    jobId,
    repository: { owner: input.owner, name: input.repository, commitSha: input.baseCommitSha },
    dependencyType: input.dependencyType,
    proposedFix: input.proposedFix,
    policy: VALIDATION_WORKER_POLICY,
  };

  try {
    const result = await invokeValidationWorker(configResult.config, request);
    const bindingFailure = workerResponseBindingFailure(result, jobId, input.baseCommitSha);
    if (bindingFailure) {
      logger.warn("validation.worker_response_rejected", logContext({ reason: bindingFailure }));
      return execution(withBase(createUnableToValidateResult("The isolated validation worker returned an invalid result."), input));
    }
    const artifact = verifiedWorkerPackageLockArtifact(result, {
      dependencyName: input.proposedFix.packageJsonChange.dependency,
      dependencyType: input.dependencyType,
      targetVersion: input.proposedFix.packageJsonChange.to,
    });
    if (artifact.kind === "invalid") throw new ValidationWorkerError("result_artifact_invalid", { field: artifact.reason });
    logger.info("validation.completed", logContext({
      overallStatus: result.overallStatus,
      artifactStatus: artifact.kind,
    }));
    return execution(
      withBase(normalizeWorkerResult(result), input),
      artifact.kind === "valid" ? artifact.artifact : null,
    );
  } catch (error) {
    const reason = error instanceof ValidationWorkerError ? error.reason : "request_failed";
    logger.error("validation.worker_request_failed", logContext({
      reason,
      ...(error instanceof ValidationWorkerError ? error.diagnostics : {}),
    }));
    return execution(withBase(createUnableToValidateResult("The isolated validation worker could not complete this validation."), input));
  }
}

export function createUnableToValidateResult(summary: string): ProposedFixValidationResult {
  return {
    overallStatus: "unable_to_validate",
    baseBranch: null,
    baseCommitSha: null,
    install: { status: "skipped", summary },
    checks: CHECK_NAMES.map((name) => ({ name, status: "skipped", durationMs: 0, summary: "Not run." })),
    warnings: [],
    partialReasons: [],
  };
}

export function isProposedFixValidationEligibleForDraftPullRequest(result: ProposedFixValidationResult) {
  return isDraftPrValidationEligible(result);
}

type WorkerConfig = { endpoint: URL; sharedSecret: string };
type WorkerConfigInvalidReason = "validation_disabled" | "provider_not_http" | "worker_url_missing" | "shared_secret_missing" | "shared_secret_too_short" | "worker_url_invalid" | "worker_url_not_https" | "worker_url_credentials_disallowed" | "worker_url_path_invalid";
type WorkerConfigResult = { kind: "valid"; config: WorkerConfig } | { kind: "invalid"; reason: WorkerConfigInvalidReason };

function getWorkerConfig(): WorkerConfigResult {
  if (process.env.SENTINEL_VALIDATION_ENABLED !== "true") return { kind: "invalid", reason: "validation_disabled" };
  if (process.env.SENTINEL_VALIDATION_PROVIDER !== "http") return { kind: "invalid", reason: "provider_not_http" };
  const endpointValue = process.env.SENTINEL_VALIDATION_WORKER_URL;
  const sharedSecret = process.env.SENTINEL_VALIDATION_WORKER_SHARED_SECRET;
  if (!endpointValue) return { kind: "invalid", reason: "worker_url_missing" };
  if (!sharedSecret) return { kind: "invalid", reason: "shared_secret_missing" };
  if (sharedSecret.length < 32) return { kind: "invalid", reason: "shared_secret_too_short" };
  try {
    const endpoint = new URL(endpointValue);
    if (endpoint.protocol !== "https:") return { kind: "invalid", reason: "worker_url_not_https" };
    if (endpoint.username || endpoint.password) return { kind: "invalid", reason: "worker_url_credentials_disallowed" };
    if (endpoint.pathname !== "/v1/validations") return { kind: "invalid", reason: "worker_url_path_invalid" };
    return { kind: "valid", config: { endpoint, sharedSecret } };
  } catch { return { kind: "invalid", reason: "worker_url_invalid" }; }
}

async function invokeValidationWorker(config: WorkerConfig, request: ValidationWorkerRequest): Promise<ValidationWorkerResult> {
  const body = JSON.stringify(request);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROPOSED_FIX_VALIDATION_LIMITS.maxTotalDurationMs);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentinel-request-signature": signPayload(config.sharedSecret, body),
        "x-sentinel-request-timestamp": String(Date.now()),
      },
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (!response.ok) {
      throw new ValidationWorkerError("worker_http_error", workerHttpErrorDiagnostics(response.status, config.endpoint));
    }
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WORKER_RESPONSE_BYTES) throw new ValidationWorkerError("response_too_large");
    const boundedResponse = await readBoundedWorkerResponseText(response, MAX_WORKER_RESPONSE_BYTES);
    if (boundedResponse.kind === "oversized") throw new ValidationWorkerError("oversized_response");
    const responseBody = boundedResponse.text;
    const parsed = parseSignedWorkerResponse(config.sharedSecret, responseBody, response.headers.get("x-sentinel-worker-signature"));
    if (parsed.kind === "invalid") throw new ValidationWorkerError(parsed.reason, parsed.diagnostics);
    return parsed.result;
  } catch (error) {
    if (error instanceof ValidationWorkerError) throw error;
    throw new ValidationWorkerError(getWorkerFetchFailureReason(error));
  } finally { clearTimeout(timeout); }
}

function normalizeWorkerResult(result: ValidationWorkerResult): ProposedFixValidationResult {
  return {
    overallStatus: result.overallStatus,
    baseBranch: null,
    baseCommitSha: null,
    install: result.install,
    checks: result.checks,
    warnings: result.warnings,
    partialReasons: result.partialReasons,
  };
}

function withBase(result: ProposedFixValidationResult, input: Pick<ValidationInput, "defaultBranch" | "baseCommitSha">): ProposedFixValidationResult {
  return { ...result, baseBranch: input.defaultBranch, baseCommitSha: input.baseCommitSha };
}

function execution(validation: ProposedFixValidationResult, validatedPackageLockArtifact: VerifiedNpmPackageLockArtifact | null = null): ProposedFixValidationExecution {
  return { validation, validatedPackageLockArtifact };
}

function isSafeGitCommitSha(value: string) { return /^[a-f\d]{40,64}$/i.test(value); }
function signPayload(secret: string, payload: string) { return signWorkerMessageSignature(secret, payload); }
export function verifyWorkerResponseSignature(secret: string, payload: string, signature: string) { return verifyWorkerMessageSignature(secret, payload, signature); }
function getWorkerFetchFailureReason(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  const code = getErrorCode(error);
  if (code === "ENOTFOUND") return "fetch_dns_failed";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "UND_ERR_CONNECT_TIMEOUT") return "fetch_connection_failed";
  if (code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "fetch_tls_failed";
  return "fetch_failed";
}
function getErrorCode(error: unknown) {
  if (!isRecord(error) || !isRecord(error.cause) || typeof error.cause.code !== "string") return null;
  return error.cause.code;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
class ValidationWorkerError extends Error {
  readonly reason: string;
  readonly diagnostics: Record<string, string>;

  constructor(reason: string, diagnostics: Record<string, string> = {}) {
    super(reason);
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}
