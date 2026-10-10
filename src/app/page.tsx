import LinkAccountButton from "~/components/ui/link-account-button";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "~/server/db";

export default async function Home() {

    const user = await auth();

    if (user.userId) {
        // If there is no email account linked, redirect to the link account page
        const num = await db.account.count({
            where: {
                userId: user.userId,
            }
        });


        if (num > 0) {
            // If there is an email account linked, redirect to the mail page
            redirect("/mail");
        }
    }

    return (
        <div className="h-screen w-screen bg-[#E7E4DF] text-black flex flex-col items-center justify-center space-y-40 dark:bg-[#545454] dark:text-[#E7E4DF] animate-rise">
            <div className="flex space-x-20 w-fit h-fit max-w-[1400px] justify-items-start animate-rise">
                <img src="/images/logo.png" className="h-[500px] w-[500px] animate-rise delay-200" alt="logo"></img>
                <div>
                    <h1 className="text-[46px] pb-10 font-notoSans animate-rise">Welcome to Mind Mail!</h1>
                    <p className="text-[24px] font-notoSans font-bold pb-3 animate-rise delay-300">Notice:</p>
                    <ul className="text-[24px] font-notoSans list-disc list-inside space-y-5 animate-rise delay-350">
                        <li className="animate-rise delay-350">This is an <span className="font-ptSerif italic">early version</span> under active <span className="font-bold">development</span>. You may encounter <span className="font-bold">bugs</span>, but I will address them <span className="font-ptSerif font-bold">promptly</span> if you <span className="font-bold">report</span> them.</li>
                        <li className="animate-rise delay-400">Due to database constraints and <span className="font-bold italic">testing</span> requirements, <span className="font-bold italic">ONLY</span> emails from the <span className="font-bold">past two days</span> will be synced after you link your email account. However, <span className="font-bold italic">ALL</span> new incoming emails will sync automatically.</li>
                        <li className="animate-rise delay-450">Currently, <span className="font-notoSans font-bold">ONLY</span> <span className="font-ptSerif font-bold italic">Gmail accounts</span> are allowed to be linked.</li>
                    </ul>
                </div>
            </div>
            <LinkAccountButton />
        </div>
    );
}
