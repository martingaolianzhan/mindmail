# MindMail

**MindMail** is a full-stack email client built with Next.js, React, TypeScript, tRPC and PostgreSQL, with mailbox synchronisation, email composition and AI-assisted drafting.

Originally built in 2024–2025, the project returned to active development in 2026 for a structured stabilisation cycle focused on account ownership, OAuth security, synchronisation correctness and regression testing.

> **Current status:** active stabilisation. Public real-mailbox use is not currently treated as production-ready.

---

## Engineering highlights

[`FIX_PLAN.md`](./FIX_PLAN.md) is the source of truth for current stabilisation work. Completed items are only marked done after their acceptance criteria have been verified.

### 1. Account ownership and query isolation

**Problem**

Account-sensitive operations in the original application did not consistently constrain mailbox resources by both the authenticated user and the selected account.

For a multi-account email client, possession of a thread or account identifier must not be sufficient to access another mailbox.

**Change**

The affected server operations now authorise through the authenticated Clerk user and scope relevant queries to the authorised account.

The work includes:

- restricting thread categories to known inbox/sent/draft values;
- binding thread queries and reply-detail lookup to an authorised account;
- rejecting cross-account access;
- preventing unauthorised accounts from sending email;
- deriving sender identity from the authorised account rather than trusting client-controlled sender fields.

Implementation:

- [`src/server/api/routers/account.ts`](./src/server/api/routers/account.ts)

Representative verification:

- [`test/integration/account-router.sec-003.test.ts`](./test/integration/account-router.sec-003.test.ts)
- [`test/integration/account-router.sec-004.test.ts`](./test/integration/account-router.sec-004.test.ts)
- [`test/unit/account-router.sec-006.test.ts`](./test/unit/account-router.sec-006.test.ts)
- [`test/integration/`](./test/integration)

The integration cases use multiple users and accounts to verify authorised access and cross-account rejection against PostgreSQL.

---

### 2. Incremental sync checkpoint ordering

**Problem**

Incremental synchronisation persists a delta token as its checkpoint.

If that checkpoint advances before the corresponding persistence operation completes, a failed persistence operation could leave the application believing changes were consumed when they were not successfully committed.

**Change**

Incremental sync now awaits the current persistence Promise before updating the stored checkpoint.

```text
Fetch incremental changes
        ↓
Start persistence
        ↓
pending  → checkpoint is not updated
rejects  → retain previous checkpoint and fail sync
resolves → advance checkpoint
```

Implementation:

- [`src/lib/account.ts`](./src/lib/account.ts)

Verification:

- [`test/unit/account.sync-002.test.ts`](./test/unit/account.sync-002.test.ts)
- [`test/integration/account.sync-002.test.ts`](./test/integration/account.sync-002.test.ts)

Current regression coverage verifies that the checkpoint remains unchanged while the persistence Promise is pending and when it explicitly rejects, and advances after that Promise resolves.

The integration test uses a real PostgreSQL account record to verify checkpoint state and update ordering, while the email-persistence function itself is mocked. It therefore verifies checkpoint behaviour at the database boundary, not a complete end-to-end email persistence transaction.

This guarantee is deliberately narrow.

Internal entity-level persistence failures that may currently be swallowed instead of propagating as a rejected top-level Promise are tracked separately as **SYNC-008**.

Initial-sync durable checkpoint ordering is also separate work tracked as **SYNC-003**.

See [`FIX_PLAN.md`](./FIX_PLAN.md) for the current status of both items.

---

### 3. External-service isolation in tests

**Problem**

MindMail integrates authentication, mailbox and AI providers. Automated tests against live services would be nondeterministic and could expose real mailbox data, credentials or production infrastructure.

**Approach**

The test harness isolates automated verification from live external services:

- Clerk, Aurinko and Gemini are mocked;
- unintended network access is disabled during tests;
- synthetic mailbox fixtures replace real email data;
- integration tests use an explicitly authorised disposable local PostgreSQL database;
- the integration database URL is guarded to prevent accidental use of another database.

Relevant infrastructure:

- [`test/setup/network.ts`](./test/setup/network.ts)
- [`test/setup/test-database-url.js`](./test/setup/test-database-url.js)
- [`test/unit/`](./test/unit)
- [`test/integration/`](./test/integration)
- [`test/mocks/`](./test/mocks)
- [`test/fixtures/`](./test/fixtures)

Repository-level development and safety constraints are documented in [`AGENTS.md`](./AGENTS.md).

---

## Product functionality

Implemented application flows include:

- Clerk-authenticated mailbox linking through Aurinko OAuth;
- mailbox synchronisation and inbox/sent/draft thread views;
- thread reading, composition, replies and email sending;
- Prisma/PostgreSQL persistence;
- context-aware AI email drafting;
- streamed inline AI autocomplete.

The current redevelopment cycle prioritises correctness and maintainability over new feature development.

---

## Architecture

```text
                     ┌─────────────┐
                     │    Clerk    │
                     │    Auth     │
                     └──────┬──────┘
                            │
                            ▼
┌────────────────────────────────────────────┐
│        Next.js / React / TypeScript        │
│                                            │
│   Mail UI · Threads · Compose · AI UI      │
└─────────────────────┬──────────────────────┘
                      │
                      │ tRPC / server actions
                      ▼
┌────────────────────────────────────────────┐
│            Server-side application         │
│                                            │
│  AuthZ · Mail operations · Sync · AI       │
└───────────┬─────────────┬──────────────┬───┘
            │             │              │
            ▼             ▼              ▼
     ┌────────────┐ ┌────────────┐ ┌──────────────┐
     │ Prisma /   │ │ Aurinko    │ │ Vercel AI   │
     │ PostgreSQL │ │ Mail/OAuth │ │ SDK / Gemini│
     └────────────┘ └────────────┘ └──────────────┘
```

Main stack:

**Next.js 15 · React · TypeScript · tRPC · Prisma · PostgreSQL · Clerk · Aurinko · Tailwind/shadcn · Vitest**

---

## AI in the product

MindMail currently implements two AI-assisted user flows.

**Context-aware drafting** combines email context with a user instruction and streams the generated draft back to the compose interface.

**Inline autocomplete** generates short continuations intended to follow the user's existing text and tone.

Implementation:

- [`src/app/mail/components/ai-compose/ai-actions.ts`](./src/app/mail/components/ai-compose/ai-actions.ts)

The current implementation uses **streamed text generation through the Vercel AI SDK with Gemini**. It does not currently rely on tool calling or structured-output workflows.

The tested AI failure paths signal generic stream errors without logging email context or provider details:

- [`test/unit/logging.sec-007.test.ts`](./test/unit/logging.sec-007.test.ts)

---

## AI-assisted development

AI tools are also part of the stabilisation workflow.

- **Pi** is used for scoped investigation, implementation and debugging.
- **Codex CLI** is used as a separate review layer for implementation decisions, affected paths and regression risks.

AI-assisted changes are manually reviewed against the repository's architecture and constraints and validated with targeted tests before being accepted.

The relevant engineering rules and acceptance criteria live in:

- [`AGENTS.md`](./AGENTS.md)
- [`FIX_PLAN.md`](./FIX_PLAN.md)

---

## Verification

Install dependencies with npm:

```bash
npm ci
```

Unit tests use mocked external services and deny unintended network access:

```bash
npm run test:unit
```

The repository also exposes:

```bash
npm run test:integration
npm run typecheck
npm run lint
npm run build
```

These commands have different environment requirements; the repository is still undergoing configuration/documentation cleanup and should not yet be treated as a zero-configuration clone-and-run project.

### Integration-test database

Integration tests require a **pre-provisioned disposable local PostgreSQL database**.

`TEST_DATABASE_URL` is deliberately restricted to:

```text
Host:     localhost or 127.0.0.1
Port:     55432
Database: mindmail_test
User:     mindmail_test
Password: required
```

Example:

```bash
export TEST_DATABASE_URL="postgresql://mindmail_test:<password>@localhost:55432/mindmail_test"
npm run test:integration
```

The database must already exist and contain the schema expected by the current test suite.

The public repository does **not yet provide a complete automated provisioning/runbook for this test database**. Completing reproducible environment setup and configuration documentation remains tracked stabilisation work.

The guard itself can be inspected in:

- [`test/setup/test-database-url.js`](./test/setup/test-database-url.js)
- [`test/setup/integration.ts`](./test/setup/integration.ts)

---

## Current status and limitations

MindMail is currently an **engineering and stabilisation project**, not a production-ready email service.

Current boundaries include:

- automated development/testing does not use previous real mailbox connections or removed remote database resources;
- automated tests must not call live Clerk, Aurinko or Gemini services;
- the previous public deployment is not currently presented as a supported evaluation environment;
- internal persistence failure propagation remains tracked under **SYNC-008**;
- initial-sync durable checkpoint ordering remains tracked under **SYNC-003**;
- synchronisation concurrency, token-at-rest protection, lifecycle/deletion behaviour and other release-readiness work remain outstanding;
- build success alone is not considered sufficient evidence that a stabilisation item is complete.

For the detailed status and remaining work, see [`FIX_PLAN.md`](./FIX_PLAN.md).

---

## Repository guide

| Area                    | Main paths                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Authentication          | `src/middleware.ts`, `src/app/api/clerk/webhook/`                                       |
| OAuth / account linking | `src/lib/aurinko.ts`, `src/lib/aurinko-oauth-state.ts`, `src/app/api/aurinko/callback/` |
| Mail synchronisation    | `src/lib/account.ts`, `src/lib/initial-sync.ts`, `src/lib/sync-to-db.ts`                |
| Application APIs        | `src/server/api/routers/account.ts`                                                     |
| Database                | `prisma/schema.prisma`, `src/server/db.ts`                                              |
| Mail UI                 | `src/app/mail/`                                                                         |
| AI features             | `src/app/mail/components/ai-compose/`                                                   |
| Tests                   | `test/unit/`, `test/integration/`                                                       |
| Stabilisation plan      | `FIX_PLAN.md`                                                                           |
| Engineering constraints | `AGENTS.md`                                                                             |


