-- This runs after READY_FOR_REVIEW was committed by the preceding migration.
-- OPEN intentionally remains in the enum for compatibility with rolling/older deployments.
UPDATE "PullRequest"
SET "status" = 'READY_FOR_REVIEW'
WHERE "status" = 'OPEN';
