import type { Prisma } from "@prisma/client";
import { vi } from "vitest";
import { db } from "~/server/db";
import type { SyncExecution } from "~/lib/sync-execution";

const realTransaction = db.$transaction.bind(db);
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

// Shared SYNC-007/SYNC-005 ORIGINAL transaction gate. By default acknowledgement
// is held AFTER real PostgreSQL COMMIT. The opposite-order test gates immediately
// before the original conditional UPDATE, without changing production claim logic.
export function holdClaimAcknowledgement(rejectAfterCommit = false, phase: "after-commit" | "before-update" = "after-commit") {
  const committed = deferred<SyncExecution>(); const entered = deferred(); const ack = deferred(); const settled = deferred<{ count: number }>();
  type Revocation = { args: Prisma.AccountUpdateManyArgs; count: number };
  const cleanup = deferred<Revocation>(); const revocations: Revocation[] = [];
  let first = true; let released = false;
  vi.spyOn(db, "$transaction").mockImplementation((async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => {
    let execution: SyncExecution | undefined;
    let revocation: Revocation | undefined;
    const result = await realTransaction((tx) => callback(new Proxy(tx, {
      get(target, key) {
        if (key !== "account") return Reflect.get(target, key) as unknown;
        return new Proxy(tx.account, {
          get(delegate, method) {
            if (method !== "updateMany") return Reflect.get(delegate, method) as unknown;
            return async (args: Prisma.AccountUpdateManyArgs) => {
              if (first && typeof args.data.activeSyncRunId === "string" && args.where?.activeSyncRunId === null) {
                first = false;
                execution = { accountId: args.where.id as string, userId: args.where.userId as string, originalAccessToken: args.where.accessToken as string, generation: args.where.syncGeneration as number, runId: args.data.activeSyncRunId };
                if (phase === "before-update") { entered.resolve(); await ack.promise; }
              }
              const result = await tx.account.updateMany(args);
              if (released && args.data.activeSyncRunId === null && typeof args.where?.activeSyncRunId === "string") revocation = { args, count: result.count };
              return result;
            };
          },
        });
      },
    })), options);
    if (revocation) { revocations.push(revocation); cleanup.resolve(revocation); }
    if (execution) {
      committed.resolve(execution);
      if (phase === "after-commit") { entered.resolve(); await ack.promise; }
      settled.resolve(result as { count: number });
      if (rejectAfterCommit) throw new Error("RAW-DB-SECRET ACK-SECRET");
    }
    return result;
  }) as typeof db.$transaction);
  return { committed: committed.promise, entered: entered.promise, release: () => { released = true; ack.resolve(); }, settled: settled.promise, cleanup: cleanup.promise, revocations };
}
