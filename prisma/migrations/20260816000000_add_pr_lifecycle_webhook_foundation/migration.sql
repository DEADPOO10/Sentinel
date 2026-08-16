-- Expand the lifecycle enum without removing OPEN so older deployments remain compatible.
ALTER TYPE "PullRequestStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_REVIEW';

-- Add stable GitHub identity and synchronization timestamps for existing PR records.
ALTER TABLE "PullRequest"
ADD COLUMN "githubPrNodeId" TEXT,
ADD COLUMN "githubUpdatedAt" TIMESTAMP(3),
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Record authenticated deliveries for transaction-safe idempotency in the processing phase.
CREATE TABLE "GitHubWebhookDelivery" (
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "githubUpdatedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubWebhookDelivery_pkey" PRIMARY KEY ("deliveryId")
);

CREATE UNIQUE INDEX "PullRequest_githubPrNodeId_key" ON "PullRequest"("githubPrNodeId");
CREATE INDEX "GitHubWebhookDelivery_pullRequestId_processedAt_idx" ON "GitHubWebhookDelivery"("pullRequestId", "processedAt");

ALTER TABLE "GitHubWebhookDelivery"
ADD CONSTRAINT "GitHubWebhookDelivery_pullRequestId_fkey"
FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
