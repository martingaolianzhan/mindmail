import { Webhook } from "svix";
import { z } from "zod";

import { db } from "~/server/db";

const requiredSignatureHeaders = ["svix-id", "svix-timestamp", "svix-signature"] as const;

const userEventSchema = z.object({
  type: z.enum(["user.created", "user.updated"]),
  data: z.object({
    id: z.string().min(1),
    email_addresses: z.array(z.object({ id: z.string().optional(), email_address: z.string().min(1) })).min(1),
    primary_email_address_id: z.string().nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
  }),
});

const deletedUserEventSchema = z.object({
  type: z.literal("user.deleted"),
  data: z.object({ id: z.string().min(1) }),
});

function getSignedHeaders(request: Request) {
  const headers = Object.fromEntries(
    requiredSignatureHeaders.map((name) => [name, request.headers.get(name)]),
  );

  return Object.values(headers).every((value) => typeof value === "string" && value.length > 0)
    ? headers as Record<(typeof requiredSignatureHeaders)[number], string>
    : null;
}

function userFields(data: z.infer<typeof userEventSchema>["data"]) {
  const primaryEmail = data.email_addresses.find(
    (email) => email.id === data.primary_email_address_id,
  ) ?? data.email_addresses[0];
  const emailAddress = primaryEmail?.email_address.trim();

  if (!emailAddress) return null;

  const firstName = data.first_name?.trim();
  const lastName = data.last_name?.trim();

  return {
    emailAddress,
    firstName: firstName === undefined || firstName.length === 0 ? emailAddress : firstName,
    lastName: lastName ?? "",
    imageUrl: data.image_url ?? null,
  };
}

// Clerk/Svix authentication is required before parsing the event payload or
// touching persistence. User deletion is deliberately acknowledged without a
// local delete: current foreign keys have no deletion policy, so complete
// account/mailbox cleanup remains LIFE-003 work.
export async function POST(request: Request) {
  const signatureHeaders = getSignedHeaders(request);
  if (!signatureHeaders) {
    return new Response("Missing webhook signature.", { status: 400 });
  }

  const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!signingSecret) {
    return new Response("Webhook is not configured.", { status: 500 });
  }

  const payload = await request.text();
  let verifiedEvent: unknown;
  try {
    verifiedEvent = new Webhook(signingSecret).verify(payload, signatureHeaders);
  } catch {
    return new Response("Invalid webhook signature.", { status: 400 });
  }

  const envelope = z.object({ type: z.string(), data: z.unknown() }).safeParse(verifiedEvent);
  if (!envelope.success) {
    return new Response("Invalid webhook event.", { status: 422 });
  }

  if (envelope.data.type === "user.deleted") {
    // Do not partially delete a User while related Accounts/mail data remain.
    // LIFE-003 owns the schema/lifecycle design for durable cleanup.
    if (!deletedUserEventSchema.safeParse(verifiedEvent).success) {
      return new Response("Invalid webhook event.", { status: 422 });
    }
    return new Response("Webhook event acknowledged.", { status: 200 });
  }

  if (envelope.data.type !== "user.created" && envelope.data.type !== "user.updated") {
    return new Response("Webhook event ignored.", { status: 200 });
  }

  const parsedEvent = userEventSchema.safeParse(verifiedEvent);
  if (!parsedEvent.success) {
    return new Response("Invalid webhook event.", { status: 422 });
  }

  const fields = userFields(parsedEvent.data.data);
  if (!fields) {
    return new Response("Invalid webhook event.", { status: 422 });
  }

  await db.user.upsert({
    where: { id: parsedEvent.data.data.id },
    update: fields,
    create: { id: parsedEvent.data.data.id, ...fields },
  });

  return new Response("Webhook event processed.", { status: 200 });
}
