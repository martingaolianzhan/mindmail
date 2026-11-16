/** Public, deterministic fiction only. Never loaded from a database or test tree. */
export type DemoCategory = "inbox" | "sent" | "draft";
export type DemoRecipient = { address: string; name?: string };
export type DemoMessage = {
    id: string; from: string; sender: string; sentAt: string; body: string;
    to?: DemoRecipient[]; cc?: DemoRecipient[]; subject?: string; inReplyTo?: string;
};
export type DemoThread = {
    id: string; accountId: string; category: DemoCategory; done: boolean;
    subject: string; messages: DemoMessage[];
};
export const demoAccounts = [
    { id: "demo-avery", name: "Avery Studio", address: "avery@example.test" },
    { id: "demo-robin", name: "Robin Workshop", address: "robin@example.test" },
] as const;

function mailbox(account: typeof demoAccounts[number]): DemoThread[] {
    const message = (slug: string, sender: string, from: string, body: string, hour = "09"): DemoMessage => ({
        id: `${account.id}-${slug}`, sender, from, body, sentAt: `2026-05-12T${hour}:00:00Z`,
    });
    const thread = (slug: string, category: DemoCategory, done: boolean, subject: string, messages: DemoMessage[]): DemoThread => ({
        id: `${account.id}-${slug}`, accountId: account.id, category, done, subject, messages,
    });
    return [
        thread("aurora", "inbox", false, "Aurora launch plan", [
            message("aurora-1", "Mira Chen", "mira@example.test", "Hi team, the Aurora launch checklist is ready. Could you review the accessibility notes and the desktop walkthrough?"),
            message("aurora-2", account.name, account.address, "The desktop walkthrough looks good. I added keyboard navigation notes and a shorter introduction.", "10"),
            { ...message("aurora-3", "Mira Chen", "mira@example.test", "Thanks! Let's bring the revised checklist to Thursday's design review. The presentation starts at 14:00 UTC.", "11"),
                to: [{ address: account.address, name: account.name }], cc: [{ address: "sam@example.test", name: "Sam Rivera" }] },
        ]),
        thread("ceramics", "inbox", false, "Saturday ceramics workshop", [
            message("ceramics-1", "Sam Rivera", "sam@example.test", "Your place at the ceramics workshop is reserved. Bring an apron; clay and tools are provided. We will meet at the fictional Riverside Studio."),
        ]),
        thread("receipt", "inbox", true, "Design books receipt", [
            message("receipt-1", "Paper Trail", "books@example.test", "Thank you for your fictional order of two design books. This synthetic receipt contains no payment information."),
        ]),
        thread("proposal", "sent", false, "Community garden proposal", [
            message("proposal-1", account.name, account.address, "Hi Noah, here is the community garden proposal. The first phase focuses on accessible paths, shared tools and seasonal planting."),
        ]),
        thread("thanks", "sent", true, "Thanks for the review", [
            message("thanks-1", account.name, account.address, "Thanks for reviewing the fictional exhibition guide. Your feedback made the visitor instructions much clearer."),
        ]),
        thread("newsletter", "draft", false, "Draft: May studio newsletter", [
            message("newsletter-1", account.name, account.address, "A draft newsletter about our synthetic studio: a new poster series, a community workshop and a few recommended books."),
        ]),
        thread("invitation", "draft", true, "Draft: exhibition invitation", [
            message("invitation-1", account.name, account.address, "An archived draft invitation for the fictional Field Notes exhibition. This is sample content, not a scheduled message."),
        ]),
    ];
}
export const demoThreads: readonly DemoThread[] = demoAccounts.flatMap(mailbox);

export function searchDemoThreads(threads: readonly DemoThread[], accountId: string, query: string): DemoThread[] {
    const term = query.trim().toLowerCase();
    return threads.filter(thread => thread.accountId === accountId &&
        [thread.subject, ...thread.messages.flatMap(message => [message.subject ?? "", message.sender, message.from, message.body])]
            .join(" ").toLowerCase().includes(term));
}
