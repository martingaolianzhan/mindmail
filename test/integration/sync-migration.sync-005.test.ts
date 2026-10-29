import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { db } from "~/server/db";

// Exercise the reviewed SQL against synthetic pre-migration Accounts in an
// isolated schema on the SAME guarded disposable DB. Public schema is untouched.
it("SYNC-005 migration adopts pre-existing Accounts blocked, fences owners and clears unverified checkpoints without deleting mail", async () => {
  const schema = `sync005_${crypto.randomUUID().replaceAll("-", "")}`;
  const sql = readFileSync("prisma/migrations/20261024000000_sync_scheduling/migration.sql", "utf8");
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    await tx.$executeRawUnsafe('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "syncGeneration" INTEGER NOT NULL DEFAULT 0, "activeSyncRunId" TEXT, "latestDeltaToken" TEXT)');
    await tx.$executeRawUnsafe('CREATE TABLE "Thread" ("id" TEXT PRIMARY KEY, "accountId" TEXT REFERENCES "Account"("id"))');
    await tx.$executeRawUnsafe('INSERT INTO "Account" VALUES (\'old\', 3, \'stranded\', \'old-checkpoint\'), (\'new\', 0, NULL, NULL)');
    await tx.$executeRawUnsafe('INSERT INTO "Thread" VALUES (\'retained\', \'old\')');
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; syncGeneration: number; activeSyncRunId: string | null; latestDeltaToken: string | null; syncScheduleState: string; syncNextRunAt: Date | null; syncRetryCount: number; syncScheduleVersion: number; syncLastOutcomeReason: string }>>('SELECT * FROM "Account" ORDER BY "id"');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ activeSyncRunId: null, latestDeltaToken: null, syncScheduleState: "blocked", syncNextRunAt: null, syncRetryCount: 0, syncScheduleVersion: 0, syncLastOutcomeReason: "adoption-relink-required" });
    expect(rows.find((r) => r.id === "old")!.syncGeneration).toBe(4);
    expect(await tx.$queryRawUnsafe('SELECT "id" FROM "Thread"')).toEqual([{ id: "retained" }]);
    await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});
afterAll(() => db.$disconnect());
