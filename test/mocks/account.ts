import { vi } from "vitest";

export const syncEmailsMock = vi.fn();

export class AccountMock {
  syncEmails = syncEmailsMock;
}
