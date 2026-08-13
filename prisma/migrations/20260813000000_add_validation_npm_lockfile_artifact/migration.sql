-- Store only the exact bounded npm lockfile artifact authenticated by the
-- isolated validation response. The validation row remains the binding to the
-- proposed fix and immutable base commit.
ALTER TABLE "ValidationRun"
ADD COLUMN "npmPackageLockContent" BYTEA,
ADD COLUMN "npmPackageLockByteLength" INTEGER,
ADD COLUMN "npmPackageLockSha256" TEXT;

ALTER TABLE "ValidationRun"
ADD CONSTRAINT "ValidationRun_npmPackageLockArtifact_complete_check" CHECK (
  ("npmPackageLockContent" IS NULL AND "npmPackageLockByteLength" IS NULL AND "npmPackageLockSha256" IS NULL)
  OR
  ("npmPackageLockContent" IS NOT NULL AND "npmPackageLockByteLength" IS NOT NULL AND "npmPackageLockSha256" IS NOT NULL)
);

ALTER TABLE "ValidationRun"
ADD CONSTRAINT "ValidationRun_npmPackageLockByteLength_check" CHECK (
  "npmPackageLockByteLength" IS NULL
  OR (
    "npmPackageLockByteLength" > 0
    AND "npmPackageLockByteLength" <= 2097152
    AND octet_length("npmPackageLockContent") = "npmPackageLockByteLength"
  )
);

ALTER TABLE "ValidationRun"
ADD CONSTRAINT "ValidationRun_npmPackageLockSha256_check" CHECK (
  "npmPackageLockSha256" IS NULL
  OR "npmPackageLockSha256" ~ '^[a-f0-9]{64}$'
);
