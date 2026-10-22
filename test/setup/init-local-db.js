import { execFileSync } from "node:child_process";
import { validateTestDatabaseUrl } from "./test-database-url.js";

// Never invoke Prisma before the exact disposable target has been checked.
validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
  env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  stdio: "inherit",
});
