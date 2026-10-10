import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { exchangeMock, detailsMock, initialSyncMock, waitUntilMock } = vi.hoisted(() => ({
  exchangeMock: vi.fn(),
  detailsMock: vi.fn(),
  initialSyncMock: vi.fn(),
  waitUntilMock: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("../mocks/clerk");
  return clerkServerMock;
});
vi.mock("~/lib/aurinko", () => ({ exchangeCodeForAccessToken: exchangeMock, getAccountDetails: detailsMock }));
vi.mock("~/lib/initial-sync", () => ({ performInitialSync: initialSyncMock }));
vi.mock("@vercel/functions", () => ({ waitUntil: waitUntilMock }));

import { GET } from "~/app/api/aurinko/callback/route";
import { AURINKO_OAUTH_STATE_COOKIE, createAurinkoOAuthCorrelation } from "~/lib/aurinko-oauth-state";
import { db } from "~/server/db";
import { clerkAuthMock } from "../mocks/clerk";

const prefix = `sec005-${crypto.randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const baseAccountId = Math.floor(Date.now() / 1000) * 100 + Math.floor(Math.random() * 50);
const p1 = String(baseAccountId + 1);
const p2 = String(baseAccountId + 2);
const p3 = String(baseAccountId + 3);

function request(state: string, cookie: string) {
  return new NextRequest(`http://mindmail.test/api/aurinko/callback?status=success&code=synthetic-code&state=${state}`, {
    headers: { cookie: `${AURINKO_OAUTH_STATE_COOKIE}=${cookie}` },
  });
}

async function callbackFor(accountId: string, accessToken: string) {
  const correlation = createAurinkoOAuthCorrelation(alice);
  exchangeMock.mockResolvedValue({ accountId: Number(accountId), accessToken });
  return GET(request(correlation.state, correlation.value));
}

beforeAll(async () => {
  process.env.AURINKO_OAUTH_STATE_SECRET = "test-oauth-state-secret";
  await db.user.createMany({ data: [
    { id: alice, emailAddress: `${alice}@example.test`, firstName: "Alice", lastName: "Test" },
    { id: bob, emailAddress: `${bob}@example.test`, firstName: "Bob", lastName: "Test" },
  ] });
  await db.account.createMany({ data: [
    { id: p1, userId: alice, emailAddress: "p1@example.test", name: "P1", accessToken: `${prefix}-old-alice` },
    { id: p2, userId: bob, emailAddress: "p2@example.test", name: "P2", accessToken: `${prefix}-old-bob` },
  ] });
});

beforeEach(() => {
  vi.clearAllMocks();
  clerkAuthMock.mockResolvedValue({ userId: alice });
  detailsMock.mockResolvedValue({ email: "linked@example.test", name: "Linked" });
  initialSyncMock.mockResolvedValue("completed");
});

afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [p1, p2, p3] } } });
  await db.user.deleteMany({ where: { id: { in: [alice, bob] } } });
  await db.$disconnect();
});

describe("SEC-005 real PostgreSQL provider-account ownership", () => {
  it("creates a new provider Account owned by the initiating/current Clerk user", async () => {
    const response = await callbackFor(p3, `${prefix}-new-p3`);

    expect(response.status).toBe(307);
    expect(await db.account.findUnique({ where: { id: p3 } })).toMatchObject({ userId: alice, accessToken: `${prefix}-new-p3` });
    expect(initialSyncMock).toHaveBeenCalledWith({ accountId: p3, userId: alice });
  });

  it("relinks Alice's existing Account with an ownership-scoped final database write", async () => {
    const realUpdateMany = db.account.updateMany.bind(db.account);
    const updateSpy = vi.spyOn(db.account, "updateMany").mockImplementation(realUpdateMany);

    const response = await callbackFor(p1, `${prefix}-new-p1`);

    expect(response.status).toBe(307);
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: p1, userId: alice },
      data: { accessToken: `${prefix}-new-p1` },
    });
    expect(await db.account.findUnique({ where: { id: p1 } })).toMatchObject({ userId: alice, accessToken: `${prefix}-new-p1` });
    expect(initialSyncMock).toHaveBeenCalledWith({ accountId: p1, userId: alice });
  });

  it("does not modify or sync Bob's existing provider Account", async () => {
    const response = await callbackFor(p2, `${prefix}-attempted-bob-token`);

    expect(response.status).toBe(403);
    expect(await db.account.findUnique({ where: { id: p2 } })).toMatchObject({ userId: bob, accessToken: `${prefix}-old-bob` });
    expect(detailsMock).not.toHaveBeenCalled();
    expect(initialSyncMock).not.toHaveBeenCalled();
  });

  it("fails closed when a unique-create race is won by another user", async () => {
    await db.account.deleteMany({ where: { id: p3 } });
    const realCreate = db.account.create.bind(db.account);
    vi.spyOn(db.account, "create").mockImplementationOnce((async () => {
      await realCreate({ data: { id: p3, userId: bob, emailAddress: "race@example.test", name: "Race", accessToken: `${prefix}-race-bob` } });
      const error = Object.assign(new Error("unique conflict"), { code: "P2002" });
      throw error;
    }) as never);

    const response = await callbackFor(p3, `${prefix}-attempted-race-token`);

    expect(response.status).toBe(403);
    expect(await db.account.findUnique({ where: { id: p3 } })).toMatchObject({ userId: bob, accessToken: `${prefix}-race-bob` });
    expect(initialSyncMock).not.toHaveBeenCalled();
  });
});
