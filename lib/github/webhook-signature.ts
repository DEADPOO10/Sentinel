import { createHmac, timingSafeEqual } from "node:crypto";

const GITHUB_SHA256_SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

export type GitHubWebhookSignatureVerification =
  | { valid: true }
  | { valid: false; reason: "missing_signature" | "malformed_signature" | "invalid_signature" };

/**
 * Verifies GitHub's HMAC-SHA256 signature against the exact request bytes.
 * This pure helper deliberately receives its secret rather than reading process state.
 */
export function verifyGitHubWebhookSignature(
  secret: string,
  signature: string | null | undefined,
  rawBody: Uint8Array,
): GitHubWebhookSignatureVerification {
  if (!signature) return { valid: false, reason: "missing_signature" };

  const match = GITHUB_SHA256_SIGNATURE_PATTERN.exec(signature);
  if (!match) return { valid: false, reason: "malformed_signature" };

  if (!secret) return { valid: false, reason: "invalid_signature" };

  const body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  const expectedDigest = createHmac("sha256", secret).update(body).digest();
  const suppliedDigest = Buffer.from(match[1], "hex");

  if (suppliedDigest.byteLength !== expectedDigest.byteLength) {
    return { valid: false, reason: "malformed_signature" };
  }

  return timingSafeEqual(suppliedDigest, expectedDigest)
    ? { valid: true }
    : { valid: false, reason: "invalid_signature" };
}
