import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailMessage } from "~/type";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    emailAddress: { create: vi.fn(), findUnique: vi.fn() },
    email: { findMany: vi.fn(), upsert: vi.fn() },
    emailAttachment: { upsert: vi.fn() },
    thread: { update: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("~/server/db", () => ({ db: dbMock }));

import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { execution } from "../fixtures/sync-execution";

const baseEmail = (id = "email-a"): EmailMessage => ({
  id,
  threadId: `thread-${id}`,
  createdTime: "2025-01-01T00:00:00.000Z",
  lastModifiedTime: "2025-01-01T00:00:00.000Z",
  sentAt: "2025-01-01T00:00:00.000Z",
  receivedAt: "2025-01-01T00:00:00.000Z",
  internetMessageId: `<${id}@example.test>`,
  subject: "Synthetic subject",
  sysLabels: ["inbox"], keywords: [], sysClassifications: [], sensitivity: "normal", meetingMessageMethod: "other",
  from: { address: "sender@example.test" }, to: [{ address: "recipient@example.test" }], cc: [], bcc: [], replyTo: [],
  hasAttachments: false, body: "Synthetic body", bodySnippet: "Synthetic body", attachments: [], inReplyTo: "", references: "", threadIndex: "",
  internetHeaders: [], nativeProperties: { property1: "", property2: "" }, folderId: "", webLink: "", omitted: [],
});

function configureSuccess() {
  dbMock.emailAddress.findUnique.mockResolvedValue(null);
  dbMock.emailAddress.create.mockImplementation(({ data }: { data: { address: string } }) => Promise.resolve({ id: `address-${data.address}`, address: data.address }));
  dbMock.thread.upsert.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id }));
  dbMock.email.upsert.mockResolvedValue({});
  dbMock.email.findMany.mockResolvedValue([{ emailLabel: "inbox" }]);
  dbMock.thread.update.mockResolvedValue({});
  dbMock.emailAttachment.upsert.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
  configureSuccess();
  dbMock.$queryRaw.mockResolvedValue([{ id: execution.accountId }]);
  dbMock.$transaction.mockImplementation((callback: (tx: typeof dbMock) => unknown) => callback(dbMock));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SYNC-008 persistence failure propagation", () => {
  it("resolves for a complete valid persistence path", async () => {
    await expect(syncEmailsToDatabase([baseEmail()], execution)).resolves.toBeUndefined();
    expect(dbMock.thread.update).toHaveBeenCalledOnce();
  });

  it.each([
    ["sender address", (email: EmailMessage) => dbMock.emailAddress.create.mockImplementation(({ data }: { data: { address: string } }) => data.address === email.from.address ? Promise.reject(new Error("SECRET-SENTINEL")) : Promise.resolve({ id: "recipient", address: data.address }))],
    ["recipient address", () => dbMock.emailAddress.create.mockImplementation(({ data }: { data: { address: string } }) => data.address === "recipient@example.test" ? Promise.reject(new Error("SECRET-SENTINEL")) : Promise.resolve({ id: "sender", address: data.address }))],
  ])("rejects when required %s persistence fails", async (_name, injectFailure) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const email = baseEmail();
    injectFailure(email);

    await expect(syncEmailsToDatabase([email], execution)).rejects.toThrow("Failed to sync emails to database.");

    expect(dbMock.thread.upsert).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Failed to sync emails to database.");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("SECRET-SENTINEL");
  });

  it.each([
    ["thread upsert", () => dbMock.thread.upsert.mockRejectedValue(new Error("failure"))],
    ["email upsert", () => dbMock.email.upsert.mockRejectedValue(new Error("failure"))],
    ["thread status update", () => dbMock.thread.update.mockRejectedValue(new Error("failure"))],
    ["attachment", () => dbMock.emailAttachment.upsert.mockRejectedValue(new Error("failure"))],
  ])("rejects when %s persistence fails", async (_name, injectFailure) => {
    const email = baseEmail();
    if (_name === "attachment") email.attachments = [{ id: "attachment-a", name: "a", mimeType: "text/plain", size: 1, inline: false }];
    injectFailure();

    await expect(syncEmailsToDatabase([email], execution)).rejects.toThrow("Failed to sync emails to database.");
  });

  it("fails fast without intentionally persisting a later email", async () => {
    const first = baseEmail("email-a");
    const failing = baseEmail("email-b");
    const later = baseEmail("email-c");
    dbMock.thread.upsert.mockImplementation(({ where }: { where: { id: string } }) => where.id === failing.threadId ? Promise.reject(new Error("failure")) : Promise.resolve({ id: where.id }));

    await expect(syncEmailsToDatabase([first, failing, later], execution)).rejects.toThrow("Failed to sync emails to database.");

    expect(dbMock.thread.upsert).toHaveBeenCalledTimes(2);
    expect(dbMock.thread.upsert).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: later.threadId } }));
  });
});
