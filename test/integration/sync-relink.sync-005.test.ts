import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as Orchestration from "~/lib/sync-orchestration";
const { http, exchange, details, fastPath } = vi.hoisted(() => ({ http: { get: vi.fn(), post: vi.fn() }, exchange: vi.fn(), details: vi.fn(), fastPath: vi.fn(async () => ({ status: "not-acquired", reason: "not-acquired" })) }));
vi.mock("axios", () => ({ default: http }));
vi.mock("@clerk/nextjs/server", async () => (await import("../mocks/clerk")).clerkServerMock);
vi.mock("~/lib/aurinko", () => ({ exchangeCodeForAccessToken: exchange, getAccountDetails: details }));
vi.mock("~/lib/sync-orchestration", async (original) => ({ ...await original<object>(), orchestrateAccountSync: fastPath }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
import { db } from "~/server/db";
import { GET } from "~/app/api/aurinko/callback/route";
import { createAurinkoOAuthCorrelation, AURINKO_OAUTH_STATE_COOKIE } from "~/lib/aurinko-oauth-state";
import { clerkAuthMock } from "../mocks/clerk";
const core = await vi.importActual<typeof Orchestration>("~/lib/sync-orchestration");
const prefix = `relink005-${crypto.randomUUID()}`; const userId = `${prefix}-user`;
let sequence = Date.now() * 100;
beforeAll(async () => {
  vi.stubEnv("AURINKO_OAUTH_STATE_SECRET", "synthetic-state-005");
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.account.deleteMany({ where: { userId } }); await db.user.delete({ where: { id: userId } }); await db.$disconnect(); vi.unstubAllEnvs();
});

describe("SYNC-005 durable production credential/schedule persistence", () => {
  it.each(["new", "relink", "create-race"])("%s survives loss of callback fast path and executes fresh initial via a new consumer", async (kind) => {
    const id = String(sequence++); const token = `${prefix}-${id}-T2`;
    const createOld = () => db.account.create({ data: { id, userId, accessToken: `${token}-T1`, emailAddress: `${id}@example.test`, name: "Synthetic", latestDeltaToken: "D-old", syncRetryCount: 4, syncScheduleVersion: 10, activeSyncRunId: "stranded-old", activeSyncLeaseExpiresAt: new Date(Date.now() + 300_000) } });
    if (kind === "relink") await createOld();
    if (kind === "create-race") {
      // The winner commits after the production lookup, before create's unique conflict.
      const realCreate = db.account.create.bind(db.account);
      vi.spyOn(db.account, "create").mockImplementationOnce((async () => {
        await realCreate({ data: { id, userId, accessToken: `${token}-T1`, emailAddress: `${id}@example.test`, name: "Synthetic", latestDeltaToken: "D-old", syncRetryCount: 4, syncScheduleVersion: 10 } });
        throw Object.assign(new Error("synthetic conflict"), { code: "P2002" });
      }) as unknown as typeof db.account.create);
    }
    clerkAuthMock.mockResolvedValue({ userId }); exchange.mockResolvedValue({ accountId: Number(id), accessToken: token }); details.mockResolvedValue({ name: "Synthetic", email: `${id}@example.test` });
    const c = createAurinkoOAuthCorrelation(userId);
    const before = new Date();
    expect((await GET(new NextRequest(`http://mindmail.test/api/aurinko/callback?status=success&code=synthetic&state=${c.state}`, { headers: { cookie: `${AURINKO_OAUTH_STATE_COOKIE}=${c.value}` } }))).status).toBe(307);
    const durable = await db.account.findUniqueOrThrow({ where: { id } });
    expect(durable).toMatchObject({ accessToken: token, syncGeneration: kind === "new" ? 0 : 1, latestDeltaToken: null, activeSyncRunId: null, activeSyncLeaseExpiresAt: null, syncScheduleState: "scheduled", syncRetryCount: 0, syncScheduleVersion: kind === "new" ? 1 : 11, syncLastOutcomeStatus: null, syncLastOutcomeReason: null });
    expect(durable.syncNextRunAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(http.get).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
    // Callback fast path did nothing. A fresh scheduler-core invocation uses DB only.
    http.post.mockResolvedValue({ data: { ready: true, syncUpdatedToken: "S0" } });
    http.get.mockResolvedValue({ data: { records: [], nextDeltaToken: "G2-D2" } });
    const [candidate] = await core.discoverSyncWork(new Date(), { accountId: id, userId });
    expect(candidate).toBeDefined();
    expect(await core.consumeSyncCandidate(candidate!)).toEqual({ status: "completed" });
    expect(http.post).toHaveBeenCalledWith(expect.any(String), {}, expect.objectContaining({ headers: { Authorization: `Bearer ${token}` }, params: { daysWithin: 2, bodyType: "html" } }));
    expect(http.get.mock.calls.at(-1)![1]).toMatchObject({ params: { deltaToken: "S0" } });
    expect(await db.account.findUniqueOrThrow({ where: { id } })).toMatchObject({ latestDeltaToken: "G2-D2", syncRetryCount: 0, syncScheduleState: "scheduled", activeSyncRunId: null });
    http.get.mockClear(); http.post.mockClear();
  });
});
