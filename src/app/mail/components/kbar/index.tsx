'use client'
import { Action, KBarProvider } from 'kbar'
import { CommandPalette } from './command-palette'
import { useLocalStorage } from 'usehooks-ts'
import useThemeSwitching from './use-theme-switching'
import { usePathname } from 'next/navigation'
import { isDemoPath } from '~/lib/demo-path'

const KBar = ({ children }: { children: React.ReactNode }) => {
    const pathname = usePathname();
    // Demo has its own state. Don't mount/register production mailbox commands.
    if (!pathname || isDemoPath(pathname)) return children;
    return <MailboxKBar>{children}</MailboxKBar>;
}

const MailboxKBar = ({ children }: { children: React.ReactNode }) => {

    const [tab, setTab] = useLocalStorage<"inbox" | "sent" | "draft">("tab-category", "inbox");
    const [, setDone] = useLocalStorage("thread-done", false);
    
    // actions will be passed to KBarProvider
    const actions: Action[] = [
        {
            id: 'inboxAction',
            name: 'Inbox',
            shortcut: ['g', 'i'], // press g and i to execute action
            section: 'Email Navigation', // set category
            subtitle: 'Switch and view inbox', // navigate to inbox
            perform: () => { // execute action
                setTab("inbox");
            }
        },
        {
            id: 'sentAction',
            name: 'Sent',
            shortcut: ['g', 's'], // press g and s to execute action
            section: 'Email Navigation', // set category
            subtitle: 'Switch and view sent', // navigate to sent
            perform: () => { // execute action
                setTab("sent");
            }
        },
        {
            id: 'draftAction',
            name: 'Draft',
            shortcut: ['g', 'd'], // press g and d to execute action
            section: 'Email Navigation', // set category
            subtitle: 'Switch and view draft', // navigate to draft
            perform: () => { // execute action
                setTab("draft");
            }
        },
        {
            id: 'activeAction',
            name: 'View Active threads',
            shortcut: ['g', 'p'], // press g and p to execute action
            section: 'Thread Status',
            subtitle: 'Switch and view Active threads',
            perform: () => { 
                setDone(false);
            }
        },
        {
            id: 'doneAction',
            name: 'View Done threads',
            shortcut: ['g', 'f'], // press g and f to execute action
            section: 'Thread Status',
            subtitle: 'Switch and view Done threads',
            perform: () => {
                setDone(true);
            }
        }
    ]

    return (
        <KBarProvider actions={actions}>
            <ActualComponent >
                {children}
            </ActualComponent>
        </KBarProvider>
    )
}

const ActualComponent = ({ children }: { children: React.ReactNode }) => { 
    useThemeSwitching();
    
    return <CommandPalette>{children}</CommandPalette>
}

export default KBar