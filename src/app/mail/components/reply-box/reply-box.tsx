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

    // if subject not starts with 'Re', manually add it
    const [subject, setSubject] = React.useState(() => { 
        if (replyDetails.reply) {
            return replyDetails.subject?.startsWith('Re:') ? replyDetails.subject : `Re: ${replyDetails.subject}`
        } else {
            return replyDetails.subject
        }
    });

    // construct toValues
    const [toValues, setToValues] = React.useState<{ label: string, value: string }[]>(replyDetails.to.map(to => ({ label: to.address ?? to.name, value: to.address })) || [])

    // construct ccValues
    const [ccValues, setCcValues] = React.useState<{ label: string, value: string }[]>(replyDetails.cc.map(cc => ({ label: cc.address ?? cc.name, value: cc.address })) || [])

    // apply reconstruction if change thread
    React.useEffect(() => { 
        // check existence
        if (!threadId || !replyDetails) { 
            return 
        }
        
        if (replyDetails.reply) { 
            // Re-construct new data structure
            if (!replyDetails.subject?.startsWith('Re:')) {
                setSubject(`Re: ${replyDetails.subject}`)
            }
        }
        
        setToValues(replyDetails.to.map(to => ({ label: to.address ?? to.name, value: to.address })))
        setCcValues(replyDetails.cc.map(cc => ({ label: cc.address ?? cc.name, value: cc.address })))

    }, [threadId, replyDetails])

    const sendEmail = api.account.sendEmail.useMutation();

    const handleSend = async (value: string) => { 
        if (!replyDetails) { 
            return
        }

        console.log("Carbon copy:", ccValues);
        console.log("CC from reply details:", replyDetails.to.map(to => ({ address: to.address, name: to.name ?? to.address })));
        sendEmail.mutate({
            accountId,
            threadId: threadId ?? undefined,
            body: value,
            subject,
            to: replyDetails.to.map(to => ({ address: to.address, name: to.name ?? to.address})).concat(toValues.map(to => ({ address: to.value, name: to.value }))),
            cc: replyDetails.cc.map(cc => ({ address: cc.address, name: cc.name ?? cc.address })).concat(ccValues.map(cc => ({ address: cc.value, name: cc.value }))),
            inReplyTo: replyDetails.internetMessageId
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
            setSubject={setSubject}

            toValues={toValues}
            setToValues={(values) => setToValues(values)}

            ccValues={ccValues}
            setCCValues={(values) => setCcValues(values)}

            // get addresses used to show them on editor
            to={replyDetails.to.map(to => to.address)}

            // for send email button
            isSending={sendEmail.isPending}
            handleSend={handleSend}

            defaultToolBarExpanded={ false }
        />
    )
}

export default ReplyBox;

