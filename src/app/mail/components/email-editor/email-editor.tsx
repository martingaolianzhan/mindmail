'use client'
import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import EditorMenubar from "./editor-menubar";
import { Separator } from "~/components/ui/separator";
import { Button } from "~/components/ui/button";
import TagInput from "./tag-input";
import { Input } from "~/components/ui/input";
import { set } from "date-fns";

type Props = {
    // email subject and setter
    subject: string,
    setSubject: (value: string) => void,

    // value and setter of tag-input for "to"
    toValues: { label: string, value: string }[],
    setToValues: (values: { label: string, value: string }[]) => void,

    // value and setter of tag-input for "cc"
    ccValues: { label: string, value: string }[],
    setCCValues: (values: { label: string, value: string }[]) => void,

    to: string[],
    // send button required 
    handleSend: (value: string) => Promise<void>,
    isSending: boolean

    defaultToolBarExpanded: boolean
}

const EmailEditor = ({ subject, setSubject, toValues, setToValues, ccValues, setCCValues, to, handleSend, isSending, defaultToolBarExpanded }: Props) => { 
    // editor value in HTML format (final version), need to be sent to receiver after user finished all editing
    const [value, setValue] = React.useState<string>('');
    // expand state to control the expand / hide of contact components
    const [expanded, setExpanded] = React.useState<boolean>(defaultToolBarExpanded ?? false);
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const sendInFlight = React.useRef(false);
    const callerPending = React.useRef(isSending);
    callerPending.current = isSending;
    const pending = isSubmitting || isSending;

    // initialise editor
    const editor = useEditor({
        autofocus: false,
        editable: !pending,
        extensions: [
            StarterKit, // common operations like bold and underline, etc
        ],
        onUpdate: ({ editor }) => {
            // set value as the html version of the editor content 
            setValue(editor.getHTML())
        }
    })

    React.useEffect(() => {
        editor?.setEditable(!pending);
    }, [editor, pending]);

    const send = async () => {
        // The ref closes the gap before React/mutation pending state rerenders.
        if (!editor || sendInFlight.current || callerPending.current) return;
        const body = editor.getHTML();
        sendInFlight.current = true;
        setIsSubmitting(true);
        editor.setEditable(false);
        try {
            await handleSend(body);
            editor.commands.clearContent();
        } catch {
            // Callers report failure. Preserve the body; never retry automatically.
        } finally {
            sendInFlight.current = false;
            setIsSubmitting(false);
            editor.setEditable(!callerPending.current);
        }
    };

    // check editor existence
    if (!editor) { 
        return null;
    }

    return (
        <div>
            <div className="flex p-4 py-2 border-b">
                <fieldset disabled={pending} className="min-w-0">
                    <EditorMenubar editor={editor} />
                </fieldset>
            </div>
            { /* Contact Components */}
            { /* CC Component */}
            <div className="p-4 pb-0 space-y-2 shadow-sm">
                {expanded && (
                    <>
                        <TagInput
                            label="TO"
                            onChange={setToValues}
                            placeholder="Add recipent(s)"
                            value={toValues}
                        />
                        <TagInput
                            label="CC"
                            onChange={setCCValues}
                            placeholder="Carbon copy to contact(s)"
                            value={ccValues}
                        />
                        <Input
                            id="subject"
                            placeholder="Subject"
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                        />
                    </>    
                )}
                {/* Click-able text to expand / hide contact components */}
                <div className="flex items-center gap-2 pb-4">
                    <div className="cursor-pointer">
                        <span className="text-green-600 font-medium" onClick={() => { setExpanded(!expanded) }}>Draft {" "}</span>
                        <span>to {to.join(", ")}</span>
                    </div>
                </div>
            </div>
            <div className="w-full px-4 mt-2">
                <EditorContent editor={editor} value={value} className="h-[180px] pt-2 overflow-auto" />
            </div>
            <Separator />
            <div className="py-3 px-4 flex items-center justify-end">
                <Button disabled={pending} onClick={send}>
                    Send
                </Button>
            </div>
        </div>
    )
}

export default EmailEditor;