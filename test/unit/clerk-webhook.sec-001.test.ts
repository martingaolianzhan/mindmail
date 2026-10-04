import { beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

const { userUpsert } = vi.hoisted(() => ({ userUpsert: vi.fn() }));

vi.mock("~/server/db", () => ({
  db: { user: { upsert: userUpsert } },
}));

import { POST } from "~/app/api/clerk/webhook/route";

const signingSecret = "whsec_dGVzdC1zZWMtMDAx";
const signer = new Webhook(signingSecret);
const now = new Date();

function userEvent(type: "user.created" | "user.updated", overrides = {}) {
  return {
    type,
    data: {
      id: "user_sec001",
      email_addresses: [{ id: "email_sec001", email_address: "user@example.test" }],
      primary_email_address_id: "email_sec001",
      first_name: "Ada",
      last_name: "Lovelace",
      image_url: "https://images.example.test/user.png",
      ...overrides,
    },
  };
}

function signedRequest(event: unknown, timestamp = now, signature = true) {
  const payload = JSON.stringify(event);
  return new Request("http://mindmail.test/api/clerk/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_sec001",
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature ? signer.sign("msg_sec001", timestamp, payload) : "v1,invalid",
    },
    body: payload,
  });
}

beforeEach(() => {
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = signingSecret;
  userUpsert.mockResolvedValue(undefined);
});

describe("SEC-001 Clerk webhook", () => {
  it("verifies a valid user.created event before idempotently persisting it", async () => {
    const response = await POST(signedRequest(userEvent("user.created")));

    expect(response.status).toBe(200);
    expect(userUpsert).toHaveBeenCalledWith({
      where: { id: "user_sec001" },
      update: {
        emailAddress: "user@example.test",
        firstName: "Ada",
        lastName: "Lovelace",
        imageUrl: "https://images.example.test/user.png",
      },
      create: {
        id: "user_sec001",
        emailAddress: "user@example.test",
        firstName: "Ada",
        lastName: "Lovelace",
        imageUrl: "https://images.example.test/user.png",
      },
    });
  });

  it("fails closed without a configured signing secret and does not process a signed payload", async () => {
    delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;

    const response = await POST(signedRequest(userEvent("user.created")));

    expect(response.status).toBe(500);
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it("rejects missing signatures without parsing/persisting the forged payload", async () => {
    const response = await POST(new Request("http://mindmail.test/api/clerk/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(userEvent("user.created")),
    }));

    expect(response.status).toBe(400);
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures without persistence", async () => {
    const response = await POST(signedRequest(userEvent("user.created"), now, false));

    expect(response.status).toBe(400);
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it("rejects stale Svix timestamps without persistence", async () => {
    const response = await POST(signedRequest(userEvent("user.created"), new Date(Date.now() - 6 * 60 * 1000)));

    expect(response.status).toBe(400);
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it("processes user.updated with verified optional profile fallbacks", async () => {
    const response = await POST(signedRequest(userEvent("user.updated", {
      first_name: null,
      last_name: null,
      image_url: null,
    })));

    expect(response.status).toBe(200);
    expect(userUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user_sec001" },
      update: expect.objectContaining({ firstName: "user@example.test", lastName: "", imageUrl: null }),
    }));
  });

  it.each(["user.created", "user.updated"] as const)("uses the same upsert for duplicate %s delivery", async (type) => {
    await POST(signedRequest(userEvent(type)));
    await POST(signedRequest(userEvent(type)));

    expect(userUpsert).toHaveBeenCalledTimes(2);
    expect(userUpsert.mock.calls[0]?.[0]).toEqual(userUpsert.mock.calls[1]?.[0]);
  });

  it("acknowledges repeated user.deleted without changing local users", async () => {
    const event = { type: "user.deleted", data: { id: "user_sec001" } };

    expect((await POST(signedRequest(event))).status).toBe(200);
    expect((await POST(signedRequest(event))).status).toBe(200);
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it("explicitly ignores verified unsupported event types", async () => {
    const response = await POST(signedRequest({ type: "session.created", data: { id: "session_sec001" } }));

    expect(response.status).toBe(200);
    expect(userUpsert).not.toHaveBeenCalled();
  });
});
