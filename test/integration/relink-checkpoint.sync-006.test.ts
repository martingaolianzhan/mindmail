import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account as DbAccount } from "@prisma/client";
import type * as InitialSyncModule from "~/lib/initial-sync";
import type { EmailMessage, SyncUpdatedEmailsReponse } from "~/type";
import { NextRequest } from "next/server";

const { axiosMock, exchange, details, backgroundInitial } = vi.hoisted(() => ({
  axiosMock: { get: vi.fn(), post: vi.fn() }, exchange: vi.fn(), details: vi.fn(), backgroundInitial: vi.fn(),
}));
vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("@clerk/nextjs/server", async () => (await import("../mocks/clerk")).clerkServerMock);
vi.mock("~/lib/aurinko", () => ({ exchangeCodeForAccessToken: exchange, getAccountDetails: details }));
// Gate the actual service boundary: delaying waitUntil alone would be too late.
vi.mock("~/lib/initial-sync", () => ({ performInitialSync: backgroundInitial }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
import { Account, ReinitializationRequiredError } from "~/lib/account";
import { db } from "~/server/db";
import { GET } from "~/app/api/aurinko/callback/route";
import { createAurinkoOAuthCorrelation, AURINKO_OAUTH_STATE_COOKIE } from "~/lib/aurinko-oauth-state";
import { claimSyncExecution, completeSyncExecution } from "~/lib/sync-execution";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { clerkAuthMock } from "../mocks/clerk";
import { syntheticEmail } from "../fixtures/emails";
import { interceptCheckpoints, interceptTransactions, restoreTransactions } from "../helpers/transactions";
const { performInitialSync: runInitial } = await vi.importActual<typeof InitialSyncModule>("~/lib/initial-sync");

type InitialResult = InitialSyncModule.InitialSyncResult;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const prefix = `sync006-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;
const accountIds: string[] = [];
let sequence = Date.now() * 100;
const queued: { start: () => Promise<InitialResult>; cancel: () => void; result: Promise<InitialResult> }[] = [];
const realUpdate = db.account.updateMany.bind(db.account);
const realFind = db.account.findUnique.bind(db.account);
const realCreate = db.account.create.bind(db.account);
const reread = (a: DbAccount) => db.account.findUniqueOrThrow({ where: { id: a.id } });
async function fixture(checkpoint: string | null = "D1") {
  const id = String(sequence++); accountIds.push(id);
  return db.account.create({ data: { id, userId, emailAddress: `${id}@example.test`, name: "Synthetic", accessToken: `${prefix}-${id}-T1`, latestDeltaToken: checkpoint } });
}
function message(a: DbAccount, subject = "G2"): EmailMessage {
  return { ...syntheticEmail, id: `${prefix}-${a.id}-email`, threadId: `${prefix}-${a.id}-thread`, subject,
    from: { address: `${a.id}-sender@example.test` }, to: [{ address: `${a.id}-recipient@example.test` }],
    hasAttachments: true, attachments: [{ id: `${prefix}-${a.id}-attachment`, name: subject, mimeType: "text/plain", size: 1, inline: false, content: "Synthetic attachment" }],
    nativeProperties: { property1: "", property2: "" },
  } as EmailMessage;
}
async function seedMail(a: DbAccount) {
  const owner = await claimSyncExecution(a);
  await syncEmailsToDatabase([message(a, "retained-before-relink")], owner);
  await completeSyncExecution(owner, "D1");
}
async function mailState(a: DbAccount) {
  return {
    threads: await db.thread.findMany({ where: { accountId: a.id }, select: { id: true, subject: true } }),
    emails: await db.email.findMany({ where: { thread: { accountId: a.id } }, select: { id: true, subject: true } }),
    addresses: await db.emailAddress.findMany({ where: { accountId: a.id }, select: { id: true }, orderBy: { id: "asc" } }),
    attachments: await db.emailAttachment.findMany({ where: { emailId: message(a).id }, select: { id: true, name: true } }),
  };
}
async function relink(a: DbAccount, accessToken: string) {
  exchange.mockResolvedValue({ accountId: Number(a.id), accessToken });
  const c = createAurinkoOAuthCorrelation(userId);
  const response = await GET(new NextRequest(`http://mindmail.test/api/aurinko/callback?status=success&code=synthetic&state=${c.state}`, {
    headers: { cookie: `${AURINKO_OAUTH_STATE_COOKIE}=${c.value}` },
  }));
  expect(response.status).toBe(307);
  return reread(a);
}
function initialResponse(a: DbAccount, checkpoint = "D2") {
  axiosMock.post.mockResolvedValue({ data: { ready: true, syncUpdatedToken: "S0" } });
  axiosMock.get.mockResolvedValue({ data: { records: [message(a)], nextDeltaToken: checkpoint } });
}
async function assertBlocked(a: DbAccount) {
  axiosMock.get.mockClear(); axiosMock.post.mockClear();
  await expect(new Account(a.accessToken).syncEmails()).rejects.toBeInstanceOf(ReinitializationRequiredError);
  expect(axiosMock.get).not.toHaveBeenCalled();
  expect(axiosMock.post).not.toHaveBeenCalled();
}
beforeAll(async () => {
  vi.stubEnv("AURINKO_OAUTH_STATE_SECRET", "synthetic-sync006-state-secret");
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
beforeEach(() => {
  axiosMock.get.mockReset(); axiosMock.post.mockReset(); exchange.mockReset(); details.mockReset(); backgroundInitial.mockReset();
  queued.length = 0;
  clerkAuthMock.mockResolvedValue({ userId });
  details.mockResolvedValue({ email: "synthetic@example.test", name: "Synthetic" });
  backgroundInitial.mockImplementation((input: InitialSyncModule.InitialSyncInput) => {
    const gate = deferred<boolean>();
    const result = gate.promise.then((start) => start ? runInitial(input) : "sync-failed" as const);
    queued.push({ start: () => { gate.resolve(true); return result; }, cancel: () => gate.resolve(false), result });
    return result;
  });
});
afterEach(async () => {
  // Unstarted background mocks settle without invoking the real service.
  for (const job of queued) job.cancel();
  await Promise.allSettled(queued.map((job) => job.result));
  vi.restoreAllMocks(); restoreTransactions();
  db.account.updateMany = realUpdate; db.account.findUnique = realFind; db.account.create = realCreate;
});
afterAll(async () => {
  await db.emailAttachment.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.email.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.thread.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.emailAddress.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect(); vi.unstubAllEnvs();
});

describe("SYNC-006 real callback checkpoint invalidation and reinitialization", () => {
  it.each([
    { name: "missing", data: { ready: true } },
    ...[undefined, null, "", "   ", 42, false, {}, []].map((token) => ({ name: `invalid ${JSON.stringify(token)}`, data: { ready: true, syncUpdatedToken: token } })),
  ])("$name initial S0 leaves persisted checkpoints unchanged/null with zero updated GETs or persistence", async ({ data }) => {
    axiosMock.post.mockResolvedValue({ data });
    axiosMock.get.mockResolvedValue({ data: { records: [], nextDeltaToken: "must-not-commit" } });
    const persistence = interceptTransactions((tx) => tx);
    const completion = interceptCheckpoints();
    for (const checkpoint of [null, "D-existing"]) {
      const a = await fixture(checkpoint);
      await expect(runInitial({ accountId: a.id, userId })).resolves.toBe("sync-failed");
      expect(axiosMock.get).not.toHaveBeenCalled();
      expect(persistence).not.toHaveBeenCalled();
      expect(completion).not.toHaveBeenCalled();
      expect(await reread(a)).toMatchObject({ latestDeltaToken: checkpoint, activeSyncRunId: null });
      expect(await mailState(a)).toEqual({ threads: [], emails: [], addresses: [], attachments: [] });
    }
  });

  it("atomically clears D1 and the owner before background initial work; other Accounts and all mail remain intact", async () => {
    const a = await fixture(); const other = await fixture("OTHER-D2");
    await seedMail(a);
    await claimSyncExecution(await reread(a));
    const before = await mailState(a);
    const write = vi.spyOn(db.account, "updateMany").mockImplementation(realUpdate);
    const token = `${a.accessToken}-T2`;
    const current = await relink(a, token);
    expect(write).toHaveBeenCalledExactlyOnceWith({
      where: { id: a.id, userId },
      data: { accessToken: token, syncGeneration: { increment: 1 }, activeSyncRunId: null, latestDeltaToken: null },
    });
    expect(current).toMatchObject({ accessToken: token, syncGeneration: 1, activeSyncRunId: null, latestDeltaToken: null });
    expect(backgroundInitial).toHaveBeenCalledWith({ accountId: a.id, userId });
    expect(queued).toHaveLength(1);
    expect(axiosMock.post).not.toHaveBeenCalled();
    expect(await mailState(a)).toEqual(before);
    expect((await reread(other)).latestDeltaToken).toBe("OTHER-D2");
    await assertBlocked(current); // In particular no provider receives D1 under T2.
  });

  it("same-owner create-race recovery performs the same four-field atomic transition", async () => {
    const a = await fixture();
    await claimSyncExecution(a);
    vi.spyOn(db.account, "findUnique").mockImplementation(realFind).mockResolvedValueOnce(null);
    vi.spyOn(db.account, "create").mockRejectedValueOnce(Object.assign(new Error("synthetic lost create race"), { code: "P2002" }));
    const write = vi.spyOn(db.account, "updateMany").mockImplementation(realUpdate);
    const token = `${a.accessToken}-T2`;
    const current = await relink(a, token);
    expect(write).toHaveBeenCalledExactlyOnceWith({
      where: { id: a.id, userId },
      data: { accessToken: token, syncGeneration: { increment: 1 }, activeSyncRunId: null, latestDeltaToken: null },
    });
    expect(current).toMatchObject({ accessToken: token, syncGeneration: 1, activeSyncRunId: null, latestDeltaToken: null });
    await assertBlocked(current);
  });

  it("fresh initial sync persists represented mail before establishing D2; only then incremental sync uses D2", async () => {
    const a = await fixture(); await seedMail(a);
    const current = await relink(a, `${a.accessToken}-T2`);
    await assertBlocked(current);
    initialResponse(a);
    const checkpoint = interceptCheckpoints((async (args) => {
      expect((await reread(a)).latestDeltaToken).toBeNull();
      expect(await db.email.findUniqueOrThrow({ where: { id: message(a).id } })).toMatchObject({ subject: "G2" });
      return realUpdate(args);
    }) as typeof realUpdate);
    await expect(queued[0]!.start()).resolves.toBe("completed");
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(await reread(a)).toMatchObject({ accessToken: current.accessToken, syncGeneration: 1, latestDeltaToken: "D2", activeSyncRunId: null });
    expect(axiosMock.get).toHaveBeenCalledWith("https://api.aurinko.io/v1/email/sync/updated", {
      headers: { Authorization: `Bearer ${current.accessToken}` }, params: { deltaToken: "S0" },
    });
    expect(await db.email.count({ where: { threadId: message(a).threadId } })).toBe(1);
    checkpoint.mockImplementation(realUpdate);
    axiosMock.get.mockReset().mockResolvedValue({ data: { records: [], nextDeltaToken: "D3" } });
    await expect(new Account(current.accessToken).syncEmails()).resolves.toMatchObject({ latestDeltaToken: "D3" });
    expect(axiosMock.get).toHaveBeenCalledExactlyOnceWith("https://api.aurinko.io/v1/email/sync/updated", {
      headers: { Authorization: `Bearer ${current.accessToken}` }, params: { deltaToken: "D2" },
    });
    expect((await reread(a)).latestDeltaToken).toBe("D3");
  });

  it.each(["provider", "malformed-terminal", "persistence", "ownership-loss"] as const)("failed %s reinitialization leaves null and incremental work blocked", async (failure) => {
    const a = await fixture(); await relink(a, `${a.accessToken}-T2`);
    initialResponse(a);
    if (failure === "provider") axiosMock.post.mockRejectedValueOnce(new Error("synthetic provider failure"));
    if (failure === "malformed-terminal") axiosMock.get.mockResolvedValueOnce({ data: { records: [message(a)] } });
    if (failure === "persistence") interceptTransactions((tx) => ({ ...tx, email: { ...tx.email, upsert: (() => { throw new Error("synthetic persistence failure"); }) as typeof tx.email.upsert } }));
    if (failure === "ownership-loss") interceptCheckpoints((async (args) => {
      if (args.data.latestDeltaToken === "D2") await relink(a, `${a.accessToken}-T3`);
      return realUpdate(args);
    }) as typeof realUpdate);
    const result = queued[0]!.start();
    if (failure === "persistence") await expect(result).rejects.toThrow("Failed to sync emails to database.");
    else await expect(result).resolves.toBe("sync-failed");
    const state = await reread(a);
    expect(state.latestDeltaToken).toBeNull();
    expect(state.activeSyncRunId).toBeNull();
    await assertBlocked(state);
  });

  it("T1 → T2 → T1 clears both D1 and D2; G3 must establish D3 before incremental work", async () => {
    const a = await fixture();
    let current = await relink(a, `${a.accessToken}-T2`);
    expect(current.latestDeltaToken).toBeNull(); await assertBlocked(current);
    initialResponse(a, "D2"); await expect(queued[0]!.start()).resolves.toBe("completed");
    expect((await reread(a)).latestDeltaToken).toBe("D2");
    current = await relink(a, a.accessToken);
    expect(current).toMatchObject({ accessToken: a.accessToken, syncGeneration: 2, latestDeltaToken: null });
    await assertBlocked(current);
    initialResponse(a, "D3"); await expect(queued[1]!.start()).resolves.toBe("completed");
    expect((await reread(a)).latestDeltaToken).toBe("D3");
    axiosMock.get.mockReset().mockResolvedValue({ data: { records: [], nextDeltaToken: "D4" } });
    await new Account(a.accessToken).syncEmails();
    expect(axiosMock.get).toHaveBeenCalledExactlyOnceWith("https://api.aurinko.io/v1/email/sync/updated", {
      headers: { Authorization: `Bearer ${a.accessToken}` }, params: { deltaToken: "D3" },
    });
  });

  it.each(["empty", "one-page", "multi-page"] as const)("durable %s initial sync stores the terminal delta, not S0/page/intermediate tokens", async (shape) => {
    const a = await fixture(); await relink(a, `${a.accessToken}-T2`);
    initialResponse(a);
    const pages: SyncUpdatedEmailsReponse[] = shape === "multi-page" ? [
      { records: [{ ...message(a, "first"), id: `${message(a).id}-first`, hasAttachments: false, attachments: [] }], nextDeltaToken: "IGNORE", nextPageToken: "P1" },
      { records: [{ ...message(a, "second"), id: `${message(a).id}-second`, hasAttachments: false, attachments: [] }], nextPageToken: "P2" },
      { records: [message(a, "terminal")], nextDeltaToken: "D-terminal" },
    ] : [{ records: shape === "empty" ? [] : [message(a)], nextDeltaToken: "D-terminal" }];
    let index = 0;
    axiosMock.get.mockImplementation(() => {
      const data = pages[index++]; if (!data) throw new Error("Unexpected page"); return Promise.resolve({ data });
    });
    await expect(queued[0]!.start()).resolves.toBe("completed");
    expect(await reread(a)).toMatchObject({ syncGeneration: 1, latestDeltaToken: "D-terminal", activeSyncRunId: null });
    expect(axiosMock.get.mock.calls.map(([, config]) => (config as { params: object }).params)).toEqual(shape === "multi-page" ? [{ deltaToken: "S0" }, { pageToken: "P1" }, { pageToken: "P2" }] : [{ deltaToken: "S0" }]);
    expect(await db.email.count({ where: { threadId: message(a).threadId } })).toBe(shape === "multi-page" ? 3 : shape === "empty" ? 0 : 1);
  });
});
