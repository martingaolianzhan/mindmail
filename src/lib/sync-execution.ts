import { randomUUID } from "node:crypto";
import type { Account, Prisma } from "@prisma/client";
import { observeDatabase, submitSyncDatabase, SyncDatabaseObservationError, withSyncDatabase } from "./sync-database";
import { SYNC_LIMITS, type SyncLimits } from "./sync-limits";
import { SYNC_SCHEDULE } from "./sync-schedule-policy";

// Trusted server-only scheduling context. Never part of the safe run outcome.
export type SyncScheduleClaim = {
  generation: number;
  version: number;
  state: "scheduled" | "retry_wait";
  checkpoint: string | null;
};
export type ScheduledExecution = SyncExecution & { scheduleVersion: number };

export type SyncExecution = {
  accountId: string;
  userId: string;
  originalAccessToken: string;
  generation: number;
  runId: string;
};

export class SyncNotAcquiredError extends Error {
  constructor() { super("Sync execution not acquired."); }
}

export class StaleSyncExecutionError extends Error {
  constructor() { super("Sync execution is no longer authoritative."); }
}

export async function claimSyncExecution(account: Account, limits: SyncLimits = SYNC_LIMITS, schedule?: SyncScheduleClaim): Promise<ScheduledExecution> {
  const scheduling = schedule ? { ...schedule } : {
    generation: account.syncGeneration, version: account.syncScheduleVersion,
    state: account.syncScheduleState, checkpoint: account.latestDeltaToken,
  };
  if ((scheduling.state !== "scheduled" && scheduling.state !== "retry_wait") || scheduling.generation !== account.syncGeneration) throw new SyncNotAcquiredError();
  const latestDeltaToken = scheduling.checkpoint;
  const execution = {
    accountId: account.id, userId: account.userId,
    originalAccessToken: account.accessToken,
    generation: account.syncGeneration, runId: randomUUID(),
  };
  // Retain R1 and the ORIGINAL bounded transaction settlement before observing
  // it. No inner observer may permanently hide a later definitive commit result.
  const settlement = submitSyncDatabase((tx) => tx.account.updateMany({
    where: {
      ...executionPredicate(execution), activeSyncRunId: null,
      // A run may have completed between the caller's read and this claim.
      // Never acquire using its now-outdated checkpoint snapshot.
      latestDeltaToken,
      syncScheduleVersion: scheduling.version,
      syncScheduleState: scheduling.state,
      syncNextRunAt: { lte: new Date() },
    },
    data: {
      activeSyncRunId: execution.runId,
      syncScheduleState: "running" as const,
      syncNextRunAt: null,
      activeSyncLeaseExpiresAt: new Date(Date.now() + SYNC_SCHEDULE.staleOwnerLeaseMs),
      syncScheduleVersion: { increment: 1 },
    },
  }), limits);
  try {
    const claimed = await observeDatabase(settlement, limits.dbObservationMs);
    if (claimed.count === 0) throw new SyncNotAcquiredError();
    if (claimed.count !== 1) throw new SyncDatabaseObservationError();
    return { ...execution, scheduleVersion: scheduling.version + 1 };
  } catch (error) {
    if (error instanceof SyncNotAcquiredError) throw error;
    // Never revoke blindly: the original claim could commit AFTER an early
    // cleanup's zero-row UPDATE. Only definitive count=1 authorizes late cleanup.
    // Installing on the retained original Promise also handles settlement racing
    // observation expiry (fulfilled Promises retain their definitive result).
    void settlement.then(async (claimed) => {
      if (claimed.count === 1 && !await terminateSyncExecution(execution, limits)) {
        console.error("Late sync claim cleanup not confirmed.");
      }
    }, () => undefined).catch(() => console.error("Late sync claim cleanup not confirmed."));
    throw error;
  }
}

function executionPredicate(execution: SyncExecution) {
  return {
    id: execution.accountId, userId: execution.userId,
    accessToken: execution.originalAccessToken,
    syncGeneration: execution.generation, activeSyncRunId: execution.runId,
  };
}

// All protected child writes must use this same transaction client. FOR UPDATE
// orders them against relink's UPDATE of the same Account row. No provider work
// occurs while this lock is held. Read Committed rechecks a waited-on row.
export async function lockSyncExecution(tx: Prisma.TransactionClient, execution: SyncExecution) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Account"
    WHERE "id" = ${execution.accountId} AND "userId" = ${execution.userId}
      AND "syncGeneration" = ${execution.generation}
      AND "activeSyncRunId" = ${execution.runId}
      AND "accessToken" = ${execution.originalAccessToken}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new StaleSyncExecutionError();
}

// One atomic boundary: checkpoint, authoritative completion, and own release.
export async function completeSyncExecution(execution: SyncExecution, latestDeltaToken: string, limits: SyncLimits = SYNC_LIMITS) {
  const result = await withSyncDatabase((tx) => tx.account.updateMany({
    where: executionPredicate(execution),
    data: { latestDeltaToken, activeSyncRunId: null, activeSyncLeaseExpiresAt: null },
  }), limits);
  if (result.count !== 1) throw new StaleSyncExecutionError();
}

export async function ownsSyncExecution(execution: SyncExecution, limits: SyncLimits = SYNC_LIMITS) {
  return withSyncDatabase(async (tx) => (await tx.account.count({ where: executionPredicate(execution) })) === 1, limits);
}

// A definite count=1 acknowledgement is proof that revocation won against this
// run's completion. Zero is not completion provenance. Includes original credential.
export async function terminateSyncExecution(execution: SyncExecution, limits: SyncLimits = SYNC_LIMITS) {
  return withSyncDatabase(async (tx) => (await tx.account.updateMany({
    where: executionPredicate(execution), data: { activeSyncRunId: null, activeSyncLeaseExpiresAt: null },
  })).count === 1, limits);
}

// Best-effort failure cleanup must never clear a newer generation/run. A hard
// crash (or failed cleanup) leaves durable running work for SYNC-005 recovery.
export async function releaseSyncExecution(execution: SyncExecution) {
  try {
    await withSyncDatabase((tx) => tx.account.updateMany({
      where: {
        id: execution.accountId, userId: execution.userId,
        syncGeneration: execution.generation, activeSyncRunId: execution.runId,
      },
      data: { activeSyncRunId: null, activeSyncLeaseExpiresAt: null },
    }));
  } catch {
    console.error("Sync ownership release failed.");
  }
}
