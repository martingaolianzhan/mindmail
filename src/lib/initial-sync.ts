import { Account } from "~/lib/account";
import { db } from "~/server/db";
import { syncEmailsToDatabase } from "~/lib/sync-to-db";

export type InitialSyncInput = {
  accountId: string;
  userId: string;
};

export type InitialSyncResult = "completed" | "account-not-found" | "sync-failed";

// This function is only called from trusted server-side flows. It still checks
// ownership at the database boundary before constructing an Aurinko client.
export async function performInitialSync({ accountId, userId }: InitialSyncInput): Promise<InitialSyncResult> {
  const dbAccount = await db.account.findFirst({
    where: { id: accountId, userId },
  });

  if (!dbAccount) {
    return "account-not-found";
  }

  const account = new Account(dbAccount.accessToken);
  const response = await account.performInitialSync();
  if (!response) {
    return "sync-failed";
  }

  const { emails, latestDeltaToken } = response;

  // Preserve the existing initial-sync persistence ordering. SYNC-003 owns
  // the durable delta-commit policy.
  await db.account.update({
    where: { accessToken: dbAccount.accessToken },
    data: { latestDeltaToken },
  });

  await syncEmailsToDatabase(emails, accountId);

  return "completed";
}
