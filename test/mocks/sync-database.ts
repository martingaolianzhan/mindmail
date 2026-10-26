import type { Prisma } from "@prisma/client";
import { db } from "~/server/db";

// Legacy unit fixtures model a single delegate. Native transaction/observation
// bounds are covered separately in SYNC-007; integration uses real transactions.
export const withSyncDatabase = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => operation(db);
export const submitSyncDatabase = withSyncDatabase;
