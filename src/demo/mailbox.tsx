'use client'

import { useEffect, useRef } from "react";
import { File, Inbox, Send, Search } from "lucide-react";
import { MailLayout } from "~/app/mail/components/mail-layout";
import { ThreadActions } from "~/app/mail/components/thread-actions";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { demoAccounts } from "./fixtures";
import { DemoMailboxProvider, useDemoMailbox } from "./provider";
import { DemoEditor } from "./editor";
import { DemoCommands } from "./commands";

function DemoAccount({ collapsed }: { collapsed: boolean }) {
    const { state, selectAccount } = useDemoMailbox();
    return <select aria-label="Synthetic demo account" value={state.accountId}
        onChange={event => selectAccount(event.target.value)}
        className="w-full rounded-md border bg-background p-2 text-sm">
        {demoAccounts.map(account => <option key={account.id} value={account.id}>
            {collapsed ? account.name[0] : `${account.name} · ${account.address}`}
        </option>)}
    </select>;
}

function DemoSidebar({ collapsed }: { collapsed: boolean }) {
    const { state, counts, selectCategory } = useDemoMailbox();
    return <nav aria-label="Demo mailbox categories" className="grid gap-1 p-2">
        {([
            ["inbox", "Inbox", Inbox], ["draft", "Draft", File], ["sent", "Sent", Send],
        ] as const).map(([category, label, Icon]) => <Button key={category}
            aria-label={`${label} demo category`} aria-pressed={state.category === category}
            variant={state.category === category ? "default" : "ghost"}
            className={cn("justify-start gap-2", collapsed && "justify-center px-2")}
            onClick={() => selectCategory(category)}>
            <Icon className="size-4 shrink-0" />
            {!collapsed && <><span>{label}</span><span className="ml-auto">{counts[category]}</span></>}
        </Button>)}
    </nav>;
}

function DemoSearch() {
    const { state, search, searchInput } = useDemoMailbox();
    return <div role="search" className="flex items-center gap-2 p-4">
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <Input ref={searchInput} aria-label="Search synthetic mailbox" placeholder="Search synthetic mail..." value={state.query}
            onChange={event => search(event.target.value)} />
        <Button variant="ghost" aria-label="Clear demo search" disabled={!state.query} onClick={() => search("")}>Clear</Button>
    </div>;
}

function DemoThreadList() {
    const { state, visibleThreads, selectedThread, selectThread } = useDemoMailbox();
    return <div aria-label="Demo thread list" className="max-h-[calc(100vh-220px)] overflow-y-auto p-4 pt-0">
        {visibleThreads.length === 0 && <p className="p-4 text-sm text-muted-foreground" role="status">
            {state.query.trim() ? "No synthetic threads match your search." : "No threads in this demo view."}
        </p>}
        <div className="flex flex-col gap-2">
            {visibleThreads.map(thread => {
                const latest = thread.messages.at(-1);
                return <button key={thread.id} data-demo-thread={thread.id} aria-pressed={selectedThread?.id === thread.id}
                    onClick={() => selectThread(thread.id)}
                    className={cn("flex flex-col gap-2 rounded-lg border p-3 text-left text-sm transition-all",
                        selectedThread?.id === thread.id && "bg-accent")}>
                    <span className="font-semibold">{latest?.sender}</span>
                    <span className="font-medium">{thread.subject}</span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{latest?.body}</span>
                </button>;
            })}
        </div>
    </div>;
}

function DemoThreadDisplay() {
    const { state, account, selectedThread, composer, sending, openReply } = useDemoMailbox();
    const canReply = selectedThread?.messages.some(message => message.from !== account.address);
    const lastMessage = useRef<HTMLElement>(null);
    const previous = useRef({ threadId: selectedThread?.id, count: selectedThread?.messages.length, replyId: composer?.threadId });
    useEffect(() => {
        if (previous.current.threadId === selectedThread?.id && (selectedThread?.messages.length ?? 0) > (previous.current.count ?? 0)
            && previous.current.replyId === selectedThread?.id && selectedThread?.accountId === state.accountId) {
            lastMessage.current?.scrollIntoView?.({ block: "nearest" });
        }
        previous.current = { threadId: selectedThread?.id, count: selectedThread?.messages.length, replyId: composer?.threadId };
    }, [selectedThread, composer, state.accountId]);
    const reply = composer?.threadId && <div hidden={composer.accountId !== state.accountId || composer.threadId !== selectedThread?.id}>
        <DemoEditor key={composer.id} composer={composer} />
    </div>;
    return <div className="flex h-full min-h-0 flex-col">
        <ThreadActions />
        <div className="flex-1 overflow-y-auto border-t p-6" aria-label="Demo reading pane">
            {selectedThread ? <>
                <div className="mb-4 flex items-center justify-between gap-2">
                    <h2 className="text-xl font-semibold">{selectedThread.subject}</h2>
                    {canReply && <Button disabled={sending} aria-label="Reply in Demo" onClick={() => openReply(selectedThread.id)}>Reply</Button>}
                </div>
                <div className="flex flex-col gap-4">
                    {selectedThread.messages.map((message, index) => <article ref={index === selectedThread.messages.length - 1 ? lastMessage : undefined}
                        key={message.id} className="rounded-md border p-4">
                        <header className="mb-3 flex flex-wrap justify-between gap-2 text-sm">
                            <div><strong>{message.sender}</strong><div className="text-muted-foreground">{message.from}</div></div>
                            <time className="text-xs text-muted-foreground" dateTime={message.sentAt}>
                                {message.sentAt.slice(0, 16).replace("T", " ")} UTC
                            </time>
                        </header>
                        {message.to?.length ? <p className="mb-1 text-xs text-muted-foreground">To: {message.to.map(value => value.address).join(", ")}</p> : null}
                        {message.cc?.length ? <p className="mb-1 text-xs text-muted-foreground">CC: {message.cc.map(value => value.address).join(", ")}</p> : null}
                        {message.subject && message.subject !== selectedThread.subject && <p className="mb-2 text-sm font-medium">{message.subject}</p>}
                        <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.body}</p>
                    </article>)}
                </div>
            </> : <p className="text-muted-foreground">No message selected.</p>}
            {reply}
        </div>
    </div>;
}

function DemoView() {
    const { state, selectDone, openCompose, closeComposer, composer, sending, notice, viewSent } = useDemoMailbox();
    const composeButton = useRef<HTMLButtonElement>(null);
    const isSearching = state.query.trim().length > 0;
    return <main className="flex h-screen flex-col overflow-hidden">
        <header className="shrink-0 border-b bg-muted/40 px-4 py-2">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <div>
                    <h1 className="font-semibold">MindMail · Interactive Demo</h1>
                    <p className="text-xs text-foreground/80">Synthetic data · No real emails sent · Resets on refresh</p>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-xs text-foreground/80">⌘K / Ctrl+K for commands</span>
                    <Button ref={composeButton} disabled={sending} aria-label="Compose in Demo" onClick={openCompose}>Compose</Button>
                </div>
            </div>
        </header>
        {notice && <div role={notice.kind === "error" ? "alert" : "status"}
            className={cn("fixed left-4 top-20 z-[60] flex max-w-[min(26rem,calc(100vw-2rem))] flex-wrap items-center gap-2 rounded-md border bg-background p-3 text-sm shadow-lg md:bottom-4 md:top-auto",
                notice.kind === "error" && "border-destructive text-destructive")}>
            <span>{notice.text}</span>
            {notice.target && <Button size="sm" onClick={() => { if (notice.target) viewSent(notice.target); }}>View in Sent</Button>}
        </div>}
        <div className="min-h-0 flex-1">
        <MailLayout className="min-h-0" defaultLayout={[20, 32, 48]} defaultCollapsed={false} navCollapseSize={4}
            done={state.done} onDoneChange={selectDone}
            heading={isSearching ? "Search Results" : { inbox: "Inbox", sent: "Sent", draft: "Draft" }[state.category]}
            showStatusTabs={!isSearching}
            accountSwitcher={collapsed => <DemoAccount collapsed={collapsed} />}
            sidebar={collapsed => <DemoSidebar collapsed={collapsed} />}
            searchBar={<DemoSearch />} threadList={<DemoThreadList />} threadDisplay={<DemoThreadDisplay />} />
        </div>
        {composer && !composer.threadId && <div className="fixed inset-x-2 bottom-2 z-40 max-h-[min(80vh,680px)] overflow-y-auto rounded-lg border bg-background shadow-2xl sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[min(32rem,calc(100vw-2rem))]"
            aria-label="Floating Demo compose" role="region">
            <DemoEditor key={composer.id} composer={composer} onCancel={() => { closeComposer(); composeButton.current?.focus(); }} />
        </div>}
    </main>;
}

export default function DemoMailbox() {
    return <DemoMailboxProvider><DemoCommands><DemoView /></DemoCommands></DemoMailboxProvider>;
}
