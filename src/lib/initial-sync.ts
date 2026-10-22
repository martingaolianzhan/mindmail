import { Account } from "~/lib/account";
import { db } from "~/server/db";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";
import { claimSyncExecution, completeSyncExecution, releaseSyncExecution, StaleSyncExecutionError, SyncNotAcquiredError, type SyncExecution } from "./sync-execution";

export type InitialSyncInput = {
  accountId: string;
  userId: string;
};

export type InitialSyncResult = "completed" | "account-not-found" | "sync-failed" | "not-acquired";

// This function is only called from trusted server-side flows. It still checks
// ownership at the database boundary before constructing an Aurinko client.
export async function performInitialSync({ accountId, userId }: InitialSyncInput): Promise<InitialSyncResult> {
  const dbAccount = await db.account.findFirst({
    where: { id: accountId, userId },
  });

  if (!dbAccount) {
    return "account-not-found";
  }

  let execution: SyncExecution;
  try {
    execution = await claimSyncExecution(dbAccount);
  } catch (error) {
    if (error instanceof SyncNotAcquiredError) return "not-acquired";
    throw error;
  }

  let completed = false;
  try {
    const account = new Account(dbAccount.accessToken);
    const response = await account.performInitialSync();
    if (!response) return "sync-failed";

    // The provider token stays a candidate until represented mail is persisted.
    await syncEmailsToDatabase(response.emails, execution);
    // Retains account/user/original-token guarding in addition to generation/run.
    await completeSyncExecution(execution, response.latestDeltaToken);
    completed = true;
    return "completed";
  } catch (error) {
    if (error instanceof StaleSyncExecutionError) return "sync-failed";
    throw error;
  } finally {
    if (!completed) await releaseSyncExecution(execution);
  }
}
