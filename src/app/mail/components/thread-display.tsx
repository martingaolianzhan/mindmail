'use client'
import useThreads from "~/hooks/use-threads"
import { ThreadActions } from "./thread-actions";
import { Separator } from "~/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { format } from "date-fns";
import EmailDisplay from "./email-display";
import ReplyBox from "./reply-box/reply-box";
import { useAtom } from "jotai";
import { isSearchingAtom } from "./email-search/search-bar";
import SearchDisplay from "./email-search/search-display";

const ThreadDisplay = () => { 

    const { threadId, threads } = useThreads();
    // get specific thread based on thread id
    const thread = threads?.find(thr => thr.id === threadId);
    const [ isSearching ] = useAtom(isSearchingAtom);

    return (
        <div className="flex flex-col h-full max-h-[calc(100vh-8px)]">
            <ThreadActions />
            { /* Thread Display */}
            <Separator></Separator>
            {isSearching ? <SearchDisplay /> : (
                <>
                    {thread ? <>
                        {/* Display subject content of a selected thread */}
                        <div className="flex flex-col flex-1 overflow-auto">
                            <div className="flex items-center p-4">
                                <div className="flex items-center gap-4 text-sm">
                                    <Avatar>
                                        <AvatarImage alt="avatar" ></AvatarImage>
                                        <AvatarFallback>
                                            {thread.emails[0]?.from?.name?.split(' ').map(letter => letter[0]).join('')}
                                        </AvatarFallback>
                                    </Avatar>
                                    { /* Subject, Name and email address of the first email */}
                                    <div className="grid gap-1">
                                        <div className="font-semibold">
                                            {thread.emails[0]?.from.name}
                                            <div className="text-xs line-clamp-1 ">
                                                {thread.emails[0]?.subject}
                                            </div>
                                            <div className="text-xs line-clamp-1">
                                                <span className="font-medium">
                                                    Reply-To:
                                                </span>
                                                {thread.emails[0]?.from.address}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                {thread.emails[0]?.sentAt && (
                                    <div className="ml-auto text-xs text-muted-foreground">
                                        {format(new Date(thread.emails[0]?.sentAt), 'PPpp')}
                                    </div>
                                )}
                            </div>
                            <Separator></Separator>
                            { /* Email Content */}
                            <div className="max-h-[calc(100vh - 500px)] overflow-auto flex flex-col">
                                <div className="p-6 flex flex-col gap-4">
                                    {thread.emails.map(email => {
                                        return (<EmailDisplay key={email.id} email={email} />)
                                    })}
                                </div>
                            </div>
                            <div className="flex-1"></div>
                            <Separator className="mt-auto"></Separator>
                            { /* Reply Box */}
                            <ReplyBox />
                        </div>
                    </> : <>
                        <div className="p-8  text-center text-muted-foreground">
                            No message selected.
                        </div>
                    </>}
                </>
            )}

        </div>
    )

} 

export default ThreadDisplay