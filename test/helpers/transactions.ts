import type { Prisma } from "@prisma/client";
import { vi } from "vitest";
import { db } from "~/server/db";
import * as executions from "~/lib/sync-execution";

const realTransaction = db.$transaction.bind(db);
const realUpdateMany = db.account.updateMany.bind(db.account);

export function interceptCheckpoints(handler: typeof db.account.updateMany = realUpdateMany) {
  const observer = vi.fn(handler);
  vi.spyOn(db.account, "updateMany").mockImplementation(((args) => {
    // Observe checkpoint completion, not relink's new null invalidation write.
    return typeof args.data.latestDeltaToken === "string" ? observer(args) : realUpdateMany(args);
  }) as typeof db.account.updateMany);
  // Execution updates now use native bounded transactions. These legacy
  // checkpoint fault-injection tests intentionally wrap the completion boundary;
  // the injected root UPDATE still executes its real conditional SQL predicate.
  vi.spyOn(executions, "completeSyncExecution").mockImplementation(async (execution, latestDeltaToken) => {
    const result = await observer({
      where: { id: execution.accountId, userId: execution.userId, accessToken: execution.originalAccessToken, syncGeneration: execution.generation, activeSyncRunId: execution.runId },
      data: { latestDeltaToken, activeSyncRunId: null },
    });
    if (result.count !== 1) throw new executions.StaleSyncExecutionError();
  });
  return observer;
}

// Test-only interception: transactions/locks/commits still execute in real
// PostgreSQL. Gates and injected failures may wrap the transaction client.
export function interceptTransactions(wrap: (tx: Prisma.TransactionClient) => Prisma.TransactionClient | Promise<Prisma.TransactionClient>) {
  return vi.spyOn(db, "$transaction").mockImplementation((async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => {
    if (typeof callback !== "function") throw new Error("Expected interactive transaction");
    if (options?.isolationLevel !== "ReadCommitted") return realTransaction(callback, options);
    return realTransaction(async (tx) => {
      const wrapped = await wrap(tx);
      // Prisma's raw-query methods are non-enumerable. Preserve them when a
      // test overrides a delegate using an object spread.
      return callback(new Proxy(tx, {
        get(target, key) {
          const value: unknown = key in wrapped ? Reflect.get(wrapped, key) : Reflect.get(target, key);
          return value;
        },
      }));
    }, options);
  }) as typeof db.$transaction);
}

export function restoreTransactions() {
  db.$transaction = realTransaction;
}
