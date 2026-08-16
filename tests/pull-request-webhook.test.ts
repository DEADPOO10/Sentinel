import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePullRequestLifecycleTransition,
  getPullRequestLifecycleStatus,
  parsePullRequestWebhookPayload,
  type PullRequestLifecycleStatus,
  type SupportedPullRequestWebhookAction,
} from "../lib/github/pull-request-webhook.ts";

const earlier = new Date("2026-08-16T10:00:00Z");
const later = new Date("2026-08-16T10:01:00Z");

function payload(overrides: {
  action?: string;
  state?: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  updatedAt?: string;
} = {}) {
  return {
    action: overrides.action ?? "ready_for_review",
    number: 42,
    repository: {
      id: 123456789,
      full_name: "DEADPOO10/express",
    },
    pull_request: {
      number: 42,
      node_id: "PR_kwDOExample_123",
      html_url: "https://github.com/DEADPOO10/express/pull/42",
      state: overrides.state ?? "open",
      draft: overrides.draft ?? false,
      merged: overrides.merged ?? false,
      updated_at: overrides.updatedAt ?? later.toISOString(),
      base: { ref: "master" },
      head: { ref: "sentinel/deps/supertest/changeid" },
    },
  };
}

test("GitHub state fields map to Sentinel lifecycle states", () => {
  assert.equal(getPullRequestLifecycleStatus({ state: "open", draft: true, merged: false }), "DRAFT");
  assert.equal(getPullRequestLifecycleStatus({ state: "open", draft: false, merged: false }), "READY_FOR_REVIEW");
  assert.equal(getPullRequestLifecycleStatus({ state: "closed", draft: true, merged: false }), "CLOSED");
  assert.equal(getPullRequestLifecycleStatus({ state: "closed", draft: false, merged: true }), "MERGED");
  assert.equal(getPullRequestLifecycleStatus({ state: "open", draft: false, merged: true }), null);
});

test("the four approved pull-request actions are parsed and normalized", () => {
  const cases = [
    payload({ action: "ready_for_review", state: "open", draft: false, merged: false }),
    payload({ action: "converted_to_draft", state: "open", draft: true, merged: false }),
    payload({ action: "closed", state: "closed", draft: false, merged: false }),
    payload({ action: "reopened", state: "open", draft: true, merged: false }),
  ];

  for (const candidate of cases) {
    const parsed = parsePullRequestWebhookPayload(candidate);
    assert.ok(parsed);
    assert.equal(parsed.repository.githubRepositoryId, "123456789");
    assert.equal(parsed.repository.fullName, "DEADPOO10/express");
    assert.equal(parsed.pullRequest.number, 42);
    assert.equal(parsed.pullRequest.nodeId, "PR_kwDOExample_123");
    assert.equal(parsed.pullRequest.baseBranch, "master");
    assert.equal(parsed.pullRequest.headBranch, "sentinel/deps/supertest/changeid");
  }
});

test("unsupported actions and action-state contradictions are rejected", () => {
  assert.equal(parsePullRequestWebhookPayload(payload({ action: "synchronize" })), null);
  assert.equal(parsePullRequestWebhookPayload(payload({ action: "ready_for_review", draft: true })), null);
  assert.equal(parsePullRequestWebhookPayload(payload({ action: "converted_to_draft", draft: false })), null);
  assert.equal(parsePullRequestWebhookPayload(payload({ action: "closed", state: "open" })), null);
  assert.equal(parsePullRequestWebhookPayload(payload({ action: "reopened", state: "closed" })), null);
  assert.equal(parsePullRequestWebhookPayload(payload({ action: "closed", state: "open", merged: true })), null);
});

test("identity and URL mismatches are rejected", () => {
  assert.equal(parsePullRequestWebhookPayload({ ...payload(), number: 43 }), null);
  assert.equal(parsePullRequestWebhookPayload({ ...payload(), repository: { id: 0, full_name: "DEADPOO10/express" } }), null);
  assert.equal(parsePullRequestWebhookPayload({
    ...payload(),
    pull_request: { ...payload().pull_request, html_url: "https://github.com/other/repository/pull/42" },
  }), null);
});

test("approved Draft and Ready lifecycle transitions are applied", () => {
  assertApply("DRAFT", "ready_for_review", "READY_FOR_REVIEW");
  assertApply("READY_FOR_REVIEW", "converted_to_draft", "DRAFT");
});

test("approved close and merge transitions are applied", () => {
  assertApply("DRAFT", "closed", "CLOSED");
  assertApply("READY_FOR_REVIEW", "closed", "MERGED");
});

test("closed pull requests reopen according to authenticated payload state", () => {
  assertApply("CLOSED", "reopened", "READY_FOR_REVIEW");
  assertApply("CLOSED", "reopened", "DRAFT");
});

test("MERGED is terminal, including for equal-time events", () => {
  const reopened = evaluatePullRequestLifecycleTransition(
    { status: "MERGED", githubUpdatedAt: later },
    { action: "reopened", status: "READY_FOR_REVIEW", githubUpdatedAt: later },
  );
  assert.deepEqual(reopened, { kind: "ignore", reason: "merged_terminal" });
});

test("older GitHub timestamps cannot regress newer stored state", () => {
  const result = evaluatePullRequestLifecycleTransition(
    { status: "READY_FOR_REVIEW", githubUpdatedAt: later },
    { action: "converted_to_draft", status: "DRAFT", githubUpdatedAt: earlier },
  );
  assert.deepEqual(result, { kind: "ignore", reason: "stale_event" });
});

test("legacy OPEN is treated as READY_FOR_REVIEW during the compatibility phase", () => {
  const result = evaluatePullRequestLifecycleTransition(
    { status: "OPEN", githubUpdatedAt: earlier },
    { action: "converted_to_draft", status: "DRAFT", githubUpdatedAt: later },
  );
  assert.equal(result.kind, "apply");
  if (result.kind === "apply") assert.equal(result.status, "DRAFT");
});

function assertApply(
  currentStatus: PullRequestLifecycleStatus,
  action: SupportedPullRequestWebhookAction,
  targetStatus: PullRequestLifecycleStatus,
) {
  const result = evaluatePullRequestLifecycleTransition(
    { status: currentStatus, githubUpdatedAt: earlier },
    { action, status: targetStatus, githubUpdatedAt: later },
  );
  assert.equal(result.kind, "apply");
  if (result.kind === "apply") {
    assert.equal(result.status, targetStatus);
    assert.equal(result.draft, targetStatus === "DRAFT");
    assert.equal(result.githubUpdatedAt, later);
  }
}
