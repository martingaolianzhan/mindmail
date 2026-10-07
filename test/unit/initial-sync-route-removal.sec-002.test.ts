import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routePath = fileURLToPath(new URL("../../src/app/api/initial-sync/route.ts", import.meta.url));
const middlewarePath = fileURLToPath(new URL("../../src/middleware.ts", import.meta.url));
const callbackPath = fileURLToPath(new URL("../../src/app/api/aurinko/callback/route.ts", import.meta.url));

describe("SEC-002 initial-sync HTTP route removal", () => {
  it("removes the route, public middleware allowlist entry, and callback self-HTTP reference", () => {
    expect(existsSync(routePath)).toBe(false);
    expect(readFileSync(middlewarePath, "utf8")).not.toContain("/api/initial-sync");
    expect(readFileSync(callbackPath, "utf8")).not.toContain("/api/initial-sync");
  });
});
