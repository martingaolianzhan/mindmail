import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookieSetMock, cookiesMock } = vi.hoisted(() => ({
  cookieSetMock: vi.fn(),
  cookiesMock: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("../mocks/clerk");
  return clerkServerMock;
});
vi.mock("next/headers", () => ({ cookies: cookiesMock }));

import { getAurinkoAuthURL } from "~/lib/aurinko";
import {
  AURINKO_OAUTH_STATE_COOKIE,
  AURINKO_OAUTH_STATE_MAX_AGE_SECONDS,
  verifyAurinkoOAuthCorrelation,
} from "~/lib/aurinko-oauth-state";
import { clerkAuthMock } from "../mocks/clerk";

const originalSecret = process.env.AURINKO_OAUTH_STATE_SECRET;

beforeEach(() => {
  process.env.AURINKO_OAUTH_STATE_SECRET = "test-oauth-state-secret";
  process.env.AURINKO_CLIENT_ID = "synthetic-client";
  process.env.NEXT_PUBLIC_URL = "http://mindmail.test";
  cookiesMock.mockResolvedValue({ set: cookieSetMock });
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AURINKO_OAUTH_STATE_SECRET;
  else process.env.AURINKO_OAUTH_STATE_SECRET = originalSecret;
});

describe("SEC-005 Aurinko OAuth initiation correlation", () => {
  it("requires Clerk authentication before producing an OAuth URL or cookie", async () => {
    clerkAuthMock.mockResolvedValue({ userId: null });

    await expect(getAurinkoAuthURL("Google")).rejects.toThrow("User not found");
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("uses fresh state and a signed, short-lived Alice-bound HttpOnly cookie", async () => {
    clerkAuthMock.mockResolvedValue({ userId: "alice" });
    const firstUrl = new URL(await getAurinkoAuthURL("Google"));
    const [firstName, firstValue, firstOptions] = cookieSetMock.mock.calls[0] as [string, string, Record<string, unknown>];
    const secondUrl = new URL(await getAurinkoAuthURL("Google"));

    expect(firstUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(secondUrl.searchParams.get("state")).not.toBe(firstUrl.searchParams.get("state"));
    expect(firstName).toBe(AURINKO_OAUTH_STATE_COOKIE);
    expect(firstOptions).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/aurinko/callback", maxAge: AURINKO_OAUTH_STATE_MAX_AGE_SECONDS });
    expect(verifyAurinkoOAuthCorrelation(firstValue, firstUrl.searchParams.get("state"), "alice")).toBe(true);
    expect(verifyAurinkoOAuthCorrelation(firstValue, firstUrl.searchParams.get("state"), "bob")).toBe(false);

    // The second set call replaces the one browser/session correlation cookie.
    const secondValue = cookieSetMock.mock.calls[1]?.[1] as string;
    expect(verifyAurinkoOAuthCorrelation(secondValue, firstUrl.searchParams.get("state"), "alice")).toBe(false);
  });

  it("fails closed without a signing secret and creates no correlation cookie", async () => {
    delete process.env.AURINKO_OAUTH_STATE_SECRET;
    clerkAuthMock.mockResolvedValue({ userId: "alice" });

    await expect(getAurinkoAuthURL("Google")).rejects.toThrow("signing is not configured");
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("rejects tampered and expired correlation data", async () => {
    const { createAurinkoOAuthCorrelation } = await import("~/lib/aurinko-oauth-state");
    const correlation = createAurinkoOAuthCorrelation("alice", 1_000);

    expect(verifyAurinkoOAuthCorrelation(`${correlation.value}x`, correlation.state, "alice", 1_001)).toBe(false);
    expect(verifyAurinkoOAuthCorrelation(correlation.value, correlation.state, "alice", 1_000 + AURINKO_OAUTH_STATE_MAX_AGE_SECONDS * 1000)).toBe(false);
  });
});
