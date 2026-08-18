import { isDeepStrictEqual } from "node:util";
import {
  VALIDATION_WORKER_POLICY,
  workerResultValidationFailure,
  type ValidationWorkerRequest,
  type ValidationWorkerResult,
} from "./worker-contract.ts";

export const ASYNC_VALIDATION_PROTOCOL_VERSION = 1 as const;
export const ASYNC_VALIDATION_FAILURE_CATEGORIES = [
  "worker_unavailable",
  "worker_timeout",
  "result_invalid",
  "job_expired",
  "internal_error",
] as const;

export type AsyncValidationFailureCategory = (typeof ASYNC_VALIDATION_FAILURE_CATEGORIES)[number];

export type AsyncValidationSubmitRequest = {
  version: typeof ASYNC_VALIDATION_PROTOCOL_VERSION;
  operation: "submit";
  validation: ValidationWorkerRequest;
};

/** Safe receipt body; the future transport must HMAC-sign its exact serialized bytes. */
export type AsyncValidationSubmitReceipt = {
  version: typeof ASYNC_VALIDATION_PROTOCOL_VERSION;
  jobId: string;
  repository: { commitSha: string };
  status: "queued";
};

export type AsyncValidationStatusRequest = {
  version: typeof ASYNC_VALIDATION_PROTOCOL_VERSION;
  operation: "status";
  jobId: string;
  repository: { commitSha: string };
};

type AsyncValidationStatusBase = {
  version: typeof ASYNC_VALIDATION_PROTOCOL_VERSION;
  jobId: string;
  repository: { commitSha: string };
};

export type AsyncValidationStatusResponse =
  | (AsyncValidationStatusBase & { status: "queued" })
  | (AsyncValidationStatusBase & { status: "running" })
  | (AsyncValidationStatusBase & { status: "completed"; result: ValidationWorkerResult })
  | (AsyncValidationStatusBase & { status: "failed"; failureCategory: AsyncValidationFailureCategory });

export type AsyncValidationContractFailure = {
  category: "schema_invalid" | "job_binding_invalid" | "commit_binding_invalid" | "result_invalid";
  field: string;
};

export function asyncValidationSubmitRequestFailure(value: unknown): AsyncValidationContractFailure | null {
  if (!hasExactKeys(value, ["version", "operation", "validation"])) return schemaFailure("request");
  if (value.version !== ASYNC_VALIDATION_PROTOCOL_VERSION) return schemaFailure("version");
  if (value.operation !== "submit") return schemaFailure("operation");
  return validationWorkerRequestShapeFailure(value.validation);
}

export function asyncValidationSubmitReceiptFailure(value: unknown): AsyncValidationContractFailure | null {
  if (!hasExactKeys(value, ["version", "jobId", "repository", "status"])) return schemaFailure("receipt");
  if (value.version !== ASYNC_VALIDATION_PROTOCOL_VERSION) return schemaFailure("version");
  if (!isUuid(value.jobId)) return schemaFailure("jobId");
  if (!isCommitRepository(value.repository)) return schemaFailure("repository.commitSha");
  return value.status === "queued" ? null : schemaFailure("status");
}

export function asyncValidationStatusRequestFailure(value: unknown): AsyncValidationContractFailure | null {
  if (!hasExactKeys(value, ["version", "operation", "jobId", "repository"])) return schemaFailure("request");
  if (value.version !== ASYNC_VALIDATION_PROTOCOL_VERSION) return schemaFailure("version");
  if (value.operation !== "status") return schemaFailure("operation");
  if (!isUuid(value.jobId)) return schemaFailure("jobId");
  return isCommitRepository(value.repository) ? null : schemaFailure("repository.commitSha");
}

export function asyncValidationStatusResponseFailure(value: unknown): AsyncValidationContractFailure | null {
  if (!isRecord(value)) return schemaFailure("response");
  if (value.version !== ASYNC_VALIDATION_PROTOCOL_VERSION) return schemaFailure("version");
  if (!isUuid(value.jobId)) return schemaFailure("jobId");
  if (!isCommitRepository(value.repository)) return schemaFailure("repository.commitSha");

  if (value.status === "queued" || value.status === "running") {
    return hasExactKeys(value, ["version", "jobId", "repository", "status"]) ? null : schemaFailure("response");
  }
  if (value.status === "failed") {
    if (!hasExactKeys(value, ["version", "jobId", "repository", "status", "failureCategory"])) return schemaFailure("response");
    return isOneOf(value.failureCategory, ASYNC_VALIDATION_FAILURE_CATEGORIES) ? null : schemaFailure("failureCategory");
  }
  if (value.status !== "completed" || !hasExactKeys(value, ["version", "jobId", "repository", "status", "result"])) {
    return schemaFailure("status");
  }

  const resultFailure = workerResultValidationFailure(value.result);
  if (resultFailure) return { category: "result_invalid", field: resultFailure.field };
  const result = value.result as ValidationWorkerResult;
  if (result.jobId !== value.jobId) return { category: "job_binding_invalid", field: "result.jobId" };
  return result.repository.commitSha.toLowerCase() === value.repository.commitSha.toLowerCase()
    ? null
    : { category: "commit_binding_invalid", field: "result.repository.commitSha" };
}

function validationWorkerRequestShapeFailure(value: unknown): AsyncValidationContractFailure | null {
  if (!hasExactKeys(value, ["version", "jobId", "repository", "dependencyType", "proposedFix", "policy"])) return schemaFailure("validation");
  if (value.version !== 1) return schemaFailure("validation.version");
  if (!isUuid(value.jobId)) return schemaFailure("validation.jobId");
  if (!isRecord(value.repository)
    || !hasExactKeys(value.repository, ["owner", "name", "commitSha"])
    || !isRepositorySegment(value.repository.owner)
    || !isRepositorySegment(value.repository.name)
    || !isCommitSha(value.repository.commitSha)) return schemaFailure("validation.repository");
  if (!isOneOf(value.dependencyType, ["dependency", "devDependency", "peerDependency", "optionalDependency"] as const)) return schemaFailure("validation.dependencyType");
  if (!isProposedFixShape(value.proposedFix)) return schemaFailure("validation.proposedFix");
  return isDeepStrictEqual(value.policy, VALIDATION_WORKER_POLICY) ? null : schemaFailure("validation.policy");
}

function isProposedFixShape(value: unknown) {
  if (!hasExactKeys(value, ["title", "summary", "confidence", "files", "packageJsonChange", "validationSteps", "warnings"])) return false;
  if (!isText(value.title, 160) || !isText(value.summary, 1_000) || typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 100) return false;
  if (!Array.isArray(value.files) || value.files.length > 3 || !value.files.every(isProposedFileShape)) return false;
  if (!hasExactKeys(value.packageJsonChange, ["required", "dependency", "from", "to"])) return false;
  if (typeof value.packageJsonChange.required !== "boolean" || !isText(value.packageJsonChange.dependency, 214) || !isText(value.packageJsonChange.from, 256) || !isText(value.packageJsonChange.to, 256)) return false;
  return isTextList(value.validationSteps) && isTextList(value.warnings);
}

function isProposedFileShape(value: unknown) {
  return hasExactKeys(value, ["path", "reason", "originalSnippet", "proposedSnippet"])
    && isText(value.path, 1_024)
    && isText(value.reason, 400)
    && isText(value.originalSnippet, 2_000)
    && isText(value.proposedSnippet, 2_000);
}

function isTextList(value: unknown) {
  return Array.isArray(value) && value.length <= 8 && value.every((item) => isText(item, 400));
}

function isCommitRepository(value: unknown): value is { commitSha: string } {
  return hasExactKeys(value, ["commitSha"]) && isCommitSha(value.commitSha);
}

function hasExactKeys<T extends readonly string[]>(value: unknown, keys: T): value is Record<T[number], unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function schemaFailure(field: string): AsyncValidationContractFailure {
  return { category: "schema_invalid", field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{40,64}$/i.test(value);
}

function isRepositorySegment(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
}
