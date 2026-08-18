import { createHash } from "node:crypto";

const DEFAULT_JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_JOB_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const TRANSACTION_OPTIONS = {
  isolationLevel: "Serializable" as const,
  maxWait: 10_000,
  timeout: 15_000,
};

export const VALIDATION_JOB_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED"] as const;
export const VALIDATION_JOB_FAILURE_CATEGORIES = [
  "WORKER_UNAVAILABLE",
  "WORKER_TIMEOUT",
  "RESULT_INVALID",
  "JOB_EXPIRED",
  "INTERNAL_ERROR",
] as const;

export type ValidationJobStatus = (typeof VALIDATION_JOB_STATUSES)[number];
export type ValidationJobFailureCategory = (typeof VALIDATION_JOB_FAILURE_CATEGORIES)[number];

export type ValidationJobRecord = {
  id: string;
  userId: string;
  repositoryId: string;
  proposedFixId: string;
  proposedChangeIdentifier: string;
  baseCommitSha: string;
  idempotencyKey: string;
  status: ValidationJobStatus;
  failureCategory: ValidationJobFailureCategory | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  expiresAt: Date;
};

export type ValidationJobCreateInput = {
  userId: string;
  repositoryId: string;
  proposedFixId: string;
  proposedChangeIdentifier: string;
  baseCommitSha: string;
  expiresAt?: Date;
};

export type ValidationJobBinding = {
  jobId: string;
  userId: string;
  repositoryId: string;
  proposedFixId: string;
  proposedChangeIdentifier: string;
  baseCommitSha: string;
};

type StoredValidationJobCreate = Omit<ValidationJobRecord, "id" | "createdAt" | "startedAt" | "completedAt" | "updatedAt">;
type ValidationJobTransitionData = Pick<ValidationJobRecord, "status" | "failureCategory" | "startedAt" | "completedAt" | "updatedAt">;

export type ValidationJobStore = {
  findByIdempotencyKey(idempotencyKey: string): Promise<ValidationJobRecord | null>;
  createWithVerifiedBinding(input: StoredValidationJobCreate): Promise<ValidationJobRecord>;
  findAuthorized(binding: ValidationJobBinding): Promise<ValidationJobRecord | null>;
  transitionAuthorized(
    binding: ValidationJobBinding,
    from: readonly ValidationJobStatus[],
    data: ValidationJobTransitionData,
  ): Promise<ValidationJobRecord | null>;
};

export type CreateValidationJobResult =
  | { kind: "created" | "reused"; job: ValidationJobRecord }
  | { kind: "unavailable"; category: "invalid_input" | "binding_not_authorized" | "database_error" };

export type ValidationJobTransitionResult =
  | { kind: "updated" | "unchanged"; job: ValidationJobRecord }
  | { kind: "rejected" | "not_found" };

class ValidationJobBindingError extends Error {}

/** Creates one durable job for an immutable request, or returns the winner of a concurrent race. */
export async function createOrReturnValidationJob(
  input: ValidationJobCreateInput,
): Promise<CreateValidationJobResult> {
  try {
    return await createOrReturnValidationJobWithStore(input, await createPrismaValidationJobStore());
  } catch (error) {
    return {
      kind: "unavailable",
      category: error instanceof ValidationJobBindingError ? "binding_not_authorized" : "database_error",
    };
  }
}

/** Injectable core used by focused tests and the production Prisma adapter. */
export async function createOrReturnValidationJobWithStore(
  input: ValidationJobCreateInput,
  store: ValidationJobStore,
  now = new Date(),
): Promise<CreateValidationJobResult> {
  const data = getValidatedCreateData(input, now);
  if (!data) return { kind: "unavailable", category: "invalid_input" };

  try {
    const existing = await store.findByIdempotencyKey(data.idempotencyKey);
    if (existing) return sameImmutableBinding(existing, data)
      ? { kind: "reused", job: existing }
      : { kind: "unavailable", category: "database_error" };

    try {
      return { kind: "created", job: await store.createWithVerifiedBinding(data) };
    } catch (error) {
      if (isBindingError(error)) {
        return { kind: "unavailable", category: "binding_not_authorized" };
      }
      if (!isIdempotencyRaceError(error)) throw error;

      // Query outside the failed insert/transaction so PostgreSQL can return the race winner.
      const winner = await store.findByIdempotencyKey(data.idempotencyKey);
      return winner && sameImmutableBinding(winner, data)
        ? { kind: "reused", job: winner }
        : { kind: "unavailable", category: "database_error" };
    }
  } catch {
    return { kind: "unavailable", category: "database_error" };
  }
}

export async function getValidationJobForAuthorizedBinding(
  binding: ValidationJobBinding,
): Promise<ValidationJobRecord | null> {
  try {
    const store = await createPrismaValidationJobStore();
    return await getValidationJobForAuthorizedBindingWithStore(binding, store);
  } catch {
    return null;
  }
}

export async function getValidationJobForAuthorizedBindingWithStore(
  binding: ValidationJobBinding,
  store: ValidationJobStore,
): Promise<ValidationJobRecord | null> {
  return isValidBinding(binding) ? store.findAuthorized(binding) : null;
}

export async function markValidationJobRunning(binding: ValidationJobBinding) {
  return transitionValidationJob(binding, "RUNNING");
}

export async function markValidationJobCompleted(binding: ValidationJobBinding) {
  return transitionValidationJob(binding, "COMPLETED");
}

export async function markValidationJobFailed(
  binding: ValidationJobBinding,
  failureCategory: ValidationJobFailureCategory,
) {
  return transitionValidationJob(binding, "FAILED", failureCategory);
}

export async function transitionValidationJobWithStore(
  binding: ValidationJobBinding,
  target: "RUNNING" | "COMPLETED" | "FAILED",
  store: ValidationJobStore,
  options: { failureCategory?: ValidationJobFailureCategory; now?: Date } = {},
): Promise<ValidationJobTransitionResult> {
  if (!isValidBinding(binding) || (target === "FAILED" && !isFailureCategory(options.failureCategory))) {
    return { kind: "not_found" };
  }

  const existing = await store.findAuthorized(binding);
  if (!existing) return { kind: "not_found" };
  if (existing.status === target) return { kind: "unchanged", job: existing };
  if (existing.status === "COMPLETED" || existing.status === "FAILED") return { kind: "rejected" };

  const allowedFrom = target === "RUNNING" ? ["QUEUED"] as const : target === "COMPLETED" ? ["RUNNING"] as const : ["QUEUED", "RUNNING"] as const;
  if (!(allowedFrom as readonly ValidationJobStatus[]).includes(existing.status)) return { kind: "rejected" };

  const now = options.now ?? new Date();
  const updated = await store.transitionAuthorized(binding, allowedFrom, {
    status: target,
    failureCategory: target === "FAILED" ? options.failureCategory ?? null : null,
    startedAt: target === "RUNNING" ? now : existing.startedAt,
    completedAt: target === "COMPLETED" || target === "FAILED" ? now : null,
    updatedAt: now,
  });
  if (updated) return { kind: "updated", job: updated };

  const raced = await store.findAuthorized(binding);
  if (!raced) return { kind: "not_found" };
  return raced.status === target ? { kind: "unchanged", job: raced } : { kind: "rejected" };
}

async function transitionValidationJob(
  binding: ValidationJobBinding,
  target: "RUNNING" | "COMPLETED" | "FAILED",
  failureCategory?: ValidationJobFailureCategory,
) {
  if (!isValidBinding(binding)) return { kind: "not_found" } satisfies ValidationJobTransitionResult;
  try {
    return await transitionValidationJobWithStore(binding, target, await createPrismaValidationJobStore(), { failureCategory });
  } catch {
    return { kind: "not_found" } satisfies ValidationJobTransitionResult;
  }
}

async function createPrismaValidationJobStore(): Promise<ValidationJobStore> {
  const { getPrismaClient } = await import("./prisma");
  const client = getPrismaClient();
  const select = {
    id: true,
    userId: true,
    repositoryId: true,
    proposedFixId: true,
    proposedChangeIdentifier: true,
    baseCommitSha: true,
    idempotencyKey: true,
    status: true,
    failureCategory: true,
    createdAt: true,
    startedAt: true,
    completedAt: true,
    updatedAt: true,
    expiresAt: true,
  } as const;

  return {
    findByIdempotencyKey: (idempotencyKey) => client.validationJob.findUnique({
      where: { idempotencyKey },
      select,
    }),
    createWithVerifiedBinding: (input) => client.$transaction(async (transaction) => {
      const [membership, proposedFix] = await Promise.all([
        transaction.userRepository.findUnique({
          where: { userId_repositoryId: { userId: input.userId, repositoryId: input.repositoryId } },
          select: { id: true },
        }),
        transaction.proposedFix.findFirst({
          where: {
            id: input.proposedFixId,
            status: "PROPOSED",
            finding: { scan: { repositoryId: input.repositoryId } },
          },
          select: { id: true },
        }),
      ]);
      if (!membership || !proposedFix) throw new ValidationJobBindingError();
      return transaction.validationJob.create({ data: input, select });
    }, TRANSACTION_OPTIONS),
    findAuthorized: (binding) => client.validationJob.findFirst({
      where: {
        id: binding.jobId,
        userId: binding.userId,
        repositoryId: binding.repositoryId,
        proposedFixId: binding.proposedFixId,
        proposedChangeIdentifier: binding.proposedChangeIdentifier,
        baseCommitSha: binding.baseCommitSha,
      },
      select,
    }),
    transitionAuthorized: async (binding, from, data) => {
      const result = await client.validationJob.updateMany({
        where: {
          id: binding.jobId,
          userId: binding.userId,
          repositoryId: binding.repositoryId,
          proposedFixId: binding.proposedFixId,
          proposedChangeIdentifier: binding.proposedChangeIdentifier,
          baseCommitSha: binding.baseCommitSha,
          status: { in: [...from] },
        },
        data,
      });
      return result.count === 1 ? client.validationJob.findUnique({ where: { id: binding.jobId }, select }) : null;
    },
  };
}

function getValidatedCreateData(
  input: ValidationJobCreateInput,
  now: Date,
): StoredValidationJobCreate | null {
  if (!isSafeId(input.userId) || !isSafeId(input.repositoryId) || !isSafeId(input.proposedFixId)) return null;
  if (!isProposedChangeIdentifier(input.proposedChangeIdentifier) || !isCommitSha(input.baseCommitSha)) return null;
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + DEFAULT_JOB_LIFETIME_MS);
  const lifetime = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(expiresAt.getTime()) || lifetime <= 0 || lifetime > MAX_JOB_LIFETIME_MS) return null;

  const normalized = {
    userId: input.userId,
    repositoryId: input.repositoryId,
    proposedFixId: input.proposedFixId,
    proposedChangeIdentifier: input.proposedChangeIdentifier,
    baseCommitSha: input.baseCommitSha.toLowerCase(),
  };
  return {
    ...normalized,
    idempotencyKey: createValidationJobIdempotencyKey(normalized),
    status: "QUEUED",
    failureCategory: null,
    expiresAt,
  };
}

export function createValidationJobIdempotencyKey(input: {
  userId: string;
  repositoryId: string;
  proposedFixId: string;
  proposedChangeIdentifier: string;
  baseCommitSha: string;
}) {
  return createHash("sha256").update([
    "sentinel-validation-job-v1",
    input.userId,
    input.repositoryId,
    input.proposedFixId,
    input.proposedChangeIdentifier,
    input.baseCommitSha.toLowerCase(),
  ].join("\u0000")).digest("base64url");
}

function sameImmutableBinding(
  job: ValidationJobRecord,
  input: Pick<StoredValidationJobCreate, "userId" | "repositoryId" | "proposedFixId" | "proposedChangeIdentifier" | "baseCommitSha">,
) {
  return job.userId === input.userId
    && job.repositoryId === input.repositoryId
    && job.proposedFixId === input.proposedFixId
    && job.proposedChangeIdentifier === input.proposedChangeIdentifier
    && job.baseCommitSha.toLowerCase() === input.baseCommitSha.toLowerCase();
}

function isValidBinding(binding: ValidationJobBinding) {
  return isSafeId(binding.jobId)
    && isSafeId(binding.userId)
    && isSafeId(binding.repositoryId)
    && isSafeId(binding.proposedFixId)
    && isProposedChangeIdentifier(binding.proposedChangeIdentifier)
    && isCommitSha(binding.baseCommitSha);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isProposedChangeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{40,64}$/i.test(value);
}

function isFailureCategory(value: unknown): value is ValidationJobFailureCategory {
  return typeof value === "string" && VALIDATION_JOB_FAILURE_CATEGORIES.includes(value as ValidationJobFailureCategory);
}

function isIdempotencyRaceError(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "P2002" || error.code === "P2034" || error.code === "40001";
}

function isBindingError(error: unknown) {
  return error instanceof ValidationJobBindingError
    || (typeof error === "object" && error !== null && "code" in error && error.code === "VALIDATION_JOB_BINDING");
}
