"use server"; // this doc should run in server side

import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import axios from "axios";
import {
    AURINKO_OAUTH_STATE_COOKIE,
    aurinkoOAuthStateCookieOptions,
    createAurinkoOAuthCorrelation,
} from "~/lib/aurinko-oauth-state";

// get the authentication url 
export const getAurinkoAuthURL = async (serviceType: "Google" | "Office365") => {

    // check whether current user logged-in
    // if success, auth() will return user's data (we need user id only) 
    const { userId } = await auth();

    // if not, throw an error
    if (!userId) {
        throw new Error("User not found");
    }

    // A signed, short-lived HttpOnly correlation cookie binds this redirect to
    // the Clerk identity that started it. A newer flow intentionally replaces it.
    const correlation = createAurinkoOAuthCorrelation(userId);
    const cookieStore = await cookies();
    cookieStore.set(AURINKO_OAUTH_STATE_COOKIE, correlation.value, aurinkoOAuthStateCookieOptions);

    // make search params, as defined as Aurinko API
    const params = new URLSearchParams(
        {
            clientId: process.env.AURINKO_CLIENT_ID as string,
            serviceType,
            scopes: "Mail.Read Mail.ReadWrite Mail.Send Mail.Drafts Mail.All",
            responseType: "code",
            state: correlation.state,
            // return url for receiving the authorization code or token
            returnUrl: `${process.env.NEXT_PUBLIC_URL}/api/aurinko/callback`
        }
    ).toString();

    // configure Aurinko api to generate the authentication url
    return `https://api.aurinko.io/v1/auth/authorize?${params}`;
}

// exchange code for access token
export const exchangeCodeForAccessToken = async (code: string) => {

    console.log(code)

    // send http request to Aurinko code exchange api
    try {
        
        const response = await axios.post(`https://api.aurinko.io/v1/auth/token/${code}`, {}, {
            auth: {
                username: process.env.AURINKO_CLIENT_ID as string,
                password: process.env.AURINKO_CLIENT_SECRET as string
            }
        });
        // return response data, with defined data object structure
        return response.data as {
            accountId: number,
            accessToken: string,
            userId: string,
            userSession: string
        };
    } catch (error) {
        // throw error
        // throw axios error
        if (axios.isAxiosError(error)) {
            throw error;
        }
        // throw other error
        console.error(error);
    }
}

// get user's email account details
export const getAccountDetails = async (accessToken: string) => { 
    try {
        // send request
        const response = await axios.get("https://api.aurinko.io/v1/account", {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        // return response data
        return response.data as {
            email: string,
            name: string
        }
    } catch (error) {
        // throw error
        // throw axios error
        if (axios.isAxiosError(error)) {
            console.error("Error fetching account details", error.response?.data);
        } else {
            // throw other error
            console.error("Execeptected error fetching account details", error);
        }
        throw error;
    }
}