import assert from "node:assert/strict";
import test from "node:test";
import {
  processPullRequestLifecycleWebhookWithStore,
  type PullRequestLifecycleStore,
  type PullRequestLifecycleTransaction,
} from "../lib/db/pull-request-lifecycle.ts";
import type {
  NormalizedPullRequestWebhook,
  PullRequestLifecycleStatus,
  StoredPullRequestLifecycleStatus,
  SupportedPullRequestWebhookAction,
} from "../lib/github/pull-request-webhook.ts";

const repositoryId = "123456789";
const repositoryFullName = "DEADPOO10/express";
const prUrl = "https://github.com/DEADPOO10/express/pull/42";
const nodeId = "PR_kwDOExample_123";
const earlier = new Date("2026-08-16T10:00:00Z");
const later = new Date("2026-08-16T10:01:00Z");

type StoredState = {
  pullRequest: {
    id: string;
    githubPrNumber: number;
    githubRepositoryId: string;
    githubPrNodeId: string | null;
    githubPrUrl: string;
    branchName: string;
    baseBranch: string;
    status: StoredPullRequestLifecycleStatus;
    draft: boolean;
    githubUpdatedAt: Date | null;
    repositoryFullName: string;
  } | null;
  deliveries: Set<string>;
};

function webhook(input: {
  action: SupportedPullRequestWebhookAction;
  status: PullRequestLifecycleStatus;
  githubUpdatedAt?: Date;
  node?: string;
  url?: string;
  headBranch?: string;
  baseBranch?: string;
  repoId?: string;
  number?: number;
}): NormalizedPullRequestWebhook {
  return {
    action: input.action,
    repository: { githubRepositoryId: input.repoId ?? repositoryId, fullName: repositoryFullName },
    pullRequest: {
      number: input.number ?? 42,
      nodeId: input.node ?? nodeId,
      url: input.url ?? prUrl,
      state: input.status === "CLOSED" || input.status === "MERGED" ? "closed" : "open",
      draft: input.status === "DRAFT",
      merged: input.status === "MERGED",
      status: input.status,
      githubUpdatedAt: input.githubUpdatedAt ?? later,
      baseBranch: input.baseBranch ?? "master",
      headBranch: input.headBranch ?? "sentinel/deps/supertest/changeid",
    },
  };
}

function state(status: StoredPullRequestLifecycleStatus = "DRAFT"): StoredState {
  return {
    pullRequest: {
      id: "pr_1",
      githubPrNumber: 42,
      githubRepositoryId: repositoryId,
      githubPrNodeId: nodeId,
      githubPrUrl: prUrl,
      branchName: "sentinel/deps/supertest/changeid",
      baseBranch: "master",
      status,
      draft: status === "DRAFT",
      githubUpdatedAt: earlier,
      repositoryFullName,
    },
    deliveries: new Set(),
  };
}

function createStore(initial = state(), options: { failUpdate?: boolean } = {}) {
  let current = cloneState(initial);
  let queue = Promise.resolve();
  let updateCalls = 0;
  let transactionCalls = 0;

  const store: PullRequestLifecycleStore = {
    transaction: async (callback) => {
      transactionCalls += 1;
      const previous = queue;
      let release = () => {};
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const pending = cloneState(current);
      const transaction: PullRequestLifecycleTransaction = {
        findDelivery: async (deliveryId) => pending.deliveries.has(deliveryId) ? { deliveryId } : null,
        findPullRequest: async (repoId, prNumber) => {
          const pullRequest = pending.pullRequest;
          if (!pullRequest || pullRequest.githubRepositoryId !== repoId || pullRequest.githubPrNumber !== prNumber) return null;
          return { ...pullRequest };
        },
        insertDelivery: async (delivery) => {
          if (pending.deliveries.has(delivery.deliveryId)) return false;
          pending.deliveries.add(delivery.deliveryId);
          return true;
        },
        updatePullRequest: async (id, data) => {
          updateCalls += 1;
          if (options.failUpdate) throw new Error("simulated update failure");
          if (!pending.pullRequest || pending.pullRequest.id !== id) throw new Error("missing PR");
          pending.pullRequest = { ...pending.pullRequest, ...data };
        },
      };
      try {
        const result = await callback(transaction);
        current = pending;
        return result;
      } finally {
        release();
      }
    },
  };

  return {
    store,
    getState: () => current,
    getUpdateCalls: () => updateCalls,
    getTransactionCalls: () => transactionCalls,
  };
}

for (const scenario of [
  { name: "Draft to Ready", current: "DRAFT", action: "ready_for_review", target: "READY_FOR_REVIEW" },
  { name: "Ready to Draft", current: "READY_FOR_REVIEW", action: "converted_to_draft", target: "DRAFT" },
  { name: "Draft to Closed", current: "DRAFT", action: "closed", target: "CLOSED" },
  { name: "Ready to Merged", current: "READY_FOR_REVIEW", action: "closed", target: "MERGED" },
  { name: "Closed to Draft", current: "CLOSED", action: "reopened", target: "DRAFT" },
  { name: "Closed to Ready", current: "CLOSED", action: "reopened", target: "READY_FOR_REVIEW" },
] as const) {
  test(`${scenario.name} is updated atomically with its delivery`, async () => {
    const fixture = createStore(state(scenario.current));
    const result = await processPullRequestLifecycleWebhookWithStore({
      deliveryId: `delivery-${scenario.name}`,
      payload: webhook({ action: scenario.action, status: scenario.target }),
    }, fixture.store);
    assert.deepEqual(result, { kind: "processed" });
    assert.equal(fixture.getState().pullRequest?.status, scenario.target);
    assert.equal(fixture.getState().pullRequest?.draft, scenario.target === "DRAFT");
    assert.equal(fixture.getState().deliveries.size, 1);
  });
}

test("MERGED is terminal and the rejected delivery is deduplicated", async () => {
  const fixture = createStore(state("MERGED"));
  const result = await processPullRequestLifecycleWebhookWithStore({
    deliveryId: "delivery-terminal",
    payload: webhook({ action: "reopened", status: "READY_FOR_REVIEW" }),
  }, fixture.store);
  assert.deepEqual(result, { kind: "rejected_transition" });
  assert.equal(fixture.getState().pullRequest?.status, "MERGED");
  assert.equal(fixture.getState().deliveries.size, 1);
});

test("duplicate and concurrent duplicate delivery IDs are successful no-ops", async () => {
  const fixture = createStore();
  const input = {
    deliveryId: "delivery-duplicate",
    payload: webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW" }),
  };
  const [first, second] = await Promise.all([
    processPullRequestLifecycleWebhookWithStore(input, fixture.store),
    processPullRequestLifecycleWebhookWithStore(input, fixture.store),
  ]);
  assert.deepEqual([first.kind, second.kind].sort(), ["duplicate", "processed"]);
  assert.equal(fixture.getState().deliveries.size, 1);
  assert.equal(fixture.getUpdateCalls(), 1);
});

test("stale events and equal-time MERGED regressions are ignored or rejected", async () => {
  const staleFixture = createStore(state("READY_FOR_REVIEW"));
  const stale = await processPullRequestLifecycleWebhookWithStore({
    deliveryId: "delivery-stale",
    payload: webhook({ action: "converted_to_draft", status: "DRAFT", githubUpdatedAt: new Date("2026-08-16T09:59:00Z") }),
  }, staleFixture.store);
  assert.deepEqual(stale, { kind: "ignored_stale" });
  assert.equal(staleFixture.getState().pullRequest?.status, "READY_FOR_REVIEW");

  const mergedState = state("MERGED");
  if (mergedState.pullRequest) mergedState.pullRequest.githubUpdatedAt = later;
  const mergedFixture = createStore(mergedState);
  const equalTime = await processPullRequestLifecycleWebhookWithStore({
    deliveryId: "delivery-equal-merged",
    payload: webhook({ action: "reopened", status: "DRAFT", githubUpdatedAt: later }),
  }, mergedFixture.store);
  assert.deepEqual(equalTime, { kind: "rejected_transition" });
  assert.equal(mergedFixture.getState().pullRequest?.status, "MERGED");
});

test("unknown repositories and PRs never create pull requests or deliveries", async () => {
  const fixture = createStore();
  const unknownRepository = await processPullRequestLifecycleWebhookWithStore({
    deliveryId: "delivery-unknown-repo",
    payload: webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW", repoId: "999" }),
  }, fixture.store);
  const unknownPullRequest = await processPullRequestLifecycleWebhookWithStore({
    deliveryId: "delivery-unknown-pr",
    payload: webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW", number: 999 }),
  }, fixture.store);
  assert.deepEqual(unknownRepository, { kind: "unknown_pull_request" });
  assert.deepEqual(unknownPullRequest, { kind: "unknown_pull_request" });
  assert.equal(fixture.getState().deliveries.size, 0);
  assert.equal(fixture.getUpdateCalls(), 0);
});

test("node ID mismatch is rejected while an exact legacy identity permits one-time backfill", async () => {
  const mismatch = createStore();
  assert.deepEqual(await processPullRequestLifecycleWebhookWithStore({
    deliveryId: "delivery-node-mismatch",
    payload: webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW", node: "PR_other" }),
  }, mismatch.store), { kind: "rejected_identity" });

  const legacy = state();
  if (legacy.pullRequest) legacy.pullRequest.githubPrNodeId = null;
  const backfill = createStore(legacy);
  assert.deepEqual(await processPullRequestLifecycleWebhookWithStore({
    deliveryId: "delivery-node-backfill",
    payload: webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW" }),
  }, backfill.store), { kind: "processed" });
  assert.equal(backfill.getState().pullRequest?.githubPrNodeId, nodeId);
});

test("URL, head branch, and base branch mismatches are rejected", async () => {
  const cases = [
    webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW", url: "https://github.com/DEADPOO10/express/pull/43" }),
    webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW", headBranch: "feature/unverified" }),
    webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW", baseBranch: "main" }),
  ];
  for (const [index, payload] of cases.entries()) {
    const fixture = createStore();
    assert.deepEqual(await processPullRequestLifecycleWebhookWithStore({
      deliveryId: `delivery-identity-${index}`,
      payload,
    }, fixture.store), { kind: "rejected_identity" });
    assert.equal(fixture.getState().deliveries.size, 0);
  }
});

test("a failed PR update rolls back the delivery insertion", async () => {
  const fixture = createStore(state(), { failUpdate: true });
  await assert.rejects(processPullRequestLifecycleWebhookWithStore({
    deliveryId: "delivery-rollback",
    payload: webhook({ action: "ready_for_review", status: "READY_FOR_REVIEW" }),
  }, fixture.store), /simulated update failure/);
  assert.equal(fixture.getState().deliveries.size, 0);
  assert.equal(fixture.getState().pullRequest?.status, "DRAFT");
});

function cloneState(value: StoredState): StoredState {
  return {
    pullRequest: value.pullRequest ? { ...value.pullRequest } : null,
    deliveries: new Set(value.deliveries),
  };
}
