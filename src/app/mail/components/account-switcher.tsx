"use client";
import React from "react";
import { api } from "~/trpc/react";
import { useLocalStorage } from "usehooks-ts";
import { Select, SelectContent, SelectTrigger, SelectValue, SelectItem } from "~/components/ui/select";
import { cn } from "~/lib/utils";
import { Plus } from "lucide-react";
import { getAurinkoAuthURL } from "~/lib/aurinko";


type Props = {
    isCollapsed: boolean
}

const AccountSwitcher = ({ isCollapsed }: Props) => { 

    // always get selected account id 
    const [accountId, setAccountId] = useLocalStorage('accountId', '');

    const { data } = api.account.getAccounts.useQuery();
    
    // check data existence
    if (!data) return null;
    
    return (
        <Select defaultValue={accountId} onValueChange={setAccountId}> 
            <SelectTrigger
                className={cn(
                "flex w-full flex-1 items-center gap-2 [&>span]:line-clamp-1 [&>span]:flex [&>span]:w-full [&>span]:items-center [&>span]:gap-1 [&>span]:truncate [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0",
                isCollapsed &&
                "flex h-9 w-9 shrink-0 items-center justify-center p-0 [&>span]:w-auto [&>svg]:hidden"
                )}
                aria-label="Select a account"
            >
                <SelectValue placeholder="Select an account">

                    {/* When isCollapsed is false, apply hidden class */}
                    <span className={cn({ 'hidden': !isCollapsed })}>
                        { /* Minimal display, just show the first letter of email address */}
                        {data.find((account) => account.id === accountId)?.emailAddress[0]}
                    </span>

                    {/* When isCollapsed is true, apply hidden class */}
                    <span className={cn({ 'hidden': isCollapsed }, 'ml-2')}>
                        { /* Full display, show full email address */}
                        {data.find((account) => account.id === accountId)?.emailAddress}
                    </span>

                </SelectValue>
            </SelectTrigger>
            { /* For unfold display */}
            <SelectContent>
                {data.map((account) => {
                    return (
                        // set all accounts of the user (authed) as options
                        // value will be used as accountId
                        <SelectItem key={account.id} value={account.id}>{account.emailAddress}</SelectItem>
                    )
                })}
                <div className="flex relative hover:bg-gray-50 w-full cursor-pointer items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    onClick={async () => { 
                        try {
                            const url = await getAurinkoAuthURL('Google');
                            window.location.href = url;
                        } catch {
                            console.error("Unable to start account linking.");
                        }
                    }}
                >
                    <Plus className="size-4 mr-1"></Plus>
                    Add account
                </div>
            </SelectContent>
        </Select>
    )
}

export default AccountSwitcher;