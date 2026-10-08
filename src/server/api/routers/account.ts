import { createTRPCRouter, privateProcedure, publicProcedure } from "../trpc";
import z from "zod";
import { db } from "~/server/db";
import { Prisma } from "@prisma/client";
import { emailAddressSchema } from "~/type";
import { Account } from "~/lib/account";
import { searchEmails } from "~/lib/search";

// based on user id and account id, find matched account (whether the user has the account or not)
export const authoriseAccountAccess = async (accountId: string, userId: string) => { 

    console.log("Account id is:" + accountId, "User id is:" + userId)

    const account = await db.account.findFirst({
        where: {
            id: accountId,
            userId
        }, select: {
            id: true,
            emailAddress: true,
            name: true,
            accessToken: true
        }
    })

    if (!account) { 
        throw new Error("Account not found");
    }

    return account;
}

export const accountRouter = createTRPCRouter({

    getAccounts: privateProcedure.query(async ({ ctx }) => { 
        return ctx.db.account.findMany({
            where: {
                userId: ctx.auth.userId
            },
            select: {
                id: true,
                emailAddress: true,
                name: true
            }
        });
    }),
    // get number of threads by category (inbox, sent, draft, etc..)
    getNumThreads: privateProcedure.input(z.object({
        accountId: z.string(),
        tabCategory: z.string()
    })).query(async ({ input, ctx }) => { 

        const account = await authoriseAccountAccess(input.accountId, ctx.auth.userId);

        // filter by the currently selected tab category for Thread model
        const filter: Prisma.ThreadWhereInput = {}

        if (input.tabCategory === "inbox") {
            filter.inboxStatus = true;
        } else if (input.tabCategory === "sent") {
            filter.sentStatus = true;
        } else if (input.tabCategory === "draft") {
            filter.draftStatus = true;
        }
        // get and return thread count
        return await ctx.db.thread.count({
            where: {
                accountId: account.id,
                // Add filter here to get relevant thread count
                ...filter
            }
        })
    }),

    // get threads list by category (inbox, sent, draft, etc..) and status (done or not)
    getThreads: privateProcedure.input(z.object({
        accountId: z.string(),
        tabCategory: z.enum(["inbox", "sent", "draft"]),
        done: z.boolean() // thread status
    })).query(async ({ input, ctx }) => { 
        const account = await authoriseAccountAccess(input.accountId, ctx.auth.userId);

        // everytime get threads, update emails
        const acc = new Account(account.accessToken);
        acc.syncEmails().catch(console.error);

        // Always scope a successful thread query to the authenticated user's account.
        const filter: Prisma.ThreadWhereInput = {
            accountId: account.id,
            done: { equals: input.done }
        };

        if (input.tabCategory === "inbox") {
            filter.inboxStatus = true;
        } else if (input.tabCategory === "sent") {
            filter.sentStatus = true;
        } else {
            filter.draftStatus = true;
        }

        return await ctx.db.thread.findMany({
            where: filter,
            include: {
                emails: {
                    orderBy: {
                        //  emails in asceding order
                        sentAt: "asc"
                    },
                    select: {
                        from: true,
                        body: true,
                        bodySnippet: true,
                        emailLabel: true,
                        subject: true,
                        sysLabels: true,
                        id: true,
                        sentAt: true
                    }
                }
            },
            // only get latest 15 threads
            take: 50,
            orderBy: {
                // threads in descending order
                lastMessageDate: "desc"
            }
        }) 
    }),
    getEmailAddressSuggesstions: privateProcedure.input(z.object({ accountId: z.string() }))
        .query(async ({ ctx, input }) => {
            const account = await authoriseAccountAccess(input.accountId, ctx.auth.userId);

            return await ctx.db.emailAddress.findMany({
                where: {
                    accountId: account.id
                },
                select: {
                    name: true,
                    address: true
                }
            })
        }
    ),
    getReplyDetails: privateProcedure.input(z.object({
        accountId: z.string(),
        threadId: z.string()
    })).query(async ({ ctx, input }) => {
        const account = await authoriseAccountAccess(input.accountId, ctx.auth.userId);

        const thread = await ctx.db.thread.findFirst({
            where: {
                id: input.threadId,
                accountId: account.id,
            },
            include: {
                emails: {
                    // emails in asceding order (from past to present)
                    orderBy: { sentAt: 'asc' },
                    select: {
                        from: true,
                        cc: true,
                        bcc: true,
                        to: true,
                        sentAt: true,
                        subject: true,
                        internetMessageId: true // for Aurinko Email Send API
                    }
                }
            }
        })
        // check thread existence
        if (!thread || thread.emails.length == 0) { 
            throw new Error('Thread not found!')
        }
        
        // defind the last email of the thread that the send from the external email address (to define the reply details)
        const lastExternalEmail = thread.emails.reverse().find(email => email.from.address !== account.emailAddress);
        // if there is no external email, means there is only emails from the account
        if (!lastExternalEmail) {
            console.log('No external email found!');
            const lastEmail = thread.emails[thread.emails.length - 1];
            if (!lastEmail) {
                throw new Error('No email found in the thread!');
            }
            // if there is no external email, means there is only emails from the account
            return {
                subject: lastEmail.subject,
                to: lastEmail.to,
                cc: lastEmail.cc,
                from: { name: account.name, address: account.emailAddress },
                reply: false,
                internetMessageId: lastEmail?.internetMessageId
            }
        }

        // return data
        return {
            subject: lastExternalEmail.subject,
            // send source email address and target emails that are not the account email address
            to: [lastExternalEmail.from, ...lastExternalEmail.to.filter(email => email.address !== account.emailAddress)],
            // carbon copy
            cc: lastExternalEmail.cc.filter(email => email.address !== account.emailAddress), 
            from: { name: account.name, address: account.emailAddress },
            reply: true,
            internetMessageId: lastExternalEmail.internetMessageId
        }
    }),
    sendEmail: privateProcedure.input(
        z.object({
            accountId: z.string(),
            body: z.string(),
            subject: z.string(),
            from: emailAddressSchema,
            to: z.array(emailAddressSchema),
            cc: z.array(emailAddressSchema).optional(),
            bcc: z.array(emailAddressSchema).optional(),
            replyTo: emailAddressSchema,
            inReplyTo: z.string().optional(),
            threadId: z.string().optional(),
        })
    ).mutation(async ({ ctx, input }) => { 
        const account = await authoriseAccountAccess(input.accountId, ctx.auth.userId);
        const acct = new Account(account.accessToken);
        await acct.sendEmail({
            from: input.from,
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            replyTo: input.replyTo,
            subject: input.subject,
            body: input.body,
            inReplyTo: input.inReplyTo,
            threadId: input.threadId
        })
    }),
    getSearchResults: privateProcedure.input(z.object({
        accountId: z.string(),
        query: z.string()
    })).mutation(async ({ ctx, input }) => { 
        const account = await authoriseAccountAccess(input.accountId, ctx.auth.userId);
        const searchResults = await searchEmails(account.id, input.query);
        console.log(searchResults.length);
        return searchResults;
    })
});
