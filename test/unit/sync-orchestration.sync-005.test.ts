import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@prisma/client";
import type { executeSync as ExecuteSync } from "~/lib/sync-run";
import type { ScheduledExecution } from "~/lib/sync-execution";
const { execute, findFirst, updateMany } = vi.hoisted(() => ({ execute: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() }));
vi.mock("~/lib/sync-run", () => ({ executeSync: execute }));
vi.mock("~/lib/account", () => ({ Account: vi.fn() }));
vi.mock("~/lib/sync-database", () => ({ withSyncDatabase: (fn: (tx: unknown) => unknown) => fn({ account: { findFirst, updateMany } }) }));
import { consumeSyncCandidate } from "~/lib/sync-orchestration";

const a = { id: "A", userId: "U", accessToken: "TOKEN-SECRET", syncGeneration: 1, latestDeltaToken: "DELTA-SECRET", activeSyncRunId: null, activeSyncLeaseExpiresAt: null, syncScheduleState: "scheduled", syncNextRunAt: new Date(0), syncScheduleVersion: 10, syncRetryCount: 0 } as Account;
const execution: ScheduledExecution = { accountId: a.id, userId: a.userId, originalAccessToken: a.accessToken, generation: a.syncGeneration, runId: "RUN-SECRET", scheduleVersion: 11 };
const unknown = { status: "indeterminate-completion", reason: "completion-indeterminate" };
function confirmed(outcome: object) {
  execute.mockImplementation(async (...args: Parameters<typeof ExecuteSync>) => { args[4]!.acquired(execution); return outcome; });
}
beforeEach(() => { updateMany.mockResolvedValue({ count: 1 }); });
describe("SYNC-005 trusted acquisition identity and safe outcome handling", () => {
  it("definite acquisition conveys V+1 internally, not through the safe returned result", async () => {
    confirmed({ status: "completed", latestDeltaToken: "NEW-DELTA-SECRET", emails: [{ body: "MAIL-SECRET" }] });
    expect(await consumeSyncCandidate(a)).toEqual({ status: "completed" });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "A", userId: "U", accessToken: a.accessToken, syncGeneration: 1, syncScheduleVersion: 11, syncScheduleState: "running", activeSyncRunId: null, syncRetryCount: 0 }, data: expect.objectContaining({ syncScheduleVersion: { increment: 1 }, syncRetryCount: 0 }) }));
  });
  it("unknown claim never gains assumed authority; durable valid owner means wait/no charge", async () => {
    execute.mockResolvedValue(unknown);
    findFirst.mockResolvedValue({ ...a, syncScheduleVersion: 11, syncScheduleState: "running", syncNextRunAt: null, activeSyncRunId: "DURABLE-OWNER", activeSyncLeaseExpiresAt: new Date(Date.now() + 300_000) });
    expect(await consumeSyncCandidate(a)).toEqual(unknown);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "A", userId: "U", syncGeneration: 1 } });
    expect(updateMany).not.toHaveBeenCalled();
  });
  it("unknown claim with still-due original opportunity supersedes only its durable snapshot", async () => {
    execute.mockResolvedValue(unknown); findFirst.mockResolvedValue(a);
    await consumeSyncCandidate(a);
    expect(updateMany).toHaveBeenCalledOnce();
    const args = updateMany.mock.calls[0]![0] as { where: object; data: object };
    expect(args.where).toMatchObject({ syncScheduleVersion: 10, activeSyncRunId: null, syncScheduleState: "scheduled", syncRetryCount: 0 });
    expect(args.data).toMatchObject({ syncRetryCount: 1, syncScheduleState: "retry_wait", syncScheduleVersion: { increment: 1 }, syncLastOutcomeReason: "incomplete-orchestration" });
    expect(JSON.stringify(args)).not.toContain(execution.runId);
  });
  it("not-acquired only rereads; it cannot charge an observed winner's release window", async () => {
    execute.mockResolvedValue({ status: "not-acquired", reason: "not-acquired" });
    findFirst.mockResolvedValue({ ...a, syncScheduleVersion: 11, syncScheduleState: "running", syncNextRunAt: null });
    await consumeSyncCandidate(a); expect(findFirst).toHaveBeenCalledOnce(); expect(updateMany).not.toHaveBeenCalled();
  });
  it("ownership-lost cannot schedule from stale acquired work", async () => {
    confirmed({ status: "ownership-lost", reason: "ownership-lost" });
    await consumeSyncCandidate(a); expect(updateMany).not.toHaveBeenCalled();
  });
  it.each([null, "current-checkpoint"])("reinitialization rereads the current checkpoint %s before any replacement", async (checkpoint) => {
    confirmed({ status: "action-required", reason: "reinitialization-required" });
    findFirst.mockResolvedValue({ ...a, latestDeltaToken: checkpoint, syncScheduleVersion: 11, syncScheduleState: "running" });
    await consumeSyncCandidate(a); expect(findFirst).toHaveBeenCalledOnce();
    if (checkpoint === null) expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ latestDeltaToken: null, syncScheduleVersion: 11 }), data: expect.objectContaining({ syncRetryCount: 1, syncScheduleState: "retry_wait" }) }));
    else expect(updateMany).not.toHaveBeenCalled();
  });
});
