-- Add a short-lived scan idempotency key so duplicate server renders do not
-- create duplicate historical snapshots for the same repository revision.
ALTER TABLE "Scan" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Scan_idempotencyKey_key" ON "Scan"("idempotencyKey");
CREATE INDEX "Scan_repositoryId_status_completedAt_idx" ON "Scan"("repositoryId", "status", "completedAt");
