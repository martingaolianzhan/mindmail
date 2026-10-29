-- Additive scheduling schema. Existing credentials/checkpoints have no verified
-- adoption provenance: retain mail, fence old executions and require relink.
CREATE TYPE "SyncScheduleState" AS ENUM ('scheduled', 'running', 'retry_wait', 'reconciling', 'blocked');
ALTER TABLE "Account"
  ADD COLUMN "syncScheduleState" "SyncScheduleState" NOT NULL DEFAULT 'blocked',
  ADD COLUMN "syncNextRunAt" TIMESTAMP(3),
  ADD COLUMN "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "syncLastOutcomeStatus" TEXT,
  ADD COLUMN "syncLastOutcomeReason" TEXT,
  ADD COLUMN "syncScheduleVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "activeSyncLeaseExpiresAt" TIMESTAMP(3);
UPDATE "Account" SET "syncGeneration" = "syncGeneration" + 1,
  "activeSyncRunId" = NULL, "latestDeltaToken" = NULL,
  "syncLastOutcomeStatus" = 'action-required', "syncLastOutcomeReason" = 'adoption-relink-required';
CREATE INDEX "Account_syncScheduleState_syncNextRunAt_idx" ON "Account"("syncScheduleState", "syncNextRunAt");
CREATE INDEX "Account_activeSyncLeaseExpiresAt_idx" ON "Account"("activeSyncLeaseExpiresAt");
