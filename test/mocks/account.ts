import { vi } from "vitest";

export const syncEmailsMock = vi.fn();
export const sendEmailMock = vi.fn();

export class AccountMock {
  syncEmails = syncEmailsMock;
  sendEmail = sendEmailMock;
}
