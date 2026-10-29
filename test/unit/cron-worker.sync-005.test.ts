import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../infra/cloudflare/mindmail-sync-wakeup/worker.js";
const url = "https://mindmail.example.test/api/cron/sync";
const secret = "synthetic-worker-SECRET";
const env = { MINDMAIL_SYNC_URL: url, MINDMAIL_CRON_SECRET: secret };
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });
async function expectSafeFailure(config = env) {
  const error: unknown = await worker.scheduled(undefined, config).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: "MindMail sync wake-up failed." });
  expect((error as Error).cause).toBeUndefined();
  const text = String(error) + (error as Error).stack;
  for (const sensitive of [config.MINDMAIL_SYNC_URL, config.MINDMAIL_CRON_SECRET.trim() ? config.MINDMAIL_CRON_SECRET : "", `Bearer ${config.MINDMAIL_CRON_SECRET}`, secret, "BODY-SECRET", "RAW-NETWORK-SECRET"]) {
    if (sensitive) expect(text).not.toContain(sensitive);
  }
}

describe("SYNC-005 Cloudflare clock-only Worker contract", () => {
  it.each([200, 201, 204, 299])("HTTPS exact-path status %s succeeds with one authenticated POST, redirects disabled", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(worker.scheduled(undefined, env)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${secret}` } });
  });
  it.each([301, 302, 307, 308, 401, 403, 404, 429, 500, 503])("HTTP %s fails the scheduled event generically (never follows/reads response)", async (status) => {
    const response = new Response("BODY-SECRET", { status, headers: { location: "https://sign-in.example.test/" } });
    const read = vi.spyOn(response, "text");
    fetchMock.mockResolvedValue(response);
    await expectSafeFailure();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe("manual");
  });
  it("replaces raw network exceptions with a generic Error and no cause", async () => {
    fetchMock.mockRejectedValue(new Error(`RAW-NETWORK-SECRET ${url} Bearer ${secret} BODY-SECRET`));
    await expectSafeFailure(); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([
    "not a URL", "http://mindmail.example.test/api/cron/sync", "ftp://mindmail.example.test/api/cron/sync",
    "https://mindmail.example.test/api/cron/example", "https://mindmail.example.test/api/cron/sync/extra",
    "https://mindmail.example.test/api/cron/sync/", "https://user:password@mindmail.example.test/api/cron/sync",
    `${url}?accountId=UNTRUSTED`, `${url}#fragment`,
  ])("invalid target %s fails before any secret-bearing fetch", async (target) => {
    await expectSafeFailure({ ...env, MINDMAIL_SYNC_URL: target }); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["", " ", "invalid secret"])("misconfigured Worker secret fails before fetch (%s)", async (value) => {
    await expectSafeFailure({ ...env, MINDMAIL_CRON_SECRET: value }); expect(fetchMock).not.toHaveBeenCalled();
  });
});
