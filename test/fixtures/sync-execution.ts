import type { SyncExecution } from "~/lib/sync-execution";

// Synthetic unit-test authority; real DB integration fixtures claim their runs.
export const execution: SyncExecution = {
  accountId: "account-a", userId: "user-a", originalAccessToken: "synthetic-token",
  generation: 0, runId: "synthetic-run",
};
