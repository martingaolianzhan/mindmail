'use client'

import { useState } from "react";
import EmailEditor from "~/app/mail/components/email-editor/email-editor";
import { RecipientInput, type RecipientInputProps } from "~/app/mail/components/email-editor/recipient-input";
import { Button } from "~/components/ui/button";
import { demoAccounts, type DemoRecipient } from "./fixtures";
import { useDemoMailbox, type DemoComposer } from "./provider";

function SyntheticRecipients(props: RecipientInputProps) {
    const { suggestions } = useDemoMailbox();
    return <RecipientInput {...props} suggestions={suggestions} showAvatars={false} />;
}

/** Only context/field adaptation; editing and send lifecycle belong to EmailEditor. */
export function DemoEditor({ composer }: { composer: DemoComposer }) {
    const { state, sending, sendMessage, closeComposer } = useDemoMailbox();
    const account = demoAccounts.find(account => account.id === composer.accountId) ?? demoAccounts[0];
    const [draft, setDraft] = useState(() => {
        const thread = state.threads.find(thread => thread.id === composer.threadId && thread.accountId === composer.accountId);
        let external: NonNullable<typeof thread>["messages"][number] | undefined;
        for (const message of thread?.messages ?? []) if (message.from !== account.address) external = message;
        const to: DemoRecipient[] = external ? [{ address: external.from, name: external.sender },
            ...(external.to ?? []).filter(value => value.address !== account.address && value.address !== external?.from)] : [];
        const cc = external?.cc?.filter(value => value.address !== account.address) ?? [];
        const subject = external?.subject ?? thread?.subject ?? "";
        const values = (recipients: DemoRecipient[]) => recipients.map(value => ({ label: value.address, value: value.address }));
        return {
            subject: composer.threadId && !subject.startsWith("Re:") ? `Re: ${subject}` : subject,
            to: values(to), cc: values(cc),
            toNames: new Map(to.map(value => [value.address, value.name?.trim() ? value.name : value.address])),
            ccNames: new Map(cc.map(value => [value.address, value.name?.trim() ? value.name : value.address])),
            inReplyTo: external?.id,
        };
    });
    const handleSend = (body: string): Promise<void> => sendMessage({
        accountId: composer.accountId, threadId: composer.threadId,
        subject: draft.subject, body, inReplyTo: draft.inReplyTo,
        to: draft.to.map(value => ({ address: value.value, name: draft.toNames.get(value.value) ?? value.value })),
        cc: draft.cc.map(value => ({ address: value.value, name: draft.ccNames.get(value.value) ?? value.value })),
    });
    return <section aria-label="Demo composer" className="border-t">
        <header className="flex items-center justify-between gap-2 p-4">
            <div><h3 className="font-semibold">{composer.threadId ? "Reply in Demo" : "Compose in Demo"}</h3>
                <p className="text-xs text-muted-foreground">From {account.address} · page memory only</p></div>
            <Button variant="ghost" disabled={sending} onClick={closeComposer}>Close draft</Button>
        </header>
        <EmailEditor recipientInput={SyntheticRecipients} bodyFormat="text"
            subject={draft.subject} setSubject={subject => setDraft(current => ({ ...current, subject }))}
            toValues={draft.to} setToValues={to => setDraft(current => ({ ...current, to }))}
            ccValues={draft.cc} setCCValues={cc => setDraft(current => ({ ...current, cc }))}
            to={draft.to.map(value => value.value)} defaultToolBarExpanded={true}
            handleSend={handleSend} isSending={sending} />
    </section>;
}
