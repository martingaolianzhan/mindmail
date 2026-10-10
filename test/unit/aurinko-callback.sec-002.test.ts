import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  accountFindUniqueMock,
  accountUpdateManyMock,
  axiosPostMock,
  exchangeCodeForAccessTokenMock,
  getAccountDetailsMock,
  initialSyncMock,
  waitUntilMock,
} = vi.hoisted(() => ({
  accountFindUniqueMock: vi.fn(),
  accountUpdateManyMock: vi.fn(),
  axiosPostMock: vi.fn(),
  exchangeCodeForAccessTokenMock: vi.fn(),
  getAccountDetailsMock: vi.fn(),
  initialSyncMock: vi.fn(),
  waitUntilMock: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("../mocks/clerk");
  return clerkServerMock;
});
vi.mock("~/lib/aurinko", () => ({
  exchangeCodeForAccessToken: exchangeCodeForAccessTokenMock,
  getAccountDetails: getAccountDetailsMock,
}));
vi.mock("~/server/db", () => ({ db: { account: { findUnique: accountFindUniqueMock, updateMany: accountUpdateManyMock } } }));
vi.mock("~/lib/aurinko-oauth-state", () => ({
  AURINKO_OAUTH_STATE_COOKIE: "mindmail_aurinko_oauth",
  verifyAurinkoOAuthCorrelation: vi.fn(() => true),
}));
vi.mock("~/lib/initial-sync", () => ({ performInitialSync: initialSyncMock }));
vi.mock("@vercel/functions", () => ({ waitUntil: waitUntilMock }));
vi.mock("axios", () => ({ default: { post: axiosPostMock } }));

import { GET } from "~/app/api/aurinko/callback/route";
import { clerkAuthMock } from "../mocks/clerk";

describe("SEC-002 Aurinko callback initial-sync boundary", () => {
  it("passes Clerk-derived identity and the provider account ID directly to trusted initial sync", async () => {
    clerkAuthMock.mockResolvedValue({ userId: "clerk-alice" });
    exchangeCodeForAccessTokenMock.mockResolvedValue({ accountId: 42, accessToken: "synthetic-token" });
    getAccountDetailsMock.mockResolvedValue({ email: "alice@example.test", name: "Alice" });
    accountFindUniqueMock.mockResolvedValue({ id: "42", userId: "clerk-alice" });
    accountUpdateManyMock.mockResolvedValue({ count: 1 });
    initialSyncMock.mockResolvedValue("completed");

    const response = await GET(new NextRequest("http://mindmail.test/api/aurinko/callback?status=success&code=synthetic-code", { headers: { cookie: "mindmail_aurinko_oauth=synthetic" } }));

    expect(response.status).toBe(307);
    expect(clerkAuthMock).toHaveBeenCalledOnce();
    expect(initialSyncMock).toHaveBeenCalledWith({ accountId: "42", userId: "clerk-alice" });
    expect(waitUntilMock).toHaveBeenCalledWith(expect.any(Promise));
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("handles a background initial-sync rejection without exposing provider failure details", async () => {
    clerkAuthMock.mockResolvedValue({ userId: "clerk-alice" });
    exchangeCodeForAccessTokenMock.mockResolvedValue({ accountId: 42, accessToken: "synthetic-token" });
    getAccountDetailsMock.mockResolvedValue({ email: "alice@example.test", name: "Alice" });
    accountFindUniqueMock.mockResolvedValue({ id: "42", userId: "clerk-alice" });
    accountUpdateManyMock.mockResolvedValue({ count: 1 });
    initialSyncMock.mockRejectedValue(new Error("provider response with sensitive context"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await GET(new NextRequest("http://mindmail.test/api/aurinko/callback?status=success&code=synthetic-code", { headers: { cookie: "mindmail_aurinko_oauth=synthetic" } }));
    const backgroundWork = waitUntilMock.mock.calls[0]?.[0] as Promise<void> | undefined;
    await expect(backgroundWork).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith("Initial sync failed.");
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("sensitive context"));
  });
});
