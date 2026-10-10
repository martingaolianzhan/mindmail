import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  accountCreateMock,
  accountFindUniqueMock,
  accountUpdateManyMock,
  exchangeMock,
  detailsMock,
  initialSyncMock,
  waitUntilMock,
} = vi.hoisted(() => ({
  accountCreateMock: vi.fn(),
  accountFindUniqueMock: vi.fn(),
  accountUpdateManyMock: vi.fn(),
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
vi.mock("~/server/db", () => ({ db: { account: { create: accountCreateMock, findUnique: accountFindUniqueMock, updateMany: accountUpdateManyMock } } }));
vi.mock("~/lib/initial-sync", () => ({ performInitialSync: initialSyncMock }));
vi.mock("@vercel/functions", () => ({ waitUntil: waitUntilMock }));

import { GET } from "~/app/api/aurinko/callback/route";
import { AURINKO_OAUTH_STATE_COOKIE, createAurinkoOAuthCorrelation } from "~/lib/aurinko-oauth-state";
import { clerkAuthMock } from "../mocks/clerk";

const originalSecret = process.env.AURINKO_OAUTH_STATE_SECRET;

function request(state: string | null, cookie?: string) {
  const query = new URLSearchParams({ status: "success", code: "synthetic-code" });
  if (state !== null) query.set("state", state);
  return new NextRequest(`http://mindmail.test/api/aurinko/callback?${query}`, {
    headers: cookie ? { cookie: `${AURINKO_OAUTH_STATE_COOKIE}=${cookie}` } : undefined,
  });
}

function expectConsumedCorrelation(response: Response) {
  expect(response.headers.get("set-cookie")).toContain(`${AURINKO_OAUTH_STATE_COOKIE}=`);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
}

function expectNoProtectedWork() {
  expect(exchangeMock).not.toHaveBeenCalled();
  expect(detailsMock).not.toHaveBeenCalled();
  expect(accountFindUniqueMock).not.toHaveBeenCalled();
  expect(accountCreateMock).not.toHaveBeenCalled();
  expect(accountUpdateManyMock).not.toHaveBeenCalled();
  expect(initialSyncMock).not.toHaveBeenCalled();
  expect(waitUntilMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  process.env.AURINKO_OAUTH_STATE_SECRET = "test-oauth-state-secret";
  clerkAuthMock.mockResolvedValue({ userId: "alice" });
  exchangeMock.mockResolvedValue({ accountId: 41, accessToken: "synthetic-new-token" });
  detailsMock.mockResolvedValue({ email: "alice@example.test", name: "Alice" });
  accountFindUniqueMock.mockResolvedValue({ id: "41", userId: "alice" });
  accountUpdateManyMock.mockResolvedValue({ count: 1 });
  initialSyncMock.mockResolvedValue("completed");
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AURINKO_OAUTH_STATE_SECRET;
  else process.env.AURINKO_OAUTH_STATE_SECRET = originalSecret;
});

describe("SEC-005 callback state validation", () => {
  it.each([
    ["missing state", null, (correlation: ReturnType<typeof createAurinkoOAuthCorrelation>) => correlation.value, "alice"],
    ["missing correlation", (correlation: ReturnType<typeof createAurinkoOAuthCorrelation>) => correlation.state, () => undefined, "alice"],
    ["mismatched state", () => "wrong-state", (correlation: ReturnType<typeof createAurinkoOAuthCorrelation>) => correlation.value, "alice"],
    ["tampered correlation", (correlation: ReturnType<typeof createAurinkoOAuthCorrelation>) => correlation.state, (correlation: ReturnType<typeof createAurinkoOAuthCorrelation>) => `${correlation.value}x`, "alice"],
    ["cross-user Clerk session", (correlation: ReturnType<typeof createAurinkoOAuthCorrelation>) => correlation.state, (correlation: ReturnType<typeof createAurinkoOAuthCorrelation>) => correlation.value, "bob"],
  ])("rejects %s before any provider, write, or sync work", async (_name, stateValue, cookieValue, callbackUser) => {
    const correlation = createAurinkoOAuthCorrelation("alice");
    clerkAuthMock.mockResolvedValue({ userId: callbackUser });
    const state = typeof stateValue === "function" ? stateValue(correlation) : stateValue;
    const cookie = typeof cookieValue === "function" ? cookieValue(correlation) : cookieValue;

    const response = await GET(request(state, cookie));
    expect(response.status).toBe(403);
    expectNoProtectedWork();
  });

  it("rejects an expired correlation before token exchange", async () => {
    const correlation = createAurinkoOAuthCorrelation("alice", 0);
    const response = await GET(request(correlation.state, correlation.value));

    expect(response.status).toBe(403);
    expectNoProtectedWork();
  });

  it("fails closed without its runtime signing secret before token exchange", async () => {
    const correlation = createAurinkoOAuthCorrelation("alice");
    delete process.env.AURINKO_OAUTH_STATE_SECRET;

    const response = await GET(request(correlation.state, correlation.value));
    expect(response.status).toBe(503);
    expectNoProtectedWork();
  });

  it("consumes valid correlation when token exchange throws without exposing its error", async () => {
    const correlation = createAurinkoOAuthCorrelation("alice");
    exchangeMock.mockRejectedValue(new Error("provider token details must stay private"));

    const response = await GET(request(correlation.state, correlation.value));

    expect(response.status).toBe(500);
    expectConsumedCorrelation(response);
    await expect(response.json()).resolves.toEqual({ message: "Unable to complete account linking" });
    expect(detailsMock).not.toHaveBeenCalled();
    expect(accountFindUniqueMock).not.toHaveBeenCalled();
    expect(accountCreateMock).not.toHaveBeenCalled();
    expect(accountUpdateManyMock).not.toHaveBeenCalled();
    expect(initialSyncMock).not.toHaveBeenCalled();
  });

  it("consumes valid correlation when account details throws without persisting or syncing", async () => {
    const correlation = createAurinkoOAuthCorrelation("alice");
    accountFindUniqueMock.mockResolvedValue(null);
    detailsMock.mockRejectedValue(new Error("private provider account response"));

    const response = await GET(request(correlation.state, correlation.value));

    expect(response.status).toBe(500);
    expectConsumedCorrelation(response);
    expect(accountCreateMock).not.toHaveBeenCalled();
    expect(accountUpdateManyMock).not.toHaveBeenCalled();
    expect(initialSyncMock).not.toHaveBeenCalled();
  });

  it("consumes valid correlation when database persistence throws without syncing", async () => {
    const correlation = createAurinkoOAuthCorrelation("alice");
    accountFindUniqueMock.mockResolvedValue(null);
    accountCreateMock.mockRejectedValue(new Error("database failure with private details"));

    const response = await GET(request(correlation.state, correlation.value));

    expect(response.status).toBe(500);
    expectConsumedCorrelation(response);
    expect(detailsMock).toHaveBeenCalledOnce();
    expect(initialSyncMock).not.toHaveBeenCalled();
  });

  it("preserves the identity chain, scopes the final update, clears the cookie, and rejects browser-style reuse", async () => {
    const correlation = createAurinkoOAuthCorrelation("alice");
    const response = await GET(request(correlation.state, correlation.value));

    expect(response.status).toBe(307);
    expect(accountUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "41", userId: "alice" },
      data: { accessToken: "synthetic-new-token" },
    });
    expect(initialSyncMock).toHaveBeenCalledWith({ accountId: "41", userId: "alice" });
    expectConsumedCorrelation(response);

    vi.clearAllMocks();
    const repeated = await GET(request(correlation.state));
    expect(repeated.status).toBe(403);
    expectNoProtectedWork();
  });
});
