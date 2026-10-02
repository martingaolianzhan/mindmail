import { describe, expect, it } from "vitest";
import { validateTestDatabaseUrl } from "../setup/test-database-url.js";

const local = "postgresql://mindmail_test:synthetic@127.0.0.1:55432/mindmail_test";

describe("disposable database URL guard", () => {
  it.each([local, local.replace("127.0.0.1", "localhost"), local.replace("postgresql:", "postgres:")])(
    "accepts approved local target", (url) => {
      expect(validateTestDatabaseUrl(url).pathname).toBe("/mindmail_test");
    },
  );
  it.each([
    local.replace("127.0.0.1", "neon.tech"),
    local.replace("/mindmail_test", "/mindmail_prod"),
    local.replace("mindmail_test:synthetic", "other_user:synthetic"),
    local.replace("postgresql:", "https:"),
    local.replace("55432", "5432"),
    local.replace("127.0.0.1", "[::1]"),
    local.replace("127.0.0.1", "[::ffff:127.0.0.1]"),
    local.replace("127.0.0.1", "localhost.evil.test"),
    local + "?schema=public",
    "not a url",
  ])("fails closed on unsafe or malformed target", (url) => {
    expect(() => validateTestDatabaseUrl(url)).toThrow();
  });
});
