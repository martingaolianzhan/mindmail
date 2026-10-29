import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account as DbAccount } from "@prisma/client";
const { dbMock, http, persist } = vi.hoisted(() => ({
  dbMock: { account: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn() },
  http: { get: vi.fn(), post: vi.fn() }, persist: vi.fn(),
}));
vi.mock("~/server/db", () => ({ db: dbMock }));
vi.mock("axios", () => ({ default: http }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: persist }));
import { Account } from "~/lib/account";
import { performInitialSync } from "~/lib/initial-sync";
import { claimSyncExecution } from "~/lib/sync-execution";
import * as database from "~/lib/sync-database";

const a = { syncScheduleState: "scheduled", syncScheduleVersion: 0, id: "A", userId: "U", accessToken: "TOKEN-SECRET", syncGeneration: 1, activeSyncRunId: null, latestDeltaToken: "DELTA-SECRET" } as DbAccount;
const limits = { dbObservationMs: 20, deadlineMs: 200 };
const unknown = { status: "indeterminate-completion", reason: "completion-indeterminate" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
const start = (kind = "incremental", signal?: AbortSignal, deadlineMs = 200) => kind === "initial"
  ? performInitialSync({ accountId: a.id, userId: a.userId }, { signal, limits: { ...limits, deadlineMs } })
  : new Account(a.accessToken).syncEmails({ signal, limits: { ...limits, deadlineMs } });
function expectNoOrdinaryWork() {
  expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  expect(dbMock.account.updateMany.mock.calls.some(([args]) => "latestDeltaToken" in (args as { data: object }).data)).toBe(false);
}
function claimArgs() {
  return dbMock.account.updateMany.mock.calls[0]![0] as { where: object; data: { activeSyncRunId: string } };
}
function expectExactCleanup() {
  expect(dbMock.account.updateMany).toHaveBeenCalledTimes(2);
  expect(dbMock.account.updateMany.mock.calls[1]![0]).toEqual({
    where: { id: a.id, userId: a.userId, accessToken: a.accessToken, syncGeneration: a.syncGeneration, activeSyncRunId: claimArgs().data.activeSyncRunId },
    data: { activeSyncRunId: null, activeSyncLeaseExpiresAt: null },
  });
}
function expectSafe(outcome: unknown) {
  const serialized = JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls });
  for (const secret of [a.accessToken, a.latestDeltaToken!, claimArgs().data.activeSyncRunId, "RAW-DB-SECRET", "RAW-CLEANUP-SECRET"]) expect(serialized).not.toContain(secret);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  dbMock.$queryRaw.mockResolvedValue([]);
  dbMock.$transaction.mockImplementation((callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock));
  dbMock.account.findUnique.mockResolvedValue(a); dbMock.account.findFirst.mockResolvedValue(a);
  dbMock.account.updateMany.mockResolvedValue({ count: 1 }); dbMock.account.count.mockResolvedValue(1);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SYNC-007 one claim observer with original settlement retained", () => {
  it("pre-generates full execution identity, keeps claim predicate, and observes the original native transaction exactly once", async () => {
    const observer = vi.spyOn(database, "observeDatabase");
    const execution = await claimSyncExecution(a);
    expect(execution).toEqual({ accountId: a.id, userId: a.userId, originalAccessToken: a.accessToken, generation: a.syncGeneration, runId: expect.any(String), scheduleVersion: 1 });
    expect(claimArgs()).toEqual({ where: { id: a.id, userId: a.userId, accessToken: a.accessToken, syncGeneration: a.syncGeneration, activeSyncRunId: null, latestDeltaToken: a.latestDeltaToken, syncScheduleVersion: 0, syncScheduleState: "scheduled", syncNextRunAt: { lte: new Date(0) } }, data: { activeSyncRunId: execution.runId, syncScheduleState: "running", syncNextRunAt: null, activeSyncLeaseExpiresAt: new Date(300_000), syncScheduleVersion: { increment: 1 } } });
    expect(observer).toHaveBeenCalledExactlyOnceWith(dbMock.$transaction.mock.results[0]!.value, 8000);
    expect(dbMock.$transaction.mock.calls[0]![1]).toEqual({ maxWait: 2000, timeout: 5000 });
    expect(dbMock.$queryRaw.mock.calls[0]!.slice(1)).toEqual(["4000", "2000"]);
  });

  it("retains identity and checkpoint snapshots before native transaction submission/queueing", async () => {
    const gate = deferred<void>(); const account = { ...a };
    dbMock.$transaction.mockImplementationOnce(async (callback: (tx: typeof dbMock) => Promise<unknown>) => { await gate.promise; return callback(dbMock); });
    const claiming = claimSyncExecution(account);
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    account.userId = "CHANGED-USER"; account.accessToken = "CHANGED-TOKEN"; account.syncGeneration = 99; account.latestDeltaToken = "CHANGED-DELTA"; account.syncScheduleVersion = 99; account.syncScheduleState = "blocked";
    gate.resolve(); const execution = await claiming;
    expect(execution).toMatchObject({ accountId: a.id, userId: a.userId, originalAccessToken: a.accessToken, generation: a.syncGeneration });
    expect(claimArgs().where).toEqual({ id: a.id, userId: a.userId, accessToken: a.accessToken, syncGeneration: a.syncGeneration, activeSyncRunId: null, latestDeltaToken: a.latestDeltaToken, syncScheduleVersion: 0, syncScheduleState: "scheduled", syncNextRunAt: { lte: new Date(0) } });
  });

  for (const kind of ["initial", "incremental"]) {
    it.each([0, 1])(`${kind}: late count=%s cannot resume the run; only definitive one triggers cleanup`, async (count) => {
      const held = deferred<{ count: number }>(); dbMock.account.updateMany.mockReturnValueOnce(held.promise);
      const run = start(kind); await vi.advanceTimersByTimeAsync(20);
      await expect(run).resolves.toEqual(unknown);
      expect(dbMock.account.updateMany).toHaveBeenCalledTimes(1); expectNoOrdinaryWork();
      held.resolve({ count }); await vi.advanceTimersByTimeAsync(0);
      if (count === 1) expectExactCleanup(); else expect(dbMock.account.updateMany).toHaveBeenCalledTimes(1);
      await expect(run).resolves.toEqual(unknown); expectNoOrdinaryWork(); expectSafe(await run);
    });
  }

  it("does not lose confirmation fulfilled after expiry but before the cleanup handler is installed", async () => {
    const submitted = deferred<void>(); const native = deferred<{ count: number }>();
    dbMock.$transaction.mockImplementationOnce((callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock))
      .mockImplementationOnce((callback: (tx: typeof dbMock) => Promise<unknown>) => {
        void callback(dbMock).then(() => submitted.resolve());
        return native.promise;
      });
    const run = start(); await submitted.promise;
    vi.advanceTimersByTime(20); // Reject observation, without draining catch microtasks.
    native.resolve({ count: 1 }); // Original Promise is already fulfilled at handler installation.
    await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toEqual(unknown); expectExactCleanup(); expectNoOrdinaryWork();
  });

  it("definite timely count=0 is not-acquired, with no cleanup", async () => {
    dbMock.account.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(start()).resolves.toEqual({ status: "not-acquired", reason: "not-acquired" });
    expect(dbMock.account.updateMany).toHaveBeenCalledTimes(1); expectNoOrdinaryWork();
  });

  it.each(["cancel", "deadline"])("%s before acquisition expires cannot falsely establish durable termination", async (kind) => {
    const held = deferred<{ count: number }>(); dbMock.account.updateMany.mockReturnValueOnce(held.promise);
    const cancel = new AbortController(); const run = start("incremental", cancel.signal, kind === "deadline" ? 5 : 200);
    await vi.advanceTimersByTimeAsync(0); if (kind === "cancel") cancel.abort();
    await vi.advanceTimersByTimeAsync(20); await expect(run).resolves.toEqual(unknown);
    expect(dbMock.account.updateMany).toHaveBeenCalledTimes(1); expectNoOrdinaryWork();
    held.resolve({ count: 1 }); await vi.advanceTimersByTimeAsync(0);
    expectExactCleanup(); await expect(run).resolves.toEqual(unknown); expectNoOrdinaryWork(); expectSafe(await run);
  });

  it("timely definitive claim after cancellation uses normal revocation, without duplicate cleanup or provider work", async () => {
    const held = deferred<{ count: number }>(); dbMock.account.updateMany.mockReturnValueOnce(held.promise);
    const cancel = new AbortController(); const run = start("incremental", cancel.signal);
    await vi.advanceTimersByTimeAsync(0); cancel.abort(); held.resolve({ count: 1 });
    await expect(run).resolves.toEqual({ status: "cancelled", reason: "cancelled" });
    expectExactCleanup(); expectNoOrdinaryWork();
  });

  it.each(["before-expiry", "after-expiry"])("underlying rejection %s is uncertain, never not-acquired and never blindly cleaned", async (when) => {
    const held = deferred<{ count: number }>(); dbMock.account.updateMany.mockReturnValueOnce(held.promise);
    const run = start(); await vi.advanceTimersByTimeAsync(when === "before-expiry" ? 0 : 20);
    held.reject(new Error("RAW-DB-SECRET")); await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toEqual(unknown);
    expect(dbMock.account.updateMany).toHaveBeenCalledTimes(1); expectNoOrdinaryWork(); expectSafe(await run);
  });

  it.each(["zero", "rejection", "observation-timeout"])("late cleanup %s cannot rewrite the final indeterminate result or trigger retry", async (mode) => {
    const claim = deferred<{ count: number }>(); const cleanup = deferred<{ count: number }>();
    dbMock.account.updateMany.mockReturnValueOnce(claim.promise);
    if (mode === "zero") dbMock.account.updateMany.mockResolvedValueOnce({ count: 0 });
    else if (mode === "rejection") dbMock.account.updateMany.mockRejectedValueOnce(new Error("RAW-CLEANUP-SECRET"));
    else dbMock.account.updateMany.mockReturnValueOnce(cleanup.promise);
    const run = start(); await vi.advanceTimersByTimeAsync(20); await expect(run).resolves.toEqual(unknown);
    claim.resolve({ count: 1 }); await vi.advanceTimersByTimeAsync(mode === "observation-timeout" ? 20 : 0);
    expectExactCleanup(); expectNoOrdinaryWork();
    expect(console.error).toHaveBeenCalledWith("Late sync claim cleanup not confirmed.");
    cleanup.resolve({ count: 1 }); await vi.advanceTimersByTimeAsync(200);
    await expect(run).resolves.toEqual(unknown); expectExactCleanup(); expectSafe(await run);
  });

  it("an invalid count is uncertainty, not false definite non-acquisition", async () => {
    dbMock.account.updateMany.mockResolvedValueOnce({ count: 2 });
    await expect(start()).resolves.toEqual(unknown);
    expect(dbMock.account.updateMany).toHaveBeenCalledTimes(1); expectNoOrdinaryWork();
  });
});
