-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "activeSyncRunId" TEXT,
ADD COLUMN     "syncGeneration" INTEGER NOT NULL DEFAULT 0;

