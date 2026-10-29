import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { consume, protect } = vi.hoisted(() => ({ consume: vi.fn(), protect: vi.fn() }));
vi.mock("~/lib/sync-orchestration", () => ({ consumeDueSyncWork: consume }));
vi.mock("@clerk/nextjs/server", async (original) => ({
  ...await original<object>(),
  // Run the actual middleware callback and actual Clerk route matcher, but no
  // live Clerk session/service. Unauthenticated protection stops dispatch.
  clerkMiddleware: (handler: (auth: unknown, req: NextRequest) => Promise<unknown>) =>
    (req: NextRequest) => handler({ protect }, req),
}));
import middleware from "~/middleware";
import { POST, maxDuration, runtime } from "~/app/api/cron/sync/route";

const secret = "synthetic-cron-SECRET";
const request = (authorization?: string, path = "/api/cron/sync") => new NextRequest(`https://mindmail.test${path}`, { method: "POST", headers: authorization === undefined ? {} : { authorization } });
async function dispatch(req: NextRequest) {
  await middleware(req, {} as never);
  return POST(req);
}
beforeEach(() => {
  vi.stubEnv("SYNC_CRON_SECRET", secret);
  consume.mockResolvedValue(undefined);
  protect.mockRejectedValue(new Error("Unauthenticated Clerk protection"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("SYNC-005 exact middleware-to-cron route authentication", () => {
  it("exact /api/cron/sync reaches its own 401 without any Clerk session", async () => {
    expect((await dispatch(request())).status).toBe(401);
    expect(protect).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
  });
  it.each(["/api/cron/example", "/api/cron/sync/extra", "/api/cron/sync/", "/api/trpc/account.getThreads", "/mail"])("%s remains Clerk-protected, never reaching cron work", async (path) => {
    await expect(dispatch(request(`Bearer ${secret}`, path))).rejects.toThrow("Unauthenticated Clerk protection");
    expect(protect).toHaveBeenCalledOnce(); expect(consume).not.toHaveBeenCalled();
  });
  it.each([undefined, "Basic synthetic", "Bearer", "Bearer ", "Bearer wrong", `bearer ${secret}`, `Bearer ${secret}x`])("rejects invalid credential %s without scheduler work", async (authorization) => {
    const response = await POST(request(authorization));
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ ok: false });
    expect(consume).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "   ", "invalid secret"])("server secret misconfiguration fails closed with 503 (%s)", async (value) => {
    if (value === undefined) delete process.env.SYNC_CRON_SECRET;
    else vi.stubEnv("SYNC_CRON_SECRET", value);
    const response = await POST(request(`Bearer ${secret}`));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false });
    expect(consume).not.toHaveBeenCalled();
  });
  it("authorized no-op calls the bounded due-work entry point once and returns only ok", async () => {
    const response = await dispatch(request(`Bearer ${secret}`));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(consume).toHaveBeenCalledExactlyOnceWith(); expect(protect).not.toHaveBeenCalled();
    expect(maxDuration).toBe(300); expect(runtime).toBe("nodejs");
  });
  it("ignores caller authority in body/query/headers and passes no arguments to scheduling", async () => {
    const authority = { accountId: "UNTRUSTED", userId: "UNTRUSTED", syncGeneration: 99, syncScheduleVersion: 99, runId: "UNTRUSTED", accessToken: "TOKEN-SECRET", latestDeltaToken: "DELTA-SECRET", retryCount: 0 };
    const query = new URLSearchParams(Object.entries(authority).map(([k, v]) => [k, String(v)]));
    const response = await POST(new Request(`https://mindmail.test/api/cron/sync?${query}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, ...Object.fromEntries(Object.entries(authority).map(([k, v]) => [k, String(v)])) }, body: JSON.stringify(authority) }));
    expect(await response.json()).toEqual({ ok: true }); expect(consume).toHaveBeenCalledExactlyOnceWith();
  });
  it("scheduler failure is generic in both response and logs", async () => {
    consume.mockRejectedValue(new Error(`RAW-DB-SECRET MAIL-SECRET ${secret} Bearer ${secret}`));
    const response = await POST(request(`Bearer ${secret}`));
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ ok: false });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Scheduled sync wake-up failed.");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/SECRET|Bearer/);
  });
});
