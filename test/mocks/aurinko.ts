import { vi } from "vitest";

export const aurinkoMock = {
  exchangeCodeForAccessToken: vi.fn(),
  getAccountDetails: vi.fn(),
  startSync: vi.fn(),
  getUpdatedEmails: vi.fn(),
  sendEmail: vi.fn(),
};
