import { createHash } from "node:crypto";

const SHORT_WINDOW_MS = 10 * 60 * 1000;
const TRANSACTION_OPTIONS = {
  isolationLevel: "Serializable" as const,
  maxWait: 10_000,
  timeout: 15_000,
};
const MAX_TRANSACTION_ATTEMPTS = 3;

export type RateLimitedOperation = "OPENAI_REQUEST" | "REPOSITORY_SCAN" | "VALIDATION_JOB";
type RateLimitScope = "USER" | "REPOSITORY";
type RateLimitWindow = "SHORT" | "DAILY";

type RateLimitPolicy = {
  user: { short: number; daily: number };
  repository: { short: number; daily: number };
};

export const RATE_LIMIT_POLICIES: Readonly<Record<RateLimitedOperation, RateLimitPolicy>> = {
  OPENAI_REQUEST: {
    user: { short: 8, daily: 75 },
    repository: { short: 4, daily: 25 },
  },
  REPOSITORY_SCAN: {
    user: { short: 10, daily: 100 },
    repository: { short: 3, daily: 24 },
  },
  VALIDATION_JOB: {
    user: { short: 5, daily: 25 },
    repository: { short: 2, daily: 8 },
  },
};

export type RateLimitReservationResult =
  | { kind: "allowed" }
  | {
      kind: "limited";
      scope: "user" | "repository";
      window: "short" | "daily";
      retryAfterSeconds: number;
    }
  | { kind: "unavailable" };

type BucketDescriptor = {
  operation: RateLimitedOperation;
  scope: RateLimitScope;
  window: RateLimitWindow;
  subjectKey: string;
  windowStart: Date;
  expiresAt: Date;
  limit: number;
};

type StoredBucket = BucketDescriptor & { requestCount: number };

export type RateLimitTransaction = {
  findBuckets(descriptors: readonly BucketDescriptor[]): Promise<StoredBucket[]>;
  incrementBuckets(descriptors: readonly BucketDescriptor[]): Promise<void>;
};

export type RateLimitStore = {
  deleteExpired(now: Date): Promise<void>;
  transaction<T>(callback: (transaction: RateLimitTransaction) => Promise<T>): Promise<T>;
};

/** Atomically reserves one costly operation across user and repository limits. */
export async function reserveCostlyOperation(input: {
  operation: RateLimitedOperation;
  userId: string;
  githubRepositoryId: string | number;
}): Promise<RateLimitReservationResult> {
  if (!isSafeIdentifier(input.userId) || !isSafeIdentifier(input.githubRepositoryId)) {
    logRateLimitFailure(input.operation, "invalid_scope");
    return { kind: "unavailable" };
  }

  try {
    const { getPrismaClient } = await import("./prisma");
    const client = getPrismaClient();
    return await reserveCostlyOperationWithStore(input, {
      deleteExpired: async (now) => {
        await client.rateLimitBucket.deleteMany({ where: { expiresAt: { lte: now } } });
      },
      transaction: (callback) => client.$transaction(
        (transaction) => callback({
          findBuckets: async (descriptors) => {
            const rows = await transaction.rateLimitBucket.findMany({
              where: {
                OR: descriptors.map((descriptor) => ({
                  operation: descriptor.operation,
                  scope: descriptor.scope,
                  window: descriptor.window,
                  subjectKey: descriptor.subjectKey,
                  windowStart: descriptor.windowStart,
                })),
              },
            });
            return rows.map((row) => {
              const descriptor = descriptors.find((candidate) => sameBucket(candidate, row));
              if (!descriptor) throw new Error("Rate-limit bucket identity mismatch.");
              return { ...descriptor, requestCount: row.requestCount };
            });
          },
          incrementBuckets: async (descriptors) => {
            await Promise.all(descriptors.map((descriptor) => transaction.rateLimitBucket.upsert({
              where: {
                operation_scope_window_subjectKey_windowStart: {
                  operation: descriptor.operation,
                  scope: descriptor.scope,
                  window: descriptor.window,
                  subjectKey: descriptor.subjectKey,
                  windowStart: descriptor.windowStart,
                },
              },
              create: {
                operation: descriptor.operation,
                scope: descriptor.scope,
                window: descriptor.window,
                subjectKey: descriptor.subjectKey,
                windowStart: descriptor.windowStart,
                expiresAt: descriptor.expiresAt,
                requestCount: 1,
              },
              update: { requestCount: { increment: 1 } },
            })));
          },
        }),
        TRANSACTION_OPTIONS,
      ),
    });
  } catch (error) {
    logRateLimitFailure(input.operation, getSafeFailureCategory(error));
    return { kind: "unavailable" };
  }
}

/** Injectable core used by focused tests and the production Prisma adapter. */
export async function reserveCostlyOperationWithStore(
  input: {
    operation: RateLimitedOperation;
    userId: string;
    githubRepositoryId: string | number;
  },
  store: RateLimitStore,
  now = new Date(),
): Promise<RateLimitReservationResult> {
  if (!isSafeIdentifier(input.userId) || !isSafeIdentifier(input.githubRepositoryId)) {
    return { kind: "unavailable" };
  }

  const descriptors = createBucketDescriptors(input, now);

  try {
    await store.deleteExpired(now);
  } catch {
    return { kind: "unavailable" };
  }

  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      const result = await store.transaction(async (transaction) => {
        const storedBuckets = await transaction.findBuckets(descriptors);
        for (const descriptor of descriptors) {
          const current = storedBuckets.find((bucket) => sameBucket(bucket, descriptor));
          if ((current?.requestCount ?? 0) >= descriptor.limit) {
            return {
              kind: "limited",
              scope: descriptor.scope === "USER" ? "user" : "repository",
              window: descriptor.window === "SHORT" ? "short" : "daily",
              retryAfterSeconds: Math.max(1, Math.ceil((descriptor.expiresAt.getTime() - now.getTime()) / 1000)),
            } satisfies RateLimitReservationResult;
          }
        }

        await transaction.incrementBuckets(descriptors);
        return { kind: "allowed" } satisfies RateLimitReservationResult;
      });
      if (result.kind === "limited") {
        console.info("[sentinel:rate-limit] request_limited", {
          operation: input.operation,
          scope: result.scope,
          window: result.window,
        });
      }
      return result;
    } catch (error) {
      if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryableTransactionError(error)) continue;
      return { kind: "unavailable" };
    }
  }

  return { kind: "unavailable" };
}

export function getRateLimitMessage(
  operation: RateLimitedOperation,
  result: Exclude<RateLimitReservationResult, { kind: "allowed" }>,
) {
  const action = operation === "OPENAI_REQUEST"
    ? "AI request"
    : operation === "REPOSITORY_SCAN"
      ? "repository scan"
      : "validation job";
  if (result.kind === "unavailable") {
    return `Sentinel cannot safely start this ${action} right now. Please try again shortly.`;
  }
  return result.window === "daily"
    ? `The daily ${action} limit has been reached. Please try again after the usage window resets.`
    : `Too many ${action}s were requested recently. Please wait a few minutes and try again.`;
}

function createBucketDescriptors(
  input: { operation: RateLimitedOperation; userId: string; githubRepositoryId: string | number },
  now: Date,
): BucketDescriptor[] {
  const policy = RATE_LIMIT_POLICIES[input.operation];
  const shortStart = new Date(Math.floor(now.getTime() / SHORT_WINDOW_MS) * SHORT_WINDOW_MS);
  const shortEnd = new Date(shortStart.getTime() + SHORT_WINDOW_MS);
  const dailyStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dailyEnd = new Date(dailyStart.getTime() + 24 * 60 * 60 * 1000);
  const userSubject = hashSubject(`user\u0000${input.userId}`);
  const repositorySubject = hashSubject(`user-repository\u0000${input.userId}\u0000${String(input.githubRepositoryId)}`);

  return [
    { operation: input.operation, scope: "USER", window: "SHORT", subjectKey: userSubject, windowStart: shortStart, expiresAt: shortEnd, limit: policy.user.short },
    { operation: input.operation, scope: "USER", window: "DAILY", subjectKey: userSubject, windowStart: dailyStart, expiresAt: dailyEnd, limit: policy.user.daily },
    { operation: input.operation, scope: "REPOSITORY", window: "SHORT", subjectKey: repositorySubject, windowStart: shortStart, expiresAt: shortEnd, limit: policy.repository.short },
    { operation: input.operation, scope: "REPOSITORY", window: "DAILY", subjectKey: repositorySubject, windowStart: dailyStart, expiresAt: dailyEnd, limit: policy.repository.daily },
  ];
}

function sameBucket(
  first: Pick<BucketDescriptor, "operation" | "scope" | "window" | "subjectKey" | "windowStart">,
  second: Pick<BucketDescriptor, "operation" | "scope" | "window" | "subjectKey" | "windowStart">,
) {
  return first.operation === second.operation
    && first.scope === second.scope
    && first.window === second.window
    && first.subjectKey === second.subjectKey
    && first.windowStart.getTime() === second.windowStart.getTime();
}

function hashSubject(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function isSafeIdentifier(value: string | number) {
  return typeof value === "number"
    ? Number.isSafeInteger(value) && value >= 0
    : typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isRetryableTransactionError(error: unknown) {
  const code = getErrorCode(error);
  return code === "P2002" || code === "P2034" || code === "40001";
}

function getSafeFailureCategory(error: unknown) {
  const code = getErrorCode(error);
  return code && /^[A-Z0-9_]{3,16}$/.test(code) ? code.toLowerCase() : "database_error";
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function logRateLimitFailure(operation: RateLimitedOperation, category: string) {
  console.error("[sentinel:rate-limit] reservation_failed", { operation, category });
}
