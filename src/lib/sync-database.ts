import type { Prisma } from "@prisma/client";
import { db } from "~/server/db";
import { SYNC_LIMITS, type SyncLimits } from "./sync-limits";

export class SyncDatabaseObservationError extends Error {
  constructor() { super("Sync database acknowledgement not established."); }
}

// Both handlers remain attached after expiry. A late operation is not cancelled,
// retried, or interpreted as rolled back; its original fencing predicates remain.
export function observeDatabase<T>(operation: PromiseLike<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SyncDatabaseObservationError()), milliseconds);
    Promise.resolve(operation).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error("Sync database operation failed.")); },
    );
  });
}

// Native transaction/pool/SQL bounds without hiding the original settlement.
// Claim acquisition retains this Promise for late confirmation/conditional cleanup.
// Other operations use withSyncDatabase's observation wrapper below.
export function submitSyncDatabase<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, limits: SyncLimits = SYNC_LIMITS, persistence = false): Promise<T> {
  const transaction = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(limits.dbStatementMs)}, true), set_config('lock_timeout', ${String(limits.dbLockMs)}, true)`;
    return operation(tx);
  }, {
    maxWait: limits.dbMaxWaitMs,
    timeout: limits.dbTransactionMs,
    ...(persistence ? { isolationLevel: "ReadCommitted" as const } : {}),
  });
  return transaction;
}

// No provider/network call belongs inside these bounded DB transactions.
export function withSyncDatabase<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, limits: SyncLimits = SYNC_LIMITS, persistence = false): Promise<T> {
  return observeDatabase(submitSyncDatabase(operation, limits, persistence), limits.dbObservationMs);
}
