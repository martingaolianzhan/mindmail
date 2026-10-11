import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailMessage, SyncUpdatedEmailsReponse } from "~/type";

const { axiosMock, dbMock } = vi.hoisted(() => ({
  axiosMock: { get: vi.fn(), post: vi.fn() },
  dbMock: { account: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("~/server/db", () => ({ db: dbMock }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: vi.fn() }));

import { Account } from "~/lib/account";

type Request = { deltaToken?: string; pageToken?: string };

const email = (id: string) => ({ id }) as EmailMessage;
const page = (records: EmailMessage[], nextPageToken?: string): SyncUpdatedEmailsReponse => ({
  records,
  nextDeltaToken: "synthetic-next-delta",
  nextPageToken,
});

function configurePagination(expectedRequests: Request[], responses: SyncUpdatedEmailsReponse[]) {
  const observedRequests: Request[] = [];
  let responseIndex = 0;

  axiosMock.post.mockResolvedValue({
    data: { ready: true, syncUpdatedToken: "synthetic-initial-delta" },
  });
  axiosMock.get.mockImplementation((_url: string, config: { params: Request }) => {
    const request = config.params;
    observedRequests.push(request);
    const expectedRequest = expectedRequests[responseIndex];
    const response = responses[responseIndex++];

    if (!expectedRequest || !response || JSON.stringify(request) !== JSON.stringify(expectedRequest)) {
      return Promise.reject(new Error("Unexpected bounded pagination request"));
    }

    return Promise.resolve({ data: response });
  });

  return observedRequests;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SYNC-001 Account.performInitialSync pagination", () => {
  it("returns the initial page without a page-token request when no additional page exists", async () => {
    const record = email("A");
    const observed = configurePagination([{ deltaToken: "synthetic-initial-delta" }], [page([record])]);

    await expect(new Account("synthetic-token").performInitialSync()).resolves.toMatchObject({ emails: [record] });

    expect(observed).toEqual([{ deltaToken: "synthetic-initial-delta" }]);
  });

  it("returns an empty initial page without requesting another page", async () => {
    const observed = configurePagination([{ deltaToken: "synthetic-initial-delta" }], [page([])]);

    await expect(new Account("synthetic-token").performInitialSync()).resolves.toMatchObject({ emails: [] });

    expect(observed).toEqual([{ deltaToken: "synthetic-initial-delta" }]);
  });

  it("requests one additional page once and preserves traversal order", async () => {
    const first = email("A");
    const second = email("B");
    const observed = configurePagination(
      [{ deltaToken: "synthetic-initial-delta" }, { pageToken: "P2" }],
      [page([first], "P2"), page([second])],
    );

    await expect(new Account("synthetic-token").performInitialSync()).resolves.toMatchObject({ emails: [first, second] });

    expect(observed).toEqual([{ deltaToken: "synthetic-initial-delta" }, { pageToken: "P2" }]);
    expect(observed.filter((request) => request.pageToken === "P2")).toHaveLength(1);
  });

  it("advances P2 to P3, aggregating every page once in traversal order", async () => {
    const first = email("A");
    const second = email("B");
    const third = email("C");
    const observed = configurePagination(
      [{ deltaToken: "synthetic-initial-delta" }, { pageToken: "P2" }, { pageToken: "P3" }],
      [page([first], "P2"), page([second], "P3"), page([third])],
    );

    await expect(new Account("synthetic-token").performInitialSync()).resolves.toMatchObject({ emails: [first, second, third] });

    // The bounded sequence makes the former P2 -> P2 loop return undefined, while these
    // request/result assertions prove the required P2 -> P3 traversal.
    expect(observed).toEqual([
      { deltaToken: "synthetic-initial-delta" },
      { pageToken: "P2" },
      { pageToken: "P3" },
    ]);
    expect(observed.filter((request) => request.pageToken === "P2")).toHaveLength(1);
    expect(observed.filter((request) => request.pageToken === "P3")).toHaveLength(1);
  });

  it("fails through the existing undefined contract before requesting an immediate repeated token", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const observed = configurePagination(
      [{ deltaToken: "synthetic-initial-delta" }, { pageToken: "P2" }],
      [page([email("A")], "P2"), page([email("B")], "P2")],
    );

    await expect(new Account("synthetic-token").performInitialSync()).resolves.toBeUndefined();

    expect(observed).toEqual([{ deltaToken: "synthetic-initial-delta" }, { pageToken: "P2" }]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Initial sync failed.");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("fails before a non-adjacent P2 -> P3 -> P2 cycle requests P2 again", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const observed = configurePagination(
      [{ deltaToken: "synthetic-initial-delta" }, { pageToken: "P2" }, { pageToken: "P3" }],
      [page([email("A")], "P2"), page([email("B")], "P3"), page([email("C")], "P2")],
    );

    await expect(new Account("synthetic-token").performInitialSync()).resolves.toBeUndefined();

    expect(observed).toEqual([
      { deltaToken: "synthetic-initial-delta" },
      { pageToken: "P2" },
      { pageToken: "P3" },
    ]);
    expect(observed.filter((request) => request.pageToken === "P2")).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Initial sync failed.");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
