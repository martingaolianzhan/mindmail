import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { axiosMock, dbMock, streamTextMock, streamableValueMock } = vi.hoisted(() => ({
  axiosMock: { get: vi.fn(), isAxiosError: vi.fn(), post: vi.fn() },
  dbMock: {
    account: { findUnique: vi.fn(), update: vi.fn() },
    email: { findMany: vi.fn(), upsert: vi.fn() },
    emailAddress: { create: vi.fn(), findUnique: vi.fn() },
    emailAttachment: { upsert: vi.fn() },
    thread: { update: vi.fn(), upsert: vi.fn() },
  },
  streamTextMock: vi.fn(),
  streamableValueMock: vi.fn(),
}));

vi.mock("axios", () => ({ default: axiosMock }));
vi.mock("~/server/db", () => ({ db: dbMock }));
vi.mock("ai", () => ({ streamText: streamTextMock }));
vi.mock("ai/rsc", () => ({ createStreamableValue: streamableValueMock }));
vi.mock("@ai-sdk/google", () => ({ google: vi.fn(() => "synthetic-model") }));

import { getAccountDetails, exchangeCodeForAccessToken } from "~/lib/aurinko";
import { Account } from "~/lib/account";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { autoAIComplete, generateEmail } from "~/app/mail/components/ai-compose/ai-actions";

const sentinels = [
  "oauth-code-SECRET-SENTINEL",
  "access-token-SECRET-SENTINEL",
  "mail-body-SECRET-SENTINEL",
  "ai-context-SECRET-SENTINEL",
  "provider-secret-SECRET-SENTINEL",
];

function loggedText(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((args) => args.map((value) => {
    try {
      return typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ")).join("\n");
}

function expectNoSensitiveLogs(spy: ReturnType<typeof vi.spyOn>) {
  const output = loggedText(spy);
  for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
}

beforeEach(() => {
  axiosMock.isAxiosError.mockReturnValue(true);
  streamableValueMock.mockImplementation(() => ({ done: vi.fn(), error: vi.fn(), update: vi.fn(), value: {} }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SEC-007 sensitive logging boundaries", () => {
  it("never logs OAuth codes or token/provider error payloads", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    axiosMock.post.mockRejectedValue({
      config: { headers: { Authorization: "Bearer access-token-SECRET-SENTINEL" } },
      response: { data: { code: "oauth-code-SECRET-SENTINEL", secret: "provider-secret-SECRET-SENTINEL" } },
    });

    await expect(exchangeCodeForAccessToken("oauth-code-SECRET-SENTINEL")).rejects.toBeDefined();

    expect(errorSpy).toHaveBeenCalledWith("Aurinko token exchange failed.");
    expectNoSensitiveLogs(errorSpy);
    expectNoSensitiveLogs(logSpy);
  });

  it("does not dump secret-bearing account-detail provider failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    axiosMock.get.mockRejectedValue({ response: { data: { token: "access-token-SECRET-SENTINEL", secret: "provider-secret-SECRET-SENTINEL" } } });

    await expect(getAccountDetails("access-token-SECRET-SENTINEL")).rejects.toBeDefined();

    expect(errorSpy).toHaveBeenCalledWith("Failed to fetch account details.");
    expectNoSensitiveLogs(errorSpy);
  });

  it("logs only safe email-send success/failure messages, not body, token, or provider payload", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const account = new Account("access-token-SECRET-SENTINEL");
    const input = {
      from: { address: "sender@example.test" },
      replyTo: { address: "sender@example.test" },
      to: [{ address: "recipient@example.test" }],
      subject: "Synthetic subject",
      body: "mail-body-SECRET-SENTINEL",
    };
    axiosMock.post.mockResolvedValue({ data: { secret: "provider-secret-SECRET-SENTINEL" } });

    await expect(account.sendEmail(input)).resolves.toEqual({ secret: "provider-secret-SECRET-SENTINEL" });
    expect(logSpy).toHaveBeenCalledWith("Email sent successfully.");
    expectNoSensitiveLogs(logSpy);

    axiosMock.post.mockRejectedValue({ response: { data: { body: "mail-body-SECRET-SENTINEL", secret: "provider-secret-SECRET-SENTINEL" } } });
    await expect(account.sendEmail(input)).rejects.toBeDefined();
    expect(errorSpy).toHaveBeenCalledWith("Email send failed.");
    expectNoSensitiveLogs(errorSpy);
  });

  it("does not log raw initial-sync provider errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    axiosMock.post.mockRejectedValue({ response: { data: { body: "mail-body-SECRET-SENTINEL", secret: "provider-secret-SECRET-SENTINEL" } } });

    await expect(new Account("access-token-SECRET-SENTINEL").performInitialSync()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith("Initial sync failed.");
    expectNoSensitiveLogs(errorSpy);
  });

  it("streams successful AI output without logging its context", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    async function* output() { yield "generated content"; }
    streamTextMock.mockResolvedValue({ textStream: output() });

    await generateEmail("ai-context-SECRET-SENTINEL", "private prompt");
    await new Promise((resolve) => setImmediate(resolve));

    const stream = streamableValueMock.mock.results[0]?.value as { done: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    expect(stream.update).toHaveBeenCalledWith("generated content");
    expect(stream.done).toHaveBeenCalledOnce();
    expectNoSensitiveLogs(errorSpy);
    expectNoSensitiveLogs(logSpy);
  });

  it("signals a generic, distinguishable AI failure without logging context or provider data", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    streamTextMock.mockRejectedValue(new Error("provider-secret-SECRET-SENTINEL api-key-SECRET-SENTINEL"));

    await generateEmail("ai-context-SECRET-SENTINEL mail-body-SECRET-SENTINEL", "private prompt");
    await autoAIComplete("ai-context-SECRET-SENTINEL");
    await new Promise((resolve) => setImmediate(resolve));

    const generation = streamableValueMock.mock.results[0]?.value as { error: ReturnType<typeof vi.fn>; done: ReturnType<typeof vi.fn> };
    const autocomplete = streamableValueMock.mock.results[1]?.value as { error: ReturnType<typeof vi.fn>; done: ReturnType<typeof vi.fn> };
    expect(generation.error).toHaveBeenCalledWith(expect.objectContaining({ message: "AI email generation failed." }));
    expect(autocomplete.error).toHaveBeenCalledWith(expect.objectContaining({ message: "AI autocomplete failed." }));
    expect(generation.done).not.toHaveBeenCalled();
    expect(autocomplete.done).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("AI email generation failed.");
    expect(errorSpy).toHaveBeenCalledWith("AI autocomplete failed.");
    expectNoSensitiveLogs(errorSpy);
    expectNoSensitiveLogs(logSpy);
  });

  it("does not log sensitive persistence failures from sync-to-database", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    dbMock.emailAddress.findUnique.mockRejectedValue(new Error("provider-secret-SECRET-SENTINEL mail-body-SECRET-SENTINEL"));
    const email = {
      id: "email-1", threadId: "thread-1", createdTime: new Date().toISOString(), lastModifiedTime: new Date().toISOString(),
      sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(), internetMessageId: "message-1", subject: "Synthetic",
      sysLabels: ["inbox"], keywords: [], sysClassifications: [], sensitivity: "normal", meetingMessageMethod: "other",
      from: { address: "sender@example.test" }, to: [], cc: [], bcc: [], replyTo: [], hasAttachments: false,
      body: "mail-body-SECRET-SENTINEL", bodySnippet: "mail-body-SECRET-SENTINEL", attachments: [], inReplyTo: "", references: "", threadIndex: "",
      internetHeaders: [], nativeProperties: null, folderId: "", webLink: "", omitted: [],
    } as never;

    await expect(syncEmailsToDatabase([email], "access-token-SECRET-SENTINEL")).rejects.toThrow("Failed to sync emails to database.");

    expect(errorSpy).toHaveBeenCalledWith("Failed to sync emails to database.");
    expectNoSensitiveLogs(errorSpy);
    expectNoSensitiveLogs(logSpy);
  });

  it("logs incremental provider failures generically while preserving rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    dbMock.account.findUnique.mockResolvedValue({ id: "account-1", latestDeltaToken: "delta" });
    axiosMock.get.mockRejectedValue({ response: { data: { body: "mail-body-SECRET-SENTINEL", token: "access-token-SECRET-SENTINEL", secret: "provider-secret-SECRET-SENTINEL" } } });

    await expect(new Account("access-token-SECRET-SENTINEL").syncEmails()).rejects.toBeDefined();

    expect(errorSpy).toHaveBeenCalledWith("Incremental sync failed.");
    expectNoSensitiveLogs(errorSpy);
  });
});
