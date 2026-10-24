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

## OAuth least privilege

MindMail requests **`Mail.Read Mail.Send`** from Aurinko for both Google and Office365, preserving the existing space-separated URL encoding. It reads/synchronizes complete email content and sends/replies directly; it does not modify provider mailbox state or create/update/delete provider drafts. Local `done`/folder flags and an in-memory compose editor do not require `Mail.ReadWrite` or `Mail.Drafts`. `Mail.All` is not listed in the current scope table and is unnecessary; no alias/legacy meaning is assumed.

Aurinko's [Authentication Scopes table](https://docs.aurinko.io/authentication/authentication-scopes) and [Account OAuth Flow URL example](https://docs.aurinko.io/authentication/oauth-flow/account-oauth-flow) use `Mail.Read`. Its example prose and [Google mapping page](https://docs.aurinko.io/authentication/google-oauth-setup) inconsistently say `Mail.ReadOnly`. We retain the existing `Mail.Read` identifier, not a speculative rename.

### Owner configuration and later live verification

**Google Data Access — manual follow-up, not observed or changed here:**

1. Select the Google project owning the existing OAuth client configured in Aurinko.
2. **Google Auth Platform → Data Access → Add or remove scopes → Gmail API**.
3. Add only these Gmail permissions, remove broader Gmail entries, and save:
   - `https://www.googleapis.com/auth/gmail.readonly` — complete mail reads; **restricted**.
   - `https://www.googleapis.com/auth/gmail.send` — send only; **sensitive**.
4. Confirm the saved Gmail scope list excludes `gmail.modify`, `gmail.compose` and `https://mail.google.com/`; record the displayed verification status/requirements. No portal verification state has been confirmed in this repository change.

**Aurinko boundary:** the documented scope selector is MindMail's `/v1/auth/authorize?scopes=...` request. Aurinko's setup guide describes storing the Google client ID/secret and redirect integration, not a separate scope list to edit. No Aurinko portal session was performed, so actual portal configuration is unverified; no portal scope change is prescribed. Keep the existing Google client ID, secret and redirects—none were rotated or changed. Microsoft/Azure configuration is unchanged.

**Live OAuth — not performed:** existing grants do not prove reduced permissions. Only after code/config alignment and separate authorisation, use a fresh/re-authorized **disposable** account: inspect Google consent/granted scopes → connect through Aurinko → initial sync → incremental sync → read a message body and attachment → send/reply with a test message. Confirm no provider modify/draft capability is required. Do not clear production/user data or use personal/historical mailbox credentials for this check; do not assume reauthorization alone removes older grants.

[Google's Gmail scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes) classifies the scopes above. OAuth verification and applicable restricted-scope/security-assessment requirements remain separate public-release work; no verification request or assessment was submitted here. Do not leave Data Access empty or request insufficient permissions to evade verification. Automated URL/state tests verify code only, not Aurinko's live translation, portal settings or granted scopes.

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
export TEST_DATABASE_URL="postgresql://mindmail_test:<password>@127.0.0.1:55432/mindmail_test"
node test/setup/init-local-db.js
npm run test:integration
```

The disposable database must already exist. The initializer validates `TEST_DATABASE_URL` **before** invoking `prisma migrate deploy`, with `DATABASE_URL` overridden by that validated target. It applies tracked migrations only; failures stop provisioning with no `db push` fallback. Keep the same `TEST_DATABASE_URL` for the integration suite, which verifies database identity and the applied baseline checksum. `npm run test:integration` does **not** run the initializer automatically.

`prisma/migrations/20261022000000_baseline/migration.sql` captures the existing pre-SYNC-004 schema, generated from `schema.prisma` using `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`. New, empty databases execute the baseline; adopting it onto an already-populated database requires a **separately reviewed** procedure, not executing its CREATE statements. The initializer is non-destructive and does not reset existing databases. Destructive clean-replay verification requires explicit authorisation and re-verification of `127.0.0.1:55432/mindmail_test` and its local disposable container before reset.

Future schema changes require reviewed additive migrations. The guarded initializer above is the supported disposable-test deployment path. The general `db:migrate` script also deploys migrations but does not validate its target; `db:generate` currently means `migrate dev` (potentially uses a shadow DB/resets), not client generation. Neither is permission to access a database. The retained `db:push` script is not the DB-001 schema-evolution or test-provisioning path.

The public repository does **not yet provide complete automated container provisioning**. Completing that environment runbook remains tracked stabilisation work.

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


