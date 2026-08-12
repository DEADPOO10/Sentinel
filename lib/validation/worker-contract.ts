import type { ProposedFix } from "@/lib/openai/proposed-fix";
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_WORKER_RESPONSE_BYTES = 64 * 1_024;
export const VALIDATION_WORKER_MAX_DURATION_MS = 5 * 60 * 1_000;
export const MAX_WORKER_TEXT_LENGTH = 1_000;
const CHECK_NAMES = ["typecheck", "lint", "test", "build"] as const;
const CHECK_STATUSES = ["passed", "failed", "skipped", "timed_out"] as const;
const OVERALL_STATUSES = ["passed", "failed", "partial", "unable_to_validate"] as const;
const PARTIAL_REASONS = ["skipped_checks", "no_lockfile_fallback", "cleanup_unconfirmed"] as const;

/** This policy is sent to every provider and must be enforced by the worker. */
export const VALIDATION_WORKER_POLICY = {
  version: 1,
  execution: { nonRoot: true, privileged: false, readOnlyRootFilesystem: true, ephemeralWorkspace: true, cpuMillicores: 1_000, memoryMiB: 2_048, maxDurationMs: VALIDATION_WORKER_MAX_DURATION_MS, maxCommandDurationMs: 90 * 1_000, maxCommandOutputBytes: 24 * 1_024 },
  archive: { maxCompressedBytes: 25 * 1_024 * 1_024, maxExtractedBytes: 100 * 1_024 * 1_024, rejectAbsolutePaths: true, rejectParentTraversal: true, rejectSymlinks: true },
  network: { install: { mode: "allowlist", hosts: ["registry.npmjs.org", "registry.yarnpkg.com"] }, checks: { mode: "disabled" } },
  installScripts: "disabled",
  allowedCommands: [
    ["npm", "ci", "--ignore-scripts", "--no-audit", "--fund=false"],
    ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
    ["yarn", "install", "--immutable", "--ignore-scripts"],
    ...CHECK_NAMES.map((name) => ["$PACKAGE_MANAGER", "run", name, "--if-present"]),
  ],
} as const;

export type ValidationWorkerRequest = { version: 1; jobId: string; repository: { owner: string; name: string; commitSha: string }; dependencyType: "dependency" | "devDependency" | "peerDependency" | "optionalDependency"; proposedFix: ProposedFix; policy: typeof VALIDATION_WORKER_POLICY };
export type ValidationWorkerResult = { version: 1; jobId: string; repository: { commitSha: string }; overallStatus: (typeof OVERALL_STATUSES)[number]; install: { status: "passed" | "failed" | "skipped"; summary: string }; checks: Array<{ name: (typeof CHECK_NAMES)[number]; status: (typeof CHECK_STATUSES)[number]; durationMs: number; summary: string }>; warnings: string[]; partialReasons: Array<(typeof PARTIAL_REASONS)[number]> };
export type WorkerResultValidationFailure = {
  category: "result_schema_invalid" | "result_status_invalid" | "result_install_invalid" | "result_check_invalid";
  field: string;
};

export function isAllowedValidationCommand(command: readonly string[], packageManager: "npm" | "pnpm" | "yarn") {
  const normalized = command.map((part) => part === "$PACKAGE_MANAGER" ? packageManager : part);
  return VALIDATION_WORKER_POLICY.allowedCommands.some((allowed) => allowed.length === normalized.length && allowed.every((part, index) => (part === "$PACKAGE_MANAGER" ? packageManager : part) === normalized[index]));
}

export function isSafeArchiveEntryPath(value: string) {
  return value.length > 0 && value.length <= 1_024 && !value.includes("\\") && !value.includes("\0") && !value.startsWith("/") && !value.split("/").some((segment) => segment === ".." || segment === "");
}

export function verifyWorkerMessageSignature(secret: string, payload: string, signature: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const expected = Buffer.from(signWorkerMessageSignature(secret, payload));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Signs the exact UTF-8 JSON text sent over the validation worker boundary. */
export function signWorkerMessageSignature(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Safe metadata for non-successful HTTP responses; never includes body data. */
export function workerHttpErrorDiagnostics(status: number, endpoint: URL) {
  const host = endpoint.hostname.toLowerCase();
  const upstream = host.endsWith(".workers.dev") || host.endsWith(".cloudflareworkers.com")
    ? "cloudflare_proxy"
    : host.endsWith(".modal.run")
      ? "validation_worker"
      : "unknown";
  return { status: String(status), upstream };
}

export function isSafeWorkerResult(value: unknown): value is ValidationWorkerResult {
  return workerResultValidationFailure(value) === null;
}

/** Return only a fixed contract field, never provider-controlled response text. */
export function workerResultValidationFailure(value: unknown): WorkerResultValidationFailure | null {
  if (!isRecord(value)) return { category: "result_schema_invalid", field: "result" };
  if (value.version !== 1) return { category: "result_schema_invalid", field: "version" };
  if (!isUuid(value.jobId)) return { category: "result_schema_invalid", field: "jobId" };
  if (!isRecord(value.repository) || !isCommitSha(value.repository.commitSha)) return { category: "result_schema_invalid", field: "repository.commitSha" };
  if (!isOneOf(value.overallStatus, OVERALL_STATUSES)) return { category: "result_status_invalid", field: "overallStatus" };
  if (!isRecord(value.install)) return { category: "result_install_invalid", field: "install" };
  if (!isOneOf(value.install.status, ["passed", "failed", "skipped"] as const)) return { category: "result_install_invalid", field: "install.status" };
  if (!isSafeText(value.install.summary)) return { category: "result_install_invalid", field: "install.summary" };
  if (!Array.isArray(value.checks) || value.checks.length !== CHECK_NAMES.length) return { category: "result_check_invalid", field: "checks" };
  const names = new Set<string>();
  for (const check of value.checks) {
    if (!isRecord(check)) return { category: "result_check_invalid", field: "checks.item" };
    if (!isOneOf(check.name, CHECK_NAMES) || names.has(check.name)) return { category: "result_check_invalid", field: "checks.name" };
    if (!isOneOf(check.status, CHECK_STATUSES)) return { category: "result_check_invalid", field: "checks.status" };
    const durationMs = check.durationMs;
    if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > VALIDATION_WORKER_POLICY.execution.maxDurationMs) return { category: "result_check_invalid", field: "checks.durationMs" };
    if (!isSafeText(check.summary)) return { category: "result_check_invalid", field: "checks.summary" };
    names.add(check.name);
  }
  if (!CHECK_NAMES.every((name) => names.has(name))) return { category: "result_check_invalid", field: "checks.name" };
  if (!Array.isArray(value.warnings) || value.warnings.length > 12 || !value.warnings.every(isSafeText)) return { category: "result_schema_invalid", field: "warnings" };
  if (!Array.isArray(value.partialReasons) || value.partialReasons.length > PARTIAL_REASONS.length || !value.partialReasons.every((reason) => isOneOf(reason, PARTIAL_REASONS))) return { category: "result_schema_invalid", field: "partialReasons" };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] { return typeof value === "string" && values.includes(value as T[number]); }
function isSafeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_WORKER_TEXT_LENGTH; }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value); }
function isCommitSha(value: unknown): value is string { return typeof value === "string" && /^[a-f\d]{40,64}$/i.test(value); }
