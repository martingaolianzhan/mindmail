import type { Metadata } from "next";
import DemoMailbox from "~/demo/mailbox";

export const metadata: Metadata = {
    title: "MindMail · Synthetic Demo",
    description: "Explore a fictional mailbox without sign-in or a real mailbox connection.",
};

export default function DemoPage() {
    return <DemoMailbox />;
}
