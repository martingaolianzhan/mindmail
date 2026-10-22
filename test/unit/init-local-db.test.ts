import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync }));

const local = "postgresql://mindmail_test:synthetic@127.0.0.1:55432/mindmail_test";

async function initialize(url: string | undefined) {
  vi.resetModules();
  vi.stubEnv("TEST_DATABASE_URL", url);
  await import("../setup/init-local-db.js");
}

afterEach(() => vi.unstubAllEnvs());

describe("migration-only disposable database initializer", () => {
  it.each([
    undefined,
    "not a url",
    local.replace("127.0.0.1", "remote.example.test"),
    local.replace("55432", "5432"),
    local.replace("/mindmail_test", "/production"),
  ])("rejects missing/unsafe target before invoking Prisma: %s", async (url) => {
    await expect(initialize(url)).rejects.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("deploys tracked migrations with the validated target overriding DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "must-not-be-used");
    await initialize(local);
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { env: expect.objectContaining({ DATABASE_URL: local, TEST_DATABASE_URL: local }), stdio: "inherit" },
    );
  });

  it("propagates migration failure without retrying or falling back to db push", async () => {
    execFileSync.mockImplementationOnce(() => { throw new Error("synthetic migration failure"); });
    await expect(initialize(local)).rejects.toThrow("synthetic migration failure");
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls[0]?.[1]).toEqual(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  });
});
