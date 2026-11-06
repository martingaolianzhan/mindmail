'use client'

import { api, RouterOutputs } from "~/trpc/react";
import EmailEditor from "../email-editor/email-editor";
import useThreads from "~/hooks/use-threads";
import React from "react";
import { toast } from "sonner";

const ReplyBox = () => {

    const { threadId, accountId } = useThreads();
    const { data : replyDetails } = api.account.getReplyDetails.useQuery({
        accountId,
        threadId: threadId ?? ""
    })

    if (!replyDetails) { 
        return null
    }

    return (
        <Component replyDetails={replyDetails} />
    )

}

const Component = ({ replyDetails }: { replyDetails: RouterOutputs["account"]["getReplyDetails"] }) => {
    const { threadId, accountId } = useThreads();

    const initializeContext = () => ({
        threadId,
        subject: replyDetails.reply && !replyDetails.subject.startsWith('Re:')
            ? `Re: ${replyDetails.subject}` : replyDetails.subject,
        toValues: replyDetails.to.map(to => ({ label: to.address ?? to.name, value: to.address })),
        ccValues: replyDetails.cc.map(cc => ({ label: cc.address ?? cc.name, value: cc.address })),
        // Pinned name metadata never supplies addresses independently of edits.
        toNames: new Map(replyDetails.to.map(to => [to.address, to.name?.trim() ? to.name : to.address])),
        ccNames: new Map(replyDetails.cc.map(cc => [cc.address, cc.name?.trim() ? cc.name : cc.address])),
        inReplyTo: replyDetails.internetMessageId
    });
    const [context, setContext] = React.useState(initializeContext);

    // Only user selection establishes a new context, not refreshed reply data.
    // Adjust before rendering children, without remounting the editor/body.
    if (context.threadId !== threadId) {
        setContext(initializeContext());
    }
    const { subject, toValues, ccValues, inReplyTo } = context;

    const sendEmail = api.account.sendEmail.useMutation();

    const handleSend = async (value: string) => { 
        if (!replyDetails) { 
            return
        }
        sendEmail.mutate({
            accountId,
            threadId: context.threadId ?? undefined,
            body: value,
            subject,
            to: toValues.map(to => ({ address: to.value, name: context.toNames.get(to.value) ?? to.value })),
            cc: ccValues.map(cc => ({ address: cc.value, name: context.ccNames.get(cc.value) ?? cc.value })),
            inReplyTo
        }, {
            onSuccess: () => {
                toast.success("Email sent");
            },
            onError: (error) => {
                toast.error("Error sending email")
            }
        }) 
    }


    return (
        <EmailEditor
            subject={subject}
            setSubject={(subject) => setContext(current => ({ ...current, subject }))}

            toValues={toValues}
            setToValues={(toValues) => setContext(current => ({ ...current, toValues }))}

            ccValues={ccValues}
            setCCValues={(ccValues) => setContext(current => ({ ...current, ccValues }))}

            // get addresses used to show them on editor
            to={toValues.map(to => to.value)}

            // for send email button
            isSending={sendEmail.isPending}
            handleSend={handleSend}

            defaultToolBarExpanded={ false }
        />
    )
}

export default ReplyBox;

