import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "~/type";
const { axiosMock } = vi.hoisted(() => ({ axiosMock: { get: vi.fn(), post: vi.fn() } }));
vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("~/server/db", () => ({ db: {} }));
import { Account } from "~/lib/account";
import { SyncRun, SyncRunFailure } from "~/lib/sync-run";
const email = (id: string) => ({ id }) as EmailMessage;
afterEach(() => vi.restoreAllMocks());

describe("SYNC-001 bounded initial pagination regressions", () => {
  it.each([
    { name: "empty", ids: [[]], cursors: [undefined], requests: [{ deltaToken: "S0" }], valid: true },
    { name: "one page", ids: [["A"]], cursors: [undefined], requests: [{ deltaToken: "S0" }], valid: true },
    { name: "extra page", ids: [["A"], ["B"]], cursors: ["P2", undefined], requests: [{ deltaToken: "S0" }, { pageToken: "P2" }], valid: true },
    { name: "multi page", ids: [["A"], ["B"], ["C"]], cursors: ["P2", "P3", undefined], requests: [{ deltaToken: "S0" }, { pageToken: "P2" }, { pageToken: "P3" }], valid: true },
    { name: "immediate repeat", ids: [["A"], ["B"]], cursors: ["P2", "P2"], requests: [{ deltaToken: "S0" }, { pageToken: "P2" }], valid: false },
    { name: "non-adjacent repeat", ids: [["A"], ["B"], ["C"]], cursors: ["P2", "P3", "P2"], requests: [{ deltaToken: "S0" }, { pageToken: "P2" }, { pageToken: "P3" }], valid: false },
  ])("$name traverses each cursor exactly once without partial success", async (f) => {
    axiosMock.post.mockResolvedValue({ data: { ready: true, syncUpdatedToken: "S0" } });
    let index = 0;
    const requests: object[] = [];
    axiosMock.get.mockImplementation((_url: string, config: { params: object }) => {
      requests.push(config.params);
      if (index >= f.ids.length) throw new Error("Unexpected bounded provider call");
      const i = index++;
      return Promise.resolve({ data: { records: f.ids[i]!.map(email), nextPageToken: f.cursors[i], nextDeltaToken: "D-final" } });
    });
    const run = new SyncRun();
    try {
      const result = new Account("synthetic-token").performInitialSync(run);
      if (f.valid) await expect(result).resolves.toEqual({ emails: f.ids.flat().map(email), latestDeltaToken: "D-final" });
      else await expect(result).rejects.toMatchObject({ outcome: { status: "internal-failure", reason: "provider-contract" } });
      expect(requests).toEqual(f.requests);
    } finally { run.fail(new SyncRunFailure({ status: "cancelled", reason: "cancelled" })); }
  });
});
