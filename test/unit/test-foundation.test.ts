import axios from "axios";
import { describe, expect, it } from "vitest";

import { initialSyncFixtures } from "../fixtures/emails";
import { aurinkoMock } from "../mocks/aurinko";
import { clerkAuthMock } from "../mocks/clerk";
import { geminiMock } from "../mocks/gemini";

describe("TEST-001 unit foundation", () => {
  it("provides synthetic initial-sync fixtures without mailbox data", () => {
    expect(initialSyncFixtures.zeroPages).toHaveLength(0);
    expect(initialSyncFixtures.onePage[0]?.records[0]?.id).toBe(
      "synthetic-email-1",
    );
    expect(initialSyncFixtures.multiplePages[0]?.nextPageToken).toBe(
      "synthetic-page-2",
    );
    expect(initialSyncFixtures.repeatedPageToken).toBe("synthetic-page-repeat");
  });

  it("provides resettable mocks for Clerk, Aurinko, and Gemini", () => {
    clerkAuthMock.mockReturnValue({ userId: "synthetic-user" });
    aurinkoMock.getUpdatedEmails.mockResolvedValue(initialSyncFixtures.onePage[0]);
    geminiMock.streamText.mockResolvedValue({ textStream: [] });

    expect(clerkAuthMock()).toEqual({ userId: "synthetic-user" });
    expect(aurinkoMock.getUpdatedEmails).toHaveBeenCalledTimes(0);
    expect(geminiMock.streamText).toHaveBeenCalledTimes(0);
  });

  it("blocks unmocked external HTTP requests", async () => {
    await expect(
      axios.get("https://api.aurinko.io/v1/email/sync/updated"),
    ).rejects.toMatchObject({ code: "ENETUNREACH" });
  });
});
