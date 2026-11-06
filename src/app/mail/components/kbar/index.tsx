'use client'
import { Action, KBarAnimator, KBarPortal, KBarPositioner, KBarProvider, KBarSearch } from 'kbar'
import RenderResults from './render-result'
import { useLocalStorage } from 'usehooks-ts'
import useThemeSwitching from './use-theme-switching'

const KBar = ({ children }: { children: React.ReactNode }) => { 

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
    
    return <>
        <KBarPortal>
            <KBarPositioner className='fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm scrollbar-hide !p-0 z-[999]'>
                <KBarAnimator className='max-w-[600px] !mt-64 w-full bg-white dark:bg-gray-800 text-foreground dark:text-gray-200 shadow-lg border dark:border-gray-700 rounded-lg overflow-hidden relative !-translate-y-12'>
                    <div className='bg-white dark:bg-gray-800'>
                        <div className='border-x-0 border-b-2 dark:border-gray-700'>
                            <KBarSearch className='py-4 px-6 text-lg w-full bg-white dark:bg-gray-800 outline-none border-none focus:outline-none focus:ring-0 focus:ring-offset-0' />
                        </div>
                        <RenderResults />
                    </div>
                </KBarAnimator>
            </KBarPositioner>
        </KBarPortal>
        {children}
    </>
}

export default KBar