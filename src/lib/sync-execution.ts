import { randomUUID } from "node:crypto";
import type { Account, Prisma } from "@prisma/client";
import { db } from "~/server/db";

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

export async function claimSyncExecution(account: Account): Promise<SyncExecution> {
  const execution = {
    accountId: account.id, userId: account.userId,
    originalAccessToken: account.accessToken,
    generation: account.syncGeneration, runId: randomUUID(),
  };
  const claimed = await db.account.updateMany({
    where: {
      ...executionPredicate(execution), activeSyncRunId: null,
      // A run may have completed between the caller's read and this claim.
      // Never acquire using its now-outdated checkpoint snapshot.
      latestDeltaToken: account.latestDeltaToken,
    },
    data: { activeSyncRunId: execution.runId },
  });
  if (claimed.count !== 1) throw new SyncNotAcquiredError();
  return execution;
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
export async function completeSyncExecution(execution: SyncExecution, latestDeltaToken: string) {
  const result = await db.account.updateMany({
    where: executionPredicate(execution),
    data: { latestDeltaToken, activeSyncRunId: null },
  });
  if (result.count !== 1) throw new StaleSyncExecutionError();
}

// Best-effort failure cleanup must never clear a newer generation/run. A hard
// crash (or failed cleanup) can strand ownership; SYNC-005 owns reclamation.
export async function releaseSyncExecution(execution: SyncExecution) {
  try {
    await db.account.updateMany({
      where: {
        id: execution.accountId, userId: execution.userId,
        syncGeneration: execution.generation, activeSyncRunId: execution.runId,
      },
      data: { activeSyncRunId: null },
    });
  } catch {
    console.error("Sync ownership release failed.");
  }
}
