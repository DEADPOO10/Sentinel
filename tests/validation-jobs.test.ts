import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrReturnValidationJobWithStore,
  getValidationJobForAuthorizedBindingWithStore,
  transitionValidationJobWithStore,
  type ValidationJobBinding,
  type ValidationJobFailureCategory,
  type ValidationJobRecord,
  type ValidationJobStore,
} from "../lib/db/validation-jobs.ts";

const now = new Date("2026-08-18T10:00:00.000Z");
const commitSha = "a".repeat(40);
const proposedChangeIdentifier = "b".repeat(43);
const defaultInput = {
  userId: "user-1",
  repositoryId: "repository-1",
  proposedFixId: "proposed-fix-1",
  proposedChangeIdentifier,
  baseCommitSha: commitSha,
};

type CreateData = Parameters<ValidationJobStore["createWithVerifiedBinding"]>[0];

function createStore() {
  const jobs = new Map<string, ValidationJobRecord>();
  let nextId = 1;

  const store: ValidationJobStore = {
    findByIdempotencyKey: async (idempotencyKey) => jobs.get(idempotencyKey) ?? null,
    createWithVerifiedBinding: async (input) => {
      await Promise.resolve();
      if (input.userId !== defaultInput.userId || input.repositoryId !== defaultInput.repositoryId || input.proposedFixId !== defaultInput.proposedFixId) {
        throw { code: "VALIDATION_JOB_BINDING" };
      }
      if (jobs.has(input.idempotencyKey)) throw { code: "P2002" };
      const job = storedJob(`job-${nextId++}`, input);
      jobs.set(input.idempotencyKey, job);
      return job;
    },
    findAuthorized: async (binding) => [...jobs.values()].find((job) => matchesBinding(job, binding)) ?? null,
    transitionAuthorized: async (binding, from, data) => {
      const job = [...jobs.values()].find((candidate) => matchesBinding(candidate, binding));
      if (!job || !from.includes(job.status)) return null;
      const updated = { ...job, ...data };
      jobs.set(updated.idempotencyKey, updated);
      return updated;
    },
  };

  return { store, jobs };
}

function storedJob(id: string, input: CreateData): ValidationJobRecord {
  return {
    id,
    ...input,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
  };
}

function matchesBinding(job: ValidationJobRecord, binding: ValidationJobBinding) {
  return job.id === binding.jobId
    && job.userId === binding.userId
    && job.repositoryId === binding.repositoryId
    && job.proposedFixId === binding.proposedFixId
    && job.proposedChangeIdentifier === binding.proposedChangeIdentifier
    && job.baseCommitSha === binding.baseCommitSha;
}

function binding(job: ValidationJobRecord): ValidationJobBinding {
  return {
    jobId: job.id,
    userId: job.userId,
    repositoryId: job.repositoryId,
    proposedFixId: job.proposedFixId,
    proposedChangeIdentifier: job.proposedChangeIdentifier,
    baseCommitSha: job.baseCommitSha,
  };
}

async function createJob(store: ValidationJobStore, input = defaultInput) {
  return createOrReturnValidationJobWithStore(input, store, now);
}

test("first creation persists one queued job and an immediate repeat reuses it", async () => {
  const fixture = createStore();
  const first = await createJob(fixture.store);
  const second = await createJob(fixture.store);
  assert.equal(first.kind, "created");
  assert.equal(second.kind, "reused");
  assert.equal(fixture.jobs.size, 1);
  assert.equal(first.job.id, second.job.id);
});

test("concurrent duplicate creation returns one durable race winner", async () => {
  const fixture = createStore();
  const results = await Promise.all([createJob(fixture.store), createJob(fixture.store)]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["created", "reused"]);
  assert.equal(fixture.jobs.size, 1);
  const ids = results.flatMap((result) => result.kind === "unavailable" ? [] : [result.job.id]);
  assert.equal(new Set(ids).size, 1);
});

test("creation rejects a repository or proposed-fix binding that is not owned", async () => {
  const fixture = createStore();
  const wrongRepository = await createJob(fixture.store, { ...defaultInput, repositoryId: "repository-2" });
  const wrongProposedFix = await createJob(fixture.store, { ...defaultInput, proposedFixId: "proposed-fix-2" });
  assert.deepEqual(wrongRepository, { kind: "unavailable", category: "binding_not_authorized" });
  assert.deepEqual(wrongProposedFix, { kind: "unavailable", category: "binding_not_authorized" });
  assert.equal(fixture.jobs.size, 0);
});

test("the immutable commit and proposed-change identifier participate in job identity", async () => {
  const fixture = createStore();
  const first = await createJob(fixture.store);
  const changedCommit = await createJob(fixture.store, { ...defaultInput, baseCommitSha: "c".repeat(40) });
  const changedProposal = await createJob(fixture.store, { ...defaultInput, proposedChangeIdentifier: "d".repeat(43) });
  assert.equal(first.kind, "created");
  assert.equal(changedCommit.kind, "created");
  assert.equal(changedProposal.kind, "created");
  assert.equal(fixture.jobs.size, 3);
});

test("authorized lookup is isolated by user and every immutable binding", async () => {
  const fixture = createStore();
  const created = await createJob(fixture.store);
  assert.notEqual(created.kind, "unavailable");
  if (created.kind === "unavailable") return;
  const exact = binding(created.job);
  assert.equal((await getValidationJobForAuthorizedBindingWithStore(exact, fixture.store))?.id, created.job.id);
  assert.equal(await getValidationJobForAuthorizedBindingWithStore({ ...exact, userId: "user-2" }, fixture.store), null);
  assert.equal(await getValidationJobForAuthorizedBindingWithStore({ ...exact, repositoryId: "repository-2" }, fixture.store), null);
  assert.equal(await getValidationJobForAuthorizedBindingWithStore({ ...exact, proposedFixId: "proposed-fix-2" }, fixture.store), null);
  assert.equal(await getValidationJobForAuthorizedBindingWithStore({ ...exact, baseCommitSha: "c".repeat(40) }, fixture.store), null);
});

test("status transitions are strict and terminal states are immutable", async () => {
  const fixture = createStore();
  const created = await createJob(fixture.store);
  assert.notEqual(created.kind, "unavailable");
  if (created.kind === "unavailable") return;
  const exact = binding(created.job);

  assert.deepEqual(await transitionValidationJobWithStore(exact, "COMPLETED", fixture.store, { now }), { kind: "rejected" });
  const running = await transitionValidationJobWithStore(exact, "RUNNING", fixture.store, { now });
  assert.equal(running.kind, "updated");
  const completed = await transitionValidationJobWithStore(exact, "COMPLETED", fixture.store, { now: new Date(now.getTime() + 1_000) });
  assert.equal(completed.kind, "updated");
  assert.deepEqual(await transitionValidationJobWithStore(exact, "FAILED", fixture.store, { failureCategory: "INTERNAL_ERROR" }), { kind: "rejected" });
  assert.deepEqual(await transitionValidationJobWithStore(exact, "RUNNING", fixture.store), { kind: "rejected" });
  assert.equal(fixture.jobs.values().next().value?.status, "COMPLETED");
});

test("failed jobs store only an allowlisted safe category", async () => {
  const fixture = createStore();
  const created = await createJob(fixture.store);
  assert.notEqual(created.kind, "unavailable");
  if (created.kind === "unavailable") return;
  const exact = binding(created.job);
  const failure = await transitionValidationJobWithStore(exact, "FAILED", fixture.store, { failureCategory: "WORKER_TIMEOUT", now });
  assert.equal(failure.kind, "updated");
  if (failure.kind === "updated") assert.equal(failure.job.failureCategory, "WORKER_TIMEOUT");

  const unsafe = "provider response body" as unknown as ValidationJobFailureCategory;
  const secondFixture = createStore();
  const second = await createJob(secondFixture.store);
  assert.notEqual(second.kind, "unavailable");
  if (second.kind !== "unavailable") {
    assert.deepEqual(await transitionValidationJobWithStore(binding(second.job), "FAILED", secondFixture.store, { failureCategory: unsafe }), { kind: "not_found" });
  }
});
