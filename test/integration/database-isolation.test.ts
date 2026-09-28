import { describe, expect, it } from "vitest";

describe("TEST-001 integration database isolation", () => {
  it("overrides DATABASE_URL with the explicit disposable test database", () => {
    expect(process.env.TEST_DATABASE_URL).toBeDefined();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);

    const databaseUrl = new URL(process.env.DATABASE_URL!);
    expect(["localhost", "127.0.0.1", "::1"]).toContain(databaseUrl.hostname);
    expect(databaseUrl.pathname).toMatch(/_test$/);
  });
});
