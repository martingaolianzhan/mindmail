import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("../mocks/clerk");
  return clerkServerMock;
});

vi.mock("~/server/db", async () => {
  const { prismaMock } = await import("../mocks/prisma");
  return { db: prismaMock };
});

vi.mock("~/lib/account", async () => {
  const { AccountMock } = await import("../mocks/account");
  return { Account: AccountMock };
});

import { createTRPCContext } from "~/server/api/trpc";
import { accountRouter } from "~/server/api/routers/account";

import { syncEmailsMock } from "../mocks/account";
import { clerkAuthMock } from "../mocks/clerk";
import { prismaMock } from "../mocks/prisma";

const accounts = {
  alice: {
    id: "account-alice",
    userId: "user-alice",
    emailAddress: "alice@example.test",
    name: "Alice",
    accessToken: "synthetic-token-alice",
  },
  bob: {
    id: "account-bob",
    userId: "user-bob",
    emailAddress: "bob@example.test",
    name: "Bob",
    accessToken: "synthetic-token-bob",
  },
};

const threads = {
  alice: [{ id: "thread-alice", accountId: accounts.alice.id }],
  bob: [{ id: "thread-bob", accountId: accounts.bob.id }],
};

function createCaller(userId: string) {
  return accountRouter.createCaller({
    auth: { userId },
    db: prismaMock,
    headers: new Headers(),
  } as never);
}

beforeEach(() => {
  prismaMock.account.findFirst.mockImplementation(({ where }) => {
    return Object.values(accounts).find(
      (account) => account.id === where.id && account.userId === where.userId,
    ) ?? null;
  });
  prismaMock.thread.findMany.mockImplementation(({ where }) => {
    if (where.accountId === accounts.alice.id) return threads.alice;
    if (where.accountId === accounts.bob.id) return threads.bob;
    throw new Error("Thread query was not scoped to an authorised account");
  });
  syncEmailsMock.mockResolvedValue(undefined);
});

describe("SEC-003 getThreads account ownership", () => {
  it("connects the Clerk and Prisma mocks to the production tRPC context", async () => {
    clerkAuthMock.mockResolvedValue({ userId: accounts.alice.userId });

    const context = await createTRPCContext({ headers: new Headers() });

    expect(context.auth).toEqual({ userId: accounts.alice.userId });
    expect(context.db).toBe(prismaMock);
  });

  it.each([
    ["inbox", { inboxStatus: true }],
    ["sent", { sentStatus: true }],
    ["draft", { draftStatus: true }],
  ] as const)("scopes %s queries to Alice's authorised account", async (tabCategory, categoryFilter) => {
    const result = await createCaller(accounts.alice.userId).getThreads({
      accountId: accounts.alice.id,
      tabCategory,
      done: false,
    });

    expect(result).toEqual(threads.alice);
    expect(prismaMock.thread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId: accounts.alice.id,
          ...categoryFilter,
          done: { equals: false },
        },
      }),
    );
    expect(syncEmailsMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid category before retrieving threads", async () => {
    await expect(
      createCaller(accounts.alice.userId).getThreads({
        accountId: accounts.alice.id,
        // A client can bypass TypeScript, so exercise runtime Zod validation.
        tabCategory: "all" as never,
        done: false,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(prismaMock.thread.findMany).not.toHaveBeenCalled();
    expect(syncEmailsMock).not.toHaveBeenCalled();
  });

  it("rejects Alice requesting Bob's account before retrieving threads", async () => {
    await expect(
      createCaller(accounts.alice.userId).getThreads({
        accountId: accounts.bob.id,
        tabCategory: "inbox",
        done: false,
      }),
    ).rejects.toThrow("Account not found");

    expect(prismaMock.thread.findMany).not.toHaveBeenCalled();
    expect(syncEmailsMock).not.toHaveBeenCalled();
  });

  it("allows Bob to query only Bob's separate account fixture", async () => {
    const result = await createCaller(accounts.bob.userId).getThreads({
      accountId: accounts.bob.id,
      tabCategory: "sent",
      done: true,
    });

    expect(result).toEqual(threads.bob);
    expect(prismaMock.thread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId: accounts.bob.id,
          sentStatus: true,
          done: { equals: true },
        },
      }),
    );
  });
});
