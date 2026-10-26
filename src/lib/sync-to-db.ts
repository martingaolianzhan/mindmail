import type { EmailAddress, EmailAttachment, EmailMessage } from "~/type";
import { withSyncDatabase } from "./sync-database";
import { SYNC_LIMITS } from "./sync-limits";
import type { SyncRun } from "./sync-run";
import type { Prisma } from "@prisma/client";
import { lockSyncExecution, type SyncExecution } from "./sync-execution";

export const syncEmailsToDatabase = async (emails: EmailMessage[], execution: SyncExecution, run?: SyncRun) => {
    console.log("Syncing emails to database...", emails.length);

    try {
        // Even an empty round must prove authority; missing context never enables
        // legacy writes. Each email is one bounded protected unit. Earlier units
        // may remain committed on failure; same-input retry still converges.
        for (const email of emails.length ? emails : [undefined]) {
            await run?.boundary();
            // Once submitted, this unit drains under finite DB bounds, not JS
            // AbortSignal. Cancellation cannot promise rollback of this email.
            run?.assertActive();
            await withSyncDatabase(async (tx) => {
                await lockSyncExecution(tx, execution);
                if (email) await upsertEmail(tx, email, execution.accountId);
            }, run?.limits ?? SYNC_LIMITS, true);
            await run?.boundary();
        }
    } catch (error) {
        console.error("Failed to sync emails to database.");
        // The run boundary maps this to a sanitized outcome. Retain typed
        // authority/observation failures without exposing the raw DB exception.
        if (run) throw error;
        throw new Error("Failed to sync emails to database.");
    }
};

const upsertEmail = async (db: Prisma.TransactionClient, email: EmailMessage, accountId: string) => {
    let emailLabelType: "inbox" | "sent" | "draft" = "inbox";
    if (email.sysLabels.includes("inbox") || email.sysLabels.includes("important")) {
        emailLabelType = "inbox";
    } else if (email.sysLabels.includes("sent")) {
        emailLabelType = "sent";
    } else if (email.sysLabels.includes("draft")) {
        emailLabelType = "draft";
    }

    const emailAddressForUpsert = new Map<string, EmailAddress>();
    for (const address of [email.from, ...email.to, ...email.cc, ...email.bcc, ...email.replyTo]) {
        emailAddressForUpsert.set(address.address, address);
    }

    const upsertedEmailAddresses: (Awaited<ReturnType<typeof upsertEmailAddress>>)[] = [];
    for (const address of emailAddressForUpsert.values()) {
        upsertedEmailAddresses.push(await upsertEmailAddress(db, address, accountId));
    }

    const addressMap = new Map(upsertedEmailAddresses.map((address) => [address.address, address]));
    const persistedAddress = (address: EmailAddress) => {
        const persisted = addressMap.get(address.address);
        if (!persisted) throw new Error("Required email address was not persisted.");
        return persisted;
    };

    const fromAddress = persistedAddress(email.from);
    const toAddresses = email.to.map(persistedAddress);
    const ccAddresses = email.cc.map(persistedAddress);
    const bccAddresses = email.bcc.map(persistedAddress);
    const replyToAddresses = email.replyTo.map(persistedAddress);

    const thread = await db.thread.upsert({
        where: { id: email.threadId },
        update: {
            subject: email.subject,
            accountId,
            lastMessageDate: new Date(email.sentAt),
            done: false,
            participantIds: [...new Set([
                fromAddress.id,
                ...toAddresses.map((address) => address.id),
                ...ccAddresses.map((address) => address.id),
                ...bccAddresses.map((address) => address.id),
            ])],
        },
        create: {
            id: email.threadId,
            accountId,
            subject: email.subject,
            done: false,
            draftStatus: emailLabelType === "draft",
            inboxStatus: emailLabelType === "inbox",
            sentStatus: emailLabelType === "sent",
            lastMessageDate: new Date(email.sentAt),
            participantIds: [...new Set([
                fromAddress.id,
                ...toAddresses.map((address) => address.id),
                ...ccAddresses.map((address) => address.id),
                ...bccAddresses.map((address) => address.id),
            ])],
        },
    });

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
            to: { set: toAddresses.map((address) => ({ id: address.id })) },
            cc: { set: ccAddresses.map((address) => ({ id: address.id })) },
            bcc: { set: bccAddresses.map((address) => ({ id: address.id })) },
            replyTo: { set: replyToAddresses.map((address) => ({ id: address.id })) },
            hasAttachments: email.hasAttachments,
            internetHeaders: email.internetHeaders as object[],
            body: email.body,
            bodySnippet: email.bodySnippet,
            inReplyTo: email.inReplyTo,
            references: email.references,
            threadIndex: email.threadIndex,
            nativeProperties: email.nativeProperties as object,
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
            internetHeaders: email.internetHeaders as object[],
            keywords: email.keywords,
            sysClassifications: email.sysClassifications,
            sensitivity: email.sensitivity,
            meetingMessageMethod: email.meetingMessageMethod,
            fromId: fromAddress.id,
            to: { connect: toAddresses.map((address) => ({ id: address.id })) },
            cc: { connect: ccAddresses.map((address) => ({ id: address.id })) },
            bcc: { connect: bccAddresses.map((address) => ({ id: address.id })) },
            replyTo: { connect: replyToAddresses.map((address) => ({ id: address.id })) },
            hasAttachments: email.hasAttachments,
            body: email.body,
            bodySnippet: email.bodySnippet,
            inReplyTo: email.inReplyTo,
            references: email.references,
            threadIndex: email.threadIndex,
            nativeProperties: email.nativeProperties as object,
            folderId: email.folderId,
            omitted: email.omitted,
        },
    });

    const threadEmails = await db.email.findMany({
        where: { threadId: thread.id },
        orderBy: { receivedAt: "asc" },
    });
    let threadFolderType = "sent";
    for (const threadEmail of threadEmails) {
        if (threadEmail.emailLabel === "inbox") {
            threadFolderType = "inbox";
            break;
        }
        if (threadEmail.emailLabel === "draft") threadFolderType = "draft";
    }

    await db.thread.update({
        where: { id: thread.id },
        data: {
            draftStatus: threadFolderType === "draft",
            inboxStatus: threadFolderType === "inbox",
            sentStatus: threadFolderType === "sent",
        },
    });

    for (const attachment of email.attachments) {
        await upsertAttachment(db, email.id, attachment);
    }
};

const upsertEmailAddress = async (db: Prisma.TransactionClient, address: EmailAddress, accountId: string) => {
    const existingEmailAddress = await db.emailAddress.findUnique({
        where: { accountId_address: { accountId, address: address.address ?? "" } },
    });
    if (existingEmailAddress) {
        const persisted = await db.emailAddress.findUnique({ where: { id: existingEmailAddress.id } });
        if (!persisted) throw new Error("Required email address was not persisted.");
        return persisted;
    }
    return db.emailAddress.create({
        data: { address: address.address ?? "", accountId, name: address.name, raw: address.raw },
    });
};

async function upsertAttachment(db: Prisma.TransactionClient, emailId: string, attachment: EmailAttachment) {
    await db.emailAttachment.upsert({
        where: { id: attachment.id },
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
}
