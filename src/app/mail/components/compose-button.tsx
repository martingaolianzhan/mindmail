'use client'

import { Pencil } from "lucide-react";
import React from "react";
import { Button } from "~/components/ui/button";
import {
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerDescription,
    DrawerFooter,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "~/components/ui/drawer"
import EmailEditor from "./email-editor/email-editor";
import { api } from "~/trpc/react";
import useThreads from "~/hooks/use-threads";
import { toast } from "sonner";

 
const ComposeButton = () => { 

    // email toValues and it's setter
    const [toValues, setToValues] = React.useState<{ label: string, value: string }[]>([])
    // email ccValues and it's setter
    const [ccValues, setCcValues] = React.useState<{ label: string, value: string }[]>([])
    // email subject and it's setter
    const [subject, setSubject] = React.useState<string>('');
    // get current account
    const { account } = useThreads();
    
    const sendEmail = api.account.sendEmail.useMutation();   

    const handleSend = (value: string) => { 
        if (!account) { return }
        sendEmail.mutate({
            accountId: account.id,
            threadId: undefined,
            body: value,
            subject,
            inReplyTo: undefined,
            to: toValues.map(to => ({ name: to.value, address: to.value })),
            cc: ccValues.map(cc => ({ name: cc.value, address: cc.value }))
        }, {
            onSuccess: () => { 
                toast.success("Email sent");
            },
            onError: (error) => { 
                toast.error("Error sending email");
            }
        });
    }   

    return (
        <Drawer>
            <DrawerTrigger asChild>
                <Button>
                    <Pencil className="size-4 mr-1"/>
                    Compose
                </Button>
            </DrawerTrigger>
            <DrawerContent>
                <DrawerHeader>
                    <DrawerTitle>Compose a new email</DrawerTitle>
                </DrawerHeader>
                <EmailEditor
                    toValues={toValues}
                    setToValues={setToValues}
                    ccValues={ccValues}
                    setCCValues={setCcValues}
                    subject={subject}
                    setSubject={setSubject}
                    to={toValues.map(to => to.value)}

                    defaultToolBarExpanded={true}

                    handleSend={handleSend}
                    isSending={sendEmail.isPending}
                />
            </DrawerContent>
        </Drawer>
    )
}

export default ComposeButton;