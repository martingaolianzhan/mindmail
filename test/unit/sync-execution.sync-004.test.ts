import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@prisma/client";
import { readFileSync } from "node:fs";

const { updateMany, query, transaction } = vi.hoisted(() => ({ updateMany: vi.fn(), query: vi.fn(), transaction: vi.fn() }));
vi.mock("~/server/db", () => ({ db: { account: { updateMany }, $transaction: transaction } }));
import { claimSyncExecution, completeSyncExecution, lockSyncExecution, releaseSyncExecution, StaleSyncExecutionError, SyncNotAcquiredError } from "~/lib/sync-execution";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { execution } from "../fixtures/sync-execution";
import type { Prisma } from "@prisma/client";

beforeEach(() => {
  updateMany.mockResolvedValue({ count: 1 });
  query.mockResolvedValue([{ id: execution.accountId }]);
  transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({ $queryRaw: query }));
});

describe("SYNC-004 durable execution boundary", () => {
  it("claims using account, user, credential, generation, unowned state and checkpoint snapshot", async () => {
    const account = { id: "A1", userId: "U1", accessToken: "T1", syncGeneration: 3, latestDeltaToken: "D0" } as Account;
    const first = await claimSyncExecution(account);
    const second = await claimSyncExecution(account);
    expect(first.runId).not.toBe(second.runId);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "A1", userId: "U1", accessToken: "T1", syncGeneration: 3, activeSyncRunId: null, latestDeltaToken: "D0" },
      data: { activeSyncRunId: first.runId },
    });
  });

  it("has explicit non-success for a competing or superseded claim", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await expect(claimSyncExecution({} as Account)).rejects.toBeInstanceOf(SyncNotAcquiredError);
  });

  it("atomically completes and releases only its original generation/run/token/user", async () => {
    await completeSyncExecution(execution, "D1");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: execution.accountId, userId: execution.userId, accessToken: execution.originalAccessToken, syncGeneration: 0, activeSyncRunId: execution.runId },
      data: { latestDeltaToken: "D1", activeSyncRunId: null },
    });
    updateMany.mockResolvedValue({ count: 0 });
    await expect(completeSyncExecution(execution, "D2")).rejects.toBeInstanceOf(StaleSyncExecutionError);
  });

  it("failure cleanup cannot clear another generation/run", async () => {
    await releaseSyncExecution(execution);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: execution.accountId, userId: execution.userId, syncGeneration: 0, activeSyncRunId: execution.runId },
      data: { activeSyncRunId: null },
    });
  });

  it("rejects the lock boundary when generation/run no longer matches", async () => {
    query.mockResolvedValue([]);
    await expect(lockSyncExecution({ $queryRaw: query } as unknown as Prisma.TransactionClient, execution)).rejects.toBeInstanceOf(StaleSyncExecutionError);
    const sql = query.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(sql.join("?")).toContain("FOR UPDATE");
  });

  it("requires fenced transactions even for an empty round", async () => {
    await syncEmailsToDatabase([], execution);
    expect(query).toHaveBeenCalledOnce();
    query.mockResolvedValue([]);
    await expect(syncEmailsToDatabase([], execution)).rejects.toThrow("Failed to sync emails to database.");
    await expect(syncEmailsToDatabase([], undefined as never)).rejects.toThrow("Failed to sync emails to database.");
  });

  it("has no production sync persistence call without execution context", () => {
    for (const file of ["src/lib/account.ts", "src/lib/initial-sync.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/await syncEmailsToDatabase\([^;]+, execution\)/);
    }
    const source = readFileSync("src/lib/sync-to-db.ts", "utf8");
    expect(source).toContain("execution: SyncExecution");
    expect(source).toContain("await lockSyncExecution(tx, execution)");
    expect(source).toContain("await upsertEmail(tx, email, execution.accountId)");
    expect(source).not.toContain("execution?:");
  });
});
