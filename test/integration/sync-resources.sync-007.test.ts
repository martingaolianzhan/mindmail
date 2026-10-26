import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "~/type";
const { http } = vi.hoisted(() => ({ http: { get: vi.fn(), post: vi.fn() } }));
vi.mock("axios", () => ({ default: http }));
import { Account } from "~/lib/account";
import { performInitialSync } from "~/lib/initial-sync";
import { db } from "~/server/db";
import * as persistence from "~/lib/sync-to-db";
import * as executions from "~/lib/sync-execution";

const prefix = `resources007-${crypto.randomUUID()}`; const userId = `${prefix}-user`;
const limits = { maxMailboxPayloadBytes: 1000 };
const bytes = (data: object) => Buffer.byteLength(JSON.stringify(data), "utf8");
function page(size: number, nextPageToken?: string, records: EmailMessage[] = []) {
  const data = { records, nextDeltaToken: "D-next", nextPageToken, padding: "" };
  data.padding = "x".repeat(size - bytes(data));
  expect(bytes(data)).toBe(size);
  return data;
}
async function fixture(checkpoint: string | null) {
  const id = `${prefix}-${crypto.randomUUID()}`;
  return db.account.create({ data: { id, userId, accessToken: `${id}-TOKEN-SECRET`, latestDeltaToken: checkpoint, emailAddress: `${id}@example.test`, name: "Synthetic" } });
}
beforeAll(async () => {
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
beforeEach(() => {
  http.get.mockReset(); http.post.mockReset().mockResolvedValue({ data: { ready: true, syncUpdatedToken: "S0" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.emailAttachment.deleteMany({ where: { Email: { thread: { account: { userId } } } } });
  await db.email.deleteMany({ where: { thread: { account: { userId } } } });
  await db.thread.deleteMany({ where: { account: { userId } } });
  await db.emailAddress.deleteMany({ where: { account: { userId } } });
  await db.account.deleteMany({ where: { userId } }); await db.user.delete({ where: { id: userId } }); await db.$disconnect();
});

describe("SYNC-007 cumulative mailbox budget with real PostgreSQL fencing", () => {
  it.each(["initial", "incremental"] as const)("%s overflow retains durable checkpoint, writes no mail and starts no completion", async (kind) => {
    const checkpoint = kind === "initial" ? null : "D-existing";
    const a = await fixture(checkpoint);
    const pages = [page(400, "P2"), page(400, "P3"), page(201, "P4", [{ id: `${prefix}-must-not-persist`, subject: "é汉💌 BODY-SECRET" } as EmailMessage])];
    expect(pages.map(bytes)).toEqual([400, 400, 201]);
    let index = 0;
    http.get.mockImplementation(() => {
      const data = pages[index++]; if (!data) throw new Error("Unexpected extra page");
      return Promise.resolve({ data }); // No Content-Length required.
    });
    const persist = vi.spyOn(persistence, "syncEmailsToDatabase"); const complete = vi.spyOn(executions, "completeSyncExecution");
    const result = await (kind === "initial" ? performInitialSync({ accountId: a.id, userId }, { limits }) : new Account(a.accessToken).syncEmails({ limits }));
    expect(result).toEqual({ status: "safety-limit", reason: "response-bytes-limit" });
    expect(http.get).toHaveBeenCalledTimes(3); expect(persist).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    expect(await db.account.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ latestDeltaToken: checkpoint, activeSyncRunId: null });
    expect(await db.email.count({ where: { thread: { accountId: a.id } } })).toBe(0);
    expect(await db.thread.count({ where: { accountId: a.id } })).toBe(0);
    expect(JSON.stringify({ result, logs: vi.mocked(console.error).mock.calls })).not.toMatch(/TOKEN-SECRET|BODY-SECRET|D-existing|P4/);
  });

  it("a fresh run on the same client/account resets the exact-boundary budget and uses its durable checkpoint", async () => {
    const a = await fixture("D0"); const client = new Account(a.accessToken);
    const data = page(1000); http.get.mockResolvedValue({ data });
    for (let i = 0; i < 2; i++) {
      await expect(client.syncEmails({ limits })).resolves.toMatchObject({ status: "completed", latestDeltaToken: "D-next", emails: [] });
      expect(await db.account.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ latestDeltaToken: "D-next", activeSyncRunId: null });
    }
    expect(http.get).toHaveBeenCalledTimes(2);
    expect(http.get.mock.calls[0]![1]).toMatchObject({ params: { deltaToken: "D0" }, maxContentLength: 20000000 });
    expect(http.get.mock.calls[1]![1]).toMatchObject({ params: { deltaToken: "D-next" }, maxContentLength: 20000000 });
  });
});
