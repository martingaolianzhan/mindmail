import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const AURINKO_OAUTH_STATE_COOKIE = "mindmail_aurinko_oauth";
export const AURINKO_OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

type OAuthCorrelation = {
  userId: string;
  state: string;
  expiresAt: number;
};

function signingSecret(): string {
  const secret = process.env.AURINKO_OAUTH_STATE_SECRET;
  if (!secret) {
    throw new Error("Aurinko OAuth state signing is not configured");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

export function createAurinkoOAuthCorrelation(userId: string, now = Date.now()) {
  const state = randomBytes(32).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    userId,
    state,
    expiresAt: now + AURINKO_OAUTH_STATE_MAX_AGE_SECONDS * 1000,
  })).toString("base64url");

  return { state, value: `${payload}.${sign(payload)}` };
}

export function verifyAurinkoOAuthCorrelation(value: string | undefined, state: string | null, userId: string, now = Date.now()): boolean {
  if (!value || !state) return false;

  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return false;

  const expectedSignature = sign(payload);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;

  try {
    const correlation = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthCorrelation;
    return correlation.userId === userId
      && correlation.state === state
      && Number.isSafeInteger(correlation.expiresAt)
      && correlation.expiresAt > now;
  } catch {
    return false;
  }
}

export const aurinkoOAuthStateCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/api/aurinko/callback",
  maxAge: AURINKO_OAUTH_STATE_MAX_AGE_SECONDS,
};
