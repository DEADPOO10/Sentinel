import "server-only";

import type { ProposedFix } from "@/lib/openai/proposed-fix";
import {
  MAX_WORKER_RESPONSE_BYTES,
  VALIDATION_WORKER_POLICY,
  isSafeWorkerResult,
  signWorkerMessageSignature,
  verifyWorkerMessageSignature,
  type ValidationWorkerRequest,
  type ValidationWorkerResult,
} from "@/lib/validation/worker-contract";

export const PROPOSED_FIX_VALIDATION_LIMITS = {
  maxTotalDurationMs: 5 * 60 * 1_000,
  maxCommandDurationMs: 90 * 1_000,
  maxCommandOutputBytes: 24 * 1_024,
  maxCommands: 5,
} as const;

type OverallValidationStatus = "passed" | "failed" | "partial" | "unable_to_validate";
type InstallStatus = "passed" | "failed" | "skipped";
type CheckName = "typecheck" | "lint" | "test" | "build";
type CheckStatus = "passed" | "failed" | "skipped" | "timed_out";
export type ProposedFixValidationPartialReason = "skipped_checks" | "no_lockfile_fallback" | "cleanup_unconfirmed";
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

/**
 * The web application never executes, downloads, extracts, or patches customer
 * code. Validation is fail-closed unless a separately deployed isolated worker
 * is explicitly configured. The worker must own its restricted GitHub identity;
 * OAuth tokens and any Sentinel application secret are never sent to it.
 */
export async function validateProposedFixInTemporaryWorkspace(input: ValidationInput): Promise<ProposedFixValidationResult> {
  if (!isSafeGitCommitSha(input.baseCommitSha)) return withBase(createUnableToValidateResult("The repository base commit could not be safely prepared for validation."), input);

  const configResult = getWorkerConfig();
  if (configResult.kind === "invalid") {
    logSafeValidationEvent("config_invalid", { reason: configResult.reason });
    return withBase(createUnableToValidateResult("Production validation is unavailable until a dedicated isolated validation worker is configured."), input);
  }

  const jobId = crypto.randomUUID();
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
    if (!result || result.jobId !== jobId || result.repository.commitSha.toLowerCase() !== input.baseCommitSha.toLowerCase()) {
      logSafeValidationEvent("worker_response_rejected", { reason: "invalid_or_unbound_result" });
      return withBase(createUnableToValidateResult("The isolated validation worker returned an invalid result."), input);
    }
    return withBase(normalizeWorkerResult(result), input);
  } catch (error) {
    const reason = error instanceof ValidationWorkerError ? error.reason : "request_failed";
    logSafeValidationEvent("worker_request_failed", { reason });
    return withBase(createUnableToValidateResult("The isolated validation worker could not complete this validation."), input);
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
  const baseRequirementsMet = result.baseBranch !== null && result.baseCommitSha !== null && result.install.status === "passed" && result.checks.every((check) => check.status === "passed" || check.status === "skipped");
  return baseRequirementsMet && (result.overallStatus === "passed" || (result.overallStatus === "partial" && result.partialReasons.length > 0 && result.partialReasons.every((reason) => reason === "skipped_checks" || reason === "no_lockfile_fallback")));
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
    if (!response.ok) throw new ValidationWorkerError("worker_http_error");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WORKER_RESPONSE_BYTES) throw new ValidationWorkerError("response_too_large");
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody) > MAX_WORKER_RESPONSE_BYTES) throw new ValidationWorkerError("oversized_response");
    const signature = response.headers.get("x-sentinel-worker-signature");
    if (!signature || !verifyPayloadSignature(config.sharedSecret, responseBody, signature)) throw new ValidationWorkerError("invalid_signature");
    const parsed: unknown = JSON.parse(responseBody);
    if (!isSafeWorkerResult(parsed)) throw new ValidationWorkerError("invalid_result");
    return parsed;
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

function isSafeGitCommitSha(value: string) { return /^[a-f\d]{40,64}$/i.test(value); }
function signPayload(secret: string, payload: string) { return signWorkerMessageSignature(secret, payload); }
export function verifyWorkerResponseSignature(secret: string, payload: string, signature: string) { return verifyWorkerMessageSignature(secret, payload, signature); }
function verifyPayloadSignature(secret: string, payload: string, signature: string) { return verifyWorkerMessageSignature(secret, payload, signature); }
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
class ValidationWorkerError extends Error { constructor(readonly reason: string) { super(reason); } }
function logSafeValidationEvent(event: string, details: Record<string, string>) { console.error("[sentinel:validation-worker]", event, details); }
