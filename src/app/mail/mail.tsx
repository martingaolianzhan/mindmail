'use client'
import React from "react";
import { useLocalStorage } from "usehooks-ts";
import AccountSwitcher from "./components/account-switcher";
import Sidebar from "./components/sidebar";
import ThreadList from "./components/thread-list";
import ThreadDisplay from "./components/thread-display";
import SearchBar from "./components/email-search/search-bar";
import { MailLayout } from "./components/mail-layout";

type Props = {
    defaultLayout: number[] | undefined;
    navCollapseSize: number;
    defaultCollapsed: boolean;
};

const Mail = (props: Props) => {
    const [done, setDone] = useLocalStorage("thread-done", false);
    const [tabCategory] = useLocalStorage<"inbox" | "sent" | "draft">("tab-category", "inbox");
    const mailboxHeading = { inbox: "Inbox", sent: "Sent", draft: "Draft" }[tabCategory];
    return <MailLayout {...props} done={done} onDoneChange={setDone} heading={mailboxHeading}
        accountSwitcher={isCollapsed => <AccountSwitcher isCollapsed={isCollapsed} />}
        sidebar={isCollapsed => <Sidebar isCollapsed={isCollapsed} />}
        searchBar={<SearchBar />} threadList={<ThreadList />} threadDisplay={<ThreadDisplay />} />;
};

export default Mail;
