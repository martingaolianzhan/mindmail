'use client'
import { TabsContent, TabsTrigger } from "~/components/ui/tabs";
import React from "react";
import { ResizablePanel, ResizableHandle, ResizablePanelGroup } from "~/components/ui/resizable";
import { Separator } from "~/components/ui/separator";
import { Tabs, TabsList } from "~/components/ui/tabs";
import { TooltipProvider } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import AccountSwitcher from "./components/account-switcher";
import Sidebar from "./components/sidebar";
import ThreadList from "./components/thread-list";
import ThreadDisplay from "./components/thread-display";
import SearchBar from "./components/email-search/search-bar";

// define props structure
type Props = {
    defaultLayout: number[] | undefined
    navCollapseSize: number
    defaultCollapsed: boolean
}

const Mail = ({ defaultLayout = [20, 32, 48], navCollapseSize, defaultCollapsed }: Props) => { 
    // side bar collapse state
    const [isCollapsed, setCollapsed] = React.useState(defaultCollapsed);

    return (
         // define the delay time of tooltip pop-up
         <TooltipProvider delayDuration={0}>
             <ResizablePanelGroup direction="horizontal" className="items-stretch h-full min-h-screen">
                { /* Side Bar Area */ }
                <ResizablePanel
                    defaultSize={defaultLayout[0]}
                    collapsedSize={navCollapseSize}
                    collapsible={true}
                    minSize={15}
                    maxSize={40}
                    // side bar collapse event
                    onCollapse={() => setCollapsed(true)}
                    // side bar expand & resize event
                    onResize={() => {
                        setCollapsed(false);
                     }}
                    // apply transition to all transitionable elements, smooth both start and end
                    // className applied only when side bar collapsed
                    className={cn(isCollapsed &&'min-w-[50px] transition-all duration-300 ease-in-out')}
                >
                    {/* Side Bar Sub Elements */ }
                    <div className="flex flex-col h-full flex-1">
                        {/* Account Switcher Area */}
                        <div className={cn("flex h-[52px] items-center justify-center", isCollapsed ? 'h-[52px]' : 'px-2')}>
                            {/* Account Switcher */}
                            <AccountSwitcher isCollapsed={isCollapsed}></AccountSwitcher>
                        </div>
                        <Separator />
                        {/* Email Category Side Bar */}
                        <Sidebar isCollapsed={isCollapsed} />
                        <div className="flex-1"></div>
                        {/* AI RAG */}
                    </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={defaultLayout[1]} minSize={30}>
                    <Tabs defaultValue="Inbox"> 
                        <div className="flex items-center px-4 py-2">
                            <h1 className="text-xl font-bold">Inbox</h1>
                            <TabsList className="ml-auto">
                                <TabsTrigger value="Inbox" className="text-xinc-600 dark:text-zinc-200">
                                    Inbox
                                </TabsTrigger>
                                <TabsTrigger value="Done" className="text-xinc-600 dark:text-zinc-200">
                                    Done
                                </TabsTrigger>
                            </TabsList>
                        </div>
                        <Separator />
                        {/* Search Bar */}
                        <SearchBar />
                        <TabsContent value="Inbox">
                            <ThreadList></ThreadList>
                        </TabsContent>
                        <TabsContent value="Done">
                            <ThreadList></ThreadList>
                        </TabsContent>
                    </Tabs>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={defaultLayout[2]} minSize={30}>
                    {/* Thread Display */}
                    <ThreadDisplay></ThreadDisplay>
                </ResizablePanel>
             </ResizablePanelGroup>
        </TooltipProvider>
     )
}

export default Mail;