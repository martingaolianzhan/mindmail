import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailMessage, SyncUpdatedEmailsReponse } from "~/type";

const { axiosMock, syncEmailsToDatabaseMock } = vi.hoisted(() => ({
  axiosMock: { get: vi.fn() },
  syncEmailsToDatabaseMock: vi.fn(),
}));

vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("~/lib/sync-to-db", () => ({ syncEmailsToDatabase: syncEmailsToDatabaseMock }));

import { Account } from "~/lib/account";
import { db } from "~/server/db";
import { interceptCheckpoints } from "../helpers/transactions";

type Request = { deltaToken?: string; pageToken?: string };

const prefix = `sync002-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;
const realAccountUpdate = db.account.updateMany.bind(db.account);
const email = (id: string) => ({ id }) as EmailMessage;
const page = (records: EmailMessage[], nextPageToken?: string): SyncUpdatedEmailsReponse => ({
  records,
  nextDeltaToken: "D2",
  nextPageToken,
});

async function createAccount(name: string) {
  const id = `${prefix}-${name}`;
  const accessToken = `${prefix}-${name}-token`;
  await db.account.create({
    data: { id, userId, accessToken, emailAddress: `${name}@example.test`, name, latestDeltaToken: "D1" },
  });
  return { id, accessToken };
}

function configureProvider(responses: SyncUpdatedEmailsReponse[]) {
  const requests: Request[] = [];
  let index = 0;
  axiosMock.get.mockImplementation((_url: string, config: { params: Request }) => {
    requests.push(config.params);
    const response = responses[index++];
    return response ? Promise.resolve({ data: response }) : Promise.reject(new Error("Unexpected provider request"));
  });
  return requests;
}

beforeAll(async () => {
  await db.$connect();
  await db.user.create({
    data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Vitest restoration removes Prisma delegate methods rather than replacing them.
  db.account.updateMany = realAccountUpdate;
});

afterAll(async () => {
  await db.account.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("SYNC-002 real PostgreSQL checkpoint ordering", () => {
  it("keeps D1 in PostgreSQL and does not initiate checkpoint update while confirmed persistence is pending", async () => {
    const account = await createAccount("deferred");
    configureProvider([page([email("A")])]);
    // Preserve Prisma's real delegate method; this spy is timing observation only.
    const updateSpy = interceptCheckpoints();
    let resolvePersistence!: () => void;
    let signalPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => { signalPersistenceStarted = resolve; });
    const persistence = new Promise<void>((resolve) => { resolvePersistence = resolve; });
    syncEmailsToDatabaseMock.mockImplementation(() => {
      signalPersistenceStarted();
      return persistence;
    });

    const sync = new Account(account.accessToken).syncEmails();
    await persistenceStarted;

    expect(updateSpy).not.toHaveBeenCalled();
    expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ latestDeltaToken: "D1" });

    resolvePersistence();
    await expect(sync).resolves.toMatchObject({ emails: [email("A")], latestDeltaToken: "D2" });
    expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ latestDeltaToken: "D2" });
  });

  it("rejects and keeps D1 in PostgreSQL when the current persistence Promise explicitly rejects", async () => {
    const account = await createAccount("rejection");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureProvider([page([email("A")])]);
    syncEmailsToDatabaseMock.mockRejectedValue(new Error("synthetic-persistence-SECRET-SENTINEL"));

    await expect(new Account(account.accessToken).syncEmails()).resolves.toEqual({ status: "internal-failure", reason: "persistence-failure" });

    expect(syncEmailsToDatabaseMock).toHaveBeenCalledWith([email("A")], expect.objectContaining({ accountId: account.id, userId, generation: 0, runId: expect.any(String) }), expect.anything());
    expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ latestDeltaToken: "D1" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Incremental sync failed.");
  });

  it("rejects a missing terminal delta without persisting or falling back to an intermediate/prior checkpoint", async () => {
    const account = await createAccount("missing-terminal");
    configureProvider([page([email("A")], "P2"), { records: [] }]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(new Account(account.accessToken).syncEmails()).resolves.toEqual({ status: "internal-failure", reason: "provider-contract" });
    expect(syncEmailsToDatabaseMock).not.toHaveBeenCalled();
    expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ latestDeltaToken: "D1", activeSyncRunId: null });
    expect(errorSpy).toHaveBeenCalledWith("Incremental sync failed.");
  });

  it("aggregates a successful multi-page round and advances PostgreSQL from D1 to D2 after persistence resolves", async () => {
    const account = await createAccount("multi-page");
    const first = email("A");
    const second = email("B");
    const third = email("C");
    const requests = configureProvider([
      { ...page([first], "P2"), nextDeltaToken: "IGNORE-intermediate" },
      { records: [second], nextPageToken: "P3" },
      page([third]),
    ]);
    syncEmailsToDatabaseMock.mockResolvedValue(undefined);

    await expect(new Account(account.accessToken).syncEmails()).resolves.toMatchObject({
      emails: [first, second, third],
      latestDeltaToken: "D2",
    });

    expect(requests).toEqual([{ deltaToken: "D1" }, { pageToken: "P2" }, { pageToken: "P3" }]);
    expect(syncEmailsToDatabaseMock).toHaveBeenCalledWith([first, second, third], expect.objectContaining({ accountId: account.id, userId, generation: 0, runId: expect.any(String) }), expect.anything());
    expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ latestDeltaToken: "D2" });
  });
});
