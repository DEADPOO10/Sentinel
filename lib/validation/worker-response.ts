import {
  verifyWorkerMessageSignature,
  workerResultValidationFailure,
  type ValidationWorkerResult,
} from "./worker-contract.ts";
import { verifyNpmPackageLockArtifact, type NpmPackageLockExpectation, type VerifiedNpmPackageLockArtifact } from "./npm-package-lock-artifact.ts";

type ParsedWorkerResponse =
  | { kind: "valid"; result: ValidationWorkerResult }
  | { kind: "invalid"; reason: string; diagnostics: Record<string, string> };

/** Verify raw signed bytes before JSON parsing; diagnostics never include response data. */
export function parseSignedWorkerResponse(secret: string, responseBody: string, signature: string | null): ParsedWorkerResponse {
  if (!signature || !verifyWorkerMessageSignature(secret, responseBody, signature)) return { kind: "invalid", reason: "result_signature_invalid", diagnostics: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { kind: "invalid", reason: "result_json_invalid", diagnostics: {} };
  }
  const validationFailure = workerResultValidationFailure(parsed);
  if (validationFailure) return { kind: "invalid", reason: validationFailure.category, diagnostics: { field: validationFailure.field } };
  if ((parsed as ValidationWorkerResult).artifact !== undefined) {
    const artifact = verifyNpmPackageLockArtifact((parsed as ValidationWorkerResult).artifact);
    if (artifact.kind === "invalid") return { kind: "invalid", reason: "result_artifact_invalid", diagnostics: { field: artifact.reason } };
  }
  return { kind: "valid", result: parsed as ValidationWorkerResult };
}

export function verifiedWorkerPackageLockArtifact(
  result: ValidationWorkerResult,
  expectation: NpmPackageLockExpectation,
): { kind: "absent" } | { kind: "valid"; artifact: VerifiedNpmPackageLockArtifact } | { kind: "invalid"; reason: string } {
  if (result.artifact === undefined) return { kind: "absent" };
  const verified = verifyNpmPackageLockArtifact(result.artifact, expectation);
  return verified.kind === "valid" ? verified : { kind: "invalid", reason: verified.reason };
}

export function workerResponseBindingFailure(result: ValidationWorkerResult, jobId: string, commitSha: string) {
  if (result.jobId !== jobId) return "result_job_mismatch";
  if (result.repository.commitSha.toLowerCase() !== commitSha.toLowerCase()) return "result_commit_mismatch";
  return null;
}

/** Drains a worker response incrementally and stops before retaining oversized data. */
export async function readBoundedWorkerResponseText(response: Response, maximumBytes: number) {
  if (!response.body) return { kind: "valid" as const, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return { kind: "oversized" as const };
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { kind: "valid" as const, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8") };
}
