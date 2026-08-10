-- Each client validation attempt has one persisted history row. The nullable
-- column keeps this additive for any existing historical records.
ALTER TABLE "ValidationRun" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "ValidationRun_idempotencyKey_key" ON "ValidationRun"("idempotencyKey");
