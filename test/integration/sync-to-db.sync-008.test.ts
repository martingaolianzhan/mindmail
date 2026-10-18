import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailMessage } from "~/type";

const { axiosMock } = vi.hoisted(() => ({ axiosMock: { get: vi.fn() } }));
vi.mock("axios", () => ({ default: axiosMock }));

import { Account } from "~/lib/account";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { db } from "~/server/db";

const prefix = `sync008-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;
const realEmailUpsert = db.email.upsert.bind(db.email);
const realThreadUpdate = db.thread.update.bind(db.thread);
const realAttachmentUpsert = db.emailAttachment.upsert.bind(db.emailAttachment);

const email = (suffix: string, attachment = false): EmailMessage => ({
  id: `${prefix}-email-${suffix}`,
  threadId: `${prefix}-thread-${suffix}`,
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
  const accessToken = `${prefix}-token-${suffix}`;
  await db.account.create({ data: { id, userId, accessToken, emailAddress: `${suffix}@example.test`, name: suffix, latestDeltaToken: "D1" } });
  return { id, accessToken };
}

beforeAll(async () => {
  await db.$connect();
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Vitest removes Prisma delegate methods on restoration; restore real delegates.
  db.email.upsert = realEmailUpsert;
  db.thread.update = realThreadUpdate;
  db.emailAttachment.upsert = realAttachmentUpsert;
});

afterAll(async () => {
  await db.emailAttachment.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.email.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.thread.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.emailAddress.deleteMany({ where: { accountId: { startsWith: prefix } } });
  await db.account.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("SYNC-008 real persistence failure contract", () => {
  it("persists a valid email successfully", async () => {
    const account = await createAccount("success");
    const message = email("success");

    await expect(syncEmailsToDatabase([message], account.id)).resolves.toBeUndefined();

    expect(await db.thread.count({ where: { id: message.threadId, accountId: account.id } })).toBe(1);
    expect(await db.email.count({ where: { id: message.id } })).toBe(1);
    expect(await db.emailAddress.count({ where: { accountId: account.id } })).toBe(2);
  });

  it("rejects a partial attachment failure, then same-account retry converges without duplicate logical rows", async () => {
    const account = await createAccount("retry");
    const message = email("retry", true);
    const attachmentSpy = vi.spyOn(db.emailAttachment, "upsert").mockRejectedValueOnce(new Error("SECRET-SENTINEL"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(syncEmailsToDatabase([message], account.id)).rejects.toThrow("Failed to sync emails to database.");
    expect(await db.email.count({ where: { id: message.id } })).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("SECRET-SENTINEL");

    attachmentSpy.mockRestore();
    db.emailAttachment.upsert = realAttachmentUpsert;
    await expect(syncEmailsToDatabase([message], account.id)).resolves.toBeUndefined();

    expect(await db.thread.count({ where: { id: message.threadId, accountId: account.id } })).toBe(1);
    expect(await db.email.count({ where: { id: message.id } })).toBe(1);
    expect(await db.emailAddress.count({ where: { accountId: account.id } })).toBe(2);
    expect(await db.emailAttachment.count({ where: { id: message.attachments[0]!.id } })).toBe(1);
  });

  it("bridges an internal email write failure through Account.syncEmails without advancing D1", async () => {
    const account = await createAccount("bridge");
    const message = email("bridge");
    axiosMock.get.mockResolvedValue({ data: { records: [message], nextDeltaToken: "D2" } });
    vi.spyOn(db.email, "upsert").mockImplementation((args) => {
      if (args.where.id === message.id) return Promise.reject(new Error("SECRET-SENTINEL")) as never;
      return realEmailUpsert(args);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(new Account(account.accessToken).syncEmails()).rejects.toThrow("Failed to sync emails to database.");

    expect(await db.account.findUnique({ where: { id: account.id } })).toMatchObject({ latestDeltaToken: "D1" });
    expect(errorSpy).toHaveBeenCalledWith("Failed to sync emails to database.");
    expect(errorSpy).toHaveBeenCalledWith("Incremental sync failed.");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("SECRET-SENTINEL");
  });
});
