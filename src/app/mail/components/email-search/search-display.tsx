import React from "react";
import { useAtom } from "jotai";
import { searchValueAtom } from "./search-bar";
import { api } from "~/trpc/react";
import { useDebounceValue } from "usehooks-ts";
import useThreads from "~/hooks/use-threads";
import  DOMPurify  from "dompurify";


/**
* Component that displays the search results.
* This component shows the search results. It's a simple list of items
* that match the search query. 
* @returns The search results component.
*/
const SearchDisplay = () => { 
    const { accountId } = useThreads();

    const [searchValue] = useAtom(searchValueAtom);

    const searchResults = api.account.getSearchResults.useMutation();

    // get the search value after 500ms stop typing
    const [debouncedSearchValue] = useDebounceValue(searchValue, 500);

    React.useEffect(() => { 
        if (!accountId || !debouncedSearchValue) return;
        
        searchResults.mutate({
            accountId: accountId,
            query: debouncedSearchValue
        });

    }, [debouncedSearchValue, accountId]);

    return (
        <div className="p-4 overflow-y-scroll">
            <div className="flex items-center gap-2 mb-4">
                <h2 className="text-gray-600 text-sm dark:text-gray-400">
                    You are searching for &quot;{ searchValue }&quot; come back with....
                </h2>
            </div>
            {searchResults.data?.length === 0 ? (
                <p>No results found...</p>
            ) : (<ul className="flex flex-col gap-2">
                    {searchResults.data?.map((result) => ( 
                        <li key={result.id} className="border rounded-md p-4 hover:bg-gray-100 cursor-pointer transition-all dark:hover:bg-gray-900">
                            <h3 className="text-base font-medium">{result.subject}</h3>
                            <p className="text-sm text-gray-500">From: {result.from}</p>
                            <p className="text-sm text-gray-500">To: {result.to.join(', ')}</p>
                            <p className="text-sm mt-2" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(result.rawBody, {USE_PROFILES: {html: true}}) }}></p>
                        </li>
                    ))}
                </ul>)
            }
        </div>
    )
}

export default SearchDisplay;

