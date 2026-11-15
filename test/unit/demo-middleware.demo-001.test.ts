import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { protect } = vi.hoisted(() => ({ protect: vi.fn() }));
vi.mock("@clerk/nextjs/server", async original => ({
  ...await original<object>(),
  clerkMiddleware: (handler: (auth: unknown, request: NextRequest) => Promise<unknown>) =>
    (request: NextRequest) => handler({ protect }, request),
}));
import middleware from "~/middleware";
import { isDemoPath } from "~/lib/demo-path";

beforeEach(() => { protect.mockRejectedValue(new Error("Authentication required")); });
const request = (path: string) => new NextRequest(`https://mindmail.test${path}`);

describe("DEMO-001 anonymous route boundary", () => {
  it.each(["/demo", "/demo/", "/demo/example"])("allows anonymous %s", async path => {
    expect(isDemoPath(path)).toBe(true);
    await middleware(request(path), {} as never);
    expect(protect).not.toHaveBeenCalled();
  });
  it.each(["/demo-other", "/demonstration", "/mail", "/api/trpc", "/api/trpc/account.getAccounts", "/settings", "/api/cron/sync/", "/api/cron/sync/extra"])("keeps %s protected", async path => {
    expect(isDemoPath(path)).toBe(false);
    await expect(middleware(request(path), {} as never)).rejects.toThrow("Authentication required");
    expect(protect).toHaveBeenCalledOnce();
  });
  it("preserves the exact cron middleware exception (Bearer route tests remain separate)", async () => {
    await middleware(request("/api/cron/sync"), {} as never);
    expect(protect).not.toHaveBeenCalled();
  });
});
