# MindMail contributor guide

## Architecture
MindMail is a Next.js 15 App Router application using TypeScript, React, Tailwind/shadcn, Clerk, tRPC, Prisma/PostgreSQL, Aurinko mail APIs, and Gemini AI. Core paths are:

- Authentication and route protection: `src/middleware.ts`, Clerk pages, and `src/app/api/clerk/webhook/route.ts`.
- OAuth and mail sync: `src/lib/aurinko.ts`, `src/app/api/aurinko/callback/route.ts`, `src/lib/initial-sync.ts`, `src/lib/account.ts`, and `src/lib/sync-to-db.ts`.
- Data and APIs: `prisma/schema.prisma`, `src/server/db.ts`, and `src/server/api/routers/account.ts`.
- Mail UI and AI: `src/app/mail/**`, `src/hooks/use-threads.ts`, and `src/app/mail/components/ai-compose/**`.

`FIX_PLAN.md` is the single source of truth for stabilisation work. Do not mark an item DONE merely because the build succeeds.

## Workflow and completion
- Use **npm only** (`npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`). Do not use Bun despite `bun.lockb` being present.
- Work only on the explicitly assigned `FIX_PLAN.md` item or a tightly related prerequisite. Make small, incremental changes; do not refactor or begin the next plan item independently.
- Before implementation, identify affected files, documented acceptance criteria, regression risks, and the validation approach. Before and after a change, inspect `git status`; never discard user work.
- Add or update automated tests for every behaviour change. Run targeted tests plus typecheck, lint, and build before reporting completion.
- Report changed files, test/validation results, unresolved issues, and decisions requiring review. Update a plan item to `DONE` only after its documented acceptance criteria have been verified by appropriate tests or explicit manual verification; a successful build alone is insufficient.
- Do not run Prisma migrations, `db push`, or production-facing database commands without explicit task authorisation.
- Use Vitest as the standard testing framework. Add targeted unit and integration tests for behaviour changes, using mocked external services and disposable test databases where appropriate. Do not introduce alternative testing frameworks without explicit approval.

## Security and ownership invariants
- Every account, thread, email, address, send, search, and reply operation must be bound to the authenticated Clerk user **and** authorised account at the database query boundary. Never trust client-supplied ownership, sender, account, or thread identifiers.
- Verify Clerk/Svix webhook signatures before parsing or persisting events. Internal/background endpoints require authentication or a signed, replay-resistant request.
- Never log, commit, return, or expose OAuth codes, access tokens, database URLs, API keys, webhook secrets, or raw mailbox/AI context. Redact sensitive error data.
- Treat mailbox data as private. Gemini/Aurinko calls require explicit, documented data flow and must be mockable in tests.

## Mail synchronisation invariants
- Never advance or persist a delta token before every email change represented by that token has been successfully persisted.
- Synchronisation must be retryable and idempotent. Bound pagination and readiness polling, and prevent concurrent jobs from corrupting one account's state.
- OAuth callbacks must bind the authorisation flow and resulting mailbox to the initiating authenticated user. Account updates must enforce ownership.

## External-service isolation
Existing Neon projects and real Aurinko mailbox connections were removed. **Never access, recreate, probe, or sync them** unless a later task explicitly authorises live integration.

Existing environment files may contain historical credentials; their presence never authorises use. Use separate test configuration, local/disposable PostgreSQL infrastructure, mocked Clerk/Aurinko/Gemini clients, and synthetic email fixtures. Automated tests and local development must not send requests to real mail, AI, production databases, OAuth exchange, or mailbox synchronisation by default.
