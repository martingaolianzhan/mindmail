import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/server/db", async () => {
  const { prismaMock } = await import("../mocks/prisma");
  return { db: prismaMock };
});
vi.mock("~/lib/account", async () => {
  const { AccountMock } = await import("../mocks/account");
  return { Account: AccountMock };
});

import { accountRouter } from "~/server/api/routers/account";
import { sendEmailMock } from "../mocks/account";
import { prismaMock } from "../mocks/prisma";

const accounts = {
  alice: { id: "account-alice", userId: "user-alice", emailAddress: "alice@example.test", name: "Alice", accessToken: "alice-token" },
  bob: { id: "account-bob", userId: "user-bob", emailAddress: "bob@example.test", name: "Bob", accessToken: "bob-token" },
};

function caller(userId: string) {
  return accountRouter.createCaller({ auth: { userId }, db: prismaMock, headers: new Headers() } as never);
}

function validInput() {
  return {
    accountId: accounts.alice.id,
    body: "Synthetic body",
    subject: "Synthetic subject",
    to: [{ address: "recipient@example.test" }],
    cc: [{ name: "CC", address: "cc@example.test" }],
    bcc: [{ name: "BCC", address: "bcc@example.test" }],
  };
}

beforeEach(() => {
  prismaMock.account.findFirst.mockImplementation(({ where }) => Object.values(accounts).find(
    (account) => account.id === where.id && account.userId === where.userId,
  ) ?? null);
  sendEmailMock.mockResolvedValue(undefined);
});

describe("SEC-006 sendEmail sender and recipient boundary", () => {
  it("derives from and replyTo from Alice's authorised account while preserving valid recipients", async () => {
    await caller(accounts.alice.userId).sendEmail(validInput());

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: "Alice", address: "alice@example.test" },
      replyTo: { name: "Alice", address: "alice@example.test" },
      to: [{ address: "recipient@example.test" }],
      cc: [{ name: "CC", address: "cc@example.test" }],
      bcc: [{ name: "BCC", address: "bcc@example.test" }],
    }));
  });

  it("does not forward obsolete spoofed from or replyTo fields", async () => {
    await caller(accounts.alice.userId).sendEmail({
      ...validInput(),
      from: { name: "CEO", address: "ceo@example.test" },
      replyTo: { name: "Attacker", address: "attacker@example.test" },
    } as never);

    const payload = sendEmailMock.mock.calls[0]?.[0] as { from: { address: string }; replyTo: { address: string } };
    expect(payload.from.address).toBe("alice@example.test");
    expect(payload.replyTo.address).toBe("alice@example.test");
    expect(JSON.stringify(payload)).not.toContain("ceo@example.test");
    expect(JSON.stringify(payload)).not.toContain("attacker@example.test");
  });

  it("rejects an empty primary recipient list before creating a provider send", async () => {
    await expect(caller(accounts.alice.userId).sendEmail({ ...validInput(), to: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it.each([
    ["to", { to: [{ address: "not-an-email" }] }],
    ["cc", { cc: [{ address: "not-an-email" }] }],
    ["bcc", { bcc: [{ address: "not-an-email" }] }],
  ])("rejects malformed %s recipients before provider send", async (_field, override) => {
    await expect(caller(accounts.alice.userId).sendEmail({ ...validInput(), ...override })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("rejects Alice sending through Bob's account before provider send", async () => {
    await expect(caller(accounts.alice.userId).sendEmail({ ...validInput(), accountId: accounts.bob.id })).rejects.toThrow("Account not found");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
