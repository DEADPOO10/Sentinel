import assert from "node:assert/strict";
import test from "node:test";
import {
  getGitHubPullRequestPersistenceFields,
  parseGitHubPullRequestResponseIdentity,
} from "../lib/github/pull-request-response.ts";

test("GitHub PR creation identity includes node ID and updated timestamp", () => {
  assert.deepEqual(parseGitHubPullRequestResponseIdentity({
    number: 42,
    html_url: "https://github.com/DEADPOO10/express/pull/42",
    node_id: "PR_kwDOExample_123",
    updated_at: "2026-08-16T10:01:00Z",
  }), {
    prNumber: 42,
    prUrl: "https://github.com/DEADPOO10/express/pull/42",
    nodeId: "PR_kwDOExample_123",
    githubUpdatedAt: "2026-08-16T10:01:00Z",
  });
});

test("GitHub PR response identity fails closed when node ID or timestamp is missing", () => {
  const valid = {
    number: 42,
    html_url: "https://github.com/DEADPOO10/express/pull/42",
    node_id: "PR_kwDOExample_123",
    updated_at: "2026-08-16T10:01:00Z",
  };
  assert.equal(parseGitHubPullRequestResponseIdentity({ ...valid, node_id: undefined }), null);
  assert.equal(parseGitHubPullRequestResponseIdentity({ ...valid, updated_at: "invalid" }), null);
  assert.equal(parseGitHubPullRequestResponseIdentity({ ...valid, html_url: "https://example.com/pull/42" }), null);
});

test("new PR persistence stores GitHub identity and no longer writes legacy OPEN", () => {
  const draft = getGitHubPullRequestPersistenceFields({
    nodeId: "PR_kwDOExample_123",
    githubUpdatedAt: "2026-08-16T10:01:00Z",
    draft: true,
  });
  const ready = getGitHubPullRequestPersistenceFields({
    nodeId: "PR_kwDOExample_123",
    githubUpdatedAt: "2026-08-16T10:01:00Z",
    draft: false,
  });
  assert.equal(draft?.status, "DRAFT");
  assert.equal(ready?.status, "READY_FOR_REVIEW");
  assert.equal(ready?.githubPrNodeId, "PR_kwDOExample_123");
  assert.equal(ready?.githubUpdatedAt.toISOString(), "2026-08-16T10:01:00.000Z");
});
