import assert from "node:assert/strict";
import test from "node:test";
import {
  RATE_LIMIT_POLICIES,
  reserveCostlyOperationWithStore,
  type RateLimitStore,
  type RateLimitTransaction,
  type RateLimitedOperation,
} from "../lib/db/rate-limits.ts";

type Descriptor = Parameters<RateLimitTransaction["findBuckets"]>[0][number];
type StoredDescriptor = Descriptor & { requestCount: number };

function createStore() {
  let buckets = new Map<string, StoredDescriptor>();
  let queue = Promise.resolve();

  const store: RateLimitStore = {
    deleteExpired: async (now) => {
      for (const [key, bucket] of buckets) {
        if (bucket.expiresAt.getTime() <= now.getTime()) buckets.delete(key);
      }
    },
    transaction: async (callback) => {
      const previous = queue;
      let release = () => {};
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const pending = new Map([...buckets].map(([key, value]) => [key, { ...value }]));
      try {
        const result = await callback({
          findBuckets: async (descriptors) => descriptors.flatMap((descriptor) => {
            const bucket = pending.get(bucketKey(descriptor));
            return bucket ? [{ ...bucket }] : [];
          }),
          incrementBuckets: async (descriptors) => {
            for (const descriptor of descriptors) {
              const key = bucketKey(descriptor);
              const existing = pending.get(key);
              pending.set(key, {
                ...descriptor,
                requestCount: (existing?.requestCount ?? 0) + 1,
              });
            }
          },
        });
        buckets = pending;
        return result;
      } finally {
        release();
      }
    },
  };

  return { store, getBucketCount: () => buckets.size };
}

function bucketKey(descriptor: Descriptor) {
  return [
    descriptor.operation,
    descriptor.scope,
    descriptor.window,
    descriptor.subjectKey,
    descriptor.windowStart.toISOString(),
  ].join(":");
}

function reserve(
  store: RateLimitStore,
  input: { operation?: RateLimitedOperation; userId?: string; githubRepositoryId?: string } = {},
  now = new Date("2026-08-17T10:01:00.000Z"),
) {
  return reserveCostlyOperationWithStore({
    operation: input.operation ?? "VALIDATION_JOB",
    userId: input.userId ?? "user-1",
    githubRepositoryId: input.githubRepositoryId ?? "repository-1",
  }, store, now);
}

test("an eligible costly request reserves its durable user and repository buckets", async () => {
  const fixture = createStore();
  assert.deepEqual(await reserve(fixture.store), { kind: "allowed" });
  assert.equal(fixture.getBucketCount(), 4);
});

test("repeated requests for one repository are blocked by its short-window limit", async () => {
  const fixture = createStore();
  const limit = RATE_LIMIT_POLICIES.VALIDATION_JOB.repository.short;
  for (let index = 0; index < limit; index += 1) {
    assert.equal((await reserve(fixture.store)).kind, "allowed");
  }
  const blocked = await reserve(fixture.store);
  assert.equal(blocked.kind, "limited");
  if (blocked.kind === "limited") {
    assert.equal(blocked.scope, "repository");
    assert.equal(blocked.window, "short");
    assert.ok(blocked.retryAfterSeconds > 0);
  }
});

test("limits are isolated between authenticated users", async () => {
  const fixture = createStore();
  const limit = RATE_LIMIT_POLICIES.VALIDATION_JOB.repository.short;
  for (let index = 0; index < limit; index += 1) {
    await reserve(fixture.store, { userId: "user-a", githubRepositoryId: "shared-repository" });
  }
  assert.equal((await reserve(fixture.store, { userId: "user-a", githubRepositoryId: "shared-repository" })).kind, "limited");
  assert.equal((await reserve(fixture.store, { userId: "user-b", githubRepositoryId: "shared-repository" })).kind, "allowed");
});

test("repository limits are isolated within the same user quota", async () => {
  const fixture = createStore();
  const limit = RATE_LIMIT_POLICIES.VALIDATION_JOB.repository.short;
  for (let index = 0; index < limit; index += 1) {
    await reserve(fixture.store, { githubRepositoryId: "repository-a" });
  }
  assert.equal((await reserve(fixture.store, { githubRepositoryId: "repository-a" })).kind, "limited");
  assert.equal((await reserve(fixture.store, { githubRepositoryId: "repository-b" })).kind, "allowed");
});

test("daily limits remain effective across short-window resets", async () => {
  const fixture = createStore();
  const limit = RATE_LIMIT_POLICIES.VALIDATION_JOB.repository.daily;
  const start = new Date("2026-08-17T00:01:00.000Z");
  for (let index = 0; index < limit; index += 1) {
    const now = new Date(start.getTime() + index * 11 * 60 * 1000);
    assert.equal((await reserve(fixture.store, {}, now)).kind, "allowed");
  }
  const blocked = await reserve(fixture.store, {}, new Date(start.getTime() + limit * 11 * 60 * 1000));
  assert.equal(blocked.kind, "limited");
  if (blocked.kind === "limited") assert.equal(blocked.window, "daily");
});

test("concurrent requests cannot exceed an atomic repository allowance", async () => {
  const fixture = createStore();
  const limit = RATE_LIMIT_POLICIES.REPOSITORY_SCAN.repository.short;
  const results = await Promise.all(Array.from({ length: limit + 2 }, () => reserve(fixture.store, {
    operation: "REPOSITORY_SCAN",
  })));
  assert.equal(results.filter((result) => result.kind === "allowed").length, limit);
  assert.equal(results.filter((result) => result.kind === "limited").length, 2);
});

test("rate-limit storage failure fails closed", async () => {
  const store: RateLimitStore = {
    deleteExpired: async () => { throw new Error("unavailable"); },
    transaction: async () => { throw new Error("must not run"); },
  };
  assert.deepEqual(await reserve(store), { kind: "unavailable" });
});
