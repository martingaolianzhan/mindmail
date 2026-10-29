import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
const { http } = vi.hoisted(() => ({ http: { get: vi.fn(), post: vi.fn() } }));
vi.mock("axios", () => ({ default: http }));
import { POST } from "~/app/api/cron/sync/route";
import { db } from "~/server/db";
import { discoverSyncWork } from "~/lib/sync-orchestration";
import * as executions from "~/lib/sync-execution";

const userId = `cron005-${crypto.randomUUID()}`;
const realClaim = executions.claimSyncExecution;
const wake = () => POST(new Request("https://mindmail.test/api/cron/sync", { method: "POST", headers: { authorization: "Bearer synthetic-cron-SECRET" } }));
async function fixture(data: Partial<Prisma.AccountUncheckedCreateInput> = {}) {
  const id = `${userId}-${crypto.randomUUID()}`;
  return db.account.create({ data: { id, userId, accessToken: `${id}-TOKEN-SECRET`, name: "Synthetic", emailAddress: `${id}@example.test`, latestDeltaToken: "D20", syncScheduleState: "scheduled", syncNextRunAt: new Date(0), ...data } });
}
beforeAll(async () => {
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
beforeEach(async () => {
  vi.stubEnv("SYNC_CRON_SECRET", "synthetic-cron-SECRET");
  // Real global discovery must not encounter unrelated eligible test work.
  // Do not mutate unrelated rows or filter the production scheduler in this test.
  expect((await discoverSyncWork()).length).toBe(0);
  http.get.mockReset().mockResolvedValue({ data: { records: [], nextDeltaToken: "D21" } });
  http.post.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await db.account.deleteMany({ where: { userId } });
});
afterAll(async () => { await db.user.delete({ where: { id: userId } }); await db.$disconnect(); });

describe("SYNC-005 authorized HTTP wake-up -> unchanged durable consumer / PostgreSQL", () => {
  it("no due work is a safe successful no-op with zero provider calls", async () => {
    const response = await wake();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
  });
  it.each(["blocked", "future"])("repeated authorized wake-ups cannot bypass %s state/time", async (kind) => {
    const a = await fixture(kind === "blocked" ? { syncScheduleState: "blocked", syncNextRunAt: null, syncRetryCount: 4 } : { syncScheduleState: "retry_wait", syncNextRunAt: new Date(Date.now() + 300_000), syncRetryCount: 2 });
    for (let tick = 0; tick < 4; tick++) expect((await wake()).status).toBe(200);
    expect(await db.account.findUniqueOrThrow({ where: { id: a.id } })).toEqual(a);
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
  });
  it("two authorized calls holding the same due opportunity produce one claim/provider run", async () => {
    const a = await fixture();
    let count = 0; let release!: () => void;
    const bothDiscovered = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(executions, "claimSyncExecution").mockImplementation(async (...args) => {
      if (++count === 2) release();
      await bothDiscovered;
      return realClaim(...args);
    });
    const responses = await Promise.all([wake(), wake()]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]); expect(count).toBe(2);
    expect(await Promise.all(responses.map((r) => r.json()))).toEqual([{ ok: true }, { ok: true }]);
    expect(http.get).toHaveBeenCalledOnce(); expect(http.post).not.toHaveBeenCalled();
    expect(await db.account.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ latestDeltaToken: "D21", syncScheduleState: "scheduled", syncRetryCount: 0, syncScheduleVersion: 2, activeSyncRunId: null });
  });
  it("one wake-up preserves batch size one, rather than draining two due Accounts", async () => {
    await fixture(); await fixture();
    expect((await wake()).status).toBe(200);
    expect(http.get).toHaveBeenCalledOnce();
    expect(await db.account.count({ where: { userId, latestDeltaToken: "D21" } })).toBe(1);
    expect(await db.account.count({ where: { userId, latestDeltaToken: "D20" } })).toBe(1);
  });
});
