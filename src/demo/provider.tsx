'use client'

import { createContext, useContext, useState, type ReactNode } from "react";
import { demoAccounts, demoThreads, searchDemoThreads, type DemoCategory } from "./fixtures";

type DemoState = { accountId: string; category: DemoCategory; done: boolean; query: string; threadId: string | null };
const initialState: DemoState = { accountId: demoAccounts[0].id, category: "inbox", done: false, query: "", threadId: null };

function useLocalMailbox() {
    const [state, setState] = useState(initialState);
    const accountThreads = demoThreads.filter(thread => thread.accountId === state.accountId);
    const visibleThreads = state.query.trim()
        ? searchDemoThreads(state.accountId, state.query)
        : accountThreads.filter(thread => thread.category === state.category && thread.done === state.done);
    const selectedThread = visibleThreads.find(thread => thread.id === state.threadId) ?? visibleThreads[0];
    return {
        state, visibleThreads, selectedThread,
        account: demoAccounts.find(account => account.id === state.accountId) ?? demoAccounts[0],
        counts: {
            inbox: accountThreads.filter(thread => thread.category === "inbox").length,
            sent: accountThreads.filter(thread => thread.category === "sent").length,
            draft: accountThreads.filter(thread => thread.category === "draft").length,
        },
        selectAccount: (accountId: string) => {
            if (demoAccounts.some(account => account.id === accountId)) setState({ ...initialState, accountId });
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
