import assert from "node:assert/strict";
import test from "node:test";
import { hashLogIdentifier, logger } from "../lib/logger.ts";

type ConsoleMethod = "info" | "warn" | "error";

function captureLog(method: ConsoleMethod, callback: () => void) {
  const original = console[method];
  const lines: unknown[][] = [];
  console[method] = (...values: unknown[]) => { lines.push(values); };
  try {
    callback();
  } finally {
    console[method] = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 1);
  assert.equal(typeof lines[0][0], "string");
  return JSON.parse(lines[0][0] as string) as Record<string, unknown>;
}

test("logger emits one structured JSON line with pseudonymous identifiers", () => {
  const record = captureLog("info", () => logger.info("scan.completed", {
    service: "sentinel-web",
    environment: "production",
    operationId: "operation-123",
    userIdentifier: "github-user-42",
    repositoryIdentifier: 123456,
    durationMs: 812,
    metadata: { dependencyCount: 44, outcome: "completed" },
  }));

  assert.equal(record.level, "info");
  assert.equal(record.event, "scan.completed");
  assert.equal(record.service, "sentinel-web");
  assert.equal(record.environment, "production");
  assert.equal(record.operationId, "operation-123");
  assert.equal(record.durationMs, 812);
  assert.equal(record.userIdentifierHash, hashLogIdentifier("github-user-42", "user"));
  assert.equal(record.repositoryIdentifierHash, hashLogIdentifier(123456, "repository"));
  assert.notEqual(record.userIdentifierHash, "github-user-42");
  assert.notEqual(record.repositoryIdentifierHash, "123456");
  assert.deepEqual(record.metadata, { dependencyCount: 44, outcome: "completed" });
  assert.equal(typeof record.timestamp, "string");
});

test("sensitive, content-bearing, and raw identity metadata keys are recursively redacted", () => {
  const record = captureLog("warn", () => logger.warn("security.rejected", {
    metadata: {
      authorization: "Bearer should-not-appear",
      nested: {
        githubAccessToken: "github-token-value",
        openaiApiKey: "openai-key-value",
        password: "password-value",
        cookie: "session=cookie-value",
        privateKey: "private-key-value",
      },
      prompt: "private model prompt",
      rawWebhookBody: "private webhook body",
      sourceCode: "const secret = true",
      repositoryContents: "private repository files",
      githubUserId: "raw-user-id",
      repositoryFullName: "private/repository",
      inputTokens: 1426,
      safeCategory: "invalid_signature",
    },
  }));

  const serialized = JSON.stringify(record);
  for (const forbidden of [
    "should-not-appear",
    "github-token-value",
    "openai-key-value",
    "password-value",
    "cookie-value",
    "private-key-value",
    "private model prompt",
    "private webhook body",
    "const secret",
    "private repository files",
    "raw-user-id",
    "private/repository",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(serialized.includes("[REDACTED]"), true);
  assert.equal(serialized.includes("invalid_signature"), true);
  assert.equal(serialized.includes("1426"), true);
});

test("credential patterns are redacted even inside otherwise safe string fields", () => {
  const privateKey = "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
  const message = [
    "Authorization: Bearer bearer-value",
    "sk-proj_1234567890abcdefghijkl",
    "github_pat_1234567890abcdefghijkl",
    "postgresql://database-user:database-password@db.example.test/app",
    privateKey,
  ].join(" | ");
  const record = captureLog("error", () => logger.error("provider.failed", {
    metadata: { category: "request_error", message },
  }));
  const serialized = JSON.stringify(record);

  for (const forbidden of [
    "bearer-value",
    "sk-proj_1234567890abcdefghijkl",
    "github_pat_1234567890abcdefghijkl",
    "database-password",
    "private-material",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("circular, binary, and oversized metadata cannot break logging", () => {
  const circular: Record<string, unknown> = { safe: true };
  circular.self = circular;
  const record = captureLog("info", () => {
    assert.doesNotThrow(() => logger.info("metadata.sanitized", {
      metadata: {
        circular,
        binary: Buffer.from("private bytes"),
        longValue: "x".repeat(3_000),
      },
    }));
  });
  const metadata = record.metadata as Record<string, unknown>;
  assert.equal(JSON.stringify(metadata).includes("private bytes"), false);
  assert.equal(JSON.stringify(metadata).includes("[CIRCULAR]"), true);
  assert.equal(JSON.stringify(metadata).includes("[BINARY_REDACTED]"), true);
  assert.equal((metadata.longValue as string).endsWith("…[TRUNCATED]"), true);
});
