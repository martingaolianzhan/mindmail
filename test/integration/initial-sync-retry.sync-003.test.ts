import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "~/type";

const { provider } = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("~/lib/account", () => ({ Account: vi.fn(() => ({ performInitialSync: provider })) }));

import { performInitialSync } from "~/lib/initial-sync";
import { db } from "~/server/db";

const prefix = `sync003-retry-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;
const realUpdateMany = db.account.updateMany.bind(db.account);
const realAttachmentUpsert = db.emailAttachment.upsert.bind(db.emailAttachment);

function message(suffix: string, withAttachment: boolean): EmailMessage {
  return {
    id: `${prefix}-email-${suffix}`, threadId: `${prefix}-thread-${suffix}`,
    createdTime: "2025-01-01T00:00:00.000Z", lastModifiedTime: "2025-01-01T00:00:00.000Z",
    sentAt: "2025-01-01T00:00:00.000Z", receivedAt: "2025-01-01T00:00:00.000Z",
    internetMessageId: `<${prefix}-${suffix}@example.test>`, subject: "Synthetic subject",
    sysLabels: ["inbox"], keywords: [], sysClassifications: [], sensitivity: "normal", meetingMessageMethod: "other",
    from: { address: `${prefix}-sender@example.test` }, to: [{ address: `${prefix}-recipient@example.test` }],
    cc: [], bcc: [], replyTo: [], hasAttachments: withAttachment, body: "Synthetic body", bodySnippet: "Synthetic body",
    attachments: withAttachment ? [{ id: `${prefix}-attachment-${suffix}`, name: "synthetic", mimeType: "text/plain", size: 1, inline: false }] : [],
    inReplyTo: "", references: "", threadIndex: "", internetHeaders: [], nativeProperties: {} as never,
    folderId: "", webLink: "", omitted: [],
  };
}

async function fixture(suffix: string) {
  const id = `${prefix}-account-${suffix}`;
  await db.account.create({ data: {
    id, userId, accessToken: `${id}-token`, emailAddress: `${suffix}@example.test`, name: suffix, latestDeltaToken: "D0",
  } });
  const emails = [message(`${suffix}-first`, true), message(`${suffix}-second`, false)];
  provider.mockResolvedValue({ emails, latestDeltaToken: "D1" });
  return { id, emails, run: () => performInitialSync({ accountId: id, userId }) };
}

async function state(id: string, emails: EmailMessage[]) {
  return {
    token: (await db.account.findUniqueOrThrow({ where: { id } })).latestDeltaToken,
    threads: await db.thread.findMany({ where: { accountId: id }, select: { id: true } }),
    emails: await db.email.findMany({ where: { id: { in: emails.map((e) => e.id) } }, select: { id: true } }),
    addresses: await db.emailAddress.findMany({ where: { accountId: id }, select: { address: true } }),
    attachments: await db.emailAttachment.findMany({ where: { id: { in: emails.flatMap((e) => e.attachments.map((a) => a.id)) } }, select: { id: true } }),
  };
}
function expectConverged(s: Awaited<ReturnType<typeof state>>, emails: EmailMessage[]) {
  expect(s.token).toBe("D1");
  expect(s.threads.map((t) => t.id).sort()).toEqual(emails.map((e) => e.threadId).sort());
  expect(s.emails.map((e) => e.id).sort()).toEqual(emails.map((e) => e.id).sort());
  expect(s.addresses.map((a) => a.address).sort()).toEqual([
    `${prefix}-recipient@example.test`, `${prefix}-sender@example.test`,
  ]);
  expect(s.attachments.map((a) => a.id)).toEqual([emails[0]!.attachments[0]!.id]);
}
function restoreDelegates() {
  vi.restoreAllMocks();
  db.account.updateMany = realUpdateMany;
  db.emailAttachment.upsert = realAttachmentUpsert;
}
beforeAll(async () => {
  await db.$connect();
  await db.user.create({ data: { id: userId, emailAddress: `${userId}@example.test`, firstName: "Synthetic", lastName: "User" } });
});
afterEach(restoreDelegates);
afterAll(async () => {
  await db.emailAttachment.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.email.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.thread.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.emailAddress.deleteMany({ where: { accountId: { startsWith: prefix } } });
  await db.account.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("SYNC-003 real mail persistence and sequential same-input recovery", () => {
  it("persists real mail before exactly one ownership-scoped checkpoint commit", async () => {
    const f = await fixture("success");
    const write = vi.spyOn(db.account, "updateMany").mockImplementation((async (args) => {
      const before = await state(f.id, f.emails);
      expect(before.token).toBe("D0");
      expect(before.threads).toHaveLength(2);
      expect(before.emails).toHaveLength(2);
      expect(before.addresses).toHaveLength(2);
      expect(before.attachments).toHaveLength(1);
      return realUpdateMany(args);
    }) as typeof realUpdateMany);
    await expect(f.run()).resolves.toBe("completed");
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({ where: { id: f.id, userId }, data: { latestDeltaToken: "D1" } });
    expectConverged(await state(f.id, f.emails), f.emails);
  });

  it("leaves partial mail and D0 on real attachment failure; retry converges without duplicates", async () => {
    const f = await fixture("partial");
    vi.spyOn(db.emailAttachment, "upsert").mockRejectedValueOnce(new Error("synthetic failure"));
    const write = vi.spyOn(db.account, "updateMany").mockImplementation(realUpdateMany);
    await expect(f.run()).rejects.toThrow("Failed to sync emails to database.");
    expect(write).not.toHaveBeenCalled();
    const partial = await state(f.id, f.emails);
    expect(partial).toMatchObject({ token: "D0", threads: [{ id: f.emails[0]!.threadId }], emails: [{ id: f.emails[0]!.id }], attachments: [] });
    expect(partial.addresses).toHaveLength(2);
    restoreDelegates();
    provider.mockResolvedValue({ emails: f.emails, latestDeltaToken: "D1" });
    await expect(f.run()).resolves.toBe("completed");
    expectConverged(await state(f.id, f.emails), f.emails);
  });

  it("retains D0 after a deterministic pre-write failure, then re-upserts mail and commits", async () => {
    const f = await fixture("prewrite");
    vi.spyOn(db.account, "updateMany").mockRejectedValueOnce(new Error("synthetic no-commit failure"));
    await expect(f.run()).rejects.toThrow("synthetic no-commit failure");
    const first = await state(f.id, f.emails);
    expect(first.token).toBe("D0");
    expect(first.threads).toHaveLength(2);
    expect(first.emails).toHaveLength(2);
    expect(first.addresses).toHaveLength(2);
    expect(first.attachments).toHaveLength(1);
    restoreDelegates();
    provider.mockResolvedValue({ emails: f.emails, latestDeltaToken: "D1" });
    await expect(f.run()).resolves.toBe("completed");
    expectConverged(await state(f.id, f.emails), f.emails);
  });

  it("does not claim completion when acknowledgement fails after the real D1 commit; re-read and retry converge", async () => {
    const f = await fixture("postcommit");
    const write = vi.spyOn(db.account, "updateMany").mockImplementation((async (args) => {
      const result = await realUpdateMany(args);
      expect(result.count).toBe(1);
      throw new Error("synthetic lost acknowledgement");
    }) as typeof realUpdateMany);
    await expect(f.run()).rejects.toThrow("synthetic lost acknowledgement");
    expect(write).toHaveBeenCalledWith({ where: { id: f.id, userId }, data: { latestDeltaToken: "D1" } });
    const reread = await state(f.id, f.emails);
    expectConverged(reread, f.emails); // D1 committed even though caller saw failure.
    restoreDelegates();
    provider.mockResolvedValue({ emails: f.emails, latestDeltaToken: "D1" });
    await expect(f.run()).resolves.toBe("completed");
    expectConverged(await state(f.id, f.emails), f.emails);
  });
});
