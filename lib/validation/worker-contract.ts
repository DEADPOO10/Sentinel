import type { ProposedFix } from "@/lib/openai/proposed-fix";
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_WORKER_RESPONSE_BYTES = 64 * 1_024;
const CHECK_NAMES = ["typecheck", "lint", "test", "build"] as const;
const CHECK_STATUSES = ["passed", "failed", "skipped", "timed_out"] as const;
const OVERALL_STATUSES = ["passed", "failed", "partial", "unable_to_validate"] as const;
const PARTIAL_REASONS = ["skipped_checks", "no_lockfile_fallback", "cleanup_unconfirmed"] as const;

/** This policy is sent to every provider and must be enforced by the worker. */
export const VALIDATION_WORKER_POLICY = {
  version: 1,
  execution: { nonRoot: true, privileged: false, readOnlyRootFilesystem: true, ephemeralWorkspace: true, cpuMillicores: 1_000, memoryMiB: 2_048, maxDurationMs: 5 * 60 * 1_000, maxCommandDurationMs: 90 * 1_000, maxCommandOutputBytes: 24 * 1_024 },
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

export function isSafeWorkerResult(value: unknown): value is ValidationWorkerResult {
  if (!isRecord(value) || value.version !== 1 || !isUuid(value.jobId) || !isRecord(value.repository) || !isCommitSha(value.repository.commitSha) || !isOneOf(value.overallStatus, OVERALL_STATUSES) || !isRecord(value.install) || !isOneOf(value.install.status, ["passed", "failed", "skipped"] as const) || !isSafeText(value.install.summary) || !Array.isArray(value.checks) || value.checks.length !== CHECK_NAMES.length || !Array.isArray(value.warnings) || value.warnings.length > 12 || !Array.isArray(value.partialReasons) || value.partialReasons.length > PARTIAL_REASONS.length) return false;
  const names = new Set<string>();
  for (const check of value.checks) { const durationMs = isRecord(check) ? check.durationMs : undefined; if (!isRecord(check) || !isOneOf(check.name, CHECK_NAMES) || names.has(check.name) || !isOneOf(check.status, CHECK_STATUSES) || !Number.isSafeInteger(durationMs) || typeof durationMs !== "number" || durationMs < 0 || durationMs > VALIDATION_WORKER_POLICY.execution.maxDurationMs || !isSafeText(check.summary)) return false; names.add(check.name); }
  return CHECK_NAMES.every((name) => names.has(name)) && value.warnings.every(isSafeText) && value.partialReasons.every((reason) => isOneOf(reason, PARTIAL_REASONS));
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] { return typeof value === "string" && values.includes(value as T[number]); }
function isSafeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1_000; }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value); }
function isCommitSha(value: unknown): value is string { return typeof value === "string" && /^[a-f\d]{40,64}$/i.test(value); }
