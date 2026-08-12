import {
  verifyWorkerMessageSignature,
  workerResultValidationFailure,
  type ValidationWorkerResult,
} from "./worker-contract.ts";

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
  return { kind: "valid", result: parsed as ValidationWorkerResult };
}

export function workerResponseBindingFailure(result: ValidationWorkerResult, jobId: string, commitSha: string) {
  if (result.jobId !== jobId) return "result_job_mismatch";
  if (result.repository.commitSha.toLowerCase() !== commitSha.toLowerCase()) return "result_commit_mismatch";
  return null;
}
