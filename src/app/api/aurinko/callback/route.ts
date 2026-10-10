import { auth } from "@clerk/nextjs/server";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { exchangeCodeForAccessToken, getAccountDetails } from "~/lib/aurinko";
import {
  AURINKO_OAUTH_STATE_COOKIE,
  verifyAurinkoOAuthCorrelation,
} from "~/lib/aurinko-oauth-state";
import { performInitialSync } from "~/lib/initial-sync";
import { db } from "~/server/db";

function failure(message: string, status: number) {
  return NextResponse.json({ message }, { status });
}

function consumeCorrelation(response: NextResponse) {
  response.cookies.set(AURINKO_OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/aurinko/callback",
    maxAge: 0,
  });
  return response;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

// This function intentionally returns unconsumed responses. GET applies the
// one post-validation consumption boundary to both successful and failed work.
async function completeValidatedOAuthCallback(req: NextRequest, userId: string): Promise<NextResponse> {
  const status = req.nextUrl.searchParams.get("status");
  if (status !== "success") return failure("Authorization failed", 403);

  const code = req.nextUrl.searchParams.get("code");
  if (!code) return failure("No code received", 400);

  const token = await exchangeCodeForAccessToken(code);
  if (!token) return failure("Failed to exchange code for access token", 502);

  const accountId = token.accountId.toString();
  const existingAccount = await db.account.findUnique({ where: { id: accountId } });
  if (existingAccount && existingAccount.userId !== userId) {
    return failure("Unable to link this account", 403);
  }

  if (existingAccount) {
    // The persistence boundary itself includes userId, so an ownership change
    // after the read above cannot turn into an ownership-blind token update.
    const updated = await db.account.updateMany({
      where: { id: accountId, userId },
      data: { accessToken: token.accessToken },
    });
    if (updated.count !== 1) return failure("Unable to link this account", 403);
  } else {
    const accountDetails = await getAccountDetails(token.accessToken);
    try {
      await db.account.create({
        data: {
          id: accountId,
          userId,
          emailAddress: accountDetails.email,
          name: accountDetails.name,
          accessToken: token.accessToken,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      // A create race never falls back to an ID-only update. Re-evaluate the
      // winner and use the same ownership-scoped write for same-owner retries.
      const racedAccount = await db.account.findUnique({ where: { id: accountId } });
      if (!racedAccount || racedAccount.userId !== userId) {
        return failure("Unable to link this account", 403);
      }
      const updated = await db.account.updateMany({
        where: { id: accountId, userId },
        data: { accessToken: token.accessToken },
      });
      if (updated.count !== 1) return failure("Unable to link this account", 403);
    }
  }

  waitUntil(
    performInitialSync({ accountId, userId })
      .then((result) => {
        if (result !== "completed") console.error("Initial sync did not complete.");
      })
      .catch(() => console.error("Initial sync failed.")),
  );

  return NextResponse.redirect(new URL("/mail", req.url));
}

// Handles the provider redirect only after proving that the current Clerk user
// is the same user that initiated this short-lived OAuth flow.
export const GET = async (req: NextRequest) => {
  const { userId } = await auth();
  if (!userId) return failure("Unauthorized", 401);

  const state = req.nextUrl.searchParams.get("state");
  try {
    if (!verifyAurinkoOAuthCorrelation(req.cookies.get(AURINKO_OAUTH_STATE_COOKIE)?.value, state, userId)) {
      return failure("Invalid OAuth state", 403);
    }
  } catch {
    // This includes a missing signing secret. Do not fall back to unsigned state.
    return failure("OAuth state verification is unavailable", 503);
  }

  // Once validation succeeds, every exit below consumes the browser cookie.
  try {
    return consumeCorrelation(await completeValidatedOAuthCallback(req, userId));
  } catch {
    return consumeCorrelation(failure("Unable to complete account linking", 500));
  }
};
