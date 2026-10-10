import { EmailMessage, EmailAddress, EmailAttachment } from "~/type";
import pLimit from "p-limit";
import { db } from "~/server/db";

export const syncEmailsToDatabase = async (emails: EmailMessage[], accountId: string) => { 
    console.log("Syncing emails to database...", emails.length);
    // sync 10 emails each time in parallel (async action)
    const limit = pLimit(10);

    // upsert all emails to database
    try {
        for (const email of emails) {
            // // sync email to orama
            // await orama.insert({
            //     subject: email.subject,
            //     body: email.body ?? "",
        
            //     from: email.from.address,
            //     to: email.to.map(to => to.address),
    
            //     sentAt: email.sentAt.toLocaleString(),
            //     threadId: email.threadId
            // })
            // sync email to database
            await upsertEmail(email, accountId, 0);
        }
    } catch {
        throw new Error("Failed to sync emails to database.");
    }
}


/**
 * Upsert an email into database.
 * 
 * @param {EmailMessage} email The email to be upserted into database.
 * @param {string} accountId The id of the account that owns this email.
 * @param {number} index The index number of the email in the array of emails to be upserted to database.
 */
const upsertEmail = async (email: EmailMessage, accountId: string, index: number) => {

    console.log(`Upserting a email to your database...`);

    try {
        // by default, set email label type to inbox
        let emailLabelType: "inbox" | "sent" | "draft" = "inbox";
        // define email label type
        if (email.sysLabels.includes("inbox") || email.sysLabels.includes("important")) {
            emailLabelType = "inbox";
        } else if (email.sysLabels.includes("sent")) {
            emailLabelType = "sent";
        } else if (email.sysLabels.includes("draft")) {
            emailLabelType = "draft";   
        }

        // 1. save all identical email addresses related to the email into database
        // a map to save identical email addresses that need to be upserted
        const emailAddressForUpsert = new Map();
        // get identical email address and save to upsert map
        for (const address of [email.from, ...email.to, ...email.cc, ...email.bcc, ...email.replyTo]) {
            // e.g. xx@example.com: {name: xx, address: xx@example.com, row: xxx}
            emailAddressForUpsert.set(address.address, address);
        }

        // get and save upserted email addresses
        const upsertedEmailAddresses: (Awaited<ReturnType<typeof upsertEmailAddress>>)[] = [];

        for (const address of emailAddressForUpsert.values()) {
            // sync identical email address to database
            const upsertedEmailAddress = await upsertEmailAddress(address as EmailAddress, accountId);
            // record upserted email address
            upsertedEmailAddresses.push(upsertedEmailAddress);
        };
        
        const addressMap = new Map(
            // filter and save upserted email addresses each has a value, and assertion each record MUST has a address value
            upsertedEmailAddresses.filter(Boolean).map(address => [address!.address, address])
        );

        // get email address of this email (parameter)
        const fromAddress = addressMap.get(email.from.address);
        // check existence
        if (!fromAddress) {
            console.error("Failed to upsert an email sender address.");
            return;
        }
        // get other relevant email addresses of this email (parameter)
        // use addressMap to double validate email addresses, ensure all addresses are upserted and have acutal value
        const toAddresses = email.to.map(addr => addressMap.get(addr.address)).filter(Boolean);
        const ccAddresses = email.cc.map(addr => addressMap.get(addr.address)).filter(Boolean);
        const bccAddresses = email.bcc.map(addr => addressMap.get(addr.address)).filter(Boolean);
        const replyToAddresses = email.replyTo.map(addr => addressMap.get(addr.address)).filter(Boolean);

        // 2. Upsert Thread
        const thread = await db.thread.upsert({
            where: { id: email.threadId },
            update: {
                subject: email.subject,
                accountId,
                // change string to Date
                lastMessageDate: new Date(email.sentAt),
                done: false,
                // store relevant email addresses, keep database values identical
                participantIds: [...new Set([
                    fromAddress.id,
                    ...toAddresses.map(a => a!.id),
                    ...ccAddresses.map(a => a!.id),
                    ...bccAddresses.map(a => a!.id)
                ])]
            },
            create: {
                id: email.threadId,
                accountId,
                subject: email.subject,
                done: false,
                draftStatus: emailLabelType === 'draft',
                inboxStatus: emailLabelType === 'inbox',
                sentStatus: emailLabelType === 'sent',
                lastMessageDate: new Date(email.sentAt),
                participantIds: [...new Set([
                    fromAddress.id,
                    ...toAddresses.map(a => a!.id),
                    ...ccAddresses.map(a => a!.id),
                    ...bccAddresses.map(a => a!.id)
                ])]
            }
        });

        // 3. Upsert Email
        await db.email.upsert({
            where: { id: email.id },
            update: {
                threadId: thread.id,
                createdTime: new Date(email.createdTime),
                lastModifiedTime: new Date(),
                sentAt: new Date(email.sentAt),
                receivedAt: new Date(email.receivedAt),
                internetMessageId: email.internetMessageId,
                subject: email.subject,
                sysLabels: email.sysLabels,
                keywords: email.keywords,
                sysClassifications: email.sysClassifications,
                sensitivity: email.sensitivity,
                meetingMessageMethod: email.meetingMessageMethod,
                fromId: fromAddress.id,
                to: { set: toAddresses.map(a => ({ id: a!.id })) },
                cc: { set: ccAddresses.map(a => ({ id: a!.id })) },
                bcc: { set: bccAddresses.map(a => ({ id: a!.id })) },
                replyTo: { set: replyToAddresses.map(a => ({ id: a!.id })) },
                hasAttachments: email.hasAttachments,
                internetHeaders: email.internetHeaders as any,
                body: email.body,
                bodySnippet: email.bodySnippet,
                inReplyTo: email.inReplyTo,
                references: email.references,
                threadIndex: email.threadIndex,
                nativeProperties: email.nativeProperties as any,
                folderId: email.folderId,
                omitted: email.omitted,
                emailLabel: emailLabelType,
            },
            create: {
                id: email.id,
                emailLabel: emailLabelType,
                threadId: thread.id,
                createdTime: new Date(email.createdTime),
                lastModifiedTime: new Date(),
                sentAt: new Date(email.sentAt),
                receivedAt: new Date(email.receivedAt),
                internetMessageId: email.internetMessageId,
                subject: email.subject,
                sysLabels: email.sysLabels,
                internetHeaders: email.internetHeaders as any,
                keywords: email.keywords,
                sysClassifications: email.sysClassifications,
                sensitivity: email.sensitivity,
                meetingMessageMethod: email.meetingMessageMethod,
                fromId: fromAddress.id,
                to: { connect: toAddresses.map(a => ({ id: a!.id })) },
                cc: { connect: ccAddresses.map(a => ({ id: a!.id })) },
                bcc: { connect: bccAddresses.map(a => ({ id: a!.id })) },
                replyTo: { connect: replyToAddresses.map(a => ({ id: a!.id })) },
                hasAttachments: email.hasAttachments,
                body: email.body,
                bodySnippet: email.bodySnippet,
                inReplyTo: email.inReplyTo,
                references: email.references,
                threadIndex: email.threadIndex,
                nativeProperties: email.nativeProperties as any,
                folderId: email.folderId,
                omitted: email.omitted,
            }
        });

        // get emails in this thread
        const threadEmails = await db.email.findMany({
            where: { threadId: thread.id },
            orderBy: { receivedAt: 'asc' }
        });

        // set default thread type
        let threadFolderType = 'sent';

        // check and update thread type
        for (const threadEmail of threadEmails) {
            if (threadEmail.emailLabel === 'inbox') {
                threadFolderType = 'inbox';
                break; // If any email is in inbox, the whole thread is in inbox
            } else if (threadEmail.emailLabel === 'draft') {
                threadFolderType = 'draft'; // Set to draft, but continue checking for inbox
            }
        }

        // update thread type in db
        await db.thread.update({
            where: { id: thread.id },
            data: {
                draftStatus: threadFolderType === 'draft',
                inboxStatus: threadFolderType === 'inbox',
                sentStatus: threadFolderType === 'sent',
            }
        });

        // 4. upsert email attachments
        for (const attachment of email.attachments) {
            await upsertAttachment(email.id, attachment);
        }
        

    } catch {
        console.error("Failed to persist an email record.");
    }

}

// update or insert an email addresses into database
const upsertEmailAddress = async (address: EmailAddress, accountId: string) => { 
    try {
        // check if email address exists in database
        const existingEmailAddress = await db.emailAddress.findUnique({
            where: {
                accountId_address: {
                    accountId: accountId,
                    // if not address then set as "" (empty value)
                    address: address.address ?? ""
                }
            }
        });
        // based on result, update existing record or insert a new record
        if (existingEmailAddress) {
            // update
            return await db.emailAddress.findUnique({
                where: {id: existingEmailAddress.id},
            });
        } else { 
            return await db.emailAddress.create({
                // insert new
                data: {
                    // if address is null then set as "" (empty)
                    address: address.address ?? "",
                    accountId: accountId,
                    name: address.name,
                    raw: address.raw
                }
            })
        }
        
    } catch {
        console.error("Failed to persist an email address.");
        return null;
    }
}

async function upsertAttachment(emailId: string, attachment: EmailAttachment) {
    try {
        await db.emailAttachment.upsert({
            where: { id: attachment.id ?? "" },
            update: {
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: attachment.size,
                inline: attachment.inline,
                contentId: attachment.contentId,
                content: attachment.content,
                contentLocation: attachment.contentLocation,
            },
            create: {
                id: attachment.id,
                emailId,
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: attachment.size,
                inline: attachment.inline,
                contentId: attachment.contentId,
                content: attachment.content,
                contentLocation: attachment.contentLocation,
            },
        });
    } catch {
        console.error("Failed to persist an email attachment.");
    }
}
