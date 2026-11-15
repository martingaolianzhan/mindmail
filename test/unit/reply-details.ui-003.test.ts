import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({ db: {
  account: { findFirst: vi.fn() },
  thread: { findFirst: vi.fn() },
} }));
vi.mock("~/server/db", () => ({ db }));
vi.mock("~/lib/account", async () => {
  const { AccountMock } = await import("../mocks/account");
  return { Account: AccountMock };
});

import { accountRouter } from "~/server/api/routers/account";
import { sendEmailMock } from "../mocks/account";

const account = { id: "reply-account", userId: "reply-user", emailAddress: "self@example.test", name: "Self", accessToken: "synthetic-token" };
const address = (value: string) => ({ name: value, address: value });
function email(id: string, sentAt: string, from = account.emailAddress) {
  return { sentAt: new Date(sentAt), from: address(from), subject: `Subject ${id}`,
    to: [address(`to-${id}@example.test`)], cc: [address(`cc-${id}@example.test`)], bcc: [],
    internetMessageId: `<${id}@example.test>` };
}
function caller() {
  return accountRouter.createCaller({ auth: { userId: account.userId }, db, headers: new Headers() } as never);
}

beforeEach(() => {
  db.account.findFirst.mockImplementation(({ where }) => where.id === account.id && where.userId === account.userId ? account : null);
});

describe("UI-003 getReplyDetails latest-message and ownership contracts", () => {
  it("uses the latest self-only email's subject, To, CC and target without reversing chronology", async () => {
    const oldest = email("old", "2026-01-01T00:00:00Z");
    const latest = email("latest", "2026-01-02T00:00:00Z");
    const emails = [oldest, latest];
    db.thread.findFirst.mockResolvedValue({ emails });

    const result = await caller().getReplyDetails({ accountId: account.id, threadId: "self-thread" });

    expect(result).toEqual({ subject: latest.subject, to: latest.to, cc: latest.cc,
      from: { name: account.name, address: account.emailAddress }, reply: false, internetMessageId: latest.internetMessageId });
    expect(emails).toEqual([oldest, latest]);
    expect(db.account.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: account.id, userId: account.userId } }));
    expect(db.thread.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "self-thread", accountId: account.id },
      include: { emails: expect.objectContaining({ orderBy: { sentAt: "asc" } }) },
    }));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("uses the latest external email even when a newer self-sent email exists", async () => {
    const old = email("external-old", "2026-01-01T00:00:00Z", "old-external@example.test");
    const external = email("external-new", "2026-01-02T00:00:00Z", "new-external@example.test");
    external.to.push(address(account.emailAddress));
    external.cc.push(address(account.emailAddress));
    const self = email("self-newest", "2026-01-03T00:00:00Z");
    const emails = [old, external, self];
    db.thread.findFirst.mockResolvedValue({ emails });

    expect(await caller().getReplyDetails({ accountId: account.id, threadId: "external-thread" })).toEqual({
      subject: external.subject, to: [external.from, external.to[0]], cc: [external.cc[0]],
      from: { name: account.name, address: account.emailAddress }, reply: true, internetMessageId: external.internetMessageId,
    });
    expect(emails).toEqual([old, external, self]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("rejects another Account before looking up a thread", async () => {
    await expect(caller().getReplyDetails({ accountId: "other-account", threadId: "private-thread" })).rejects.toThrow("Account not found");
    expect(db.thread.findFirst).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("scopes a missing/foreign thread lookup to the authorized Account", async () => {
    db.thread.findFirst.mockResolvedValue(null);
    await expect(caller().getReplyDetails({ accountId: account.id, threadId: "foreign-thread" })).rejects.toThrow("Thread not found!");
    expect(db.thread.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "foreign-thread", accountId: account.id } }));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
