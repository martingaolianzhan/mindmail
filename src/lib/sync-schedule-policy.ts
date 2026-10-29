import type { Prisma } from "@prisma/client";
import type { SyncFailure } from "./sync-run";

// Application defaults, not provider requirements.
export const SYNC_SCHEDULE = {
  targetCadenceMs: 60_000,
  successIntervalMs: 300_000,
  retryDelaysMs: [60_000, 300_000, 900_000, 3_600_000],
  maxReplacements: 4,
  staleOwnerLeaseMs: 300_000,
  batchSize: 1,
} as const;

export type SafeSyncOutcome = SyncFailure | { status: "completed" };
export function replacementSchedule(count: number, now: Date): Prisma.AccountUpdateManyMutationInput {
  const delay = count >= SYNC_SCHEDULE.maxReplacements ? undefined : SYNC_SCHEDULE.retryDelaysMs[count];
  return delay === undefined
    ? { syncScheduleState: "blocked", syncNextRunAt: null }
    : { syncScheduleState: "retry_wait", syncRetryCount: count + 1, syncNextRunAt: new Date(now.getTime() + delay) };
}

export function outcomeSchedule(outcome: SafeSyncOutcome, count: number, now: Date): Prisma.AccountUpdateManyMutationInput | null {
  switch (outcome.status) {
    case "completed": return { syncScheduleState: "scheduled", syncRetryCount: 0, syncNextRunAt: new Date(now.getTime() + SYNC_SCHEDULE.successIntervalMs) };
    case "retryable-failure":
    case "cancelled": return replacementSchedule(count, now);
    case "action-required": return outcome.reason === "reinitialization-required" ? replacementSchedule(count, now) : { syncScheduleState: "blocked", syncNextRunAt: null };
    case "safety-limit":
    case "internal-failure": return { syncScheduleState: "blocked", syncNextRunAt: null };
    case "ownership-lost":
    case "account-not-found":
    case "not-acquired":
    case "indeterminate-completion": return null;
  }
}

// Included in the SAME credential write, for both relink branches and creation.
export function newGenerationSchedule(now = new Date()) {
  return {
    activeSyncLeaseExpiresAt: null,
    syncScheduleState: "scheduled" as const,
    syncNextRunAt: now,
    syncRetryCount: 0,
    syncScheduleVersion: { increment: 1 },
    syncLastOutcomeStatus: null,
    syncLastOutcomeReason: null,
  };
}
