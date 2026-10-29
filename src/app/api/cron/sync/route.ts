import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { consumeDueSyncWork } from "~/lib/sync-orchestration";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.SYNC_CRON_SECRET;
  if (!secret || /\s/.test(secret)) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    // Caller input never selects an Account or overrides durable eligibility.
    await consumeDueSyncWork();
    return NextResponse.json({ ok: true });
  } catch {
    console.error("Scheduled sync wake-up failed.");
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
