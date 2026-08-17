import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createGitHubWebhookPostHandler,
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
} from "../lib/github/github-webhook-route.ts";
import type { PullRequestLifecycleProcessingInput } from "../lib/db/pull-request-lifecycle.ts";
import { hashLogIdentifier } from "../lib/logger.ts";

const secret = "8d71f0ce950e4710b03f2b8c9e4d6a12726db7ec86124a32b17a3569b8fd4321";

function payload(action = "ready_for_review") {
  return {
    action,
    number: 42,
    repository: { id: 123456789, full_name: "DEADPOO10/express" },
    pull_request: {
      number: 42,
      node_id: "PR_kwDOExample_123",
      html_url: "https://github.com/DEADPOO10/express/pull/42",
      state: "open",
      draft: false,
      merged: false,
      updated_at: "2026-08-16T10:01:00Z",
      base: { ref: "master" },
      head: { ref: "sentinel/deps/supertest/changeid" },
    },
  };
}

function request(body: string, overrides: {
  event?: string | null;
  delivery?: string | null;
  signature?: string | null;
  contentType?: string;
} = {}) {
  const headers = new Headers({ "Content-Type": overrides.contentType ?? "application/json" });
  const event = overrides.event === undefined ? "pull_request" : overrides.event;
  const delivery = overrides.delivery === undefined ? "delivery-123" : overrides.delivery;
  const signature = overrides.signature === undefined ? sign(body) : overrides.signature;
  if (event !== null) headers.set("X-GitHub-Event", event);
  if (delivery !== null) headers.set("X-GitHub-Delivery", delivery);
  if (signature !== null) headers.set("X-Hub-Signature-256", signature);
  return new Request("https://sentinel.example/api/github/webhooks", { method: "POST", headers, body });
}

function handler(options: {
  configured?: boolean;
  secret?: string;
  process?: (input: PullRequestLifecycleProcessingInput) => Promise<{ kind: "processed" }>;
} = {}) {
  return createGitHubWebhookPostHandler({
    getSecret: () => options.configured === false ? undefined : options.secret ?? secret,
    processPullRequest: options.process ?? (async () => ({ kind: "processed" })),
  });
}

test("a valid signed supported event is normalized and processed", async () => {
  const received: PullRequestLifecycleProcessingInput[] = [];
  const response = await handler({ process: async (input) => {
    received.push(input);
    return { kind: "processed" };
  } })(request(JSON.stringify(payload())));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(received[0]?.deliveryId, "delivery-123");
  assert.equal(received[0]?.payload.pullRequest.status, "READY_FOR_REVIEW");
});

test("successful webhook logs share a safe operation ID and hashed repository identity", async () => {
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  console.info = (...values: unknown[]) => { logs.push(values); };
  try {
    const response = await handler()(request(JSON.stringify(payload())));
    assert.equal(response.status, 200);
    assert.equal(logs.length, 2);

    const started = JSON.parse(logs[0][0] as string) as Record<string, unknown>;
    const completed = JSON.parse(logs[1][0] as string) as Record<string, unknown>;
    assert.equal(started.event, "github_webhook.started");
    assert.equal(completed.event, "github_webhook.completed");
    assert.match(started.operationId as string, /^[0-9a-f-]{36}$/i);
    assert.equal(completed.operationId, started.operationId);
    assert.equal((started.metadata as Record<string, unknown>).deliveryId, "delivery-123");
    assert.equal((completed.metadata as Record<string, unknown>).deliveryId, "delivery-123");
    assert.equal(completed.repositoryIdentifierHash, hashLogIdentifier("123456789", "repository"));
    assert.equal(JSON.stringify(completed).includes("DEADPOO10/express"), false);
  } finally {
    console.info = originalInfo;
  }
});

test("a correctly signed ping is accepted as a no-op", async () => {
  let calls = 0;
  const body = JSON.stringify({ zen: "safe setup check" });
  const response = await handler({ process: async () => {
    calls += 1;
    return { kind: "processed" };
  } })(request(body, { event: "ping" }));
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});

test("invalid and missing signatures are rejected before JSON parsing", async () => {
  assert.equal((await handler()(request("not json", { signature: `sha256=${"0".repeat(64)}` }))).status, 401);
  assert.equal((await handler()(request("not json", { signature: null }))).status, 401);
});

test("missing delivery/event headers and wrong content type are rejected", async () => {
  const body = JSON.stringify(payload());
  assert.equal((await handler()(request(body, { delivery: null }))).status, 400);
  assert.equal((await handler()(request(body, { event: null }))).status, 400);
  assert.equal((await handler()(request(body, { contentType: "text/plain" }))).status, 415);
});

test("malformed JSON and malformed supported payloads return 400", async () => {
  assert.equal((await handler()(request("not json"))).status, 400);
  assert.equal((await handler()(request(JSON.stringify({ action: "ready_for_review" })))).status, 400);
});

test("unsupported events and pull-request actions are safe no-ops", async () => {
  const eventResponse = await handler()(request(JSON.stringify({ action: "created" }), { event: "issues" }));
  const actionResponse = await handler()(request(JSON.stringify(payload("synchronize"))));
  assert.equal(eventResponse.status, 202);
  assert.equal(actionResponse.status, 202);
});

test("streamed request bodies over 1 MiB return 413 even without Content-Length", async () => {
  const body = "x".repeat(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1);
  const response = await handler()(request(body));
  assert.equal(response.status, 413);
});

test("a missing webhook secret fails closed", async () => {
  const response = await handler({ configured: false })(request(JSON.stringify(payload())));
  assert.equal(response.status, 503);
});

test("short and obvious placeholder webhook secrets fail closed", async () => {
  const insecureSecrets = [
    "too-short",
    "example".repeat(5),
    "changeme".repeat(4),
    "test".repeat(8),
    "secret".repeat(6),
    "default".repeat(5),
    "replace-with-a-random-webhook-secret",
  ];

  for (const insecureSecret of insecureSecrets) {
    const response = await handler({ secret: insecureSecret })(request(JSON.stringify(payload())));
    assert.equal(response.status, 503);
  }
});

test("database failures return a retryable 500 without sensitive response details", async () => {
  const originalError = console.error;
  const logs: unknown[][] = [];
  console.error = (...values: unknown[]) => { logs.push(values); };
  try {
    const response = await handler({ process: async () => {
      throw new Error("DATABASE_URL=should-never-appear");
    } })(request(JSON.stringify(payload())));
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.doesNotMatch(body, /DATABASE_URL|should-never-appear/);
    assert.equal(JSON.stringify(logs).includes("should-never-appear"), false);
    assert.equal(logs.length, 1);
    const record = JSON.parse(logs[0][0] as string) as Record<string, unknown>;
    assert.equal(record.event, "github_webhook.completed");
    assert.match(record.operationId as string, /^[0-9a-f-]{36}$/i);
    assert.equal(record.repositoryIdentifierHash, hashLogIdentifier("123456789", "repository"));
    assert.deepEqual(record.metadata, {
      result: "processing_failed",
      httpStatus: 500,
      eventType: "pull_request",
      deliveryId: "delivery-123",
      action: "ready_for_review",
      stage: "database_transaction",
      category: "retryable_database_error",
    });
  } finally {
    console.error = originalError;
  }
});

function sign(body: string) {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}
