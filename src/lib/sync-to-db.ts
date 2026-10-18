import type { EmailAddress, EmailAttachment, EmailMessage } from "~/type";
import { db } from "~/server/db";

export const syncEmailsToDatabase = async (emails: EmailMessage[], accountId: string) => {
    console.log("Syncing emails to database...", emails.length);

    try {
        for (const email of emails) {
            await upsertEmail(email, accountId);
        }
    } catch {
        console.error("Failed to sync emails to database.");
        throw new Error("Failed to sync emails to database.");
    }
};

const upsertEmail = async (email: EmailMessage, accountId: string) => {
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
        upsertedEmailAddresses.push(await upsertEmailAddress(address, accountId));
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
        await upsertAttachment(email.id, attachment);
    }
};

const upsertEmailAddress = async (address: EmailAddress, accountId: string) => {
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

async function upsertAttachment(emailId: string, attachment: EmailAttachment) {
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
