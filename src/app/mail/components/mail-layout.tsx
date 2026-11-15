'use client'

import React, { type ReactNode } from "react";
import { ResizablePanel, ResizableHandle, ResizablePanelGroup } from "~/components/ui/resizable";
import { Separator } from "~/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import { TooltipProvider } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export type MailLayoutProps = {
    defaultLayout: number[] | undefined;
    className?: string;
    navCollapseSize: number;
    defaultCollapsed: boolean;
    done: boolean;
    onDoneChange: (done: boolean) => void;
    showStatusTabs?: boolean;
    heading: string;
    accountSwitcher: (collapsed: boolean) => ReactNode;
    sidebar: (collapsed: boolean) => ReactNode;
    searchBar: ReactNode;
    threadList: ReactNode;
    threadDisplay: ReactNode;
};

/** Shared presentation only: no identity, account API, storage or mailbox state. */
export function MailLayout({ defaultLayout = [20, 32, 48], navCollapseSize, defaultCollapsed, className,
    done, onDoneChange, showStatusTabs = true, heading, accountSwitcher, sidebar, searchBar, threadList, threadDisplay }: MailLayoutProps) {
    const [isCollapsed, setCollapsed] = React.useState(defaultCollapsed);
    return (
        <TooltipProvider delayDuration={0}>
            <ResizablePanelGroup direction="horizontal" className={cn("items-stretch h-full min-h-screen", className)}>
                <ResizablePanel
                    defaultSize={defaultLayout[0]}
                    collapsedSize={navCollapseSize}
                    collapsible={true}
                    minSize={15}
                    maxSize={40}
                    onCollapse={() => setCollapsed(true)}
                    onResize={() => setCollapsed(false)}
                    className={cn(isCollapsed && 'min-w-[50px] transition-all duration-300 ease-in-out')}
                >
                    <div className="flex flex-col h-full flex-1">
                        <div className={cn("flex h-[52px] items-center justify-center", isCollapsed ? 'h-[52px]' : 'px-2')}>
                            {accountSwitcher(isCollapsed)}
                        </div>
                        <Separator />
                        {sidebar(isCollapsed)}
                        <div className="flex-1"></div>
                    </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={defaultLayout[1]} minSize={30}>
                    <Tabs value={done ? "done" : "active"} onValueChange={(value) => onDoneChange(value === "done")}>
                        <div className="flex items-center px-4 py-2">
                            <h1 className="text-xl font-bold">{heading}</h1>
                            {showStatusTabs && <TabsList className="ml-auto">
                                <TabsTrigger value="active" className="text-zinc-600 dark:text-zinc-200">Active</TabsTrigger>
                                <TabsTrigger value="done" className="text-zinc-600 dark:text-zinc-200">Done</TabsTrigger>
                            </TabsList>}
                        </div>
                        <Separator />
                        {searchBar}
                        {showStatusTabs ? <>
                            <TabsContent value="active">{threadList}</TabsContent>
                            <TabsContent value="done">{threadList}</TabsContent>
                        </> : <div className="mt-2">{threadList}</div>}
                    </Tabs>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={defaultLayout[2]} minSize={30}>
                    {threadDisplay}
                </ResizablePanel>
            </ResizablePanelGroup>
        </TooltipProvider>
    );
}
