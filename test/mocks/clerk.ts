import { vi } from "vitest";

export const clerkAuthMock = vi.fn();

export const clerkServerMock = {
  auth: clerkAuthMock,
};
