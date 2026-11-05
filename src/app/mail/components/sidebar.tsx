'use client'
import React from "react";
import { useLocalStorage } from "usehooks-ts";
import { Nav } from "./nav";
import { File, Inbox, Send } from "lucide-react";
import { api } from "~/trpc/react";

type Props = {

    isCollapsed: boolean

};

const Sidebar = ({ isCollapsed }: Props) => { 
    
    // account id from local storage, READ-ONLY
    const [accountId] = useLocalStorage('accountId', '');
    // get value from local storage
    const [tab] = useLocalStorage<"inbox" | "sent" | "draft">("tab-category", "inbox");

    // get number of threads by category
    const { data : inboxNum } = api.account.getNumThreads.useQuery({
        accountId,
        tabCategory: "inbox"
    })

    const { data: draftNum } = api.account.getNumThreads.useQuery({
        accountId,
        tabCategory: "draft"
    })

    const { data: sentNum } = api.account.getNumThreads.useQuery({
        accountId,
        tabCategory: "sent"
    })


    return (
        <div suppressHydrationWarning={ true }>
            <Nav
                isCollapsed={isCollapsed}
                links={[
                    {
                        title: "Inbox",
                        label: inboxNum?.toString() ?? '0',
                        icon: Inbox,
                        variant: tab === "inbox" ? "default" : "ghost"
                    },
                    {
                        title: "Draft",
                        label: draftNum?.toString() ?? '0',
                        icon: File,
                        variant: tab === "draft" ? "default" : "ghost"
                    },
                    {
                        title: "Sent",
                        label: sentNum?.toString() ?? '0',
                        icon: Send,
                        variant: tab === "sent" ? "default" : "ghost"
                    }
                ]}
            />
        </div>
    )
}

export default Sidebar;