export const syntheticEmail = {
  id: "synthetic-email-1",
  threadId: "synthetic-thread-1",
  createdTime: "2025-01-01T09:00:00.000Z",
  lastModifiedTime: "2025-01-01T09:00:00.000Z",
  sentAt: "2025-01-01T09:00:00.000Z",
  receivedAt: "2025-01-01T09:00:00.000Z",
  internetMessageId: "<synthetic-email-1@example.test>",
  subject: "Synthetic mailbox message",
  sysLabels: ["inbox"],
  keywords: [],
  sysClassifications: [],
  sensitivity: "normal",
  meetingMessageMethod: "other",
  from: { name: "Sender", address: "sender@example.test" },
  to: [{ name: "Recipient", address: "recipient@example.test" }],
  cc: [],
  bcc: [],
  replyTo: [],
  hasAttachments: false,
  body: "Synthetic body",
  bodySnippet: "Synthetic body",
  attachments: [],
  inReplyTo: "",
  references: "",
  threadIndex: "",
  internetHeaders: [],
  nativeProperties: {},
  folderId: "synthetic-inbox",
  webLink: "https://example.test/messages/synthetic-email-1",
  omitted: [],
};

export const initialSyncFixtures = {
  zeroPages: [],
  onePage: [
    {
      records: [syntheticEmail],
      nextDeltaToken: "synthetic-delta-final",
    },
  ],
  multiplePages: [
    {
      records: [syntheticEmail],
      nextPageToken: "synthetic-page-2",
      nextDeltaToken: "synthetic-delta-page-1",
    },
    {
      records: [{ ...syntheticEmail, id: "synthetic-email-2" }],
      nextDeltaToken: "synthetic-delta-final",
    },
  ],
  repeatedPageToken: "synthetic-page-repeat",
} as const;
