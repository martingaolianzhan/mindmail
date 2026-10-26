import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "~/type";
const { http, dbMock, persist } = vi.hoisted(() => ({
  http: { get: vi.fn(), post: vi.fn() }, persist: vi.fn(),
  dbMock: { account: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn(), updateMany: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn() },
}));
vi.mock("axios", () => ({ default: http }));
vi.mock("~/server/db", () => ({ db: dbMock }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: persist }));
import { Account } from "~/lib/account";
import { performInitialSync } from "~/lib/initial-sync";
import { SyncRun, SyncRunFailure, type SyncRunOptions } from "~/lib/sync-run";
import { observeDatabase, SyncDatabaseObservationError } from "~/lib/sync-database";
import { SYNC_LIMITS } from "~/lib/sync-limits";

const a = { id: "A", userId: "U", accessToken: "TOKEN-SECRET", syncGeneration: 1, latestDeltaToken: "DELTA-SECRET", activeSyncRunId: null };
const options: SyncRunOptions = { limits: { requestTimeoutMs: 100, deadlineMs: 10_000, backoffMs: 10, readinessIntervalMs: 20, maxReadinessPolls: 3, maxPages: 2, maxRecords: 2, dbObservationMs: 200 } };
const page = (count = 0, nextPageToken?: string) => ({ data: { records: Array.from({ length: count }, (_, i) => ({ id: `E${i}`, body: "MAIL-SECRET" }) as EmailMessage), nextDeltaToken: "FINAL-SECRET", nextPageToken } });
const initial = (extra: SyncRunOptions = {}) => performInitialSync({ accountId: a.id, userId: a.userId }, { ...options, ...extra, limits: { ...options.limits, ...extra.limits } });
const incremental = (extra: SyncRunOptions = {}) => new Account(a.accessToken).syncEmails({ ...options, ...extra, limits: { ...options.limits, ...extra.limits } });
const completions = () => dbMock.account.updateMany.mock.calls.filter(([args]) => "latestDeltaToken" in (args as { data: object }).data);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  dbMock.$transaction.mockImplementation((callback: (tx: typeof dbMock) => unknown) => Promise.resolve(callback(dbMock)));
  dbMock.$queryRaw.mockResolvedValue([]);
  dbMock.account.findFirst.mockResolvedValue(a); dbMock.account.findUnique.mockResolvedValue(a);
  dbMock.account.count.mockResolvedValue(1); dbMock.account.updateMany.mockResolvedValue({ count: 1 });
  persist.mockResolvedValue(undefined);
  http.post.mockResolvedValue({ data: { ready: true, syncUpdatedToken: "START-SECRET" } });
  http.get.mockResolvedValue(page());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SYNC-007 finite sync provider retry", () => {
  it.each([
    ["network", { code: "ECONNRESET" }], ["DNS", { code: "EAI_AGAIN" }],
    ["408", { response: { status: 408 } }], ["429", { response: { status: 429 } }],
    ["500", { response: { status: 500 } }], ["503", { response: { status: 503 } }],
    ["Axios timeout", { code: "ECONNABORTED" }],
  ])("%s retries once after exactly one backoff", async (_name, error) => {
    http.get.mockRejectedValueOnce(error);
    const result = incremental();
    await vi.advanceTimersByTimeAsync(0); expect(http.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9); expect(http.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(http.get).toHaveBeenCalledTimes(2);
  });
  it.each([[400, "provider-rejected"], [404, "provider-rejected"], [401, "provider-auth"], [403, "provider-auth"]])("HTTP %s makes exactly one attempt", async (status, reason) => {
    http.get.mockRejectedValue({ response: { status, data: "PROVIDER-SECRET" } });
    await expect(incremental()).resolves.toEqual({ status: "action-required", reason });
    expect(http.get).toHaveBeenCalledTimes(1); expect(completions()).toHaveLength(0);
  });
  it("exhaustion remains retryable with exact linear delays and attempt count", async () => {
    const times: number[] = [];
    http.get.mockImplementation(() => { times.push(Date.now()); return Promise.reject(Object.assign(new Error("RAW-SECRET"), { code: "ECONNRESET" })); });
    const result = incremental();
    await vi.advanceTimersByTimeAsync(0); expect(times).toEqual([0]);
    await vi.advanceTimersByTimeAsync(10); expect(times).toEqual([0, 10]);
    await vi.advanceTimersByTimeAsync(19); expect(times).toEqual([0, 10]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ status: "retryable-failure", reason: "provider-transient" });
    expect(times).toEqual([0, 10, 30]); expect(completions()).toHaveLength(0);
  });
  it.each(["initial", "incremental"] as const)("%s request timeout aborts each attempt, then ends retryable after exactly 3 attempts", async (kind) => {
    const signals: AbortSignal[] = []; const times: number[] = [];
    const pending = (config: { signal: AbortSignal; timeout: number }) => {
      expect(config.timeout).toBe(100); signals.push(config.signal); times.push(Date.now());
      return new Promise(() => undefined); // Deliberately ignores abort: observation still stops.
    };
    if (kind === "initial") http.post.mockImplementation((_url: string, _body: unknown, config: { signal: AbortSignal; timeout: number }) => pending(config));
    else http.get.mockImplementation((_url: string, config: { signal: AbortSignal; timeout: number }) => pending(config));
    const result = kind === "initial" ? initial() : incremental();
    await vi.advanceTimersByTimeAsync(330);
    await expect(result).resolves.toEqual({ status: "retryable-failure", reason: "provider-timeout" });
    expect(times).toEqual([0, 110, 230]); expect(signals.every((s) => s.aborted)).toBe(true);
    expect(completions()).toHaveLength(0);
  });
  it.each(["cancel", "deadline"])("%s during backoff prevents another attempt", async (kind) => {
    const cancel = new AbortController(); http.get.mockRejectedValue({ code: "ECONNRESET" });
    const result = incremental({ signal: cancel.signal, limits: { deadlineMs: kind === "deadline" ? 5 : 1000 } });
    await vi.advanceTimersByTimeAsync(0);
    if (kind === "cancel") cancel.abort(); else await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toEqual(kind === "cancel" ? { status: "cancelled", reason: "cancelled" } : { status: "retryable-failure", reason: "run-deadline" });
    await vi.advanceTimersByTimeAsync(100);
    expect(http.get).toHaveBeenCalledTimes(1); expect(completions()).toHaveLength(0);
  });
  it("known ownership loss aborts a retry wait immediately, without starting another attempt", async () => {
    const run = new SyncRun(options);
    const attempt = vi.fn().mockRejectedValue({ code: "ECONNRESET" });
    const work = run.request(attempt).catch((error: unknown) => run.fail(error));
    await vi.advanceTimersByTimeAsync(0); expect(attempt).toHaveBeenCalledTimes(1);
    run.stop({ status: "ownership-lost", reason: "ownership-lost" });
    await work;
    await expect(run.result).resolves.toEqual({ status: "ownership-lost", reason: "ownership-lost" });
    expect(Date.now()).toBe(0); expect(run.signal.aborted).toBe(true); expect(attempt).toHaveBeenCalledTimes(1);
  });
  it("sendEmail never inherits retry, sync timeouts or signals", async () => {
    http.post.mockRejectedValue({ code: "ETIMEDOUT" });
    await expect(new Account(a.accessToken).sendEmail({ from: { address: "a@example.test" }, to: [{ address: "b@example.test" }], subject: "Synthetic", body: "MAIL-SECRET" })).rejects.toEqual({ code: "ETIMEDOUT" });
    expect(http.post).toHaveBeenCalledTimes(1);
    const config = http.post.mock.calls[0]![2] as object;
    expect(config).not.toHaveProperty("timeout"); expect(config).not.toHaveProperty("signal");
  });
});

describe("SYNC-007 readiness and whole-run control", () => {
  it.each([400, 401, 403])("non-retryable readiness HTTP %s stops after one POST", async (status) => {
    http.post.mockRejectedValue({ response: { status, data: "PROVIDER-SECRET" } });
    await expect(initial()).resolves.toEqual({ status: "action-required", reason: status === 400 ? "provider-rejected" : "provider-auth" });
    expect(http.post).toHaveBeenCalledTimes(1); expect(http.get).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
  });
  it("readiness succeeds on the exact final allowed poll", async () => {
    http.post.mockResolvedValueOnce({ data: { ready: false } }).mockResolvedValueOnce({ data: { ready: false } });
    const result = initial(); await vi.advanceTimersByTimeAsync(40);
    await expect(result).resolves.toEqual({ status: "completed" }); expect(http.post).toHaveBeenCalledTimes(3);
  });
  it("never-ready stops at exactly 3 polls, without GET/persistence/completion", async () => {
    http.post.mockResolvedValue({ data: { ready: false } });
    const result = initial(); await vi.advanceTimersByTimeAsync(40);
    await expect(result).resolves.toEqual({ status: "safety-limit", reason: "readiness-limit" });
    expect(http.post).toHaveBeenCalledTimes(3); expect(http.get).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
  });
  it("transient readiness POST retries finitely without consuming an extra readiness poll", async () => {
    http.post.mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValueOnce({ data: { ready: false } });
    const result = initial(); await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toEqual({ status: "completed" }); expect(http.post).toHaveBeenCalledTimes(3);
  });
  it.each(["cancel", "deadline", "ownership"])("%s during readiness delay stops before the next POST", async (kind) => {
    http.post.mockResolvedValue({ data: { ready: false } }); const cancel = new AbortController();
    const result = initial({ signal: cancel.signal, limits: { deadlineMs: kind === "deadline" ? 10 : 1000 } });
    await vi.advanceTimersByTimeAsync(0);
    const signal = (http.post.mock.calls[0]![2] as { signal: AbortSignal }).signal;
    if (kind === "cancel") cancel.abort();
    if (kind === "ownership") dbMock.account.count.mockResolvedValue(0);
    await vi.advanceTimersByTimeAsync(kind === "ownership" ? 20 : 10);
    await expect(result).resolves.toEqual(kind === "ownership" ? { status: "ownership-lost", reason: "ownership-lost" } : kind === "cancel" ? { status: "cancelled", reason: "cancelled" } : { status: "retryable-failure", reason: "run-deadline" });
    // The per-attempt signal is only connected while its request is in flight.
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(http.post).toHaveBeenCalledTimes(1); expect(http.get).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
  });
  it("each request fits its timeout but the overall sequence exceeds the separate deadline", async () => {
    http.get.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(page(0, "NEXT-SECRET")), 40)));
    const result = incremental({ limits: { deadlineMs: 70, maxPages: 10 } });
    await vi.advanceTimersByTimeAsync(70);
    await expect(result).resolves.toEqual({ status: "retryable-failure", reason: "run-deadline" });
    await vi.advanceTimersByTimeAsync(100);
    expect(http.get).toHaveBeenCalledTimes(2); expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
  });
  it("explicit cancellation aborts an in-flight provider request and late response cannot resurrect the run", async () => {
    const held = deferred<ReturnType<typeof page>>(); const cancel = new AbortController();
    http.get.mockReturnValue(held.promise);
    const result = incremental({ signal: cancel.signal }); await vi.advanceTimersByTimeAsync(0);
    const signal = (http.get.mock.calls[0]![1] as { signal: AbortSignal }).signal;
    cancel.abort(); await expect(result).resolves.toEqual({ status: "cancelled", reason: "cancelled" });
    expect(signal.aborted).toBe(true); held.resolve(page(1, "NEXT-SECRET")); await vi.advanceTimersByTimeAsync(0);
    expect(http.get).toHaveBeenCalledTimes(1); expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
    await expect(result).resolves.toEqual({ status: "cancelled", reason: "cancelled" });
  });
  it("pre-cancelled run starts no lookup, provider request or claim", async () => {
    const cancel = new AbortController(); cancel.abort();
    await expect(initial({ signal: cancel.signal })).resolves.toEqual({ status: "cancelled", reason: "cancelled" });
    expect(dbMock.$transaction).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
  });
});

for (const [name, start] of [["initial", initial], ["incremental", incremental]] as const) {
  describe(`SYNC-007 ${name} page/record limits`, () => {
    it("exact page limit with terminal response succeeds", async () => {
      http.get.mockResolvedValueOnce(page(1, "P2" )).mockResolvedValueOnce(page(1));
      await expect(start()).resolves.toMatchObject({ status: "completed" }); expect(http.get).toHaveBeenCalledTimes(2);
    });
    it("max page already announcing continuation fails immediately without N+1 or persistence", async () => {
      http.get.mockResolvedValueOnce(page(0, "P2")).mockResolvedValueOnce(page(0, "P3"));
      await expect(start()).resolves.toEqual({ status: "safety-limit", reason: "page-limit" });
      expect(http.get).toHaveBeenCalledTimes(2); expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
    });
    it("exact record limit succeeds", async () => {
      http.get.mockResolvedValue(page(2)); await expect(start()).resolves.toMatchObject({ status: "completed" });
    });
    it("accumulated record overflow on page two stops before page three", async () => {
      http.get.mockResolvedValueOnce(page(2, "P2")).mockResolvedValueOnce(page(1, "P3"));
      await expect(start()).resolves.toEqual({ status: "safety-limit", reason: "record-limit" });
      expect(http.get).toHaveBeenCalledTimes(2); expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
    });
    it("limit+1 fails on that response, even when it announces another page", async () => {
      http.get.mockResolvedValue(page(3, "P2"));
      await expect(start()).resolves.toEqual({ status: "safety-limit", reason: "record-limit" });
      expect(http.get).toHaveBeenCalledTimes(1); expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
    });
  });
}

describe("SYNC-007 database bounds and safe contracts", () => {
  it("does not retry persistence or checkpoint completion", async () => {
    persist.mockRejectedValueOnce(new Error("RAW-DB-SECRET"));
    await expect(incremental()).resolves.toEqual({ status: "internal-failure", reason: "persistence-failure" });
    expect(persist).toHaveBeenCalledTimes(1); expect(completions()).toHaveLength(0);
    dbMock.account.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("RAW-COMPLETION-SECRET"));
    await expect(incremental()).resolves.toEqual({ status: "internal-failure", reason: "persistence-failure" });
    expect(completions()).toHaveLength(1); expect(http.get).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, null, {}, { records: null }, { records: "MAIL-SECRET" }])("malformed provider dataset is not retried or persisted (%j)", async (data) => {
    http.get.mockResolvedValue({ data });
    await expect(incremental()).resolves.toEqual({ status: "internal-failure", reason: "provider-contract" });
    expect(http.get).toHaveBeenCalledTimes(1); expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
  });
  it("native DB transaction, pool, statement and lock bounds cover lookup/claim/checks/completion", async () => {
    await expect(incremental()).resolves.toMatchObject({ status: "completed" });
    expect(dbMock.$transaction.mock.calls.length).toBeGreaterThan(4);
    for (const [, bounds] of dbMock.$transaction.mock.calls) expect(bounds).toMatchObject({ maxWait: SYNC_LIMITS.dbMaxWaitMs, timeout: SYNC_LIMITS.dbTransactionMs });
    const sql = dbMock.$queryRaw.mock.calls[0]![0] as TemplateStringsArray;
    expect(sql.join("?")).toContain("statement_timeout"); expect(sql.join("?")).toContain("lock_timeout");
    expect(dbMock.$queryRaw.mock.calls[0]!.slice(1)).toEqual(["4000", "2000"]);
  });
  it("default Axios timeouts are explicit for both sync endpoints", async () => {
    await performInitialSync({ accountId: a.id, userId: a.userId });
    expect(http.post.mock.calls[0]![2]).toMatchObject({ timeout: 15000, signal: expect.any(AbortSignal), maxContentLength: 20000000 });
    expect(http.get.mock.calls[0]![1]).toMatchObject({ timeout: 15000, signal: expect.any(AbortSignal), maxContentLength: 20000000 });
  });
  it.each(["lookup", "claim"])("%s acknowledgement expiry is bounded/indeterminate and cannot resume provider work late", async (kind) => {
    const held = deferred<unknown>();
    if (kind === "lookup") dbMock.account.findUnique.mockReturnValue(held.promise);
    else dbMock.account.updateMany.mockReturnValueOnce(held.promise);
    const result = incremental(); await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
    expect(http.get).not.toHaveBeenCalled();
    held.resolve(kind === "lookup" ? a : { count: 1 }); await vi.advanceTimersByTimeAsync(0);
    expect(http.get).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
  });
  it("ownership observation timeout is indeterminate, not proof of DB failure", async () => {
    const held = deferred<number>(); dbMock.account.count.mockReturnValue(held.promise);
    const result = incremental(); await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
    expect(http.get).not.toHaveBeenCalled(); held.resolve(1); await vi.advanceTimersByTimeAsync(0);
    expect(completions()).toHaveLength(0);
  });
  it("post-response ownership observation expiry is not reclassified/retried as a provider timeout", async () => {
    const held = deferred<number>();
    dbMock.account.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockReturnValueOnce(held.promise);
    const result = incremental(); await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual({ status: "indeterminate-completion", reason: "completion-indeterminate" });
    expect(dbMock.account.count).toHaveBeenCalledTimes(3); expect(http.get).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled(); expect(completions()).toHaveLength(0);
    held.resolve(1); await vi.advanceTimersByTimeAsync(0);
    expect(http.get).toHaveBeenCalledTimes(1);
  });
  it("database observation expiry does not cancel a late underlying mutation", async () => {
    let committed = false; const held = deferred<void>();
    const observed = observeDatabase(held.promise.then(() => { committed = true; }), 10);
    const assertion = expect(observed).rejects.toBeInstanceOf(SyncDatabaseObservationError);
    await vi.advanceTimersByTimeAsync(10); await assertion; expect(committed).toBe(false);
    held.resolve(); await vi.advanceTimersByTimeAsync(0); expect(committed).toBe(true);
  });
  it("failure and indeterminate results/logs have no sensitive provider/mail/raw-error detail", async () => {
    http.get.mockRejectedValue({ code: "ECONNRESET", message: "RAW-SECRET", config: { token: a.accessToken }, response: { data: "PROVIDER-SECRET PAGE-SECRET MAIL-SECRET FINAL-SECRET" } });
    const result = incremental(); await vi.advanceTimersByTimeAsync(30);
    const outcome = await result;
    const serialized = JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls });
    for (const secret of [a.accessToken, a.latestDeltaToken, "RAW-SECRET", "PROVIDER-SECRET", "PAGE-SECRET", "MAIL-SECRET", "FINAL-SECRET"]) expect(serialized).not.toContain(secret);
    expect(Object.keys(outcome).sort()).toEqual(["reason", "status"]);
  });
  it("local final state is immutable; requesting termination is distinct from finalizing it", async () => {
    const run = new SyncRun(options); const final = run.result;
    run.stop({ status: "cancelled", reason: "cancelled" }); expect(run.state).toBe("termination-pending");
    expect(run.signal.aborted).toBe(true);
    run.fail(new SyncRunFailure({ status: "cancelled", reason: "cancelled" }));
    await expect(final).resolves.toEqual({ status: "cancelled", reason: "cancelled" }); expect(run.state).toBe("terminated");
    run.stop({ status: "retryable-failure", reason: "run-deadline" }); expect(run.state).toBe("terminated");
  });
});
