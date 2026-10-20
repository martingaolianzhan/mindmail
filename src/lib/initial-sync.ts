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

  // The provider token is only a candidate until all represented mail is persisted.
  await syncEmailsToDatabase(emails, accountId);

  const checkpoint = await db.account.updateMany({
    where: { id: accountId, userId },
    data: { latestDeltaToken },
  });
  if (checkpoint.count !== 1) {
    return "sync-failed";
  }

  return "completed";
}
