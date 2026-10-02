import { vi } from "vitest";

export const prismaMock = {
  account: {
    findFirst: vi.fn(),
  },
  thread: {
    findMany: vi.fn(),
  },
};
