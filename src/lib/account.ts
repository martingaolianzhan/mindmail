import axios from "axios";
import type { SyncResponse, SyncUpdatedEmailsReponse, EmailMessage, EmailAddress } from "~/type";
import { contractFailure, executeSync, SyncRunFailure, type SyncRun, type SyncRunOptions } from "./sync-run";

function validToken(token: unknown): token is string {
    return typeof token === "string" && token.trim().length > 0;
}

export class Account {
    constructor(private readonly token: string) {}

    private async startSync(run: SyncRun) {
        const response = await run.request((signal, timeout) => axios.post<SyncResponse>("https://api.aurinko.io/v1/email/sync", {}, {
            headers: { Authorization: `Bearer ${this.token}` },
            params: { daysWithin: 2, bodyType: "html" },
            signal, timeout, maxContentLength: run.limits.maxResponseBytes,
        }));
        run.assertActive();
        if (!response.data || typeof response.data.ready !== "boolean") contractFailure();
        return response.data;
    }

    private async getUpdatedEmails(params: { deltaToken?: string; pageToken?: string }, run: SyncRun) {
        const response = await run.request((signal, timeout) => axios.get<SyncUpdatedEmailsReponse>("https://api.aurinko.io/v1/email/sync/updated", {
            headers: { Authorization: `Bearer ${this.token}` }, params, signal, timeout, maxContentLength: run.limits.maxResponseBytes,
        }));
        run.assertActive();
        if (!response.data || !Array.isArray(response.data.records)) contractFailure();
        return response.data;
    }

    private async fetchPages(deltaToken: string, run: SyncRun) {
        if (!validToken(deltaToken)) contractFailure();
        const emails: EmailMessage[] = [];
        const seenPageTokens = new Set<string>();
        let params: { deltaToken?: string; pageToken?: string } = { deltaToken };
        for (let pages = 1; pages <= run.limits.maxPages; pages++) {
            const response = await this.getUpdatedEmails(params, run);
            run.acceptMailboxResponse(response);
            if (emails.length + response.records.length > run.limits.maxRecords) {
                throw new SyncRunFailure({ status: "safety-limit", reason: "record-limit" });
            }
            emails.push(...response.records);
            if (response.nextPageToken != null) {
                if (!validToken(response.nextPageToken) || seenPageTokens.has(response.nextPageToken)) contractFailure();
                if (pages === run.limits.maxPages) {
                    throw new SyncRunFailure({ status: "safety-limit", reason: "page-limit" });
                }
                seenPageTokens.add(response.nextPageToken);
                params = { pageToken: response.nextPageToken };
            } else {
                if (!validToken(response.nextDeltaToken)) contractFailure();
                return { emails, latestDeltaToken: response.nextDeltaToken };
            }
        }
        return contractFailure();
    }

    // Internal provider phase only. The trusted service owns claim/persistence/
    // completion; this phase cannot manufacture a successful run on its own.
    async performInitialSync(run: SyncRun) {
        for (let polls = 1; polls <= run.limits.maxReadinessPolls; polls++) {
            const response = await this.startSync(run);
            run.assertActive();
            if (response.ready) {
                if (!validToken(response.syncUpdatedToken)) contractFailure();
                return this.fetchPages(response.syncUpdatedToken, run);
            }
            if (polls === run.limits.maxReadinessPolls) {
                throw new SyncRunFailure({ status: "safety-limit", reason: "readiness-limit" });
            }
            await run.wait(run.limits.readinessIntervalMs);
        }
        return contractFailure();
    }

    // Sending deliberately does not share sync timeout/retry/cancellation policy.
    async sendEmail({ from, to, cc, bcc, replyTo, subject, body, inReplyTo, references, threadId }: {
        from: EmailAddress; to: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[];
        replyTo?: EmailAddress; subject: string; body: string; inReplyTo?: string; references?: string; threadId?: string;
    }) {
        try {
            const response = await axios.post("https://api.aurinko.io/v1/email/messages", {
                from, to, cc, bcc, replyTo: [replyTo], subject, body, inReplyTo, references, threadId,
            }, {
                params: { returnIds: true }, headers: { Authorization: `Bearer ${this.token}` },
            });
            console.log("Email sent successfully.");
            return response.data;
        } catch (error) {
            console.error("Email send failed.");
            throw error;
        }
    }

    // Provider phase used by durable orchestration after a confirmed claim.
    fetchIncrementalSync(checkpoint: string, run: SyncRun) {
        return this.fetchPages(checkpoint, run);
    }

    // Low-level single-run primitive; application triggers use sync-orchestration.
    syncEmails(options: SyncRunOptions = {}) {
        return executeSync(
            (tx) => tx.account.findUnique({ where: { accessToken: this.token } }),
            (account, run) => this.fetchPages(account.latestDeltaToken!, run),
            options, true,
        ).then((result) => {
            if (result.status !== "completed") console.error("Incremental sync failed.");
            return result;
        });
    }
}
