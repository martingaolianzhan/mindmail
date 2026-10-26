import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage, SyncUpdatedEmailsReponse } from "~/type";

const { axiosMock, dbMock, persist } = vi.hoisted(() => ({
  axiosMock: { get: vi.fn(), post: vi.fn() },
  dbMock: { account: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), count: vi.fn() } },
  persist: vi.fn(),
}));
vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("~/lib/sync-database", async (original) => ({ ...await original<object>(), ...await import("../mocks/sync-database") }));
vi.mock("~/server/db", () => ({ db: dbMock }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: persist }));
import { Account } from "~/lib/account";
import { performInitialSync } from "~/lib/initial-sync";

const a = { id: "A1", userId: "U1", accessToken: "synthetic-T1", syncGeneration: 0, activeSyncRunId: null, latestDeltaToken: "D1" };
const email = (id: string) => ({ id }) as EmailMessage;
const page = (records: EmailMessage[], nextDeltaToken?: string, nextPageToken?: string): SyncUpdatedEmailsReponse => ({ records, nextDeltaToken, nextPageToken });
const checkpointWrites = () => dbMock.account.updateMany.mock.calls.filter(([args]) => "latestDeltaToken" in (args as { data: object }).data);

function provider(pages: SyncUpdatedEmailsReponse[]) {
  let index = 0;
  axiosMock.get.mockImplementation(() => {
    const next = pages[index++];
    if (!next) throw new Error("Unexpected provider request");
    return Promise.resolve({ data: next });
  });
}
const requests = () => axiosMock.get.mock.calls.map(([, config]) => (config as { params: object }).params);
const fixtures = [
  { name: "empty terminal", pages: [page([], "D-final")], ids: [], requests: [] },
  { name: "one page", pages: [page([email("A")], "D-final")], ids: ["A"], requests: [] },
  { name: "one extra page", pages: [page([email("A")], undefined, "P1"), page([email("B")], "D-final")], ids: ["A", "B"], requests: [{ pageToken: "P1" }] },
  { name: "multiple pages", pages: [page([email("A")], "IGNORE-intermediate", "P1"), page([email("B")], undefined, "P2"), page([email("C")], "D-final")], ids: ["A", "B", "C"], requests: [{ pageToken: "P1" }, { pageToken: "P2" }] },
];

beforeEach(() => {
  dbMock.account.findFirst.mockResolvedValue({ ...a, latestDeltaToken: null });
  dbMock.account.findUnique.mockResolvedValue(a);
  dbMock.account.updateMany.mockResolvedValue({ count: 1 });
  dbMock.account.count.mockResolvedValue(1);
  persist.mockResolvedValue(undefined);
  axiosMock.post.mockResolvedValue({ data: { ready: true, syncUpdatedToken: "S0" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SYNC-006 terminal checkpoint contract", () => {
  it.each([
    { name: "missing", data: { ready: true } },
    ...[undefined, null, "", "   ", 42, false, {}, []].map((token) => ({ name: `invalid ${JSON.stringify(token)}`, data: { ready: true, syncUpdatedToken: token } })),
  ])("initial $name S0 fails before updated GET, persistence or completion", async ({ data }) => {
    axiosMock.post.mockResolvedValue({ data });
    provider([page([email("must-not-persist")], "must-not-commit")]);
    await expect(performInitialSync({ accountId: a.id, userId: a.userId })).resolves.toEqual({ status: "internal-failure", reason: "provider-contract" });
    expect(axiosMock.get).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(checkpointWrites()).toHaveLength(0);
  });

  it("validates the response that becomes ready, not an earlier readiness response's token", async () => {
    vi.useFakeTimers();
    axiosMock.post.mockResolvedValueOnce({ data: { ready: false, syncUpdatedToken: "NOT-READY-S0" } })
      .mockResolvedValueOnce({ data: { ready: true, syncUpdatedToken: "" } });
    provider([page([], "must-not-commit")]);
    const run = performInitialSync({ accountId: a.id, userId: a.userId });
    await vi.runAllTimersAsync();
    await expect(run).resolves.toEqual({ status: "internal-failure", reason: "provider-contract" });
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
    expect(axiosMock.get).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(checkpointWrites()).toHaveLength(0);
  });

  it.each(fixtures)("initial $name uses terminal delta, never the start/page/intermediate token", async (f) => {
    provider(f.pages);
    await expect(performInitialSync({ accountId: a.id, userId: a.userId })).resolves.toEqual({ status: "completed" });
    expect(requests()).toEqual([{ deltaToken: "S0" }, ...f.requests]);
    expect(persist).toHaveBeenCalledWith(f.ids.map(email), expect.objectContaining({ accountId: a.id, generation: 0 }), expect.anything());
    const writes = checkpointWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toMatchObject({ data: { latestDeltaToken: "D-final", activeSyncRunId: null } });
    // Claim is the first update; actual completion is the second, after persistence.
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(dbMock.account.updateMany.mock.invocationCallOrder[1]!);
    expect(axiosMock.post).toHaveBeenCalledWith("https://api.aurinko.io/v1/email/sync", {}, expect.objectContaining({ params: { daysWithin: 2, bodyType: "html" } }));
  });

  it.each(fixtures)("incremental $name commits only its terminal delta", async (f) => {
    provider(f.pages);
    await expect(new Account(a.accessToken).syncEmails()).resolves.toMatchObject({ latestDeltaToken: "D-final", emails: f.ids.map(email) });
    expect(requests()).toEqual([{ deltaToken: "D1" }, ...f.requests]);
    expect(checkpointWrites()).toHaveLength(1);
    expect(checkpointWrites()[0]?.[0]).toMatchObject({ data: { latestDeltaToken: "D-final" } });
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(dbMock.account.updateMany.mock.invocationCallOrder[1]!);
  });

  for (const mode of ["initial", "incremental"] as const) {
    it.each([undefined, null, "", "   ", 42])(`${mode} rejects invalid terminal delta %s without persistence/checkpoint or fallback`, async (invalid) => {
      // An earlier page's delta must not mask a malformed terminal page.
      provider([page([email("A")], "DO-NOT-REUSE", "P1"), { records: [email("B")], nextDeltaToken: invalid } as SyncUpdatedEmailsReponse]);
      const run = mode === "initial" ? performInitialSync({ accountId: a.id, userId: a.userId }) : new Account(a.accessToken).syncEmails();
      await expect(run).resolves.toEqual({ status: "internal-failure", reason: "provider-contract" });
      expect(persist).not.toHaveBeenCalled();
      expect(checkpointWrites()).toHaveLength(0);
    });

    it(`${mode} fails a single terminal page without a delta instead of retaining the start/prior token`, async () => {
      provider([{ records: [] }]);
      const run = mode === "initial" ? performInitialSync({ accountId: a.id, userId: a.userId }) : new Account(a.accessToken).syncEmails();
      await expect(run).resolves.toEqual({ status: "internal-failure", reason: "provider-contract" });
      expect(persist).not.toHaveBeenCalled();
      expect(checkpointWrites()).toHaveLength(0);
    });
  }

  it("signals reinitialization required before claim, persistence or any provider work", async () => {
    dbMock.account.findUnique.mockResolvedValue({ ...a, syncGeneration: 1, latestDeltaToken: null });
    await expect(new Account(a.accessToken).syncEmails()).resolves.toEqual({ status: "action-required", reason: "reinitialization-required" });
    expect(axiosMock.get).not.toHaveBeenCalled();
    expect(axiosMock.post).not.toHaveBeenCalled();
    expect(dbMock.account.updateMany).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    [page([], undefined, "P1"), page([], undefined, "P1")],
    [page([], undefined, "P1"), page([], undefined, "P2"), page([], undefined, "P1")],
  ])("incremental repeated cursors fail before persistence without requesting a repeated page twice", async (...pages) => {
    provider(pages);
    await expect(new Account(a.accessToken).syncEmails()).resolves.toEqual({ status: "internal-failure", reason: "provider-contract" });
    expect(axiosMock.get).toHaveBeenCalledTimes(pages.length);
    expect(persist).not.toHaveBeenCalled();
    expect(checkpointWrites()).toHaveLength(0);
  });
});
