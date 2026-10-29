import type { Account } from "@prisma/client";
import { db } from "~/server/db";

// Single-run regressions explicitly create/replace test scheduling opportunities.
// Production never bypasses eligibility or forcibly makes backoff work due.
export const testSyncSchedule = { syncScheduleState: "scheduled" as const, syncNextRunAt: new Date(0) };
export async function scheduleTestRun(a: Pick<Account, "id" | "userId">) {
  const result = await db.account.updateMany({
    where: { id: a.id, userId: a.userId, activeSyncRunId: null },
    data: { ...testSyncSchedule, syncScheduleVersion: { increment: 1 } },
  });
  if (result.count !== 1) throw new Error("Test execution owner must be released first");
  return db.account.findUniqueOrThrow({ where: { id: a.id } });
}
