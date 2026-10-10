"use client"
import React, { ComponentProps } from "react";
import useThreads from "~/hooks/use-threads";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "~/lib/utils";
import DOMPurify from "dompurify"
import { Badge } from "~/components/ui/badge";

const ThreadList = () => { 

    const { threads, threadId, setThreadId } = useThreads();

    // group threads by date, acc refers to the accumulator
    const groupThreads = threads?.reduce((acc, currThread) => {
        // get latest date of email of current thread, if no, use current date
        const date = format(currThread.lastMessageDate ?? new Date(), "dd-MM-yyyy"); 

        // if the original value of acc doesn't has the date as key, create with empty array value,
        // if exists, just skip
        if (!acc[date]) { 
            acc[date] = [];
        }

        // push current thread into the date
        acc[date].push(currThread)

        // return grouped threads
        return acc
    }, {} as Record<string, typeof threads>) // define data type of acc

    return (
        <div className="max-w-full overflow-y-auto max-h-[calc(100vh-140px)]">
            <div className="flex flex-col gap-2 p-4 pt-0">
                {   // transfer an object into array, then map each record
                    Object.entries(groupThreads ?? {}).map(([date, threads]) => { 
                        return <React.Fragment key={ date }>
                            <div className="text-xs font-medium text-muted-foreground mt-5 first:mt-0">{date}</div>
                            { 
                                threads.map(thread => { 
                                    return <button onClick={() => { setThreadId(thread.id) }} key={thread.id} className={cn("flex flex-col gap-2 items-start rounded-lg border p-3 text-left text-sm transition-all relative", {
                                        'bg-accent' : thread.id == threadId
                                    })}>
                                        <div className="flex flex-col w-full gap-1">
                                            { /* Titles */}
                                            <div className="flex items-center">
                                                <div className="flex items-center gap-2">
                                                    { /* Main Title Here */}
                                                    <div className="font-semibold">
                                                        {/* Show Thread Name as Main Title */ }
                                                        { thread.emails.at(-1)?.from.name }
                                                    </div>
                                                </div>
                                                { /* Sub-Title Here */}
                                                <div className={cn('ml-auto text-xs')}>
                                                    { /* Sub-title displays time distance from now to the latest email */}
                                                    {formatDistanceToNow(thread.emails.at(-1)?.sentAt ?? new Date(), { addSuffix: true })}
                                                </div>
                                            </div>
                                            { /* Subject */}
                                            <div className="text-xs font-medium">
                                                {thread.subject}
                                            </div>
                                        </div>
                                        { /* Body Snippet */ }
                                        <div className="text-xs line-clamp-2 text-muted-foreground" dangerouslySetInnerHTML={{
                                            __html: DOMPurify.sanitize(thread.emails.at(-1)?.bodySnippet ?? "",
                                                { USE_PROFILES: { html: true} })
                                        }}>
                                        </div>
                                        {thread.emails[0]?.sysLabels.length && (
                                            <div className="flex items-center gap-2">
                                                {thread.emails[0]?.sysLabels.map(label => { 
                                                    return <Badge key={label} variant={ getBadgeVariantFromLabel( label )}>
                                                        { label }
                                                    </Badge>
                                                }) }
                                            </div>
                                        )}
                                    </button>
                                })
                            }
                        </React.Fragment>
                    })
                }
            </div>   
        </div>
    )
}

// get badge variant based on label value
function getBadgeVariantFromLabel(label: string): ComponentProps<typeof Badge>['variant'] { 
    if (['work'].includes(label.toLowerCase())) {
        return "default"
    } else { 
        return "secondary"
    }
}

export default ThreadList;
