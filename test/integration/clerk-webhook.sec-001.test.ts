import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Webhook } from "svix";

import { POST } from "~/app/api/clerk/webhook/route";
import { db } from "~/server/db";

const signingSecret = "whsec_dGVzdC1zZWMtMDAx";
const signer = new Webhook(signingSecret);
const prefix = `sec001-${crypto.randomUUID()}`;
const userId = `${prefix}-user`;

function signedRequest(event: unknown) {
  const payload = JSON.stringify(event);
  const timestamp = new Date();
  const messageId = `msg-${crypto.randomUUID()}`;
  return new Request("http://mindmail.test/api/clerk/webhook", {
    method: "POST",
    headers: {
      "svix-id": messageId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signer.sign(messageId, timestamp, payload),
    },
    body: payload,
  });
}

function userEvent(type: "user.created" | "user.updated", fields = {}) {
  return {
    type,
    data: {
      id: userId,
      email_addresses: [{ id: `${prefix}-email`, email_address: `${prefix}@example.test` }],
      primary_email_address_id: `${prefix}-email`,
      first_name: "Initial",
      last_name: "Name",
      image_url: null,
      ...fields,
    },
  };
}

beforeEach(() => {
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = signingSecret;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: userId } });
});

describe("SEC-001 Clerk webhook real PostgreSQL persistence", () => {
  it("keeps one local user when a valid user.created delivery is repeated", async () => {
    const event = userEvent("user.created");

    expect((await POST(signedRequest(event))).status).toBe(200);
    expect((await POST(signedRequest(event))).status).toBe(200);

    const users = await db.user.findMany({ where: { id: userId } });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: userId, firstName: "Initial", lastName: "Name" });
  });

  it("updates the same local user idempotently for repeated user.updated delivery", async () => {
    const event = userEvent("user.updated", { first_name: "Updated", last_name: null });

    expect((await POST(signedRequest(event))).status).toBe(200);
    expect((await POST(signedRequest(event))).status).toBe(200);

    const users = await db.user.findMany({ where: { id: userId } });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: userId, firstName: "Updated", lastName: "" });
  });

  it("acknowledges repeated user.deleted without partial local cleanup", async () => {
    const event = { type: "user.deleted", data: { id: userId } };

    expect((await POST(signedRequest(event))).status).toBe(200);
    expect((await POST(signedRequest(event))).status).toBe(200);
    expect(await db.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
});
