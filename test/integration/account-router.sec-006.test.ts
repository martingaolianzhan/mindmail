import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/lib/account", async () => {
  const { AccountMock } = await import("../mocks/account");
  return { Account: AccountMock };
});

import { accountRouter } from "~/server/api/routers/account";
import { db } from "~/server/db";
import { sendEmailMock } from "../mocks/account";

const prefix = `sec006-${crypto.randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const a1 = `${prefix}-a1`;
const b1 = `${prefix}-b1`;

function caller(userId: string) {
  return accountRouter.createCaller({ auth: { userId }, db, headers: new Headers() } as never);
}

function input(accountId: string) {
  return {
    accountId,
    body: "Synthetic body",
    subject: "Synthetic subject",
    to: [{ address: "recipient@example.test" }],
  };
}

beforeAll(async () => {
  await db.user.createMany({ data: [
    { id: alice, emailAddress: `${alice}@example.test`, firstName: "Alice", lastName: "Synthetic" },
    { id: bob, emailAddress: `${bob}@example.test`, firstName: "Bob", lastName: "Synthetic" },
  ] });
  await db.account.createMany({ data: [
    { id: a1, userId: alice, name: "Alice A1", emailAddress: "alice-a1@example.test", accessToken: `${prefix}-alice-token` },
    { id: b1, userId: bob, name: "Bob B1", emailAddress: "bob-b1@example.test", accessToken: `${prefix}-bob-token` },
  ] });
});

beforeEach(() => {
  vi.clearAllMocks();
  sendEmailMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [a1, b1] } } });
  await db.user.deleteMany({ where: { id: { in: [alice, bob] } } });
  await db.$disconnect();
});

describe("SEC-006 real PostgreSQL Account ownership", () => {
  it("allows Alice to reach the mocked send boundary only through Alice A1", async () => {
    await caller(alice).sendEmail(input(a1));

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: "Alice A1", address: "alice-a1@example.test" },
      replyTo: { name: "Alice A1", address: "alice-a1@example.test" },
    }));
  });

  it("rejects Alice using Bob B1 before provider send", async () => {
    await expect(caller(alice).sendEmail(input(b1))).rejects.toThrow("Account not found");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
