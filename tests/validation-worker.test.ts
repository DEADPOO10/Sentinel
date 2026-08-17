import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { isAllowedValidationCommand, isSafeArchiveEntryPath, isSafeWorkerResult, MAX_WORKER_TEXT_LENGTH, VALIDATION_WORKER_MAX_DURATION_MS, VALIDATION_WORKER_POLICY, signValidationWorkerRequest, signWorkerMessageSignature, validationWorkerRequestSignedMessage, verifyValidationWorkerRequestSignature, verifyWorkerMessageSignature, workerHttpErrorDiagnostics, workerResultValidationFailure, type ValidationWorkerResult } from "../lib/validation/worker-contract.ts";
import { parseSignedWorkerResponse, readBoundedWorkerResponseText, workerResponseBindingFailure } from "../lib/validation/worker-response.ts";
import { MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES, createNpmPackageLockArtifactTransport, isNpmPackageLockValidationBindingCurrent, verifyNpmPackageLockArtifact } from "../lib/validation/npm-package-lock-artifact.ts";

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

function validLockfileArtifact() {
  return createNpmPackageLockArtifactTransport(JSON.stringify({
    name: "example",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "example", version: "1.0.0", devDependencies: { supertest: "7.1.4" } },
      "node_modules/supertest": { version: "7.1.4" },
    },
  }));
}

test("the worker's documented validation budget is five minutes", () => {
  assert.equal(VALIDATION_WORKER_MAX_DURATION_MS, 300_000);
  assert.equal(VALIDATION_WORKER_POLICY.execution.maxDurationMs, VALIDATION_WORKER_MAX_DURATION_MS);
  assert.equal(VALIDATION_WORKER_POLICY.execution.maxCommandDurationMs, 120_000);
});

test("validation request signatures bind version, timestamp, and exact body", () => {
  const secret = "a sufficiently long worker shared secret";
  const timestamp = "1786896000000";
  const body = '{"message":"café","version":1}';
  const signedMessage = `v1\n${timestamp}\n${body}`;
  const signature = signValidationWorkerRequest(secret, timestamp, body);

  assert.equal(validationWorkerRequestSignedMessage(timestamp, body), signedMessage);
  assert.equal(signature, createHmac("sha256", secret).update(signedMessage).digest("base64url"));
  assert.equal(verifyValidationWorkerRequestSignature(secret, timestamp, body, signature), true);
  assert.equal(verifyValidationWorkerRequestSignature(secret, `${Number(timestamp) + 1}`, body, signature), false);
  assert.equal(verifyValidationWorkerRequestSignature(secret, timestamp, `${body} `, signature), false);
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

test("a valid authenticated npm lockfile artifact is accepted and decodes exactly", () => {
  const secret = "a sufficiently long worker shared secret";
  const artifact = validLockfileArtifact();
  const result = currentNpmValidationResult({ artifact });
  const body = JSON.stringify(result);
  const parsed = parseSignedWorkerResponse(secret, body, signWorkerMessageSignature(secret, body));
  assert.equal(parsed.kind, "valid");
  const verified = verifyNpmPackageLockArtifact(artifact, {
    dependencyName: "supertest",
    dependencyType: "devDependency",
    targetVersion: "7.1.4",
  });
  assert.equal(verified.kind, "valid");
  if (verified.kind === "valid") {
    const exactBytes = Buffer.from(artifact.content, "base64");
    assert.equal(verified.artifact.content, exactBytes.toString("utf8"));
    assert.deepEqual(Buffer.from(verified.artifact.bytes), exactBytes);
  }
});

test("invalidly signed artifact responses are rejected before artifact parsing", () => {
  const artifact = { ...validLockfileArtifact(), content: "not base64" };
  const body = JSON.stringify(currentNpmValidationResult({ artifact }));
  assert.deepEqual(parseSignedWorkerResponse("x".repeat(32), body, "invalid"), {
    kind: "invalid",
    reason: "result_signature_invalid",
    diagnostics: {},
  });
});

test("artifact encoding, byte length, digest, UTF-8, JSON, version, path, and dependency are strict", () => {
  const valid = validLockfileArtifact();
  const invalidUtf8Bytes = Buffer.from([0xff, 0xfe]);
  const invalidUtf8 = {
    kind: "npm_package_lock",
    path: "package-lock.json",
    encoding: "base64",
    content: invalidUtf8Bytes.toString("base64"),
    byteLength: invalidUtf8Bytes.byteLength,
    sha256: createHash("sha256").update(invalidUtf8Bytes).digest("hex"),
  };
  const cases: Array<[unknown, string]> = [
    [{ ...valid, content: "%%%=" }, "invalid_artifact_encoding"],
    [{ ...valid, byteLength: valid.byteLength + 1 }, "artifact_byte_length_mismatch"],
    [{ ...valid, sha256: "0".repeat(64) }, "artifact_digest_mismatch"],
    [invalidUtf8, "artifact_invalid_utf8"],
    [createNpmPackageLockArtifactTransport("not json"), "artifact_invalid_json"],
    [createNpmPackageLockArtifactTransport(JSON.stringify({ lockfileVersion: 1, packages: { "": {} } })), "artifact_unsupported_lockfile_version"],
    [{ ...valid, path: "nested/package-lock.json" }, "invalid_artifact_fields"],
  ];
  for (const [artifact, reason] of cases) {
    const verified = verifyNpmPackageLockArtifact(artifact);
    assert.equal(verified.kind, "invalid", reason);
    if (verified.kind === "invalid") assert.equal(verified.reason, reason);
  }
  const mismatch = verifyNpmPackageLockArtifact(valid, { dependencyName: "supertest", dependencyType: "devDependency", targetVersion: "8.0.0" });
  assert.deepEqual(mismatch, { kind: "invalid", reason: "artifact_dependency_mismatch" });
});

test("decoded npm lockfile artifacts are capped at exactly 2 MiB and never truncated", () => {
  const oversized = createNpmPackageLockArtifactTransport("x".repeat(MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES + 1));
  const verified = verifyNpmPackageLockArtifact(oversized);
  assert.deepEqual(verified, { kind: "invalid", reason: "artifact_oversized" });
});

test("existing signed worker responses without artifacts remain accepted", () => {
  const secret = "a sufficiently long worker shared secret";
  const body = JSON.stringify(currentNpmValidationResult());
  const parsed = parseSignedWorkerResponse(secret, body, signWorkerMessageSignature(secret, body));
  assert.equal(parsed.kind, "valid");
});

test("persisted lockfile authority is bound to one validation, proposal, and base commit", () => {
  const binding = {
    validationRunId: "validation_run_1",
    proposedFixId: "proposal_1",
    baseCommitSha: commitSha,
  };
  assert.equal(isNpmPackageLockValidationBindingCurrent(binding, { ...binding, baseCommitSha: commitSha.toUpperCase() }), true);
  assert.equal(isNpmPackageLockValidationBindingCurrent(binding, { ...binding, validationRunId: "validation_run_2" }), false);
  assert.equal(isNpmPackageLockValidationBindingCurrent(binding, { ...binding, proposedFixId: "proposal_2" }), false);
  assert.equal(isNpmPackageLockValidationBindingCurrent(binding, { ...binding, baseCommitSha: "b".repeat(40) }), false);
});

test("worker responses are retained incrementally only up to the configured byte limit", async () => {
  const accepted = await readBoundedWorkerResponseText(new Response("exact"), 5);
  assert.deepEqual(accepted, { kind: "valid", text: "exact" });
  const rejected = await readBoundedWorkerResponseText(new Response("oversized"), 5);
  assert.deepEqual(rejected, { kind: "oversized" });
});
