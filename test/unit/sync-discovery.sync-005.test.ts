import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@prisma/client";
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("~/server/db", () => ({ db: { account: { findMany } } }));
vi.mock("~/lib/sync-database", () => ({ withSyncDatabase: (fn: (tx: unknown) => unknown) => fn({ account: { findMany } }) }));
import { discoverSyncWork } from "~/lib/sync-orchestration";
const now = new Date(0);
beforeEach(() => { findMany.mockResolvedValue([]); });
describe("SYNC-005 bounded due/recovery discovery (not authority)", () => {
  it("prioritizes expired owners and reads at most one candidate", async () => {
    const row = { id: "synthetic" } as Account; findMany.mockResolvedValueOnce([row]);
    expect(await discoverSyncWork(now)).toEqual([row]);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({ where: { activeSyncRunId: { not: null }, activeSyncLeaseExpiresAt: { lte: now } }, orderBy: { activeSyncLeaseExpiresAt: "asc" }, take: 1 });
  });
  it("next prioritizes running/reconciling null-owner incomplete work", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "synthetic" }]);
    await discoverSyncWork(now);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1]![0]).toMatchObject({ where: { activeSyncRunId: null, syncScheduleState: { in: ["running", "reconciling"] } }, take: 1 });
  });
  it("finally reads due scheduled/retry_wait work, excluding blocked and retaining authenticated fast-path scope", async () => {
    await discoverSyncWork(now, { accountId: "A", userId: "U" });
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[2]![0]).toEqual({ where: { id: "A", userId: "U", syncScheduleState: { in: ["scheduled", "retry_wait"] }, activeSyncRunId: null, syncNextRunAt: { lte: now } }, orderBy: [{ syncNextRunAt: "asc" }, { id: "asc" }], take: 1 });
  });
});
