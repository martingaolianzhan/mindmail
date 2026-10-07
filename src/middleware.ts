import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// create public routes
const isPublicRoute = createRouteMatcher([
    '/sign-in(.*)', '/sign-up(.*)',
    '/api/clerk/webhook(.*)'
]);

// Clerk middleware to protect public routes
export default clerkMiddleware(async (auth, request) => {
    // protect private routes
    if (!isPublicRoute(request)) {
        // if not logged-in, redirect to sign-in page
        await auth.protect()
    }
});

export const config = {
    matcher: [
        // Skip Next.js internals and all static files, unless found in search params
        '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
        // Always run for API routes
        '/(api|trpc)(.*)',
    ],
}; 