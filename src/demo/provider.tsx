'use client'

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { emailAddressSchema } from "~/type";
import { demoAccounts, demoThreads, searchDemoThreads, type DemoCategory, type DemoThread, type DemoRecipient } from "./fixtures";

const initialView = { accountId: demoAccounts[0].id as string, category: "inbox" as DemoCategory, done: false, query: "", threadId: null as string | null };
export type DemoComposer = { id: number; accountId: string; threadId?: string };
export type DemoSend = { accountId: string; threadId?: string; to: DemoRecipient[]; cc: DemoRecipient[]; subject: string; body: string; inReplyTo?: string };

function useLocalMailbox() {
    const [state, setState] = useState(() => ({ ...initialView, threads: structuredClone([...demoThreads]) }));
    const [composer, setComposer] = useState<DemoComposer | null>(null);
    const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string; target?: { accountId: string; threadId: string } } | null>(null);
    const [sending, setSending] = useState(false);
    const pending = useRef(false);
    const sequence = useRef(0);
    const searchInput = useRef<HTMLInputElement>(null);
    const account = demoAccounts.find(account => account.id === state.accountId) ?? demoAccounts[0];
    const accountThreads = state.threads.filter(thread => thread.accountId === state.accountId);
    const visibleThreads = state.query.trim()
        ? searchDemoThreads(state.threads, state.accountId, state.query)
        : accountThreads.filter(thread => thread.category === state.category && thread.done === state.done);
    const selectedThread = visibleThreads.find(thread => thread.id === state.threadId) ?? visibleThreads[0];
    const contactMessages = demoThreads.filter(thread => thread.accountId === (composer?.accountId ?? state.accountId)).flatMap(thread => thread.messages);
    const suggestions = [...new Set([...demoAccounts.map(account => account.address), ...contactMessages.flatMap(message => [
        message.from, ...(message.to ?? []).map(value => value.address), ...(message.cc ?? []).map(value => value.address),
    ])])].map(address => ({ address }));

    const openCompose = () => {
        if (pending.current) return;
        setNotice(null);
        setComposer({ id: ++sequence.current, accountId: state.accountId });
    };
    const openReply = (threadId: string) => {
        const thread = accountThreads.find(thread => thread.id === threadId);
        if (pending.current || !thread?.messages.some(message => message.from !== account.address)) return;
        setNotice(null);
        setComposer({ id: ++sequence.current, accountId: state.accountId, threadId });
    };
    const sendMessage = async (input: DemoSend): Promise<void> => {
        // Copy every send field before awaiting; later view changes never retarget it.
        const snapshot = { ...input,
            to: input.to.map(value => ({ ...value, address: value.address.trim() })).filter(value => value.address),
            cc: input.cc.map(value => ({ ...value, address: value.address.trim() })).filter(value => value.address),
        };
        const fail = (text: string): never => { setNotice({ kind: "error", text }); throw new Error(text); };
        if (!snapshot.to.length) fail("Add a To recipient to continue.");
        if (![...snapshot.to, ...snapshot.cc].every(value => emailAddressSchema.safeParse(value).success)) fail("Use valid email addresses for To and CC.");
        const sender = demoAccounts.find(account => account.id === snapshot.accountId);
        if (!sender) return fail("Demo reply context is unavailable.");
        if (snapshot.threadId && !state.threads.some(thread => thread.id === snapshot.threadId && thread.accountId === snapshot.accountId)) return fail("Demo reply context is unavailable.");
        if (pending.current) fail("A Demo send is already in progress.");
        const id = ++sequence.current;
        const message = { id: `${sender.id}-message-${id}`, from: sender.address, sender: sender.name,
            sentAt: new Date().toISOString(), subject: snapshot.subject, body: snapshot.body,
            to: snapshot.to, cc: snapshot.cc, inReplyTo: snapshot.inReplyTo };
        pending.current = true; setSending(true); setNotice(null);
        try {
            // Deliberately local latency. No API, delivery claim, retry or persistence.
            await new Promise<void>(resolve => setTimeout(resolve, 400));
            setState(current => {
                const threads: DemoThread[] = snapshot.threadId
                    ? current.threads.map(thread => thread.id === snapshot.threadId && thread.accountId === snapshot.accountId
                        ? { ...thread, messages: [...thread.messages, message] } : thread)
                    : [{ id: `${sender.id}-sent-${id}`, accountId: sender.id, category: "sent", done: false,
                        subject: snapshot.subject, messages: [message] }, ...current.threads];
                // Keep ALL current navigation unchanged, even after account/thread switches.
                return { ...current, threads };
            });
            setNotice(snapshot.threadId
                ? { kind: "success", text: "Reply added to demo thread. No real email was sent." }
                : { kind: "success", text: "Saved to Demo Sent · Simulated successfully. No real email was sent.",
                    target: { accountId: sender.id, threadId: `${sender.id}-sent-${id}` } });
            setComposer(null);
        } finally {
            pending.current = false; setSending(false);
        }
    };

    return {
        state, visibleThreads, selectedThread, account, composer, notice, sending, suggestions, searchInput,
        openCompose, openReply, sendMessage,
        closeComposer: () => { if (!pending.current) { setComposer(null); setNotice(null); } },
        viewSent: (target: { accountId: string; threadId: string }) => setState(current => {
            if (!current.threads.some(thread => thread.id === target.threadId && thread.accountId === target.accountId
                && thread.category === "sent" && !thread.done)) return current;
            return { ...current, accountId: target.accountId, query: "", category: "sent", done: false, threadId: target.threadId };
        }),
        focusSearch: () => searchInput.current?.focus(),
        counts: {
            inbox: accountThreads.filter(thread => thread.category === "inbox").length,
            sent: accountThreads.filter(thread => thread.category === "sent").length,
            draft: accountThreads.filter(thread => thread.category === "draft").length,
        },
        selectAccount: (accountId: string) => {
            if (demoAccounts.some(account => account.id === accountId)) setState(current => ({ ...current, ...initialView, accountId }));
        },
        selectCategory: (category: DemoCategory) => setState(current => ({ ...current, category, query: "", threadId: null })),
        selectDone: (done: boolean) => setState(current => ({ ...current, done, query: "", threadId: null })),
        search: (query: string) => setState(current => ({ ...current, query, threadId: null })),
        selectThread: (threadId: string) => {
            if (visibleThreads.some(thread => thread.id === threadId)) setState(current => ({ ...current, threadId }));
        },
    };
}
const DemoContext = createContext<ReturnType<typeof useLocalMailbox> | null>(null);

export function DemoMailboxProvider({ children }: { children: ReactNode }) {
    const mailbox = useLocalMailbox();
    return <DemoContext.Provider value={mailbox}>{children}</DemoContext.Provider>;
}

export function useDemoMailbox() {
    const mailbox = useContext(DemoContext);
    if (!mailbox) throw new Error("Demo mailbox requires its isolated provider.");
    return mailbox;
}
