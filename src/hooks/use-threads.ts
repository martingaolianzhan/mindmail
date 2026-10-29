// a custom hook to read threads from db based on states stored in local storage
import { useLocalStorage } from "usehooks-ts";
import { api } from "~/trpc/react";
import { atom, useAtom } from "jotai";

// create / register a state atom
export const threadIdAtom = atom<string | null>(null);
 
const useThreads = () => { 
    const { data: accounts } = api.account.getAccounts.useQuery();
    const [accountId] = useLocalStorage('accountId', '');
    const [tabCategory] = useLocalStorage<"inbox" | "sent" | "draft">("tab-category", "inbox");
    const [done] = useLocalStorage("thread-done", false);

    // subscribe threadIdAtom
    const [threadId, setThreadId] = useAtom(threadIdAtom);

    const { data: threads, isFetching, refetch } = api.account.getThreads.useQuery({
        accountId,
        tabCategory,
        done
    }, {
        // if accountId and tabCategory is not null, execute query
        enabled: !!accountId && !!tabCategory,
        // set placeholder data displaying while query is loading in UI
        // placeholderData: previousData => previousData,
        // Local DB refresh only; external sync has independent durable scheduling.
        refetchInterval: 5000
    })

    return {
        // threads of current account
        threads,
        // fetching status
        isFetching,
        // transfer refetch function
        refetch,
        // find relevant account based on account id
        account: accounts?.find(account => account.id === accountId),
        // pass the current thread id state and setter
        threadId,
        setThreadId,
        accountId
    }
}

export default useThreads