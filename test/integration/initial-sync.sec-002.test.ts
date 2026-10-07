import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { AccountMock, performInitialSyncMock, syncEmailsToDatabaseMock } = vi.hoisted(() => {
  const performInitialSync = vi.fn();
  return {
    AccountMock: vi.fn(() => ({ performInitialSync })),
    performInitialSyncMock: performInitialSync,
    syncEmailsToDatabaseMock: vi.fn(),
  };
});

vi.mock("~/lib/account", () => ({ Account: AccountMock }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: syncEmailsToDatabaseMock }));

import { performInitialSync } from "~/lib/initial-sync";
import { db } from "~/server/db";

const prefix = `sec002-${crypto.randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const a1 = `${prefix}-a1`;
const b1 = `${prefix}-b1`;

beforeAll(async () => {
  await db.user.createMany({ data: [alice, bob].map((id) => ({
    id,
    emailAddress: `${id}@example.test`,
    firstName: "Synthetic",
    lastName: "User",
  })) });
  await db.account.createMany({ data: [
    { id: a1, userId: alice, name: "A1", emailAddress: "a1@example.test", accessToken: `${prefix}-token-a1` },
    { id: b1, userId: bob, name: "B1", emailAddress: "b1@example.test", accessToken: `${prefix}-token-b1` },
  ] });
});

beforeEach(() => {
  vi.clearAllMocks();
  performInitialSyncMock.mockResolvedValue({ emails: [], latestDeltaToken: `${prefix}-delta` });
  syncEmailsToDatabaseMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await db.account.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.$disconnect();
});

describe("SEC-002 trusted initial-sync service ownership", () => {
  it("allows the account owner to reach the mocked provider and persistence boundary", async () => {
    await expect(performInitialSync({ accountId: a1, userId: alice })).resolves.toBe("completed");

    expect(AccountMock).toHaveBeenCalledWith(`${prefix}-token-a1`);
    expect(performInitialSyncMock).toHaveBeenCalledOnce();
    expect(syncEmailsToDatabaseMock).toHaveBeenCalledWith([], a1);
    expect(await db.account.findUnique({ where: { id: a1 } })).toMatchObject({ latestDeltaToken: `${prefix}-delta` });
  });

  it("rejects Alice synchronising Bob's account before provider or persistence work", async () => {
    await expect(performInitialSync({ accountId: b1, userId: alice })).resolves.toBe("account-not-found");

    expect(AccountMock).not.toHaveBeenCalled();
    expect(performInitialSyncMock).not.toHaveBeenCalled();
    expect(syncEmailsToDatabaseMock).not.toHaveBeenCalled();
    expect(await db.account.findUnique({ where: { id: b1 } })).toMatchObject({ latestDeltaToken: null });
  });

  it("rejects a non-existent account before provider or persistence work", async () => {
    await expect(performInitialSync({ accountId: `${prefix}-missing`, userId: alice })).resolves.toBe("account-not-found");

    expect(AccountMock).not.toHaveBeenCalled();
    expect(performInitialSyncMock).not.toHaveBeenCalled();
    expect(syncEmailsToDatabaseMock).not.toHaveBeenCalled();
  });
});
