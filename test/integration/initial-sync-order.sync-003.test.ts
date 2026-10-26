import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "~/type";

const { provider } = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("~/lib/account", () => ({ Account: vi.fn(() => ({ performInitialSync: provider })) }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: vi.fn() }));

import { performInitialSync } from "~/lib/initial-sync";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { db } from "~/server/db";
import { interceptCheckpoints } from "../helpers/transactions";

const prefix = `sync003-order-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;
const realUpdateMany = db.account.updateMany.bind(db.account);
const input = (accountId: string) => ({ accountId, userId });

async function createAccount(suffix: string, latestDeltaToken: string | null) {
  const id = `${prefix}-${suffix}`;
  await db.account.create({ data: {
    id, userId, accessToken: `${id}-token`, name: suffix,
    emailAddress: `${suffix}@example.test`, latestDeltaToken,
  } });
  return id;
}
async function token(id: string) {
  return (await db.account.findUniqueOrThrow({ where: { id } })).latestDeltaToken;
}

beforeAll(async () => {
  await db.$connect();
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
afterEach(() => {
  vi.restoreAllMocks();
  // Prisma delegates may lose methods after Vitest restoration.
  db.account.updateMany = realUpdateMany;
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("SYNC-003 confirmed-pending and rejected persistence against PostgreSQL", () => {
  it("keeps D0 while persistence is confirmed pending, then commits D1 on success", async () => {
    const id = await createAccount("pending", "D0");
    const emails = [{ id: "synthetic" }] as EmailMessage[];
    provider.mockResolvedValue({ emails, latestDeltaToken: "D1" });
    let started!: () => void;
    let resolve!: () => void;
    const invoked = new Promise<void>((r) => { started = r; });
    const pending = new Promise<void>((r) => { resolve = r; });
    vi.mocked(syncEmailsToDatabase).mockImplementationOnce(() => { started(); return pending; });
    const write = interceptCheckpoints();

    const run = performInitialSync(input(id));
    await invoked;
    expect(syncEmailsToDatabase).toHaveBeenCalledWith(emails, expect.objectContaining({ accountId: id, userId, generation: 0 }), expect.anything());
    expect(write).not.toHaveBeenCalled();
    expect(await token(id)).toBe("D0");
    resolve();
    await expect(run).resolves.toEqual({ status: "completed" });
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({ where: { id, userId, accessToken: `${id}-token`, syncGeneration: 0, activeSyncRunId: expect.any(String) }, data: { latestDeltaToken: "D1", activeSyncRunId: null } });
    expect(await token(id)).toBe("D1");
  });

  it.each([
    ["new-account", null],
    ["existing-checkpoint", "D0"],
  ])("retains %s prior checkpoint on persistence failure", async (suffix, previous) => {
    const id = await createAccount(suffix, previous);
    provider.mockResolvedValue({ emails: [], latestDeltaToken: "D1" });
    vi.mocked(syncEmailsToDatabase).mockRejectedValueOnce(new Error("synthetic persistence failure"));
    const write = interceptCheckpoints();

    await expect(performInitialSync(input(id))).resolves.toEqual({ status: "internal-failure", reason: "persistence-failure" });
    expect(write).not.toHaveBeenCalled();
    expect(await token(id)).toBe(previous);
  });

  it("does not commit the old T1 checkpoint after a direct token replacement to T2 during persistence", async () => {
    const id = await createAccount("relink", "D0");
    const originalAccessToken = `${id}-token`;
    const replacementAccessToken = `${id}-replacement-token`;
    const emails = [{ id: "synthetic-relink-email" }] as EmailMessage[];
    provider.mockResolvedValue({ emails, latestDeltaToken: "D1" });
    let signalPersistenceStarted!: () => void;
    let releasePersistence!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => { signalPersistenceStarted = resolve; });
    const pendingPersistence = new Promise<void>((resolve) => { releasePersistence = resolve; });
    vi.mocked(syncEmailsToDatabase).mockImplementationOnce(() => {
      signalPersistenceStarted();
      return pendingPersistence;
    });
    const updateCounts: number[] = [];
    const write = interceptCheckpoints((async (args) => {
      const result = await realUpdateMany(args);
      updateCounts.push(result.count);
      return result;
    }) as typeof realUpdateMany);

    const oldRun = performInitialSync(input(id));
    await persistenceStarted;
    expect(syncEmailsToDatabase).toHaveBeenCalledWith(emails, expect.objectContaining({ accountId: id, userId, generation: 0 }), expect.anything());
    expect(write).not.toHaveBeenCalled();
    expect(await db.account.findUniqueOrThrow({ where: { id } })).toMatchObject({
      id, userId, accessToken: originalAccessToken, latestDeltaToken: "D0",
    });

    // Preserve the original SYNC-003 direct-token snapshot regression separately
    // from production relink (which also changes generation and clears checkpoint).
    expect(await db.account.updateMany({
      where: { id, userId }, data: { accessToken: replacementAccessToken },
    })).toMatchObject({ count: 1 });
    expect(await db.account.findUniqueOrThrow({ where: { id } })).toMatchObject({
      id, userId, accessToken: replacementAccessToken, latestDeltaToken: "D0",
    });

    // Ignore the relink update when observing the old run's final checkpoint write.
    updateCounts.length = 0;
    write.mockClear();
    releasePersistence();
    await expect(oldRun).resolves.toEqual({ status: "ownership-lost", reason: "ownership-lost" });
    // SYNC-007 now observes lost authority before submitting completion. Direct
    // stale completion predicates remain separately covered by SYNC-004.
    expect(write).not.toHaveBeenCalled();
    expect(updateCounts).toEqual([]);
    expect(await db.account.findUniqueOrThrow({ where: { id } })).toMatchObject({
      id, userId, accessToken: replacementAccessToken, latestDeltaToken: "D0",
    });
  });

  it("does not accept a zero-row ownership mismatch after the initial authorised read", async () => {
    const id = await createAccount("ownership", "D0");
    provider.mockResolvedValue({ emails: [], latestDeltaToken: "D1" });
    vi.mocked(syncEmailsToDatabase).mockResolvedValueOnce(undefined);
    const write = interceptCheckpoints((async (args) => {
      // Simulate ownership changing after the initial read, before the real scoped write.
      await db.account.update({ where: { id }, data: { userId: `${prefix}-other-user` } });
      return realUpdateMany(args);
    }) as typeof realUpdateMany);
    await db.user.create({ data: { id: `${prefix}-other-user`, emailAddress: "other@example.test", firstName: "Other", lastName: "Test" } });
    try {
      await expect(performInitialSync(input(id))).resolves.toEqual({ status: "ownership-lost", reason: "ownership-lost" });
      expect(write).toHaveBeenCalledWith({ where: { id, userId, accessToken: `${id}-token`, syncGeneration: 0, activeSyncRunId: expect.any(String) }, data: { latestDeltaToken: "D1", activeSyncRunId: null } });
      expect(await token(id)).toBe("D0");
    } finally {
      await db.account.update({ where: { id }, data: { userId } });
      await db.user.delete({ where: { id: `${prefix}-other-user` } });
    }
  });
});
