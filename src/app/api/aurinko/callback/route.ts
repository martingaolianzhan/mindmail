import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { exchangeCodeForAccessToken, getAccountDetails } from "~/lib/aurinko";
import { db } from "~/server/db";
import { performInitialSync } from "~/lib/initial-sync";
import { waitUntil } from "@vercel/functions";

// handle account token after received from Aurinko
export const GET = async (req: NextRequest) => {

    console.log("Callback received from Aurinko");
    // check user login status first
    const { userId } = await auth();
    if (!userId) { 
        return NextResponse.json({
            message: "Unauthorized",
            status: 401 // unauthorized error code
        })
    };

    // get return params from Aurinko
    const params = req.nextUrl.searchParams;

    // get status
    const status = params.get("status");
    // check wehether it is success
    if (status !== "success") {
        return NextResponse.json({
            message: "Authorization failed",
            status: 403 // forbidden error code
        })
    };

    // get code for exchange token
    const code = params.get("code");
    
    // check whether code exists
    if (!code) {
        return NextResponse.json({
            message: "No code received",
            status: 400 // bad request error code
        })
    };
    // exchange code for token
    const token = await exchangeCodeForAccessToken(code);
    // check whether token exists
    if (!token) {
        return NextResponse.json({
            message:"Failed to exchange code for access token."
        });
    }

    // get account details
    const accountDetails = await getAccountDetails(token.accessToken);

    // save details to database
    // "upsert": if no record, insert it. Otherwise update it if exists, e.g.update new access token
    await db.account.upsert({
        where: { // check if record exists by account id
            id: token.accountId.toString()
        },
        update: { // if exists, update
            accessToken: token.accessToken,
        },
        create: { // otherwise insert new record into db
            id: token.accountId.toString(),
            userId,
            emailAddress: accountDetails.email,
            name: accountDetails.name,
            accessToken: token.accessToken
        }
    });

    // Run initial sync in the existing background flow using the Clerk-derived
    // identity directly; no public callback-to-self HTTP boundary is involved.
    waitUntil(
        performInitialSync({ accountId: token.accountId.toString(), userId })
            .then((result) => {
                if (result !== "completed") {
                    console.error("Initial sync did not complete.");
                }
            })
            .catch(() => {
                // Do not include provider errors, tokens, or mailbox data.
                console.error("Initial sync failed.");
            }),
    );

    // redirect to mail page once authorizationis done, under the same domain as request url
    return NextResponse.redirect(new URL("/mail", req.url));
}