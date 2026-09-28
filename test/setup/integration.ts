import "./network";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required for integration tests and must name a loopback *_test PostgreSQL database.",
  );
}

let parsedUrl: URL;
try {
  parsedUrl = new URL(testDatabaseUrl);
} catch {
  throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL connection URL.");
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const databaseName = parsedUrl.pathname.slice(1);

if (
  !["postgres:", "postgresql:"].includes(parsedUrl.protocol) ||
  !loopbackHosts.has(parsedUrl.hostname) ||
  !databaseName.endsWith("_test")
) {
  throw new Error(
    "TEST_DATABASE_URL must target a loopback PostgreSQL database whose name ends in _test.",
  );
}

// This deliberate override prevents application imports in integration tests
// from falling back to a historical DATABASE_URL from .env.
process.env.DATABASE_URL = testDatabaseUrl;
