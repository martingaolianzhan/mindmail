import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("../mocks/clerk");
  return clerkServerMock;
});

import { accountRouter } from "~/server/api/routers/account";
import { createTRPCContext } from "~/server/api/trpc";
import { db } from "~/server/db";
import { clerkAuthMock } from "../mocks/clerk";

const prefix = `sec004-${crypto.randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const a1 = `${prefix}-a1`;
const a2 = `${prefix}-a2`;
const b1 = `${prefix}-b1`;
const t1 = `${prefix}-t1`;
const t2 = `${prefix}-t2`;
const t3 = `${prefix}-t3`;

const threadDelegate = {
  findFirst: (args: Prisma.ThreadFindFirstArgs) => db.thread.findFirst(args),
};
const findFirstSpy = vi.spyOn(threadDelegate, "findFirst");

async function replyDetailsAs(userId: string | null, accountId: string, threadId: string) {
  clerkAuthMock.mockResolvedValue({ userId });
  const context = await createTRPCContext({ headers: new Headers() });
  return accountRouter.createCaller({
    ...context,
    db: { ...context.db, thread: threadDelegate },
  } as never).getReplyDetails({ accountId, threadId });
}

async function createThreadEmail({
  threadId,
  accountAddressId,
  externalAddressId,
  subject,
}: {
  threadId: string;
  accountAddressId: string;
  externalAddressId: string;
  subject: string;
}) {
  const now = new Date();
  await db.email.create({
    data: {
      id: `${threadId}-email`,
      threadId,
      createdTime: now,
      lastModifiedTime: now,
      sentAt: now,
      receivedAt: now,
      internetMessageId: `<${threadId}@example.test>`,
      subject,
      sysLabels: ["inbox"],
      keywords: [],
      sysClassifications: [],
      fromId: externalAddressId,
      to: { connect: [{ id: accountAddressId }] },
      hasAttachments: false,
      internetHeaders: [],
      omitted: [],
      emailLabel: "inbox",
    },
  });
}

beforeAll(async () => {
  await db.$connect();
  await db.user.createMany({ data: [alice, bob].map((id) => ({
    id,
    emailAddress: `${id}@example.test`,
    firstName: "Synthetic",
    lastName: "User",
  })) });
  await db.account.createMany({ data: [
    { id: a1, userId: alice, name: "Alice A1", emailAddress: "alice-a1@example.test", accessToken: `${prefix}-token-a1` },
    { id: a2, userId: alice, name: "Alice A2", emailAddress: "alice-a2@example.test", accessToken: `${prefix}-token-a2` },
    { id: b1, userId: bob, name: "Bob B1", emailAddress: "bob-b1@example.test", accessToken: `${prefix}-token-b1` },
  ] });
  await db.emailAddress.createMany({ data: [
    { id: `${t1}-self`, accountId: a1, address: "alice-a1@example.test", name: "Alice A1" },
    { id: `${t1}-external`, accountId: a1, address: "external-t1@example.test", name: "External T1" },
    { id: `${t2}-self`, accountId: a2, address: "alice-a2@example.test", name: "Alice A2" },
    { id: `${t2}-external`, accountId: a2, address: "private-t2@example.test", name: "Private T2" },
    { id: `${t3}-self`, accountId: b1, address: "bob-b1@example.test", name: "Bob B1" },
    { id: `${t3}-external`, accountId: b1, address: "private-t3@example.test", name: "Private T3" },
  ] });
  await db.thread.createMany({ data: [
    { id: t1, accountId: a1, subject: "T1", lastMessageDate: new Date(), participantIds: [], inboxStatus: true, sentStatus: false, draftStatus: false },
    { id: t2, accountId: a2, subject: "T2", lastMessageDate: new Date(), participantIds: [], inboxStatus: true, sentStatus: false, draftStatus: false },
    { id: t3, accountId: b1, subject: "T3", lastMessageDate: new Date(), participantIds: [], inboxStatus: true, sentStatus: false, draftStatus: false },
  ] });
  await createThreadEmail({ threadId: t1, accountAddressId: `${t1}-self`, externalAddressId: `${t1}-external`, subject: "T1 external" });
  await createThreadEmail({ threadId: t2, accountAddressId: `${t2}-self`, externalAddressId: `${t2}-external`, subject: "T2 private" });
  await createThreadEmail({ threadId: t3, accountAddressId: `${t3}-self`, externalAddressId: `${t3}-external`, subject: "T3 private" });
});

beforeEach(() => {
  findFirstSpy.mockImplementation((args) => db.thread.findFirst(args));
});

afterEach(() => {
  vi.resetAllMocks();
});

afterAll(async () => {
  try {
    await db.email.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.thread.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.emailAddress.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.account.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  } finally {
    await db.$disconnect();
  }
});

describe("SEC-004 real PostgreSQL reply-detail account isolation", () => {
  it("returns reply details only for Alice's requested thread in A1 and scopes the Prisma query", async () => {
    const result = await replyDetailsAs(alice, a1, t1);

    expect(result).toMatchObject({
      subject: "T1 external",
      from: { name: "Alice A1", address: "alice-a1@example.test" },
      reply: true,
      internetMessageId: `<${t1}@example.test>`,
    });
    expect(result.to).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: "external-t1@example.test" }),
    ]));
    expect(findFirstSpy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: t1, accountId: a1 }),
    }));
  });

  it.each([
    ["Alice's other account", t2],
    ["Bob's account", t3],
    ["a non-existent thread", `${prefix}-missing`],
  ])("does not disclose %s through Alice A1", async (_case, threadId) => {
    await expect(replyDetailsAs(alice, a1, threadId)).rejects.toThrow("Thread not found!");
    expect(findFirstSpy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: threadId, accountId: a1 }),
    }));
  });

  it("rejects Alice's request for Bob's account before the Thread lookup", async () => {
    await expect(replyDetailsAs(alice, b1, t3)).rejects.toThrow("Account not found");
    expect(findFirstSpy).not.toHaveBeenCalled();
  });
});
