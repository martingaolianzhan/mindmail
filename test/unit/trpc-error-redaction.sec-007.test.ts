import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

vi.mock("~/server/db", async () => {
  const { prismaMock } = await import("../mocks/prisma");
  return { db: prismaMock };
});
vi.mock("~/lib/account", async () => {
  const { AccountMock } = await import("../mocks/account");
  return { Account: AccountMock };
});

import { appRouter } from "~/server/api/root";
import { sendEmailMock } from "../mocks/account";
import { prismaMock } from "../mocks/prisma";

const account = {
  id: "account-alice",
  userId: "user-alice",
  emailAddress: "alice@example.test",
  name: "Alice",
  accessToken: "access-token-SECRET-SENTINEL",
};

beforeEach(() => {
  prismaMock.account.findFirst.mockResolvedValue(account);
  sendEmailMock.mockRejectedValue(new Error("provider-secret-SECRET-SENTINEL mail-body-SECRET-SENTINEL"));
});

describe("SEC-007 tRPC error serialization", () => {
  it("does not expose provider errors, tokens, or mailbox content in the real HTTP adapter response", async () => {
    const request = new Request("http://mindmail.test/api/trpc/account.sendEmail?batch=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        0: { json: {
          accountId: account.id,
          body: "mail-body-SECRET-SENTINEL",
          subject: "Synthetic subject",
          to: [{ address: "recipient@example.test" }],
        } },
      }),
    });

    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: request,
      router: appRouter,
      createContext: () => ({ auth: { userId: account.userId }, db: prismaMock, headers: request.headers } as never),
    });
    const payload = await response.text();

    expect(response.status).toBe(500);
    expect(payload).toContain("Unable to send email.");
    expect(payload).not.toContain("provider-secret-SECRET-SENTINEL");
    expect(payload).not.toContain("mail-body-SECRET-SENTINEL");
    expect(payload).not.toContain("access-token-SECRET-SENTINEL");
  });
});
