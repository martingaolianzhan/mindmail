import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account as DbAccount } from "@prisma/client";
import type { EmailMessage } from "~/type";
import { NextRequest } from "next/server";
const { http, exchange } = vi.hoisted(() => ({ http: { get: vi.fn(), post: vi.fn() }, exchange: vi.fn() }));
vi.mock("axios", () => ({ default: http }));
vi.mock("@clerk/nextjs/server", async () => (await import("../mocks/clerk")).clerkServerMock);
vi.mock("~/lib/aurinko", () => ({ exchangeCodeForAccessToken: exchange, getAccountDetails: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("~/lib/sync-orchestration", () => ({ orchestrateAccountSync: vi.fn(async () => ({ status: "completed" })) }));
import type * as Initial from "~/lib/initial-sync";
const { performInitialSync } = await vi.importActual<typeof Initial>("~/lib/initial-sync");
import { Account } from "~/lib/account";
import { db } from "~/server/db";
import { testSyncSchedule, scheduleTestRun } from "../helpers/scheduling";
import * as executions from "~/lib/sync-execution";
import * as persistence from "~/lib/sync-to-db";
import { GET } from "~/app/api/aurinko/callback/route";
import { createAurinkoOAuthCorrelation, AURINKO_OAUTH_STATE_COOKIE } from "~/lib/aurinko-oauth-state";
import { clerkAuthMock } from "../mocks/clerk";
import { syntheticEmail } from "../fixtures/emails";
import { interceptTransactions, restoreTransactions } from "../helpers/transactions";

const prefix = `sync007-${crypto.randomUUID()}`; const userId = `${prefix}-user`;
let sequence = Date.now() * 100;
const ids: string[] = [];
const limits = { deadlineMs: 1000, requestTimeoutMs: 2000, dbObservationMs: 3000 };
const realComplete = executions.completeSyncExecution;
const realTerminate = executions.terminateSyncExecution;
const realOwns = executions.ownsSyncExecution;
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
async function fixture() {
  const id = String(sequence++); ids.push(id);
  return db.account.create({ data: { ...testSyncSchedule, id, userId, accessToken: `${prefix}-${id}-TOKEN-SECRET`, latestDeltaToken: "D0", emailAddress: `${id}@example.test`, name: "Synthetic" } });
}
const reread = (a: DbAccount) => db.account.findUniqueOrThrow({ where: { id: a.id } });
function message(a: DbAccount, suffix: string): EmailMessage {
  return { ...syntheticEmail, id: `${prefix}-${a.id}-${suffix}`, threadId: `${prefix}-${a.id}-${suffix}-thread`, nativeProperties: {} as never, attachments: [], hasAttachments: false } as EmailMessage;
}
async function relink(a: DbAccount) {
  clerkAuthMock.mockResolvedValue({ userId }); exchange.mockResolvedValue({ accountId: Number(a.id), accessToken: `${a.accessToken}-T2` });
  const c = createAurinkoOAuthCorrelation(userId);
  const response = await GET(new NextRequest(`http://mindmail.test/api/aurinko/callback?status=success&code=synthetic&state=${c.state}`, { headers: { cookie: `${AURINKO_OAUTH_STATE_COOKIE}=${c.value}` } }));
  expect(response.status).toBe(307); return reread(a);
}
beforeAll(async () => {
  vi.stubEnv("AURINKO_OAUTH_STATE_SECRET", "synthetic-sync007-state-secret");
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  http.get.mockReset().mockResolvedValue({ data: { records: [], nextDeltaToken: "D1" } });
  http.post.mockReset().mockResolvedValue({ data: { ready: true, syncUpdatedToken: "S0" } });
  vi.spyOn(console, "log").mockImplementation(() => undefined); vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); restoreTransactions(); });
afterAll(async () => {
  await db.emailAttachment.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.email.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.thread.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.emailAddress.deleteMany({ where: { accountId: { in: ids } } });
  await db.account.deleteMany({ where: { id: { in: ids } } });
  await db.user.delete({ where: { id: userId } }); await db.$disconnect(); vi.unstubAllEnvs();
});

describe("SYNC-007 real PostgreSQL completion/termination linearization", () => {
  it.each(["initial", "incremental"] as const)("%s: termination wins; already-submitted late completion is fenced", async (kind) => {
    const a = await fixture(); const entered = deferred(); const release = deferred();
    const completion = vi.spyOn(executions, "completeSyncExecution").mockImplementation(async (execution, token, bounds) => {
      entered.resolve(); await release.promise; return realComplete(execution, token, bounds);
    });
    const run = kind === "initial" ? performInitialSync({ accountId: a.id, userId }, { limits }) : new Account(a.accessToken).syncEmails({ limits });
    await entered.promise;
    expect((await reread(a)).activeSyncRunId).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(run).resolves.toEqual({ status: "retryable-failure", reason: "run-deadline" });
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D0", activeSyncRunId: null });
    release.resolve();
    await expect(completion.mock.results[0]!.value).rejects.toBeInstanceOf(executions.StaleSyncExecutionError);
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D0", activeSyncRunId: null });
    await expect(run).resolves.toEqual({ status: "retryable-failure", reason: "run-deadline" });
  });
  it.each(["initial", "incremental"] as const)("%s: completion wins; a later deadline never rolls back committed D1", async (kind) => {
    const a = await fixture(); const committed = deferred(); const ack = deferred();
    vi.spyOn(executions, "completeSyncExecution").mockImplementation(async (execution, token, bounds) => {
      await realComplete(execution, token, bounds); committed.resolve(); await ack.promise;
    });
    const termination = vi.spyOn(executions, "terminateSyncExecution");
    const run = kind === "initial" ? performInitialSync({ accountId: a.id, userId }, { limits }) : new Account(a.accessToken).syncEmails({ limits });
    await committed.promise;
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D1", activeSyncRunId: null });
    await vi.advanceTimersByTimeAsync(1000); ack.resolve();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    await expect(termination.mock.results[0]!.value).resolves.toBe(false);
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D1", activeSyncRunId: null });
    await vi.advanceTimersByTimeAsync(1000); await expect(run).resolves.toMatchObject({ status: "completed" });
  });
  it.each([false, true])("lost completion acknowledgement is indeterminate, including token equality after later run=%s", async (laterRun) => {
    const a = await fixture(); const committed = deferred(); const ack = deferred();
    vi.spyOn(executions, "completeSyncExecution").mockImplementation(async (execution, token, bounds) => {
      await realComplete(execution, token, bounds); committed.resolve(); await ack.promise;
      throw new Error("RAW-DB-SECRET FINAL-TOKEN-SECRET MAIL-SECRET");
    });
    const run = new Account(a.accessToken).syncEmails({ limits }); await committed.promise;
    if (laterRun) {
      const next = await executions.claimSyncExecution(await scheduleTestRun(a));
      await realComplete(next, "D1"); // Equivalent visible checkpoint is not R1 provenance.
    }
    ack.resolve();
    const outcome = await run;
    expect(outcome).toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D1", activeSyncRunId: null });
    expect(JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls })).not.toMatch(/SECRET/);
  });
  it("termination-pending is not final until revocation acknowledges; no false timeout certainty", async () => {
    const a = await fixture(); const provider = deferred<{ data: object }>(); const started = deferred();
    const revoke = deferred(); const entered = deferred();
    http.get.mockImplementationOnce(() => { started.resolve(); return provider.promise; });
    const termination = vi.spyOn(executions, "terminateSyncExecution").mockImplementation(async (execution, bounds) => { entered.resolve(); await revoke.promise; return realTerminate(execution, bounds); });
    const run = new Account(a.accessToken).syncEmails({ limits }); let settled = false; void run.then(() => { settled = true; });
    await started.promise; await vi.advanceTimersByTimeAsync(1000); await entered.promise;
    expect(settled).toBe(false); expect((await reread(a)).activeSyncRunId).not.toBeNull();
    revoke.resolve(); await expect(run).resolves.toEqual({ status: "retryable-failure", reason: "run-deadline" });
    await termination.mock.results[0]!.value;
    provider.resolve({ data: { records: [], nextPageToken: "P2", nextDeltaToken: "D-late" } });
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D0", activeSyncRunId: null });
    expect(http.get).toHaveBeenCalledTimes(1);
  });
});

describe("SYNC-007 real ownership loss and late work", () => {
  it.each(["page", "readiness", "retry"] as const)("production relink during gated %s stops all avoidable work and propagates abort", async (kind) => {
    const a = await fixture(); const started = deferred(); const held = deferred<{ data: object }>();
    let signal!: AbortSignal;
    if (kind === "readiness") http.post.mockImplementationOnce((_url: string, _body: unknown, config: { signal: AbortSignal }) => { signal = config.signal; started.resolve(); return held.promise; });
    else http.get.mockImplementationOnce((_url: string, config: { signal: AbortSignal }) => { signal = config.signal; started.resolve(); return held.promise; });
    const persisted = vi.spyOn(persistence, "syncEmailsToDatabase"); const completed = vi.spyOn(executions, "completeSyncExecution");
    const run = kind === "readiness" ? performInitialSync({ accountId: a.id, userId }, { limits }) : new Account(a.accessToken).syncEmails({ limits });
    await started.promise; const owner = (await reread(a)).activeSyncRunId; expect(owner).not.toBeNull();
    const g2 = await relink(a); expect(g2).toMatchObject({ syncGeneration: 1, activeSyncRunId: null, latestDeltaToken: null });
    const current = await executions.claimSyncExecution(g2);
    if (kind === "retry") held.reject({ code: "ECONNRESET", response: { data: "PROVIDER-SECRET" } });
    else held.resolve({ data: kind === "readiness" ? { ready: false } : { records: [message(a, "stale")], nextPageToken: "P2" } });
    await expect(run).resolves.toEqual({ status: "ownership-lost", reason: "ownership-lost" });
    expect(signal.aborted).toBe(true); expect(persisted).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
    expect(http.get).toHaveBeenCalledTimes(kind === "readiness" ? 0 : 1); expect(http.post).toHaveBeenCalledTimes(kind === "readiness" ? 1 : 0);
    expect(await reread(a)).toMatchObject({ syncGeneration: 1, activeSyncRunId: current.runId, latestDeltaToken: null });
    expect(await db.email.count({ where: { thread: { accountId: a.id } } })).toBe(0);
  });
  it.each(["cancel", "deadline"] as const)("%s during email K drains K but starts neither K+1 nor completion", async (kind) => {
    const a = await fixture(); const entered = deferred(); const release = deferred(); const cancel = new AbortController();
    const first = message(a, "first"); const second = message(a, "second");
    http.get.mockResolvedValue({ data: { records: [first, second], nextDeltaToken: "D1" } });
    let transactions = 0;
    interceptTransactions((tx) => {
      transactions++;
      return { ...tx, emailAddress: { ...tx.emailAddress, findUnique: (async (args) => { entered.resolve(); await release.promise; return tx.emailAddress.findUnique(args); }) as typeof tx.emailAddress.findUnique } };
    });
    const completion = vi.spyOn(executions, "completeSyncExecution");
    const run = new Account(a.accessToken).syncEmails({ signal: cancel.signal, limits }); await entered.promise;
    if (kind === "cancel") cancel.abort(); else await vi.advanceTimersByTimeAsync(1000);
    expect(transactions).toBe(1); expect(completion).not.toHaveBeenCalled();
    release.resolve();
    await expect(run).resolves.toEqual(kind === "cancel" ? { status: "cancelled", reason: "cancelled" } : { status: "retryable-failure", reason: "run-deadline" });
    expect(transactions).toBe(1); expect(completion).not.toHaveBeenCalled();
    expect(await db.email.count({ where: { id: first.id } })).toBe(1);
    expect(await db.email.count({ where: { id: second.id } })).toBe(0);
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D0", activeSyncRunId: null });
  });
});

describe("SYNC-007 uncertain DB acknowledgements are not cancellation", () => {
  it("native PostgreSQL lock timeout bounds arbitration (25ms), with sanitized indeterminate result", async () => {
    const a = await fixture(); const started = deferred(); const provider = deferred<{ data: object }>();
    http.get.mockImplementationOnce(() => { started.resolve(); return provider.promise; });
    const cancel = new AbortController();
    const run = new Account(a.accessToken).syncEmails({ signal: cancel.signal, limits: { ...limits, dbLockMs: 25, dbStatementMs: 50, dbTransactionMs: 500, dbMaxWaitMs: 200 } });
    await started.promise;
    const locked = deferred(); const release = deferred();
    const holding = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${a.id} FOR UPDATE`;
      locked.resolve(); await release.promise;
    }, { maxWait: 500, timeout: 1000 });
    await locked.promise;
    try {
      cancel.abort();
      const outcome = await run; // Native PG clock, not a real multi-second JS wait.
      expect(outcome).toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
      expect(JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls })).not.toMatch(/TOKEN-SECRET|Invalid.*invocation|UPDATE|P2010/);
    } finally { release.resolve(); await holding; }
    provider.resolve({ data: { records: [], nextDeltaToken: "D-late" } });
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D0", activeSyncRunId: expect.any(String) });
  });
  it("completion observation expires after actual commit: indeterminate, never false unchanged or completed", async () => {
    const a = await fixture(); const committed = deferred(); const ack = deferred();
    const completion = vi.spyOn(executions, "completeSyncExecution").mockImplementation(async (execution, token, bounds) => { await realComplete(execution, token, bounds); committed.resolve(); await ack.promise; });
    const run = new Account(a.accessToken).syncEmails({ limits: { ...limits, dbObservationMs: 300 } }); await committed.promise;
    await vi.advanceTimersByTimeAsync(300);
    await expect(run).resolves.toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
    expect(await reread(a)).toMatchObject({ latestDeltaToken: "D1", activeSyncRunId: null });
    ack.resolve(); await completion.mock.results[0]!.value;
    await expect(run).resolves.toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
  });
  it("revocation observation expires: indeterminate; late conditional UPDATE cannot clear G2 owner", async () => {
    const a = await fixture(); const started = deferred(); const provider = deferred<{ data: object }>();
    http.get.mockImplementationOnce(() => { started.resolve(); return provider.promise; });
    const release = deferred(); const entered = deferred();
    const termination = vi.spyOn(executions, "terminateSyncExecution").mockImplementation(async (execution, bounds) => { entered.resolve(); await release.promise; return realTerminate(execution, bounds); });
    const run = new Account(a.accessToken).syncEmails({ limits }); await started.promise;
    await vi.advanceTimersByTimeAsync(1000); await entered.promise; await vi.advanceTimersByTimeAsync(3000);
    await expect(run).resolves.toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
    const current = await executions.claimSyncExecution(await relink(a));
    release.resolve(); await expect(termination.mock.results[0]!.value).resolves.toBe(false);
    provider.resolve({ data: { records: [], nextDeltaToken: "D-late" } });
    expect(await reread(a)).toMatchObject({ activeSyncRunId: current.runId, syncGeneration: 1, latestDeltaToken: null });
  });
  it("required authority reread observation expires: zero-row termination is not enough to assert why", async () => {
    const a = await fixture(); const started = deferred(); const provider = deferred<{ data: object }>();
    http.get.mockImplementationOnce(() => { started.resolve(); return provider.promise; });
    const cancel = new AbortController(); const run = new Account(a.accessToken).syncEmails({ signal: cancel.signal, limits }); await started.promise;
    await relink(a);
    const entered = deferred(); const release = deferred();
    const owns = vi.spyOn(executions, "ownsSyncExecution").mockImplementation(async (execution, bounds) => { entered.resolve(); await release.promise; return realOwns(execution, bounds); });
    cancel.abort(); await entered.promise; await vi.advanceTimersByTimeAsync(3000);
    await expect(run).resolves.toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
    release.resolve(); await expect(owns.mock.results[0]!.value).resolves.toBe(false);
    provider.resolve({ data: { records: [], nextDeltaToken: "D-late" } });
    expect(await reread(a)).toMatchObject({ latestDeltaToken: null, activeSyncRunId: null, syncGeneration: 1 });
  });
});
