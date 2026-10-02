import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("../mocks/clerk");
  return clerkServerMock;
});
vi.mock("~/lib/account", async () => {
  const { AccountMock } = await import("../mocks/account");
  return { Account: AccountMock };
});

import { accountRouter } from "~/server/api/routers/account";
import { createTRPCContext } from "~/server/api/trpc";
import { db } from "~/server/db";
import { clerkAuthMock } from "../mocks/clerk";
import { syncEmailsMock } from "../mocks/account";

const prefix = `sec003-${crypto.randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const a1 = `${prefix}-a1`;
const a2 = `${prefix}-a2`;
const b1 = `${prefix}-b1`;
const threadId = (label: string) => `${prefix}-${label}`;

// Spy on a transparent delegate: every observed call executes the real Prisma
// findMany. Spying directly on Prisma's proxy delegate can replace its method.
const threadDelegate = {
  findMany: (args: Prisma.ThreadFindManyArgs) => db.thread.findMany(args),
};
const findManySpy = vi.spyOn(threadDelegate, "findMany");

async function callAs(userId: string | null, accountId: string, tabCategory: string, done = false) {
  clerkAuthMock.mockResolvedValue({ userId });
  const context = await createTRPCContext({ headers: new Headers() });
  return accountRouter.createCaller({
    ...context,
    db: { ...context.db, thread: threadDelegate },
  } as never).getThreads({
    accountId,
    tabCategory: tabCategory as never, // Exercise actual runtime validation.
    done,
  });
}

beforeAll(async () => {
  await db.$connect();
  await db.user.createMany({ data: [alice, bob].map((id) => ({
    id, emailAddress: `${id}@example.test`, firstName: "Synthetic", lastName: "User",
  })) });
  await db.account.createMany({ data: [
    { id: a1, userId: alice, name: "A1", emailAddress: "a1@example.test", accessToken: `${a1}-synthetic` },
    { id: a2, userId: alice, name: "A2", emailAddress: "a2@example.test", accessToken: `${a2}-synthetic` },
    { id: b1, userId: bob, name: "B1", emailAddress: "b1@example.test", accessToken: `${b1}-synthetic` },
  ] });
  await db.thread.createMany({ data: [
    { id: threadId("inbox"), accountId: a1, subject: "Inbox A1", lastMessageDate: new Date(), participantIds: [], inboxStatus: true, sentStatus: false, draftStatus: false },
    { id: threadId("sent"), accountId: a1, subject: "Sent A1", lastMessageDate: new Date(), participantIds: [], inboxStatus: false, sentStatus: true, draftStatus: false },
    { id: threadId("draft"), accountId: a1, subject: "Draft A1", lastMessageDate: new Date(), participantIds: [], inboxStatus: false, sentStatus: false, draftStatus: true },
    { id: threadId("a2"), accountId: a2, subject: "Inbox A2", lastMessageDate: new Date(), participantIds: [], inboxStatus: true, sentStatus: false, draftStatus: false },
    { id: threadId("b1"), accountId: b1, subject: "Inbox B1", lastMessageDate: new Date(), participantIds: [], inboxStatus: true, sentStatus: false, draftStatus: false },
  ] });
});

beforeEach(() => {
  syncEmailsMock.mockResolvedValue(undefined);
  findManySpy.mockImplementation((args) => db.thread.findMany(args));
});

afterEach(() => {
  vi.resetAllMocks();
});

afterAll(async () => {
  try {
    await db.thread.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.account.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  } finally {
    await db.$disconnect();
  }
});

describe("SEC-003 real PostgreSQL ownership and categories", () => {
  it.each([
    ["inbox", "inbox", "inboxStatus"],
    ["sent", "sent", "sentStatus"],
    ["draft", "draft", "draftStatus"],
  ])("filters %s by category and authorised account", async (category, label, statusKey) => {
    const result = await callAs(alice, a1, category);
    expect(result.map((thread) => thread.id)).toEqual([threadId(label)]);
    expect(findManySpy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ accountId: a1, [statusKey]: true }),
    }));
    // Category and account boundaries are proved by disjoint persisted fixtures.
    expect(result.every((thread) => thread.accountId === a1 && thread[statusKey as "inboxStatus" | "sentStatus" | "draftStatus"])).toBe(true);
  });

  it("isolates Alice's two accounts from each other and from Bob", async () => {
    expect((await callAs(alice, a1, "inbox")).map((t) => t.id)).toEqual([threadId("inbox")]);
    expect((await callAs(alice, a2, "inbox")).map((t) => t.id)).toEqual([threadId("a2")]);
    expect((await callAs(bob, b1, "inbox")).map((t) => t.id)).toEqual([threadId("b1")]);
    findManySpy.mockClear();
    await expect(callAs(alice, b1, "inbox")).rejects.toThrow("Account not found");
    expect(findManySpy).not.toHaveBeenCalled();
    expect(syncEmailsMock).toHaveBeenCalledTimes(3);
  });

  it("rejects unauthenticated requests and nonexistent accounts before querying threads", async () => {
    await expect(callAs(null, a1, "inbox")).rejects.toThrow("User not authenticated");
    await expect(callAs(alice, `${prefix}-missing`, "inbox")).rejects.toThrow("Account not found");
    expect(findManySpy).not.toHaveBeenCalled();
    expect(syncEmailsMock).not.toHaveBeenCalled();
  });

  it.each(["", "all", "trash", "INBOX", "random text", "   "])(
    "rejects invalid category %j without a thread query", async (category) => {
      await expect(callAs(alice, a1, category)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(findManySpy).not.toHaveBeenCalled();
      expect(syncEmailsMock).not.toHaveBeenCalled();
    },
  );
});
