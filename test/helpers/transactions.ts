import type { Prisma } from "@prisma/client";
import { vi } from "vitest";
import { db } from "~/server/db";

const realTransaction = db.$transaction.bind(db);
const realUpdateMany = db.account.updateMany.bind(db.account);

export function interceptCheckpoints(handler: typeof db.account.updateMany = realUpdateMany) {
  const observer = vi.fn(handler);
  vi.spyOn(db.account, "updateMany").mockImplementation(((args) => {
    return "latestDeltaToken" in args.data ? observer(args) : realUpdateMany(args);
  }) as typeof db.account.updateMany);
  return observer;
}

// Test-only interception: transactions/locks/commits still execute in real
// PostgreSQL. Gates and injected failures may wrap the transaction client.
export function interceptTransactions(wrap: (tx: Prisma.TransactionClient) => Prisma.TransactionClient | Promise<Prisma.TransactionClient>) {
  return vi.spyOn(db, "$transaction").mockImplementation((async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => {
    if (typeof callback !== "function") throw new Error("Expected interactive transaction");
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
