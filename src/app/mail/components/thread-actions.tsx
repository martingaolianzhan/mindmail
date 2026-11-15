'use client'

import { Button } from "~/components/ui/button";
import { Archive, ArchiveX, Clock, MoreVertical, Trash2 } from "lucide-react";
import { Separator } from "~/components/ui/separator";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";

/** UX-001 toolbar presentation; no mailbox hooks or mutation handlers. */
export function ThreadActions() {
    return (
        <div className="flex items-center p-2">
            <div className="flex items-center gap-2">
                <Button variant={'ghost'} size={'icon'} disabled aria-label="Archive (unavailable)">
                    <Archive className="size-4"></Archive>
                </Button>
                <Button variant={'ghost'} size={'icon'} disabled aria-label="ArchiveX (unavailable)">
                    <ArchiveX className="size-4"></ArchiveX>
                </Button>
                <Button variant={'ghost'} size={'icon'} disabled aria-label="Delete (unavailable)">
                    <Trash2 className="size-4"></Trash2>
                </Button>
            </div>
            <Separator orientation="vertical"></Separator>
            <Button variant={'ghost'} size={'icon'} disabled aria-label="Snooze (unavailable)" className="ml-2">
                <Clock className="size-4"></Clock>
            </Button>
            <div className="flex items-center ml-auto">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild disabled>
                        <Button variant={'ghost'} size={'icon'} disabled aria-label="More actions (unavailable)" className="ml-2">
                            <MoreVertical className="size-4"></MoreVertical>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem>Mark as unread</DropdownMenuItem>
                        <DropdownMenuItem>Star thread</DropdownMenuItem>
                        <DropdownMenuItem>Add label</DropdownMenuItem>
                        <DropdownMenuItem>Mute thread</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    );
}
