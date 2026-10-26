import { afterEach, expect, it, vi } from "vitest";
const { client } = vi.hoisted(() => ({ client: vi.fn(function () { return {}; }) }));
vi.mock("@prisma/client", () => ({ PrismaClient: client }));
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
afterEach(() => { delete (globalThis as { prisma?: unknown }).prisma; });
it("SYNC-007 disables Prisma automatic raw query/error logging; callers log only safe categories", async () => {
  delete (globalThis as { prisma?: unknown }).prisma;
  await import("~/server/db");
  expect(client).toHaveBeenCalledExactlyOnceWith({ log: [] });
});
