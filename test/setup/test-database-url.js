// Restrict tests to the one explicitly authorised disposable Docker database.
/** @param {string | undefined} value */
export function validateTestDatabaseUrl(value) {
  if (!value) throw new Error("TEST_DATABASE_URL is required for integration tests.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.pathname !== "/mindmail_test" ||
    url.username !== "mindmail_test" ||
    !url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("TEST_DATABASE_URL must target the authorised local mindmail_test database on port 55432.");
  }
  return url;
}
