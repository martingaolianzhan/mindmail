'use client'

import { KBarAnimator, KBarPortal, KBarPositioner, KBarSearch } from "kbar";
import type { ReactNode } from "react";
import RenderResults from "./render-result";

/** Existing palette visuals only; action registration belongs to each provider. */
export function CommandPalette({ children }: { children: ReactNode }) {
    return <>
        <KBarPortal>
            <KBarPositioner className='fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm scrollbar-hide !p-0 z-[999]'>
                <KBarAnimator className='max-w-[600px] !mt-64 w-full bg-white dark:bg-gray-800 text-foreground dark:text-gray-200 shadow-lg border dark:border-gray-700 rounded-lg overflow-hidden relative !-translate-y-12'>
                    <div className='bg-white dark:bg-gray-800'>
                        <div className='border-x-0 border-b-2 dark:border-gray-700'>
                            <KBarSearch className='py-4 px-6 text-lg w-full bg-white dark:bg-gray-800 outline-none border-none focus:outline-none focus:ring-0 focus:ring-offset-0' />
                        </div>
                        <RenderResults />
                    </div>
                </KBarAnimator>
            </KBarPositioner>
        </KBarPortal>
        {children}
    </>;
}
