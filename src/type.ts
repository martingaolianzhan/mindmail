import { z } from "zod";

// defines all the possible data type returned from api request

// start a new email sync api response data structure
export interface SyncResponse {
    syncUpdatedToken: string,
    syncDeletedToken: string,
    ready: boolean
} 

// updated email api response data structure
export interface SyncUpdatedEmailsReponse { 
    nextPageToken?: string,
    nextDeltaToken: string,
    records: EmailMessage[]
}

// Email message structurefrom updated email api
export interface EmailMessage {
    id: string;
    threadId: string;
    createdTime: string;
    lastModifiedTime: string;
    sentAt: string;
    receivedAt: string;
    internetMessageId: string;
    subject: string;
    sysLabels: Array<"junk" | "trash" | "sent" | "inbox" | "unread"| "flagged" | "important" | "draft">;
    keywords: string[];
    sysClassifications: Array<"personal" | "social" | "promotions" | "updates" | "forums">;
    sensitivity: "normal" | "private" | "personal" | "confidential";
    meetingMessageMethod: "request" | "reply" | "cancel" | "counter" | "other";
    from: EmailAddress;
    to: EmailAddress[];
    cc: EmailAddress[];
    bcc: EmailAddress[];
    replyTo: EmailAddress[];
    hasAttachments: boolean;
    body: string;
    bodySnippet: string;
    attachments: EmailAttachment[];
    inReplyTo: string;
    references: string;
    threadIndex: string;
    internetHeaders: EmailHeader[];
    nativeProperties: {
        property1: string;
        property2: string;
    };
    folderId: string;
    webLink: string;
    omitted: Array<"threadId" | "body" | "attachments" | "recipients" | "internetHeaders" >;
}

export interface EmailAddress {
    name?: string;
    address: string;
    raw?: string;
}

export interface EmailAttachment {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    inline: boolean;
    contentId?: string;
    content?: string;
    contentLocation?: string;
}

export interface EmailHeader {
    name: string;
    value: string;
}

export const emailAddressSchema = z.object({
    name: z.string().optional(),
    address: z.string().email(),
})