import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "~/type";
import { execution } from "../fixtures/sync-execution";
import type * as SyncExecutionModule from "~/lib/sync-execution";
vi.mock("~/lib/sync-execution", async (original) => ({
  ...await original<typeof SyncExecutionModule>(),
  claimSyncExecution: vi.fn(async () => execution), releaseSyncExecution: vi.fn(),
  ownsSyncExecution: vi.fn(async () => true), terminateSyncExecution: vi.fn(async () => true),
}));

const { provider, persist, findFirst, updateMany } = vi.hoisted(() => ({
  provider: vi.fn(), persist: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(),
}));
vi.mock("~/lib/account", () => ({ Account: vi.fn(() => ({ performInitialSync: provider })) }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: persist }));
vi.mock("~/server/db", () => ({ db: { account: { findFirst, updateMany } } }));
vi.mock("~/lib/sync-database", async (original) => ({ ...await original<object>(), ...await import("../mocks/sync-database") }));

import { performInitialSync } from "~/lib/initial-sync";

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ id: "A1", userId: "U1", accessToken: "synthetic-token" });
  provider.mockResolvedValue({ emails: [{ id: "E1" } as EmailMessage], latestDeltaToken: "D1" });
  persist.mockResolvedValue(undefined);
  updateMany.mockResolvedValue({ count: 1 });
});

const run = () => performInitialSync({ accountId: "A1", userId: "U1" });

describe("SYNC-003 initial-sync service", () => {
  it("returns existing provider failure without persisting or committing", async () => {
    provider.mockResolvedValue(undefined);
    await expect(run()).resolves.toMatchObject({ status: "internal-failure" });
    expect(persist).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects persistence failure before beginning a checkpoint write", async () => {
    persist.mockRejectedValue(new Error("synthetic persistence failure"));
    await expect(run()).resolves.toEqual({ status: "internal-failure", reason: "persistence-failure" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("commits only after persistence and requires an authorised exactly-one-row result", async () => {
    await expect(run()).resolves.toEqual({ status: "completed" });
    expect(persist).toHaveBeenCalledWith([{ id: "E1" }], execution, expect.anything());
    expect(updateMany).toHaveBeenCalledWith({ where: { id: execution.accountId, userId: execution.userId, accessToken: execution.originalAccessToken, syncGeneration: 0, activeSyncRunId: execution.runId }, data: { latestDeltaToken: "D1", activeSyncRunId: null, activeSyncLeaseExpiresAt: null } });
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(updateMany.mock.invocationCallOrder[0]!);
  });

  it("never reports completion on zero-row, uncertain, or invalid checkpoint results", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(run()).resolves.toMatchObject({ status: "ownership-lost" });
    updateMany.mockRejectedValueOnce(new Error("synthetic lost acknowledgement"));
    await expect(run()).resolves.toMatchObject({ status: "internal-failure" });
    updateMany.mockResolvedValueOnce({ count: 2 });
    await expect(run()).resolves.toMatchObject({ status: "ownership-lost" });
  });
});
