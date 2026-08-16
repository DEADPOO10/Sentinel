import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyGitHubWebhookSignature } from "../lib/github/webhook-signature.ts";

function sign(secret: string, body: Uint8Array) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("GitHub's published HMAC-SHA256 test vector is accepted", () => {
  const body = new TextEncoder().encode("Hello, World!");
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  assert.deepEqual(verifyGitHubWebhookSignature("It's a Secret to Everybody", signature, body), { valid: true });
});

test("a signature produced with the wrong secret is rejected", () => {
  const body = new TextEncoder().encode('{"action":"closed"}');
  assert.deepEqual(
    verifyGitHubWebhookSignature("correct-secret", sign("wrong-secret", body), body),
    { valid: false, reason: "invalid_signature" },
  );
});

test("missing and malformed signature headers are rejected", () => {
  const body = new TextEncoder().encode("payload");
  assert.deepEqual(verifyGitHubWebhookSignature("secret", null, body), { valid: false, reason: "missing_signature" });
  assert.deepEqual(verifyGitHubWebhookSignature("secret", "sha1=abc", body), { valid: false, reason: "malformed_signature" });
  assert.deepEqual(verifyGitHubWebhookSignature("secret", "sha256=abc", body), { valid: false, reason: "malformed_signature" });
});

test("Unicode payloads are verified from their exact raw UTF-8 bytes", () => {
  const body = new TextEncoder().encode('{"message":"café 👋"}');
  const changedBody = new TextEncoder().encode('{"message":"cafe 👋"}');
  const signature = sign("secret", body);

  assert.deepEqual(verifyGitHubWebhookSignature("secret", signature, body), { valid: true });
  assert.deepEqual(verifyGitHubWebhookSignature("secret", signature, changedBody), { valid: false, reason: "invalid_signature" });
});
