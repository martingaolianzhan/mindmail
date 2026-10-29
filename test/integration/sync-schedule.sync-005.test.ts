import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Prisma } from "@prisma/client";
const { http } = vi.hoisted(() => ({ http: { get: vi.fn(), post: vi.fn() } }));
vi.mock("axios", () => ({ default: http }));
import { db } from "~/server/db";
import { holdClaimAcknowledgement } from "../helpers/claim-acknowledgement";
import { applySyncOutcome, consumeSyncCandidate, discoverSyncWork, orchestrateAccountSync, reconcileSyncWork, recoverSyncSnapshot } from "~/lib/sync-orchestration";
import { claimSyncExecution, completeSyncExecution, StaleSyncExecutionError, SyncNotAcquiredError, terminateSyncExecution, type ScheduledExecution } from "~/lib/sync-execution";
import { SYNC_SCHEDULE, type SafeSyncOutcome } from "~/lib/sync-schedule-policy";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { accountRouter } from "~/server/api/routers/account";
import { syntheticEmail } from "../fixtures/emails";

const prefix = `schedule005-${crypto.randomUUID()}`; const userId = `${prefix}-user`;
const now = () => new Date();
const realTransaction = db.$transaction.bind(db);
const unknown = { status: "indeterminate-completion", reason: "completion-indeterminate" } as const;
const retry = { status: "retryable-failure", reason: "provider-transient" } as const;
async function fixture(data: Partial<Prisma.AccountUncheckedCreateInput> = {}) {
  const id = `${prefix}-${crypto.randomUUID()}`;
  return db.account.create({ data: { id, userId, accessToken: `${id}-TOKEN-SECRET`, emailAddress: `${id}@example.test`, name: "Synthetic", latestDeltaToken: "D20", syncScheduleState: "scheduled", syncNextRunAt: new Date(Date.now() - 1), ...data } });
}
const reread = (a: Account) => db.account.findUniqueOrThrow({ where: { id: a.id } });
const identity = (a: Account) => ({ accountId: a.id, userId: a.userId });
async function acquire(a: Account): Promise<ScheduledExecution> {
  if (a.syncScheduleState !== "scheduled" && a.syncScheduleState !== "retry_wait") throw new Error("Invalid test candidate");
  return await claimSyncExecution(a, undefined, { generation: a.syncGeneration, version: a.syncScheduleVersion, state: a.syncScheduleState, checkpoint: a.latestDeltaToken });
}
async function due(a: Account) {
  // Test-only clock advancement expressed durably; production never forces due.
  await db.account.update({ where: { id: a.id }, data: { syncNextRunAt: new Date(Date.now() - 1) } });
  return reread(a);
}
async function noOwner(a: Account, count = 0, checkpoint: string | null = "D20") {
  return db.account.update({ where: { id: a.id }, data: { syncScheduleState: "running", activeSyncRunId: null, syncNextRunAt: null, syncRetryCount: count, latestDeltaToken: checkpoint } });
}
beforeAll(async () => {
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
beforeEach(() => {
  http.get.mockReset().mockResolvedValue({ data: { records: [], nextDeltaToken: "D21" } });
  http.post.mockReset().mockResolvedValue({ data: { ready: true, syncUpdatedToken: "S0" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.$transaction = realTransaction; });
afterAll(async () => {
  await db.emailAttachment.deleteMany({ where: { Email: { thread: { account: { userId } } } } });
  await db.email.deleteMany({ where: { thread: { account: { userId } } } });
  await db.thread.deleteMany({ where: { account: { userId } } });
  await db.emailAddress.deleteMany({ where: { account: { userId } } });
  await db.account.deleteMany({ where: { userId } }); await db.user.delete({ where: { id: userId } }); await db.$disconnect();
});

describe("SYNC-005 real PostgreSQL scheduling opportunities", () => {
  it("claim atomically consumes V into owner/running/lease/V+1, then success creates V+2/+5m", async () => {
    const a = await fixture(); const before = now(); const execution = await acquire(a);
    expect(execution.scheduleVersion).toBe(a.syncScheduleVersion + 1);
    const running = await reread(a);
    expect(running).toMatchObject({ syncScheduleVersion: execution.scheduleVersion, syncScheduleState: "running", syncNextRunAt: null, activeSyncRunId: execution.runId });
    expect(running.activeSyncLeaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 300_000);
    await completeSyncExecution(execution, "D21");
    expect((await reread(a)).activeSyncLeaseExpiresAt).toBeNull();
    expect(await applySyncOutcome(a, execution, { status: "completed" }, before)).toBe(1);
    expect(await reread(a)).toMatchObject({ syncScheduleState: "scheduled", syncScheduleVersion: a.syncScheduleVersion + 2, syncRetryCount: 0, syncNextRunAt: new Date(before.getTime() + 300_000), latestDeltaToken: "D21" });
  });

  it.each<SafeSyncOutcome>([{ status: "completed" }, retry, { status: "safety-limit", reason: "page-limit" }])("stale due discovery cannot bypass $status's next schedule/backoff/blocked", async (outcome) => {
    const a = await fixture();
    const [snapshotA] = await discoverSyncWork(now(), identity(a)); const [snapshotB] = await discoverSyncWork(now(), identity(a));
    const r1 = await acquire(snapshotA!); await completeSyncExecution(r1, "D20"); // unchanged checkpoint: scheduling predicates must reject B
    expect(await applySyncOutcome(a, r1, outcome)).toBe(1);
    const newer = await reread(a);
    await expect(acquire(snapshotB!)).rejects.toBeInstanceOf(SyncNotAcquiredError);
    await expect(consumeSyncCandidate(snapshotB!)).resolves.toEqual({ status: "not-acquired", reason: "not-acquired" });
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
    expect(await reread(a)).toEqual(newer);
  });

  it.each(["future", "blocked"])("atomic eligibility rechecks %s even with unchanged generation/version/checkpoint", async (kind) => {
    const a = await fixture();
    await db.account.update({ where: { id: a.id }, data: kind === "future" ? { syncNextRunAt: new Date(Date.now() + 300_000) } : { syncScheduleState: "blocked", syncNextRunAt: null } });
    const newer = await reread(a);
    await expect(acquire(a)).rejects.toBeInstanceOf(SyncNotAcquiredError);
    await consumeSyncCandidate(a);
    expect(await reread(a)).toEqual(newer); expect(http.get).not.toHaveBeenCalled();
  });

  it.each<SafeSyncOutcome>([{ status: "completed" }, retry])("same-generation delayed R1 $status cannot overwrite completed R2", async (outcome) => {
    const a = await fixture(); const r1 = await acquire(a); await terminateSyncExecution(r1);
    const incomplete = await reread(a);
    expect(await recoverSyncSnapshot(incomplete)).toBe(1);
    const replacement = await due(a); const r2 = await acquire(replacement); await completeSyncExecution(r2, "D22");
    expect(await applySyncOutcome(replacement, r2, { status: "completed" })).toBe(1);
    const newer = await reread(a);
    expect(await applySyncOutcome(a, r1, outcome)).toBe(0);
    expect(await reread(a)).toEqual(newer);
    expect(newer.syncGeneration).toBe(a.syncGeneration);
  });

  it.each<SafeSyncOutcome>([{ status: "completed" }, retry])("G1 delayed $status cannot overwrite G2", async (outcome) => {
    const a = await fixture(); const r1 = await acquire(a); await terminateSyncExecution(r1);
    const { newGenerationSchedule } = await import("~/lib/sync-schedule-policy");
    await db.account.updateMany({ where: { id: a.id, userId }, data: { accessToken: `${a.accessToken}-T2`, syncGeneration: { increment: 1 }, activeSyncRunId: null, latestDeltaToken: null, ...newGenerationSchedule() } });
    const newer = await reread(a);
    expect(await applySyncOutcome(a, r1, outcome)).toBe(0); expect(await reconcileSyncWork(a, now(), true)).toBe(0);
    expect(await reread(a)).toEqual(newer);
  });

  it("not-acquired observes the winner's incomplete release without charging recovery", async () => {
    const a = await fixture(); const r1 = await acquire(a); await completeSyncExecution(r1, "D21");
    const incomplete = await reread(a);
    expect(await consumeSyncCandidate(a)).toEqual({ status: "not-acquired", reason: "not-acquired" });
    expect(await reread(a)).toEqual(incomplete);
    expect(incomplete.syncRetryCount).toBe(0); expect(http.get).not.toHaveBeenCalled();
  });

  it("concurrent consumers allow exactly one provider run without a scheduler mutex", async () => {
    const a = await fixture();
    const results = await Promise.all([consumeSyncCandidate(a), consumeSyncCandidate(a)]);
    expect(results.filter((x) => x?.status === "completed")).toHaveLength(1);
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(await reread(a)).toMatchObject({ syncScheduleState: "scheduled", latestDeltaToken: "D21", syncRetryCount: 0, syncScheduleVersion: 2 });
  });

  it("persisted retry survives a new consumer; D20 is reused, real persistence converges and success resets recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = await fixture(); http.get.mockRejectedValueOnce({ code: "ECONNRESET" });
    expect(await consumeSyncCandidate(a, { limits: { maxAttempts: 1 } })).toEqual(retry);
    const waiting = await reread(a);
    expect(waiting).toMatchObject({ latestDeltaToken: "D20", syncRetryCount: 1, syncScheduleState: "retry_wait", syncScheduleVersion: 2 });
    expect(waiting.syncNextRunAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + 59_000);
    expect(await discoverSyncWork(now(), identity(a))).toEqual([]);
    const message = { ...syntheticEmail, id: `${a.id}-email`, threadId: `${a.id}-thread`, attachments: [], hasAttachments: false, nativeProperties: {} as never };
    http.get.mockResolvedValue({ data: { records: [message], nextDeltaToken: "D22" } });
    await vi.advanceTimersByTimeAsync(60_000);
    // New invocation has no old run/timer/object. The persisted due time is unchanged.
    expect(await orchestrateAccountSync(identity(a))).toEqual({ status: "completed" });
    expect(http.get.mock.calls[1]![1]).toMatchObject({ params: { deltaToken: "D20" } });
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D22", syncRetryCount: 0, syncScheduleState: "scheduled", syncLastOutcomeStatus: "completed", syncLastOutcomeReason: null });
    expect(await db.email.count({ where: { threadId: message.threadId } })).toBe(1);
    const calls = http.get.mock.calls.length;
    await orchestrateAccountSync(identity(a)); expect(http.get).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(300_000); await orchestrateAccountSync(identity(a));
    expect(await db.email.count({ where: { threadId: message.threadId } })).toBe(1);
  });

  it.each([null, "D20"])("duplicate running/null reconcilers consume one incident with checkpoint %s", async (checkpoint) => {
    const a = await noOwner(await fixture(), 2, checkpoint);
    expect((await Promise.all([recoverSyncSnapshot(a), recoverSyncSnapshot(a)])).sort()).toEqual([0, 1]);
    const next = await reread(a);
    expect(next).toMatchObject({ syncRetryCount: 3, syncScheduleVersion: a.syncScheduleVersion + 1, syncScheduleState: "retry_wait", latestDeltaToken: checkpoint });
    expect(next.syncNextRunAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + 899_000);
    await due(a); await orchestrateAccountSync(identity(a));
    expect(http.post).toHaveBeenCalledTimes(checkpoint === null ? 1 : 0);
    expect(http.get.mock.calls[0]![1]).toMatchObject({ params: { deltaToken: checkpoint === null ? "S0" : "D20" } });
  });

  it("separate running/null crash incidents exhaust one shared budget and blocked survives restart", async () => {
    const a = await noOwner(await fixture());
    for (let count = 1; count <= 4; count++) {
      const incident = await reread(a); expect(await recoverSyncSnapshot(incident)).toBe(1);
      const replacement = await reread(a);
      expect(replacement.syncRetryCount).toBe(count);
      expect(replacement.syncNextRunAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + SYNC_SCHEDULE.retryDelaysMs[count - 1]! - 1000);
      const execution = await acquire(await due(a)); await terminateSyncExecution(execution);
    }
    expect(await recoverSyncSnapshot(await reread(a))).toBe(1);
    const blocked = await reread(a);
    expect(blocked).toMatchObject({ syncRetryCount: 4, syncScheduleState: "blocked", syncNextRunAt: null });
    expect(await discoverSyncWork(new Date(Date.now() + 99_000_000), identity(a))).toEqual([]);
    await orchestrateAccountSync(identity(a));
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled(); expect(await reread(a)).toEqual(blocked);
  });

  it.each([0, 4])("expired exact owner recovers/blocks at count %s and late R1 stays fenced", async (count) => {
    const a = await fixture({ syncRetryCount: count }); const r1 = await acquire(a);
    await db.account.update({ where: { id: a.id }, data: { activeSyncLeaseExpiresAt: new Date(Date.now() - 1) } });
    const expired = await reread(a);
    expect((await Promise.all([recoverSyncSnapshot(expired), recoverSyncSnapshot(expired)])).sort()).toEqual([0, 1]);
    expect(await reread(a)).toMatchObject({ activeSyncRunId: null, activeSyncLeaseExpiresAt: null, latestDeltaToken: "D20", syncRetryCount: count === 4 ? 4 : 1, syncScheduleState: count === 4 ? "blocked" : "retry_wait" });
    await expect(completeSyncExecution(r1, "STALE")).rejects.toBeInstanceOf(StaleSyncExecutionError);
    await expect(syncEmailsToDatabase([], r1)).rejects.toThrow("Failed to sync emails to database.");
    expect(await applySyncOutcome(a, r1, retry)).toBe(0);
  });

  it("a valid lease is not reclaimed, modified, or charged by reconciliation", async () => {
    const a = await fixture(); await acquire(a); const running = await reread(a);
    expect(await reconcileSyncWork(a, now(), true)).toBe(0);
    expect(await recoverSyncSnapshot(running)).toBe(0);
    await consumeSyncCandidate(running);
    expect(await discoverSyncWork(now(), identity(a))).toEqual([]);
    expect(await reread(a)).toEqual(running); expect(http.get).not.toHaveBeenCalled();
  });

  it("recovery invalidates a delayed old success before any replacement runs", async () => {
    const a = await fixture(); const r1 = await acquire(a); await completeSyncExecution(r1, "D21");
    expect(await reconcileSyncWork(a)).toBe(1);
    const recovered = await reread(a);
    expect(await applySyncOutcome(a, r1, { status: "completed" })).toBe(0);
    expect(await reread(a)).toEqual(recovered); expect(recovered.syncRetryCount).toBe(1);
  });

  it.each([2, 4])("indeterminate owner-null two-consumer reconciliation charges once at count %s", async (count) => {
    const a = await fixture({ syncRetryCount: count }); const r1 = await acquire(a); await terminateSyncExecution(r1);
    expect((await Promise.all([reconcileSyncWork(a), reconcileSyncWork(a)])).sort()).toEqual([0, 1]);
    expect(await reread(a)).toMatchObject({ syncRetryCount: count === 4 ? 4 : 3, syncScheduleState: count === 4 ? "blocked" : "retry_wait", syncScheduleVersion: 2 });
  });

  it("current-generation reinitialization-required replaces null-checkpoint work using the same budget", async () => {
    const a = await fixture({ latestDeltaToken: null, syncRetryCount: 2 }); const r1 = await acquire(a); await terminateSyncExecution(r1);
    expect(await applySyncOutcome(a, r1, { status: "action-required", reason: "reinitialization-required" })).toBe(1);
    expect(await reread(a)).toMatchObject({ syncRetryCount: 3, latestDeltaToken: null, syncScheduleState: "retry_wait" });
    await due(a); await orchestrateAccountSync(identity(a)); expect(http.post).toHaveBeenCalledOnce();
  });

  it("status selection is user/account scoped and exposes no authority, mail, or credentials", async () => {
    const a = await fixture({ syncScheduleState: "blocked", syncNextRunAt: null, syncRetryCount: 4, syncLastOutcomeStatus: "retryable-failure", syncLastOutcomeReason: "provider-transient" });
    const caller = (owner: string) => accountRouter.createCaller({ auth: { userId: owner }, db, headers: new Headers() } as never);
    const status = await caller(userId).getSyncStatus({ accountId: a.id });
    expect(Object.keys(status).sort()).toEqual(["syncLastOutcomeReason", "syncLastOutcomeStatus", "syncNextRunAt", "syncRetryCount", "syncScheduleState"]);
    expect(status).toMatchObject({ syncScheduleState: "blocked", syncRetryCount: 4 });
    expect(JSON.stringify(status)).not.toMatch(/TOKEN-SECRET|D20|scheduleVersion|runId/);
    await expect(caller("other-user").getSyncStatus({ accountId: a.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("SYNC-005 uncertain claim uses durable state, never attempted run identity", () => {
  it("committed claim with held acknowledgement waits for valid lease, then exact late cleanup/recovery converges", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = await fixture(); const held = holdClaimAcknowledgement();
    const run = consumeSyncCandidate(a, { limits: { dbObservationMs: 200, deadlineMs: 1000 } });
    await held.entered;
    try {
      await vi.advanceTimersByTimeAsync(200); expect(await run).toEqual(unknown);
      const running = await reread(a);
      expect(running).toMatchObject({ syncScheduleVersion: 1, syncScheduleState: "running", syncRetryCount: 0, activeSyncRunId: expect.any(String) });
      await consumeSyncCandidate(a); expect(await reread(a)).toEqual(running);
      expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
    } finally { held.release(); }
    expect((await held.settled).count).toBe(1); await held.cleanup;
    expect(await reread(a)).toMatchObject({ activeSyncRunId: null, activeSyncLeaseExpiresAt: null, syncScheduleState: "running", syncScheduleVersion: 1 });
    expect(await reconcileSyncWork(a)).toBe(1);
    const newer = await reread(a);
    expect(newer).toMatchObject({ syncRetryCount: 1, syncScheduleState: "retry_wait", syncScheduleVersion: 2 });
    expect(await reconcileSyncWork(a, now(), true)).toBe(0);
    expect(await reread(a)).toEqual(newer);
    await vi.advanceTimersByTimeAsync(60_000); await orchestrateAccountSync(identity(a));
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D21", syncRetryCount: 0, syncScheduleState: "scheduled" });
    expect(http.get).toHaveBeenCalledOnce();
    expect(JSON.stringify({ result: await run, logs: vi.mocked(console.error).mock.calls })).not.toContain("TOKEN-SECRET");
  });

  it("late acknowledgement cleanup cannot overwrite newer same-generation recovery/R2 state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = await fixture(); const held = holdClaimAcknowledgement();
    const run = consumeSyncCandidate(a, { limits: { dbObservationMs: 200, deadlineMs: 1000 } });
    await held.entered;
    let newer!: Account;
    try {
      await vi.advanceTimersByTimeAsync(200); expect(await run).toEqual(unknown);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(await reconcileSyncWork(a)).toBe(1);
      expect((await reread(a)).syncRetryCount).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000); await orchestrateAccountSync(identity(a));
      newer = await reread(a);
      expect(newer).toMatchObject({ syncScheduleState: "scheduled", syncRetryCount: 0, syncScheduleVersion: 4, latestDeltaToken: "D21" });
    } finally { held.release(); }
    await held.settled;
    expect((await held.cleanup).count).toBe(0);
    expect(await reread(a)).toEqual(newer);
    expect(await reconcileSyncWork(a, now(), true)).toBe(0);
    expect(http.get).toHaveBeenCalledOnce();
  });

  it("reconciliation supersedes V before delayed original UPDATE: stale claim updates zero and never resurrects", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = await fixture(); const held = holdClaimAcknowledgement(false, "before-update");
    const run = consumeSyncCandidate(a, { limits: { dbObservationMs: 200, deadlineMs: 1000 } });
    await held.entered;
    try {
      await vi.advanceTimersByTimeAsync(200); expect(await run).toEqual(unknown);
      expect(await reread(a)).toMatchObject({ activeSyncRunId: null, syncRetryCount: 1, syncScheduleVersion: 1, syncScheduleState: "retry_wait" });
    } finally { held.release(); }
    expect((await held.settled).count).toBe(0);
    expect(await reconcileSyncWork(a, now(), true)).toBe(0);
    expect(await reread(a)).toMatchObject({ activeSyncRunId: null, syncRetryCount: 1, syncScheduleVersion: 1, syncScheduleState: "retry_wait" });
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
  });
});
