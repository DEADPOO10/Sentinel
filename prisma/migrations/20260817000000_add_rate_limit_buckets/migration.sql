CREATE TYPE "RateLimitOperation" AS ENUM ('OPENAI_REQUEST', 'REPOSITORY_SCAN', 'VALIDATION_JOB');
CREATE TYPE "RateLimitScope" AS ENUM ('USER', 'REPOSITORY');
CREATE TYPE "RateLimitWindow" AS ENUM ('SHORT', 'DAILY');

CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "operation" "RateLimitOperation" NOT NULL,
    "scope" "RateLimitScope" NOT NULL,
    "window" "RateLimitWindow" NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RateLimitBucket_requestCount_check" CHECK ("requestCount" >= 0)
);

CREATE UNIQUE INDEX "RateLimitBucket_operation_scope_window_subjectKey_windowStart_key"
ON "RateLimitBucket"("operation", "scope", "window", "subjectKey", "windowStart");

CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");
