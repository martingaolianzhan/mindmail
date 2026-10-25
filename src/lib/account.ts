import axios from "axios";
import { db } from "~/server/db";
import type { SyncResponse, SyncUpdatedEmailsReponse, EmailMessage, EmailAddress } from "~/type";
import { syncEmailsToDatabase } from "./sync-to-db";
import { claimSyncExecution, completeSyncExecution, releaseSyncExecution, type SyncExecution } from "./sync-execution";

export class ReinitializationRequiredError extends Error {
    constructor() { super("Initial sync required before incremental sync."); }
}

function terminalDeltaToken(response: SyncUpdatedEmailsReponse): string {
    const token = response.nextDeltaToken;
    if (typeof token !== "string" || token.trim().length === 0) {
        throw new Error("Sync terminal checkpoint is missing or invalid.");
    }
    return token;
}

export class Account {
    // the token represents the email account
    private token: string;
    
    constructor(token: string) {
        // assign token value
        this.token = token;
    }

    // Start sync by requesting deltaToken through Aurinko api
    private async startSync() {
        // send request
        const response = await axios.post<SyncResponse>("https://api.aurinko.io/v1/email/sync", {}, {
            headers: { // header for authorization 
                Authorization: `Bearer ${this.token}`
            },
            params: { // parameters
                daysWithin: 2,
                bodyType: "html" // email content in html version 
            }
        })
        return response.data;
    }

    /**
     * Get updated emails data. 
     * If deltaToken is provided, it is used to get the next delta token. 
     * If pageToken is provided, it is used to get the next page of emails.
     * 
     * @param {{ deltaToken?: string, pageToken?: string }} - The params object.
     * 
     * @returns {Promise<SyncUpdatedEmailsReponse>} - The response data from the api.
     */
    async getUpdatedEmails({ deltaToken, pageToken }: { deltaToken?: string, pageToken?: string }) {
        // receive deltaToken and pageToken by a project
        const params: Record<string, string> = {};

        // store value into params if exists
        if (deltaToken) {
            params.deltaToken = deltaToken;
        }
        if (pageToken) { 
            params.pageToken = pageToken;
        }

        // request for nextDeltaToken, nextPageToken and return email contents
        const response = await axios.get<SyncUpdatedEmailsReponse>("https://api.aurinko.io/v1/email/sync/updated", {
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            params
        });

        return response.data;
    }

    // perform initial sync and get emails
    async performInitialSync() { 
        try {
            // start sync process
            let syncResponse = await this.startSync();
            // if not ready, keep requesting until success
            while (!syncResponse.ready) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                syncResponse = await this.startSync();
            }
            const startToken = syncResponse.syncUpdatedToken;
            if (typeof startToken !== "string" || startToken.trim().length === 0) {
                throw new Error("Initial sync start token is missing or invalid.");
            }
            // The start token is only for the first fetch, never a durable checkpoint.
            let updatedResponse = await this.getUpdatedEmails({ deltaToken: startToken });
            // store returned email contents
            let allEmails: EmailMessage[] = updatedResponse.records;
            const seenPageTokens = new Set<string>();

            // while there is a next page
            while (updatedResponse.nextPageToken) {
                const pageToken = updatedResponse.nextPageToken;
                if (seenPageTokens.has(pageToken)) {
                    throw new Error("Repeated initial sync page token");
                }
                seenPageTokens.add(pageToken);

                updatedResponse = await this.getUpdatedEmails({ pageToken });
                // store returned email contents
                allEmails = allEmails.concat(updatedResponse.records);
            }

            const deltaToken = terminalDeltaToken(updatedResponse);
            console.log("Initial sync done, got total emails:", allEmails.length, "waiting to upsert to database...");

            // return latest delta token with all emails in the first sync (initial sync)
            return {
                latestDeltaToken: deltaToken,
                emails: allEmails
            }
        
        } catch {
            console.error("Initial sync failed.");
        }
    }

    // send email
    async sendEmail({ 
        from, // sender
        to, // recipents
        cc, 
        bcc,
        replyTo, // eamil address that 
        subject,
        body,
        inReplyTo, // internet message id
        references, 
        threadId
    }: { 
        from: EmailAddress,
        to: EmailAddress[],
        cc?: EmailAddress[],
        bcc?: EmailAddress[],
        replyTo?: EmailAddress
        subject: string,
        body: string,
        inReplyTo?: string, 
        references?: string,
        threadId?: string
    }) { 
        try {
            // console.log("Carbon copy:", cc)
            const response = await axios.post("https://api.aurinko.io/v1/email/messages", {
                from,
                to,
                cc,
                bcc,
                replyTo: [replyTo], // actually we only support one replyTo list
                subject,
                body,
                inReplyTo,
                references,
                threadId
            }, {
                params: {
                    returnIds: true
                },
                headers: {
                    Authorization: `Bearer ${this.token}`
                }
            });
            console.log("Email sent successfully.");
            return response.data;
        } catch (error) {
            console.error("Email send failed.");
            throw error;
        }
    }

    async syncEmails() {
        let execution: SyncExecution | undefined;
        let completed = false;
        try {
        const account = await db.account.findUnique({
            where: {
                accessToken: this.token
            }
        });
        // check account and latest delta token
        if (!account) { 
            throw new Error("Account not found");
        }
        // Null means this generation has no trusted incremental checkpoint.
        if (!account.latestDeltaToken) {
            throw new ReinitializationRequiredError();
        }
        execution = await claimSyncExecution(account);
        // request for updated emails by latest delta token
        let response = await this.getUpdatedEmails({ deltaToken: account.latestDeltaToken });
        // get all updated emails
        let allEmails: EmailMessage[] = response.records;
        const seenPageTokens = new Set<string>();
        // update emails until no page (up to date)
        while (response.nextPageToken) { 
            const pageToken = response.nextPageToken;
            if (seenPageTokens.has(pageToken)) throw new Error("Repeated incremental sync page token");
            seenPageTokens.add(pageToken);
            response = await this.getUpdatedEmails({ pageToken });
            allEmails = allEmails.concat(response.records);
        }
        const storedDeltaToken = terminalDeltaToken(response);
        // sync all updated emails to database before advancing the checkpoint
        await syncEmailsToDatabase(allEmails, execution);

        await completeSyncExecution(execution, storedDeltaToken);
        completed = true;

        return {
            emails: allEmails,
            latestDeltaToken: storedDeltaToken
        }
        } catch (error) {
            console.error("Incremental sync failed.");
            throw error;
        } finally {
            if (execution && !completed) await releaseSyncExecution(execution);
        }
    }
}