import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/server/db";
import { validateTestDatabaseUrl } from "../setup/test-database-url.js";

const id = `test001-${crypto.randomUUID()}`;

beforeAll(async () => {
  await db.$connect(); // Must fail when PostgreSQL is unavailable; URL validation alone is insufficient.
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id } });
  await db.$disconnect();
});

describe("TEST-001 real disposable PostgreSQL isolation", () => {
  it("connects to the validated local DB and reads its real identity", async () => {
    const target = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
    const identity = await db.$queryRaw<Array<{ database: string; dbUser: string }>>`
      SELECT current_database() AS database, current_user AS "dbUser"
    `;
    expect(identity).toEqual([{ database: "mindmail_test", dbUser: "mindmail_test" }]);
  });

  it("writes, reads and cleans up a synthetic User through the project Prisma schema", async () => {
    await db.user.create({
      data: { id, emailAddress: `${id}@example.test`, firstName: "Synthetic", lastName: "Test" },
    });
    expect(await db.user.findUnique({ where: { id } })).toMatchObject({ id, firstName: "Synthetic" });
    await db.user.delete({ where: { id } });
    expect(await db.user.findUnique({ where: { id } })).toBeNull();
  });
});
