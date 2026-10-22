import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailMessage, SyncUpdatedEmailsReponse } from "~/type";
import { execution } from "../fixtures/sync-execution";
import type * as SyncExecutionModule from "~/lib/sync-execution";
vi.mock("~/lib/sync-execution", async (original) => ({
  ...await original<typeof SyncExecutionModule>(),
  claimSyncExecution: vi.fn(async () => execution), releaseSyncExecution: vi.fn(),
}));

const { axiosMock, dbMock, syncEmailsToDatabaseMock } = vi.hoisted(() => ({
  axiosMock: { get: vi.fn() },
  dbMock: { account: { findUnique: vi.fn(), updateMany: vi.fn() } },
  syncEmailsToDatabaseMock: vi.fn(),
}));

vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("~/server/db", () => ({ db: dbMock }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: syncEmailsToDatabaseMock }));

import { Account } from "~/lib/account";

type Request = { deltaToken?: string; pageToken?: string };

const email = (id: string) => ({ id }) as EmailMessage;
const page = (records: EmailMessage[], nextPageToken?: string): SyncUpdatedEmailsReponse => ({
  records,
  nextDeltaToken: "D2",
  nextPageToken,
});

function configureAccount(responses: SyncUpdatedEmailsReponse[]) {
  const account = { id: "account-id", latestDeltaToken: "D1" };
  const requests: Request[] = [];
  let index = 0;
  dbMock.account.findUnique.mockResolvedValue(account);
  axiosMock.get.mockImplementation((_url: string, config: { params: Request }) => {
    requests.push(config.params);
    const response = responses[index++];
    return response ? Promise.resolve({ data: response }) : Promise.reject(new Error("Unexpected request"));
  });
  dbMock.account.updateMany.mockResolvedValue({ count: 1 });
  return requests;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SYNC-002 Account.syncEmails persistence ordering", () => {
  it("does not begin the checkpoint update while confirmed-invoked persistence is pending", async () => {
    const requests = configureAccount([page([email("A")])]);
    let resolvePersistence!: () => void;
    let signalPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => { signalPersistenceStarted = resolve; });
    const persistence = new Promise<void>((resolve) => { resolvePersistence = resolve; });
    syncEmailsToDatabaseMock.mockImplementation(() => {
      signalPersistenceStarted();
      return persistence;
    });

    const sync = new Account("synthetic-token").syncEmails();
    await persistenceStarted;

    expect(requests).toEqual([{ deltaToken: "D1" }]);
    expect(dbMock.account.updateMany).not.toHaveBeenCalled();

    resolvePersistence();
    await expect(sync).resolves.toMatchObject({ emails: [email("A")], latestDeltaToken: "D2" });
    expect(dbMock.account.updateMany).toHaveBeenCalledWith({
      where: { id: execution.accountId, userId: execution.userId, accessToken: execution.originalAccessToken, syncGeneration: 0, activeSyncRunId: execution.runId },
      data: { latestDeltaToken: "D2", activeSyncRunId: null },
    });
  });

  it("rejects and does not update the checkpoint when persistence explicitly rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureAccount([page([email("A")])]);
    syncEmailsToDatabaseMock.mockRejectedValue(new Error("synthetic persistence failure"));

    await expect(new Account("synthetic-token").syncEmails()).rejects.toThrow("synthetic persistence failure");

    expect(syncEmailsToDatabaseMock).toHaveBeenCalledWith([email("A")], execution);
    expect(dbMock.account.updateMany).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Incremental sync failed.");
  });

  it("persists all multi-page records before advancing the current candidate checkpoint", async () => {
    const first = email("A");
    const second = email("B");
    const third = email("C");
    const requests = configureAccount([page([first], "P2"), page([second], "P3"), page([third])]);
    syncEmailsToDatabaseMock.mockResolvedValue(undefined);

    await expect(new Account("synthetic-token").syncEmails()).resolves.toMatchObject({
      emails: [first, second, third],
      latestDeltaToken: "D2",
    });

    expect(requests).toEqual([{ deltaToken: "D1" }, { pageToken: "P2" }, { pageToken: "P3" }]);
    expect(syncEmailsToDatabaseMock).toHaveBeenCalledWith([first, second, third], execution);
    expect(dbMock.account.updateMany).toHaveBeenCalledOnce();
  });
});
