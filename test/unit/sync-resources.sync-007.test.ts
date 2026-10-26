import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage, SyncUpdatedEmailsReponse } from "~/type";
const { http, dbMock, persist } = vi.hoisted(() => ({
  http: { get: vi.fn(), post: vi.fn() }, persist: vi.fn(),
  dbMock: { account: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn() },
}));
vi.mock("axios", () => ({ default: http }));
vi.mock("~/server/db", () => ({ db: dbMock }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: persist }));
import { Account } from "~/lib/account";
import { performInitialSync } from "~/lib/initial-sync";
import { executeSync } from "~/lib/sync-run";
import { SYNC_LIMITS, type SyncLimits } from "~/lib/sync-limits";

const a = { id: "A", userId: "U", accessToken: "TOKEN-SECRET", syncGeneration: 1, latestDeltaToken: "D1", activeSyncRunId: null };
const client = new Account(a.accessToken);
let checkpoint: string;
const overflow = { status: "safety-limit", reason: "response-bytes-limit" };
const start = (kind: string, limits: Partial<SyncLimits> = {}) => kind === "initial"
  ? performInitialSync({ accountId: a.id, userId: a.userId }, { limits })
  : client.syncEmails({ limits });
const bytes = (data: object) => Buffer.byteLength(JSON.stringify(data), "utf8");
function page(size: number, id: string, nextPageToken?: string) {
  const data = { records: [{ id, body: "BODY-SECRET-é汉💌" } as EmailMessage], nextDeltaToken: "DELTA-SECRET", nextPageToken, padding: "" };
  const padding = size - bytes(data);
  if (padding < 0) throw new Error("Fixture size too small");
  data.padding = "x".repeat(padding);
  expect(bytes(data)).toBe(size);
  return data;
}
function provider(pages: SyncUpdatedEmailsReponse[]) {
  let index = 0;
  http.get.mockImplementation(() => {
    const data = pages[index++];
    if (!data) throw new Error("Unexpected extra provider page");
    return Promise.resolve({ data }); // Intentionally no Content-Length/header object.
  });
}
function expectNoPersistence() {
  expect(persist).not.toHaveBeenCalled();
  expect(checkpoint).toBe("D1");
  expect(dbMock.account.updateMany.mock.calls.filter(([args]) => "latestDeltaToken" in (args as { data: object }).data)).toHaveLength(0);
}
function expectSafe(outcome: unknown) {
  const output = JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls });
  for (const secret of ["TOKEN-SECRET", "DELTA-SECRET", "BODY-SECRET", "PAGE-SECRET"]) expect(output).not.toContain(secret);
  expect(outcome).not.toHaveProperty("emails"); expect(outcome).not.toHaveProperty("latestDeltaToken");
}
beforeEach(() => {
  vi.useFakeTimers(); checkpoint = "D1";
  dbMock.$transaction.mockImplementation((callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock));
  dbMock.$queryRaw.mockResolvedValue([]);
  dbMock.account.findFirst.mockImplementation(async () => ({ ...a, latestDeltaToken: checkpoint }));
  dbMock.account.findUnique.mockImplementation(async () => ({ ...a, latestDeltaToken: checkpoint }));
  dbMock.account.count.mockResolvedValue(1);
  dbMock.account.updateMany.mockImplementation(async ({ data }: { data: { latestDeltaToken?: string } }) => {
    if (typeof data.latestDeltaToken === "string") checkpoint = data.latestDeltaToken;
    return { count: 1 };
  });
  persist.mockResolvedValue(undefined);
  http.post.mockResolvedValue({ data: { ready: true, syncUpdatedToken: "S0" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("SYNC-007 defaults change only page count and cumulative payload; decimal single-response, records and timing bounds stay fixed", () => {
  expect(SYNC_LIMITS).toEqual({
    requestTimeoutMs: 15000, deadlineMs: 120000, readinessIntervalMs: 1000, maxReadinessPolls: 30,
    maxAttempts: 3, backoffMs: 250, maxPages: 50, maxRecords: 10000,
    maxResponseBytes: 20000000, maxMailboxPayloadBytes: 134217728,
    dbMaxWaitMs: 2000, dbTransactionMs: 5000, dbStatementMs: 4000, dbLockMs: 2000, dbObservationMs: 8000,
  });
});

for (const kind of ["initial", "incremental"]) {
  describe(`SYNC-007 ${kind} per-run resources`, () => {
    it.each([false, true])("page 50 continuation=%s obeys default limit without requesting page 51", async (continuation) => {
      const pages = Array.from({ length: 50 }, (_, i) => ({ records: [{ id: `E${i}` } as EmailMessage], nextDeltaToken: "D-final", nextPageToken: i < 49 || continuation ? `P${i + 2}` : undefined }));
      provider(pages);
      const result = await start(kind); // No maxPages override: production default.
      if (continuation) {
        expect(result).toEqual({ status: "safety-limit", reason: "page-limit" }); expectNoPersistence();
      } else {
        expect(result.status).toBe("completed"); expect(checkpoint).toBe("D-final");
        expect(persist).toHaveBeenCalledWith(pages.flatMap((p) => p.records), expect.anything(), expect.anything());
      }
      expect(http.get).toHaveBeenCalledTimes(50);
      expect(http.get.mock.calls[49]![1]).toMatchObject({ params: { pageToken: "P50" } });
      expect(http.get.mock.calls.some(([, config]) => (config as { params: { pageToken?: string } }).params.pageToken === "P51")).toBe(false);
    });

    it.each([1000, 1001])("serialized cumulative boundary %s without Content-Length uses real measurement and is not retried", async (size) => {
      const data = page(size, "one"); provider([data]);
      const result = await start(kind, { maxMailboxPayloadBytes: 1000 });
      if (size === 1000) { expect(result.status).toBe("completed"); expect(checkpoint).toBe("DELTA-SECRET"); }
      else { expect(result).toEqual(overflow); expectNoPersistence(); expectSafe(result); }
      expect(http.get).toHaveBeenCalledTimes(1);
      expect(http.get.mock.calls[0]![1]).toMatchObject({ maxContentLength: 20000000 });
    });

    it("third individually small page exceeds 1000 cumulative bytes before retaining its records or requesting page four", async () => {
      const pages = [page(400, "first", "P2"), page(400, "second", "P3"), page(201, "overflow", "PAGE-SECRET")];
      expect(pages.map(bytes)).toEqual([400, 400, 201]);
      expect(pages.every((p) => bytes(p) < SYNC_LIMITS.maxResponseBytes)).toBe(true);
      const iterators = pages.map((p) => vi.spyOn(p.records, Symbol.iterator));
      provider(pages);
      const result = await start(kind, { maxMailboxPayloadBytes: 1000 });
      expect(result).toEqual(overflow);
      // JSON serialization reads array indices; spread retention invokes iterator.
      expect(iterators[0]).toHaveBeenCalledTimes(1); expect(iterators[1]).toHaveBeenCalledTimes(1);
      expect(iterators[2]).not.toHaveBeenCalled();
      expect(http.get).toHaveBeenCalledTimes(3); expectNoPersistence(); expectSafe(result);
      await vi.advanceTimersByTimeAsync(1000); expect(http.get).toHaveBeenCalledTimes(3);
    });

    it("counts UTF-8 bytes, not JavaScript character count", async () => {
      const data = { records: [{ id: "unicode", subject: "é汉💌" } as EmailMessage], nextDeltaToken: "D-next" };
      const actualBytes = bytes(data); const limit = actualBytes - 1;
      expect(JSON.stringify(data).length).toBeLessThanOrEqual(limit);
      provider([data]);
      await expect(start(kind, { maxMailboxPayloadBytes: limit })).resolves.toEqual(overflow);
      expectNoPersistence(); expect(http.get).toHaveBeenCalledTimes(1);
    });

    it("serializes each current mailbox response exactly once, never the accumulated dataset", async () => {
      const pages = [page(400, "first", "P2"), page(600, "second")]; provider(pages);
      const serialize = vi.spyOn(JSON, "stringify");
      const result = await start(kind, { maxMailboxPayloadBytes: 1000 });
      expect(result.status).toBe("completed");
      expect(serialize.mock.calls.map(([value]) => value as unknown)).toEqual(pages);
      expect(persist).toHaveBeenCalledWith(pages.flatMap((p) => p.records), expect.anything(), expect.anything());
    });

    it("resets payload and page budgets on each new run, including a reused Account client", async () => {
      const data = page(1000, "one"); http.get.mockResolvedValue({ data });
      const serialize = vi.spyOn(JSON, "stringify");
      for (let run = 0; run < 2; run++) await expect(start(kind, { maxMailboxPayloadBytes: 1000, maxPages: 1 })).resolves.toMatchObject({ status: "completed" });
      expect(http.get).toHaveBeenCalledTimes(2); expect(persist).toHaveBeenCalledTimes(2);
      expect(serialize.mock.calls.filter(([value]) => value === data)).toHaveLength(2);
    });
  });
}

it("excludes readiness POST responses from mailbox budget while retaining their decimal Axios response limit", async () => {
  const control = "c".repeat(2000);
  const notReady = { ready: false, control }; const ready = { ready: true, syncUpdatedToken: "S0", control };
  expect(bytes(notReady)).toBeGreaterThan(1000); expect(bytes(ready)).toBeGreaterThan(1000);
  http.post.mockResolvedValueOnce({ data: notReady }).mockResolvedValueOnce({ data: ready });
  const data = page(1000, "one"); provider([data]);
  const serialize = vi.spyOn(JSON, "stringify");
  const result = start("initial", { maxMailboxPayloadBytes: 1000, readinessIntervalMs: 1 });
  await vi.advanceTimersByTimeAsync(1); await expect(result).resolves.toEqual({ status: "completed" });
  expect(serialize.mock.calls.map(([value]) => value as unknown)).toEqual([data]);
  expect(http.post).toHaveBeenCalledTimes(2); expect(http.get).toHaveBeenCalledTimes(1);
  for (const [, , config] of http.post.mock.calls) expect(config).toMatchObject({ maxContentLength: 20000000 });
});

it("actual payload-limit error passing through SyncRun.request stays typed safety-limit, without retry or provider reclassification", async () => {
  const data = page(1001, "overflow");
  const attempt = vi.fn();
  const result = await executeSync(
    (tx) => tx.account.findUnique({ where: { accessToken: a.accessToken } }),
    async (_account, run) => run.request(async () => {
      attempt(); run.acceptMailboxResponse(data);
      return { emails: data.records, latestDeltaToken: "DELTA-SECRET" };
    }),
    { limits: { maxMailboxPayloadBytes: 1000 } },
  );
  expect(result).toEqual(overflow); expect(attempt).toHaveBeenCalledTimes(1); expectNoPersistence(); expectSafe(result);
  await vi.advanceTimersByTimeAsync(1000); expect(attempt).toHaveBeenCalledTimes(1);
});
