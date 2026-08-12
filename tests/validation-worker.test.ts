import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { isAllowedValidationCommand, isSafeArchiveEntryPath, isSafeWorkerResult, MAX_WORKER_TEXT_LENGTH, VALIDATION_WORKER_MAX_DURATION_MS, VALIDATION_WORKER_POLICY, signWorkerMessageSignature, verifyWorkerMessageSignature, workerHttpErrorDiagnostics, workerResultValidationFailure, type ValidationWorkerResult } from "../lib/validation/worker-contract.ts";
import { parseSignedWorkerResponse, workerResponseBindingFailure } from "../lib/validation/worker-response.ts";

const jobId = "4f15241e-8c5d-4a4a-8d8d-963402b51d4a";
const commitSha = "a".repeat(40);
function currentNpmValidationResult(overrides: Record<string, unknown> = {}): ValidationWorkerResult {
  return {
    version: 1,
    jobId,
    repository: { commitSha },
    overallStatus: "partial",
    install: {
      status: "passed",
      summary: "package-lock.json was regenerated only inside the isolated validation sandbox; dependencies installed with scripts disabled.",
    },
    checks: [
      { name: "typecheck", status: "skipped", durationMs: 0, summary: "No package script is defined." },
      { name: "lint", status: "passed", durationMs: 1467, summary: "Completed." },
      { name: "test", status: "passed", durationMs: 23900, summary: "Completed." },
      { name: "build", status: "skipped", durationMs: 0, summary: "No package script is defined." },
    ],
    warnings: ["package_lock_synchronized_in_sandbox", "one_or_more_allowlisted_checks_not_defined"],
    partialReasons: ["skipped_checks"],
    ...overrides,
  } as ValidationWorkerResult;
}

test("the worker's documented validation budget is five minutes", () => {
  assert.equal(VALIDATION_WORKER_MAX_DURATION_MS, 300_000);
  assert.equal(VALIDATION_WORKER_POLICY.execution.maxDurationMs, VALIDATION_WORKER_MAX_DURATION_MS);
  assert.equal(VALIDATION_WORKER_POLICY.execution.maxCommandDurationMs, 120_000);
});

test("HTTP failure diagnostics contain only a status and determined upstream category", () => {
  assert.deepEqual(
    workerHttpErrorDiagnostics(504, new URL("https://sentinel-validation-proxy.example.workers.dev/v1/validations")),
    { status: "504", upstream: "cloudflare_proxy" },
  );
  assert.deepEqual(
    workerHttpErrorDiagnostics(500, new URL("https://example.modal.run/v1/validations")),
    { status: "500", upstream: "validation_worker" },
  );
});

test("validation commands are exact allowlist entries", () => {
  assert.equal(isAllowedValidationCommand(["npm", "ci", "--ignore-scripts", "--no-audit", "--fund=false"], "npm"), true);
  assert.equal(isAllowedValidationCommand(["npm", "run", "test", "--if-present"], "npm"), true);
  assert.equal(isAllowedValidationCommand(["npm", "run", "test", "&&", "curl", "example.com"], "npm"), false);
  assert.equal(isAllowedValidationCommand(["sh", "-c", "npm test"], "npm"), false);
});

test("archive paths reject traversal and host-specific paths", () => {
  for (const path of ["../secret", "/etc/passwd", "src\\index.ts", "src/../../secret", "src//index.ts", "src/\0secret"]) assert.equal(isSafeArchiveEntryPath(path), false, path);
  assert.equal(isSafeArchiveEntryPath("src/index.ts"), true);
});

test("worker results require bounded, complete status data", () => {
  const result = { ...currentNpmValidationResult(), overallStatus: "passed", checks: ["typecheck", "lint", "test", "build"].map((name) => ({ name, status: "passed", durationMs: 10, summary: "Passed." })), warnings: [], partialReasons: [] };
  assert.equal(isSafeWorkerResult(result), true);
  assert.equal(isSafeWorkerResult({ ...result, checks: result.checks.slice(1) }), false);
  assert.equal(isSafeWorkerResult({ ...result, checks: result.checks.map((check) => ({ ...check, durationMs: 999_999_999 })) }), false);
  assert.equal(isSafeWorkerResult({ ...result, overallStatus: "partial", checks: result.checks.map((check) => check.name === "test" ? { ...check, status: "timed_out", durationMs: 120_000, summary: "Tests exceeded the isolated validation time budget." } : check), warnings: ["validation_check_timed_out"], partialReasons: ["validation_timeout"] }), true);
});

test("the current npm lockfile-sync result is accepted as exact signed worker JSON", () => {
  const secret = "cross-language fixture secret; not a production credential";
  const pythonStyleJson = JSON.stringify(currentNpmValidationResult());
  const signature = signWorkerMessageSignature(secret, pythonStyleJson);

  assert.equal(verifyWorkerMessageSignature(secret, pythonStyleJson, signature), true);
  assert.equal(isSafeWorkerResult(JSON.parse(pythonStyleJson)), true);
});

test("signed worker response parsing identifies safe failure stages without exposing response text", () => {
  const secret = "cross-language fixture secret; not a production credential";
  const valid = JSON.stringify(currentNpmValidationResult());
  const signature = signWorkerMessageSignature(secret, valid);
  assert.equal(parseSignedWorkerResponse(secret, valid, signature).kind, "valid");
  assert.deepEqual(parseSignedWorkerResponse(secret, valid, "invalid"), { kind: "invalid", reason: "result_signature_invalid", diagnostics: {} });

  const malformed = "{";
  assert.deepEqual(parseSignedWorkerResponse(secret, malformed, signWorkerMessageSignature(secret, malformed)), { kind: "invalid", reason: "result_json_invalid", diagnostics: {} });

  const invalidCheck = JSON.stringify({ ...currentNpmValidationResult(), checks: currentNpmValidationResult().checks.map((check) => check.name === "test" ? { ...check, status: "invalid" } : check) });
  assert.deepEqual(
    parseSignedWorkerResponse(secret, invalidCheck, signWorkerMessageSignature(secret, invalidCheck)),
    { kind: "invalid", reason: "result_check_invalid", diagnostics: { field: "checks.status" } },
  );
});

test("valid results remain bound to the initiated job and immutable commit", () => {
  const result = currentNpmValidationResult();
  assert.equal(workerResponseBindingFailure(result, jobId, commitSha), null);
  assert.equal(workerResponseBindingFailure(result, "6f15241e-8c5d-4a4a-8d8d-963402b51d4a", commitSha), "result_job_mismatch");
  assert.equal(workerResponseBindingFailure(result, jobId, "b".repeat(40)), "result_commit_mismatch");
});

test("result validation returns only safe fixed categories and fields", () => {
  const cases: Array<[unknown, { category: string; field: string }]> = [
    [{ ...currentNpmValidationResult(), overallStatus: "COMPLETE" }, { category: "result_status_invalid", field: "overallStatus" }],
    [{ ...currentNpmValidationResult(), install: { status: "complete", summary: "done" } }, { category: "result_install_invalid", field: "install.status" }],
    [{ ...currentNpmValidationResult(), checks: currentNpmValidationResult().checks.map((check) => check.name === "test" ? { ...check, status: "COMPLETE" } : check) }, { category: "result_check_invalid", field: "checks.status" }],
    [{ ...currentNpmValidationResult(), checks: currentNpmValidationResult().checks.map((check) => check.name === "test" ? { ...check, summary: "x".repeat(MAX_WORKER_TEXT_LENGTH + 1) } : check) }, { category: "result_check_invalid", field: "checks.summary" }],
    [{ ...currentNpmValidationResult(), partialReasons: ["total_deadline_reached"] }, { category: "result_schema_invalid", field: "partialReasons" }],
  ];
  for (const [result, expected] of cases) assert.deepEqual(workerResultValidationFailure(result), expected);
});

test("all worker result outcome statuses are accepted when their complete shape is valid", () => {
  for (const overallStatus of ["passed", "failed", "partial", "unable_to_validate"] as const) {
    const result = currentNpmValidationResult({ overallStatus, ...(overallStatus === "passed" ? { warnings: [], partialReasons: [] } : {}) });
    assert.equal(isSafeWorkerResult(result), true, overallStatus);
  }
});

test("worker response signatures are integrity checked", () => {
  const secret = "a sufficiently long worker shared secret";
  const body = '{"jobId":"example"}';
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  assert.equal(verifyWorkerMessageSignature(secret, body, signature), true);
  assert.equal(verifyWorkerMessageSignature(secret, `${body} `, signature), false);
  assert.equal(verifyWorkerMessageSignature(secret, body, "not-a-signature"), false);
});
