import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account as DbAccount, Prisma } from "@prisma/client";
const { http } = vi.hoisted(() => ({ http: { get: vi.fn(), post: vi.fn() } }));
vi.mock("axios", () => ({ default: http }));
import { Account } from "~/lib/account";
import { db } from "~/server/db";
import * as executions from "~/lib/sync-execution";
import * as persistence from "~/lib/sync-to-db";
import { SyncDatabaseObservationError } from "~/lib/sync-database";
import { performInitialSync } from "~/lib/initial-sync";

const prefix = `claim007-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;
const realTransaction = db.$transaction.bind(db);
const realTerminate = executions.terminateSyncExecution;
const limits = { dbObservationMs: 200, deadlineMs: 1000 };
const unknown = { status: "indeterminate-completion", reason: "completion-indeterminate" };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const id = `${prefix}-${crypto.randomUUID()}`;
  return db.account.create({ data: { id, userId, accessToken: `${id}-TOKEN-SECRET`, emailAddress: `${id}@example.test`, name: "Synthetic", syncGeneration: 1, latestDeltaToken: "DELTA-SECRET" } });
}
const reread = (a: DbAccount) => db.account.findUniqueOrThrow({ where: { id: a.id } });

// Gate the original transaction's acknowledgement AFTER PostgreSQL COMMIT, not
// the higher-level claim helper. This reproduces its former INNER observer loss.
function holdClaimAcknowledgement(rejectAfterCommit = false) {
  const committed = deferred<executions.SyncExecution>(); const ack = deferred(); const settled = deferred();
  type Revocation = { args: Prisma.AccountUpdateManyArgs; count: number };
  const cleanup = deferred<Revocation>(); const revocations: Revocation[] = [];
  let first = true; let released = false;
  vi.spyOn(db, "$transaction").mockImplementation((async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => {
    let execution: executions.SyncExecution | undefined;
    let revocation: Revocation | undefined;
    const result = await realTransaction((tx) => callback(new Proxy(tx, {
      get(target, key) {
        if (key !== "account") { const value: unknown = Reflect.get(target, key); return value; }
        return new Proxy(tx.account, {
          get(delegate, method) {
            if (method !== "updateMany") { const value: unknown = Reflect.get(delegate, method); return value; }
            return async (args: Prisma.AccountUpdateManyArgs) => {
              if (first && typeof args.data.activeSyncRunId === "string" && args.where?.activeSyncRunId === null) {
                first = false;
                execution = { accountId: args.where.id as string, userId: args.where.userId as string, originalAccessToken: args.where.accessToken as string, generation: args.where.syncGeneration as number, runId: args.data.activeSyncRunId };
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
      committed.resolve(execution); await ack.promise; settled.resolve();
      if (rejectAfterCommit) throw new Error("RAW-DB-SECRET ACK-SECRET");
    }
    return result;
  }) as typeof db.$transaction);
  return { committed: committed.promise, release: () => { released = true; ack.resolve(); }, settled: settled.promise, cleanup: cleanup.promise, revocations };
}

beforeAll(async () => {
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.$transaction = realTransaction; });
afterAll(async () => { await db.account.deleteMany({ where: { userId } }); await db.user.delete({ where: { id: userId } }); await db.$disconnect(); });

describe("SYNC-007 late original claim acknowledgement against real PostgreSQL", () => {
  it.each(["initial", "incremental"] as const)("%s: committed R1 blocks R2 until its late acknowledgement triggers exact-R1 cleanup", async (kind) => {
    const a = await fixture(); const held = holdClaimAcknowledgement();
    const claim = vi.spyOn(executions, "claimSyncExecution");
    const persist = vi.spyOn(persistence, "syncEmailsToDatabase");
    const complete = vi.spyOn(executions, "completeSyncExecution");
    const run = kind === "initial" ? performInitialSync({ accountId: a.id, userId }, { limits }) : new Account(a.accessToken).syncEmails({ limits });
    const r1 = await held.committed;
    try {
      await vi.advanceTimersByTimeAsync(200);
      await expect(run).resolves.toEqual(unknown);
      // Before the patch this proved the INNER observer rejected permanently.
      // Now the same raw-transaction gate exercises the SINGLE claim observer.
      await expect(claim.mock.results[0]!.value).rejects.toBeInstanceOf(SyncDatabaseObservationError);
      expect(await reread(a)).toMatchObject({ activeSyncRunId: r1.runId, latestDeltaToken: a.latestDeltaToken });
      await expect(new Account(a.accessToken).syncEmails({ limits })).resolves.toEqual({ status: "not-acquired", reason: "not-acquired" });
      expect(held.revocations).toHaveLength(0);
      expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    } finally { held.release(); }
    await held.settled;
    const cleanup = await held.cleanup;
    expect(held.revocations).toHaveLength(1);
    expect(cleanup).toEqual({ args: { where: { id: r1.accountId, userId: r1.userId, accessToken: r1.originalAccessToken, syncGeneration: r1.generation, activeSyncRunId: r1.runId }, data: { activeSyncRunId: null } }, count: 1 });
    expect(await reread(a)).toMatchObject({ activeSyncRunId: null, latestDeltaToken: a.latestDeltaToken });
    const r2 = await executions.claimSyncExecution(await reread(a));
    expect(r2.runId).not.toBe(r1.runId);
    expect((await reread(a)).activeSyncRunId).toBe(r2.runId);
    await expect(run).resolves.toEqual(unknown);
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    const output = JSON.stringify({ outcome: await run, logs: vi.mocked(console.error).mock.calls });
    for (const secret of [r1.runId, a.accessToken, a.latestDeltaToken!]) expect(output).not.toContain(secret);
  });

  it.each(["new-generation", "same-generation"] as const)("late R1 cleanup cannot clear %s R2", async (kind) => {
    const a = await fixture(); const held = holdClaimAcknowledgement();
    const run = new Account(a.accessToken).syncEmails({ limits }); const r1 = await held.committed;
    let r2!: executions.SyncExecution;
    try {
      await vi.advanceTimersByTimeAsync(200); await expect(run).resolves.toEqual(unknown);
      expect(held.revocations).toHaveLength(0);
      if (kind === "new-generation") {
        // Exact production-compatible, ownership-scoped four-field relink.
        await db.account.updateMany({ where: { id: a.id, userId }, data: { accessToken: `${a.accessToken}-T2`, syncGeneration: { increment: 1 }, activeSyncRunId: null, latestDeltaToken: null } });
      } else {
        // A definite conditional revocation is an existing valid same-generation
        // transition, not stale-owner reclamation, a lease or a recovery worker.
        expect(await realTerminate(r1)).toBe(true);
      }
      r2 = await executions.claimSyncExecution(await reread(a));
      expect(r2.runId).not.toBe(r1.runId);
    } finally { held.release(); }
    await held.settled;
    const cleanup = await held.cleanup;
    expect(held.revocations).toHaveLength(1);
    expect(cleanup).toEqual({ args: { where: { id: r1.accountId, userId: r1.userId, accessToken: r1.originalAccessToken, syncGeneration: r1.generation, activeSyncRunId: r1.runId }, data: { activeSyncRunId: null } }, count: 0 });
    expect(await reread(a)).toMatchObject({ activeSyncRunId: r2.runId, syncGeneration: kind === "new-generation" ? 2 : 1, accessToken: kind === "new-generation" ? `${a.accessToken}-T2` : a.accessToken, latestDeltaToken: kind === "new-generation" ? null : a.latestDeltaToken });
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
    await expect(run).resolves.toEqual(unknown);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/TOKEN-SECRET|DELTA-SECRET/);
  });

  it("lost original claim result stays indeterminate without pretending R1 did not commit or was cleared", async () => {
    const a = await fixture(); const held = holdClaimAcknowledgement(true);
    const run = new Account(a.accessToken).syncEmails({ limits }); const r1 = await held.committed;
    try { await vi.advanceTimersByTimeAsync(200); await expect(run).resolves.toEqual(unknown); }
    finally { held.release(); }
    await held.settled; await vi.advanceTimersByTimeAsync(0);
    expect(held.revocations).toHaveLength(0);
    expect((await reread(a)).activeSyncRunId).toBe(r1.runId);
    await expect(new Account(a.accessToken).syncEmails({ limits })).resolves.toEqual({ status: "not-acquired", reason: "not-acquired" });
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
    expect(JSON.stringify({ outcome: await run, logs: vi.mocked(console.error).mock.calls })).not.toMatch(/RAW-DB-SECRET|ACK-SECRET|TOKEN-SECRET|DELTA-SECRET/);
  });
});
