import assert from "node:assert/strict";
import test from "node:test";
import {
  ASYNC_VALIDATION_PROTOCOL_VERSION,
  asyncValidationStatusRequestFailure,
  asyncValidationStatusResponseFailure,
  asyncValidationSubmitReceiptFailure,
  asyncValidationSubmitRequestFailure,
} from "../lib/validation/async-worker-contract.ts";
import {
  VALIDATION_WORKER_POLICY,
  signWorkerMessageSignature,
  verifyWorkerMessageSignature,
  type ValidationWorkerRequest,
  type ValidationWorkerResult,
} from "../lib/validation/worker-contract.ts";

const jobId = "123e4567-e89b-42d3-a456-426614174000";
const commitSha = "a".repeat(40);

function validationRequest(): ValidationWorkerRequest {
  return {
    version: 1,
    jobId,
    repository: { owner: "DEADPOO10", name: "express", commitSha },
    dependencyType: "devDependency",
    proposedFix: {
      title: "Update dependency",
      summary: "Proposed dependency-only update.",
      confidence: 80,
      files: [],
      packageJsonChange: { required: true, dependency: "supertest", from: "^6.0.0", to: "7.1.4" },
      validationSteps: ["Install dependencies.", "Run tests."],
      warnings: ["Source compatibility still requires review."],
    },
    policy: VALIDATION_WORKER_POLICY,
  };
}

function validationResult(): ValidationWorkerResult {
  return {
    version: 1,
    jobId,
    repository: { commitSha },
    overallStatus: "passed",
    install: { status: "passed", summary: "Install completed." },
    checks: [
      { name: "typecheck", status: "skipped", durationMs: 0, summary: "No script." },
      { name: "lint", status: "passed", durationMs: 100, summary: "Lint passed." },
      { name: "test", status: "passed", durationMs: 200, summary: "Tests passed." },
      { name: "build", status: "skipped", durationMs: 0, summary: "No script." },
    ],
    warnings: [],
    partialReasons: [],
  };
}

test("async submit request validates the versioned envelope and current worker request", () => {
  const request = {
    version: ASYNC_VALIDATION_PROTOCOL_VERSION,
    operation: "submit",
    validation: validationRequest(),
  };
  assert.equal(asyncValidationSubmitRequestFailure(request), null);
  assert.deepEqual(asyncValidationSubmitRequestFailure({ ...request, unexpected: true }), { category: "schema_invalid", field: "request" });
  assert.deepEqual(asyncValidationSubmitRequestFailure({ ...request, validation: { ...request.validation, policy: {} } }), { category: "schema_invalid", field: "validation.policy" });
});

test("submit receipt contains only safe queued binding fields", () => {
  const receipt = {
    version: ASYNC_VALIDATION_PROTOCOL_VERSION,
    jobId,
    repository: { commitSha },
    status: "queued",
  };
  assert.equal(asyncValidationSubmitReceiptFailure(receipt), null);
  assert.notEqual(asyncValidationSubmitReceiptFailure({ ...receipt, signature: "must-be-a-header" }), null);
  assert.notEqual(asyncValidationSubmitReceiptFailure({ ...receipt, status: "running" }), null);
});

test("async receipt bytes remain compatible with the existing HMAC response signature", () => {
  const body = JSON.stringify({
    version: ASYNC_VALIDATION_PROTOCOL_VERSION,
    jobId,
    repository: { commitSha },
    status: "queued",
  });
  const signature = signWorkerMessageSignature("test-secret", body);
  assert.equal(verifyWorkerMessageSignature("test-secret", body, signature), true);
  assert.equal(verifyWorkerMessageSignature("test-secret", `${body} `, signature), false);
});

test("status request requires an immutable job and commit binding", () => {
  const request = {
    version: ASYNC_VALIDATION_PROTOCOL_VERSION,
    operation: "status",
    jobId,
    repository: { commitSha },
  };
  assert.equal(asyncValidationStatusRequestFailure(request), null);
  assert.notEqual(asyncValidationStatusRequestFailure({ ...request, jobId: "not-a-job-id" }), null);
  assert.notEqual(asyncValidationStatusRequestFailure({ ...request, repository: { commitSha: "main" } }), null);
});

test("queued, running, and failed status responses accept only fixed safe fields", () => {
  const base = { version: ASYNC_VALIDATION_PROTOCOL_VERSION, jobId, repository: { commitSha } };
  assert.equal(asyncValidationStatusResponseFailure({ ...base, status: "queued" }), null);
  assert.equal(asyncValidationStatusResponseFailure({ ...base, status: "running" }), null);
  assert.equal(asyncValidationStatusResponseFailure({ ...base, status: "failed", failureCategory: "worker_timeout" }), null);
  assert.notEqual(asyncValidationStatusResponseFailure({ ...base, status: "failed", failureCategory: "raw provider error" }), null);
  assert.notEqual(asyncValidationStatusResponseFailure({ ...base, status: "queued", rawOutput: "not allowed" }), null);
});

test("completed status preserves strict final-result validation and binding", () => {
  const response = {
    version: ASYNC_VALIDATION_PROTOCOL_VERSION,
    jobId,
    repository: { commitSha },
    status: "completed",
    result: validationResult(),
  };
  assert.equal(asyncValidationStatusResponseFailure(response), null);

  const wrongJobResult = { ...response.result, jobId: "223e4567-e89b-42d3-a456-426614174000" };
  assert.deepEqual(asyncValidationStatusResponseFailure({ ...response, result: wrongJobResult }), { category: "job_binding_invalid", field: "result.jobId" });

  const wrongCommitResult = { ...response.result, repository: { commitSha: "b".repeat(40) } };
  assert.deepEqual(asyncValidationStatusResponseFailure({ ...response, result: wrongCommitResult }), { category: "commit_binding_invalid", field: "result.repository.commitSha" });

  const malformedResult = { ...response.result, checks: [] };
  assert.deepEqual(asyncValidationStatusResponseFailure({ ...response, result: malformedResult }), { category: "result_invalid", field: "checks" });
});
