'use client'

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "~/components/ui/dialog"


import React from "react";
import { Button } from "~/components/ui/button";
import { Bot } from "lucide-react";  
import { Textarea } from "~/components/ui/textarea";
import { generateEmail } from "./ai-actions";
import { readStreamableValue } from "ai/rsc";
import useThreads from "~/hooks/use-threads";
import { turndown } from "~/lib/turndown";

type Props = {
    isComposing: boolean,
    onGenerate: (token: string) => void
}

const AIComposeBotton = ({ isComposing, onGenerate }: Props) => { 

    // state controls the open & close of dialog
    const [open, setOpen] = React.useState(false)
    // prompt for AI model
    const [prompt, setPrompt] = React.useState('')
    // get current threadId and threads of current account
    const { threads, threadId, account } = useThreads();
    // find the current thread
    const thread = threads?.find(thread => thread.id === threadId);

    // generate email content by AI
    const AIGenerate = async (prompt: string) => {
        let context = '';

        for (const email of thread?.emails ?? []) {
            // construct context
            const content = `
                Subject: ${email.subject},
                From: ${email.from.address},
                Sent: ${new Date(email.sentAt).toLocaleString()},
                Body: ${turndown.turndown(email.body ?? email.bodySnippet ?? "")}
            `
            context += content
        }
        // add my personal information
        context += `My name is ${account?.name} and my email is ${account?.emailAddress}.`

        const { output } = await generateEmail(context, prompt);

        for await (const snippet of readStreamableValue(output)) { 
            if (snippet) { 
                onGenerate(snippet);
            }
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button size='icon' variant={'outline'} onClick={() => setOpen(true)}>
                    <Bot className="size-5" />
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>AI Smart Compose</DialogTitle>
                    <DialogDescription>
                        AI will help you to compose your email.
                    </DialogDescription>
                    <div className="h-2"></div>
                    <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Enter a prompt to compose your email..." />
                    <div className="h-2"></div>
                    <Button onClick={() => {
                        // close dialog
                        setOpen(false)
                        // reset prompt
                        setPrompt('')
                        // generate email content by AI
                        AIGenerate(prompt)   
                    }}>
                        Generate
                    </Button>
                </DialogHeader>
            </DialogContent>
        </Dialog>
    )
}

export default AIComposeBotton