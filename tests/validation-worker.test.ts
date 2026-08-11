import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { isAllowedValidationCommand, isSafeArchiveEntryPath, isSafeWorkerResult, verifyWorkerMessageSignature } from "../lib/validation/worker-contract.ts";

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
  const result = { version: 1, jobId: "4f15241e-8c5d-4a4a-8d8d-963402b51d4a", repository: { commitSha: "a".repeat(40) }, overallStatus: "passed", install: { status: "passed", summary: "Installed with scripts disabled." }, checks: ["typecheck", "lint", "test", "build"].map((name) => ({ name, status: "passed", durationMs: 10, summary: "Passed." })), warnings: [], partialReasons: [] };
  assert.equal(isSafeWorkerResult(result), true);
  assert.equal(isSafeWorkerResult({ ...result, checks: result.checks.slice(1) }), false);
  assert.equal(isSafeWorkerResult({ ...result, checks: result.checks.map((check) => ({ ...check, durationMs: 999_999_999 })) }), false);
  assert.equal(isSafeWorkerResult({ ...result, overallStatus: "failed", checks: result.checks.map((check) => check.name === "test" ? { ...check, status: "timed_out", durationMs: 90_000, summary: "Command timed out." } : check) }), true);
});

test("worker response signatures are integrity checked", () => {
  const secret = "a sufficiently long worker shared secret";
  const body = '{"jobId":"example"}';
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  assert.equal(verifyWorkerMessageSignature(secret, body, signature), true);
  assert.equal(verifyWorkerMessageSignature(secret, `${body} `, signature), false);
  assert.equal(verifyWorkerMessageSignature(secret, body, "not-a-signature"), false);
});
