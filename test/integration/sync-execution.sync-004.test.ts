import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Account as DbAccount } from "@prisma/client";
import type * as InitialSyncModule from "~/lib/initial-sync";
import type { EmailMessage, SyncUpdatedEmailsReponse } from "~/type";
import { NextRequest } from "next/server";

const { axiosMock, exchange, details } = vi.hoisted(() => ({
  axiosMock: { get: vi.fn(), post: vi.fn() }, exchange: vi.fn(), details: vi.fn(),
}));
vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("@clerk/nextjs/server", async () => (await import("../mocks/clerk")).clerkServerMock);
vi.mock("~/lib/aurinko", () => ({ exchangeCodeForAccessToken: exchange, getAccountDetails: details }));
// Callback background execution is isolated; direct initial-sync tests below use
// the actual service, actual Account provider adapter (mocked axios), and real DB.
vi.mock("~/lib/initial-sync", () => ({ performInitialSync: vi.fn(async () => ({ status: "completed" })) }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

import { db } from "~/server/db";
import { Account } from "~/lib/account";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { claimSyncExecution, completeSyncExecution, releaseSyncExecution, StaleSyncExecutionError, SyncNotAcquiredError } from "~/lib/sync-execution";
import { GET } from "~/app/api/aurinko/callback/route";
import { createAurinkoOAuthCorrelation, AURINKO_OAUTH_STATE_COOKIE } from "~/lib/aurinko-oauth-state";
import { clerkAuthMock } from "../mocks/clerk";
import { interceptTransactions, restoreTransactions, interceptCheckpoints } from "../helpers/transactions";
const { performInitialSync } = await vi.importActual<typeof InitialSyncModule>("~/lib/initial-sync");

const prefix = `sync004-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;
const otherUser = `${prefix}-other`;
const ids: string[] = [];
let sequence = Date.now() * 100;
const realUpdateMany = db.account.updateMany.bind(db.account);
const realCreate = db.account.create.bind(db.account);
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function fixture(owner = userId) {
  const id = String(sequence++);
  ids.push(id);
  return db.account.create({ data: { id, userId: owner, accessToken: `${prefix}-${id}-T1`, emailAddress: `${id}@example.test`, name: "Synthetic", latestDeltaToken: "D0" } });
}
const reread = (a: DbAccount) => db.account.findUniqueOrThrow({ where: { id: a.id } });
function message(a: DbAccount, version: "OLD-G1" | "NEW-G2"): EmailMessage {
  const id = `${prefix}-${a.id}`;
  return {
    id: `${id}-email`, threadId: `${id}-thread`,
    createdTime: "2025-01-01T00:00:00.000Z", lastModifiedTime: "2025-01-01T00:00:00.000Z",
    sentAt: "2025-01-01T00:00:00.000Z", receivedAt: "2025-01-01T00:00:00.000Z",
    internetMessageId: `<${id}@example.test>`, subject: version,
    sysLabels: [version === "OLD-G1" ? "inbox" : "sent"], keywords: [], sysClassifications: [], sensitivity: "normal", meetingMessageMethod: "other",
    from: { address: `${id}-sender@example.test`, name: version }, to: [{ address: `${id}-recipient@example.test`, name: version }], cc: [], bcc: [], replyTo: [],
    hasAttachments: true, body: version, bodySnippet: version,
    attachments: [{ id: `${id}-attachment`, name: version, mimeType: "text/plain", size: version === "OLD-G1" ? 1 : 2, inline: false, content: version }],
    inReplyTo: "", references: "", threadIndex: "", internetHeaders: [], nativeProperties: {} as never, folderId: "", webLink: "", omitted: [],
  };
}
const page = (records: EmailMessage[], token = "D1"): SyncUpdatedEmailsReponse => ({ records, nextDeltaToken: token });
async function relink(a: DbAccount, token: string) {
  clerkAuthMock.mockResolvedValue({ userId: a.userId });
  exchange.mockResolvedValue({ accountId: Number(a.id), accessToken: token });
  const correlation = createAurinkoOAuthCorrelation(a.userId);
  const response = await GET(new NextRequest(`http://mindmail.test/api/aurinko/callback?status=success&code=synthetic&state=${correlation.state}`, {
    headers: { cookie: `${AURINKO_OAUTH_STATE_COOKIE}=${correlation.value}` },
  }));
  expect(response.status).toBe(307);
  return reread(a);
}
beforeAll(async () => {
  vi.stubEnv("AURINKO_OAUTH_STATE_SECRET", "synthetic-sync004-state-secret");
  await db.user.createMany({ data: [userId, otherUser].map((id) => ({ id, emailAddress: `${id}@example.test`, firstName: "Synthetic", lastName: "User" })) });
});
afterEach(() => {
  vi.restoreAllMocks(); restoreTransactions(); db.account.updateMany = realUpdateMany; db.account.create = realCreate;
});
afterAll(async () => {
  await db.emailAttachment.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.email.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.thread.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.emailAddress.deleteMany({ where: { accountId: { in: ids } } });
  await db.account.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: [userId, otherUser] } } });
  await db.$disconnect(); vi.unstubAllEnvs();
});

describe("SYNC-004 real PostgreSQL execution ownership and hard fencing", () => {
  it("allows only one same-Account run, reports non-acquisition, safely releases and permits a later run", async () => {
    const a = await fixture();
    const started = deferred(); const provider = deferred<{ data: SyncUpdatedEmailsReponse }>();
    axiosMock.get.mockImplementationOnce(() => { started.resolve(); return provider.promise; });
    const r1 = new Account(a.accessToken).syncEmails();
    await started.promise;
    const owned = await reread(a);
    expect(owned.activeSyncRunId).toEqual(expect.any(String));
    await expect(new Account(a.accessToken).syncEmails()).resolves.toEqual({ status: "not-acquired", reason: "not-acquired" });
    await expect(performInitialSync({ accountId: a.id, userId })).resolves.toEqual({ status: "not-acquired", reason: "not-acquired" });
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    expect(axiosMock.post).not.toHaveBeenCalled();
    expect(await reread(a)).toMatchObject({ activeSyncRunId: owned.activeSyncRunId, latestDeltaToken: "D0" });
    expect(await db.thread.count({ where: { accountId: a.id } })).toBe(0);
    provider.resolve({ data: page([message(a, "OLD-G1")]) });
    await expect(r1).resolves.toMatchObject({ latestDeltaToken: "D1" });
    expect(await reread(a)).toMatchObject({ activeSyncRunId: null, latestDeltaToken: "D1" });
    axiosMock.get.mockResolvedValue({ data: page([], "D2") });
    await expect(new Account(a.accessToken).syncEmails()).resolves.toMatchObject({ latestDeltaToken: "D2" });
    expect(await reread(a)).toMatchObject({ activeSyncRunId: null, latestDeltaToken: "D2" });
  });

  it("does not globally or per-user block other Accounts", async () => {
    const a = await fixture(); const a2 = await fixture(); const b = await fixture(otherUser);
    const started = deferred(); const held = deferred<{ data: SyncUpdatedEmailsReponse }>();
    axiosMock.get.mockImplementationOnce(() => { started.resolve(); return held.promise; });
    const r1 = new Account(a.accessToken).syncEmails(); await started.promise;
    const owner = (await reread(a)).activeSyncRunId;
    axiosMock.get.mockResolvedValue({ data: page([]) });
    for (const independent of [a2, b]) {
      await expect(new Account(independent.accessToken).syncEmails()).resolves.toMatchObject({ latestDeltaToken: "D1" });
      expect(await reread(independent)).toMatchObject({ latestDeltaToken: "D1", activeSyncRunId: null });
    }
    expect((await reread(a)).activeSyncRunId).toBe(owner);
    held.resolve({ data: page([]) }); await r1;
  });

  it.each(["initial", "incremental"] as const)("fences stale %s provider results, checkpoint, success and cleanup after real callback relink", async (kind) => {
    const a = await fixture(); const started = deferred(); const provider = deferred<{ data: SyncUpdatedEmailsReponse }>();
    axiosMock.post.mockResolvedValue({ data: { ready: true, syncUpdatedToken: "D-initial" } });
    axiosMock.get.mockImplementationOnce(() => { started.resolve(); return provider.promise; });
    const old = kind === "initial" ? performInitialSync({ accountId: a.id, userId }) : new Account(a.accessToken).syncEmails();
    // Attach rejection handling before releasing stale provider work.
    const result = old.then((value) => ({ value }), (error: unknown) => ({ error }));
    await started.promise;
    expect((await reread(a)).activeSyncRunId).not.toBeNull();
    const current = await relink(a, `${a.accessToken}-T2`);
    expect(current).toMatchObject({ syncGeneration: 1, activeSyncRunId: null, latestDeltaToken: null });
    const r2 = await claimSyncExecution(current);
    provider.resolve({ data: page([message(a, "OLD-G1")], "STALE-D2") });
    const outcome = await result;
    expect(outcome).toEqual({ value: { status: "ownership-lost", reason: "ownership-lost" } });
    expect(await reread(a)).toMatchObject({ syncGeneration: 1, activeSyncRunId: r2.runId, latestDeltaToken: null });
    expect(await db.thread.count({ where: { accountId: a.id } })).toBe(0);
    await releaseSyncExecution(r2);
  });

  it("T1 → T2 → T1 never resurrects an old run or clears a new owner", async () => {
    const a = await fixture(); const old = await claimSyncExecution(a);
    await relink(a, `${a.accessToken}-T2`);
    const g3 = await relink(a, a.accessToken);
    expect(g3).toMatchObject({ syncGeneration: 2, accessToken: a.accessToken });
    const current = await claimSyncExecution(g3);
    await expect(syncEmailsToDatabase([message(a, "OLD-G1")], old)).rejects.toThrow("Failed to sync emails to database.");
    await expect(completeSyncExecution(old, "STALE")).rejects.toBeInstanceOf(StaleSyncExecutionError);
    await releaseSyncExecution(old);
    expect(await reread(a)).toMatchObject({ syncGeneration: 2, activeSyncRunId: current.runId, latestDeltaToken: null });
    expect(await db.thread.count({ where: { accountId: a.id } })).toBe(0);
  });

  it("rejects missing and invalid persistence authority without creating any mail entities", async () => {
    const a = await fixture(); const owner = await claimSyncExecution(a);
    for (const invalid of [undefined, { ...owner, runId: "wrong" }, { ...owner, generation: 99 }, { ...owner, userId: otherUser }]) {
      await expect(syncEmailsToDatabase([message(a, "OLD-G1")], invalid as typeof owner)).rejects.toThrow("Failed to sync emails to database.");
    }
    expect(await reread(a)).toMatchObject({ activeSyncRunId: owner.runId, latestDeltaToken: "D0" });
    expect(await db.thread.count({ where: { accountId: a.id } })).toBe(0);
    expect(await db.emailAddress.count({ where: { accountId: a.id } })).toBe(0);
    expect(await db.email.count({ where: { id: message(a, "OLD-G1").id } })).toBe(0);
    expect(await db.emailAttachment.count({ where: { id: message(a, "OLD-G1").attachments[0]!.id } })).toBe(0);
  });

  it("preserves same-owner create-race relinking with a generation transition", async () => {
    const id = String(sequence++); ids.push(id);
    const a = { id, userId } as DbAccount;
    vi.spyOn(db.account, "create").mockImplementationOnce((async () => {
      await realCreate({ data: { id, userId, accessToken: `${prefix}-${id}-raced`, emailAddress: `${id}@example.test`, name: "Synthetic" } });
      throw Object.assign(new Error("synthetic unique conflict"), { code: "P2002" });
    }) as unknown as typeof db.account.create);
    details.mockResolvedValue({ name: "Synthetic", email: `${id}@example.test` });
    const current = await relink(a, `${prefix}-${id}-replacement`);
    expect(current).toMatchObject({ userId, syncGeneration: 1, activeSyncRunId: null, accessToken: `${prefix}-${id}-replacement` });
  });

  it("rejects an outdated checkpoint snapshot even after a prior same-generation run released", async () => {
    const a = await fixture(); const r1 = await claimSyncExecution(a);
    await completeSyncExecution(r1, "D1");
    await expect(claimSyncExecution(a)).rejects.toBeInstanceOf(SyncNotAcquiredError);
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D1", activeSyncRunId: null });
    const r2 = await claimSyncExecution(await reread(a));
    await expect(syncEmailsToDatabase([message(a, "OLD-G1")], r1)).rejects.toThrow("Failed to sync emails to database.");
    await expect(completeSyncExecution(r1, "STALE")).rejects.toBeInstanceOf(StaleSyncExecutionError);
    await releaseSyncExecution(r1);
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D1", syncGeneration: 0, activeSyncRunId: r2.runId });
  });

  it("fences completion when relink happens after valid mail persistence but before checkpoint", async () => {
    const a = await fixture();
    axiosMock.get.mockResolvedValue({ data: page([message(a, "OLD-G1")], "STALE-D1") });
    let newOwner = "";
    interceptCheckpoints((async (args) => {
      expect(await db.email.count({ where: { id: message(a, "OLD-G1").id } })).toBe(1);
      const current = await relink(a, `${a.accessToken}-T2`);
      newOwner = (await claimSyncExecution(current)).runId;
      return realUpdateMany(args);
    }) as typeof realUpdateMany);
    await expect(new Account(a.accessToken).syncEmails()).resolves.toEqual({ status: "ownership-lost", reason: "ownership-lost" });
    expect(await reread(a)).toMatchObject({ syncGeneration: 1, activeSyncRunId: newOwner, latestDeltaToken: null });
  });

  it("Case A: old protected persistence owns the row; PostgreSQL blocks relink until that commit", async () => {
    const a = await fixture(); const old = await claimSyncExecution(a);
    const entered = deferred(); const release = deferred(); let pid = 0;
    interceptTransactions(async (tx) => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      return { ...tx, emailAddress: { ...tx.emailAddress, findUnique: (async (args) => {
        // First child operation is reached only after production FOR UPDATE.
        entered.resolve(); await release.promise; return tx.emailAddress.findUnique(args);
      }) as typeof tx.emailAddress.findUnique } };
    });
    const write = syncEmailsToDatabase([message(a, "OLD-G1")], old);
    await entered.promise;
    const transition = relink(a, `${a.accessToken}-T2`);
    try {
      await vi.waitFor(async () => {
        const blocked = await db.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
        `;
        expect(Number(blocked[0]!.count)).toBeGreaterThan(0);
      }, { timeout: 2000 });
      expect(await reread(a)).toMatchObject({ syncGeneration: 0, accessToken: a.accessToken });
      expect(await db.email.count({ where: { id: message(a, "OLD-G1").id } })).toBe(0);
    } finally { release.resolve(); }
    await write; const current = await transition;
    expect(current).toMatchObject({ syncGeneration: 1, activeSyncRunId: null });
    expect(await db.email.findUniqueOrThrow({ where: { id: message(a, "OLD-G1").id } })).toMatchObject({ subject: "OLD-G1" });
    await expect(completeSyncExecution(old, "STALE")).rejects.toBeInstanceOf(StaleSyncExecutionError);
  });

  it("Case B: already-issued old persistence resumes after durable relink and G2 writes; every final state remains G2", async () => {
    const a = await fixture(); const old = await claimSyncExecution(a);
    const issued = deferred(); const release = deferred(); let first = true;
    interceptTransactions(async (tx) => {
      if (first) { first = false; issued.resolve(); await release.promise; }
      return tx;
    });
    const oldWrite = syncEmailsToDatabase([message(a, "OLD-G1")], old);
    const rejected = expect(oldWrite).rejects.toThrow("Failed to sync emails to database.");
    await issued.promise;
    try {
      const g2 = await relink(a, `${a.accessToken}-T2`);
      const current = await claimSyncExecution(g2);
      const newer = message(a, "NEW-G2");
      await syncEmailsToDatabase([newer], current);
      await completeSyncExecution(current, "G2-D2");
      const next = await claimSyncExecution(await reread(a));
      release.resolve(); await rejected;
      await expect(completeSyncExecution(old, "OLD-D1")).rejects.toBeInstanceOf(StaleSyncExecutionError);
      await releaseSyncExecution(old);
      expect(await reread(a)).toMatchObject({ syncGeneration: 1, accessToken: `${a.accessToken}-T2`, activeSyncRunId: next.runId, latestDeltaToken: "G2-D2" });
      expect(await db.thread.findUniqueOrThrow({ where: { id: newer.threadId } })).toMatchObject({ subject: "NEW-G2", inboxStatus: false, sentStatus: true, draftStatus: false });
      expect(await db.email.findUniqueOrThrow({ where: { id: newer.id } })).toMatchObject({ subject: "NEW-G2", body: "NEW-G2", emailLabel: "sent" });
      expect(await db.emailAttachment.findUniqueOrThrow({ where: { id: newer.attachments[0]!.id } })).toMatchObject({ name: "NEW-G2", content: "NEW-G2", size: 2 });
      expect(await db.emailAddress.findMany({ where: { accountId: a.id } })).toEqual(expect.arrayContaining([expect.objectContaining({ name: "NEW-G2" })]));
      expect(await db.email.count({ where: { threadId: newer.threadId } })).toBe(1);
      expect(await db.emailAddress.count({ where: { accountId: a.id } })).toBe(2);
    } finally { release.resolve(); }
  });
});
