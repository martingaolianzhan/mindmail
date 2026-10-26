import { Account } from "~/lib/account";
import { executeSync, type SyncFailure, type SyncRunOptions } from "./sync-run";

export type InitialSyncInput = { accountId: string; userId: string };
export type InitialSyncResult = SyncFailure | { status: "completed" };

// Trusted server-side boundary. Never return the successful checkpoint/mail from
// this background service; only the provider/persistence phases need that data.
export async function performInitialSync({ accountId, userId }: InitialSyncInput, options: SyncRunOptions = {}): Promise<InitialSyncResult> {
  const result = await executeSync(
    (tx) => tx.account.findFirst({ where: { id: accountId, userId } }),
    (account, run) => new Account(account.accessToken).performInitialSync(run),
    options,
  );
  if (result.status !== "completed") console.error("Initial sync failed.");
  return result.status === "completed" ? { status: "completed" } : result;
}
