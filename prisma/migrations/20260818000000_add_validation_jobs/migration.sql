-- CreateEnum
CREATE TYPE "ValidationJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ValidationJobFailureCategory" AS ENUM ('WORKER_UNAVAILABLE', 'WORKER_TIMEOUT', 'RESULT_INVALID', 'JOB_EXPIRED', 'INTERNAL_ERROR');

-- CreateTable
CREATE TABLE "ValidationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "proposedFixId" TEXT NOT NULL,
    "proposedChangeIdentifier" TEXT NOT NULL,
    "baseCommitSha" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ValidationJobStatus" NOT NULL DEFAULT 'QUEUED',
    "failureCategory" "ValidationJobFailureCategory",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ValidationJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ValidationJob_commit_sha_check" CHECK ("baseCommitSha" ~ '^[0-9a-fA-F]{40,64}$'),
    CONSTRAINT "ValidationJob_proposed_change_identifier_check" CHECK ("proposedChangeIdentifier" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "ValidationJob_expiration_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "ValidationJob_terminal_state_check" CHECK (
      ("status" IN ('COMPLETED', 'FAILED') AND "completedAt" IS NOT NULL)
      OR ("status" IN ('QUEUED', 'RUNNING') AND "completedAt" IS NULL)
    ),
    CONSTRAINT "ValidationJob_failure_category_check" CHECK (
      ("status" = 'FAILED' AND "failureCategory" IS NOT NULL)
      OR ("status" <> 'FAILED' AND "failureCategory" IS NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "ValidationJob_idempotencyKey_key" ON "ValidationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ValidationJob_userId_createdAt_idx" ON "ValidationJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ValidationJob_repositoryId_createdAt_idx" ON "ValidationJob"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "ValidationJob_proposedFixId_createdAt_idx" ON "ValidationJob"("proposedFixId", "createdAt");

-- CreateIndex
CREATE INDEX "ValidationJob_status_expiresAt_idx" ON "ValidationJob"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "ValidationJob" ADD CONSTRAINT "ValidationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationJob" ADD CONSTRAINT "ValidationJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationJob" ADD CONSTRAINT "ValidationJob_proposedFixId_fkey" FOREIGN KEY ("proposedFixId") REFERENCES "ProposedFix"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
