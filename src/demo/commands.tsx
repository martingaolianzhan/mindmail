'use client'

import { KBarProvider, useKBar, VisualState, type Action } from "kbar";
import { useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "~/app/mail/components/kbar/command-palette";
import { useDemoMailbox } from "./provider";

function DemoPalette({ children, searchRequested, onSearchReady }: { children: ReactNode; searchRequested: boolean; onSearchReady: () => void }) {
    const { hidden } = useKBar(state => ({ hidden: state.visualState === VisualState.hidden }));
    // KBar restores previous focus while closing; focus Search only after it is hidden.
    useEffect(() => { if (hidden && searchRequested) onSearchReady(); }, [hidden, searchRequested, onSearchReady]);
    return <CommandPalette>{children}</CommandPalette>;
}

export function DemoCommands({ children }: { children: ReactNode }) {
    const { selectCategory, selectDone, openCompose, focusSearch, sending } = useDemoMailbox();
    const [searchRequested, requestSearch] = useState(false);
    const actions: Action[] = [
        ...(["inbox", "sent", "draft"] as const).map(category => ({
            id: `demo-${category}`, name: { inbox: "Inbox", sent: "Sent", draft: "Draft" }[category],
            section: "Demo mailbox", shortcut: ["g", category[0] ?? ""], perform: () => selectCategory(category),
        })),
        { id: "demo-active", name: "View Active threads", section: "Demo mailbox", shortcut: ["g", "p"], perform: () => selectDone(false) },
        { id: "demo-done", name: "View Done threads", section: "Demo mailbox", shortcut: ["g", "f"], perform: () => selectDone(true) },
        { id: "demo-search", name: "Search mailbox", section: "Demo workflow", shortcut: ["g", "q"], perform: () => requestSearch(true) },
    ];
    if (!sending) actions.push({ id: "demo-compose", name: "Compose", section: "Demo workflow", shortcut: ["g", "c"], perform: openCompose });
    return <KBarProvider actions={actions}>
        <DemoPalette searchRequested={searchRequested} onSearchReady={() => { focusSearch(); requestSearch(false); }}>{children}</DemoPalette>
    </KBarProvider>;
}
