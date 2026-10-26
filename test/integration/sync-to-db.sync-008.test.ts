import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "~/type";
const { axiosMock } = vi.hoisted(() => ({ axiosMock: { get: vi.fn() } }));
vi.mock("axios", () => ({ default: axiosMock }));
import { Account } from "~/lib/account";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { claimSyncExecution } from "~/lib/sync-execution";
import { db } from "~/server/db";
import { interceptTransactions, restoreTransactions } from "../helpers/transactions";

const prefix = `sync008-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;
const email = (suffix: string, attachment = false): EmailMessage => ({
  id: `${prefix}-email-${suffix}`, threadId: `${prefix}-thread-${suffix}`,
  createdTime: "2025-01-01T00:00:00.000Z", lastModifiedTime: "2025-01-01T00:00:00.000Z",
  sentAt: "2025-01-01T00:00:00.000Z", receivedAt: "2025-01-01T00:00:00.000Z",
  internetMessageId: `<${prefix}-${suffix}@example.test>`, subject: "Synthetic subject", sysLabels: ["inbox"],
  keywords: [], sysClassifications: [], sensitivity: "normal", meetingMessageMethod: "other",
  from: { address: `${prefix}-sender-${suffix}@example.test` }, to: [{ address: `${prefix}-recipient-${suffix}@example.test` }],
  cc: [], bcc: [], replyTo: [], hasAttachments: attachment, body: "Synthetic body", bodySnippet: "Synthetic body",
  attachments: attachment ? [{ id: `${prefix}-attachment-${suffix}`, name: "synthetic", mimeType: "text/plain", size: 1, inline: false }] : [],
  inReplyTo: "", references: "", threadIndex: "", internetHeaders: [], nativeProperties: {} as never,
  folderId: "", webLink: "", omitted: [],
});
async function createAccount(suffix: string) {
  const id = `${prefix}-account-${suffix}`;
  return db.account.create({ data: { id, userId, accessToken: `${prefix}-token-${suffix}`, emailAddress: `${suffix}@example.test`, name: suffix, latestDeltaToken: "D1" } });
}
beforeAll(async () => {
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
afterEach(() => { vi.restoreAllMocks(); restoreTransactions(); });
afterAll(async () => {
  await db.emailAttachment.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.email.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.thread.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.emailAddress.deleteMany({ where: { accountId: { startsWith: prefix } } });
  await db.account.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("SYNC-008 real persistence failure contract under execution fencing", () => {
  it("persists a valid email successfully", async () => {
    const account = await createAccount("success");
    const message = email("success");
    const execution = await claimSyncExecution(account);
    await expect(syncEmailsToDatabase([message], execution)).resolves.toBeUndefined();
    expect(await db.thread.count({ where: { id: message.threadId, accountId: account.id } })).toBe(1);
    expect(await db.email.count({ where: { id: message.id } })).toBe(1);
    expect(await db.emailAddress.count({ where: { accountId: account.id } })).toBe(2);
  });

  it("rejects an attachment failure after a prior email committed; retry converges without duplicate logical rows", async () => {
    const account = await createAccount("retry");
    const message = email("retry", true);
    const prior = { ...message, id: `${message.id}-prior`, attachments: [], hasAttachments: false };
    const execution = await claimSyncExecution(account);
    interceptTransactions((tx) => ({ ...tx, emailAttachment: { ...tx.emailAttachment, upsert: (() => { throw new Error("SECRET-SENTINEL"); }) as typeof tx.emailAttachment.upsert } }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(syncEmailsToDatabase([prior, message], execution)).rejects.toThrow("Failed to sync emails to database.");
    expect(await db.email.count({ where: { id: prior.id } })).toBe(1);
    expect(await db.email.count({ where: { id: message.id } })).toBe(0);
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("SECRET-SENTINEL");
    vi.restoreAllMocks();
    restoreTransactions();
    await expect(syncEmailsToDatabase([prior, message], execution)).resolves.toBeUndefined();
    expect(await db.thread.count({ where: { id: message.threadId, accountId: account.id } })).toBe(1);
    expect(await db.email.count({ where: { id: { in: [prior.id, message.id] } } })).toBe(2);
    expect(await db.emailAddress.count({ where: { accountId: account.id } })).toBe(2);
    expect(await db.emailAttachment.count({ where: { id: message.attachments[0]!.id } })).toBe(1);
  });

  it("bridges an internal email write failure through Account.syncEmails without advancing D1", async () => {
    const account = await createAccount("bridge");
    const message = email("bridge");
    axiosMock.get.mockResolvedValue({ data: { records: [message], nextDeltaToken: "D2" } });
    interceptTransactions((tx) => ({ ...tx, email: { ...tx.email, upsert: (() => { throw new Error("SECRET-SENTINEL"); }) as typeof tx.email.upsert } }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(new Account(account.accessToken).syncEmails()).resolves.toEqual({ status: "internal-failure", reason: "persistence-failure" });
    expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ latestDeltaToken: "D1", activeSyncRunId: null });
    expect(errorSpy).toHaveBeenCalledWith("Failed to sync emails to database.");
    expect(errorSpy).toHaveBeenCalledWith("Incremental sync failed.");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("SECRET-SENTINEL");
  });
});
