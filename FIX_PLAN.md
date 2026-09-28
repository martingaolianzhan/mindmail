# MindMail Stabilisation Plan

**Single source of truth.** Consolidated from the supplied Existing Bug List and the local Baseline Diagnostic Report. Scope is stabilisation only: removed Neon projects and real Aurinko mailbox connections must never be accessed, recreated, probed, or synchronised without explicit later authorisation.

## Rules and status

- **Status:** `TODO` = not started; `IN PROGRESS` = active change; `BLOCKED` = cannot proceed safely; `DONE` = acceptance criteria verified by the stated tests or explicit recorded manual verification.
- A successful typecheck, lint, or build alone never changes an item to `DONE`.
- Use npm and **Vitest**. Automated tests must never contact real Neon, Clerk, Aurinko, Gmail, or Gemini services. Use mocked services/synthetic fixtures for unit tests and only a disposable local PostgreSQL database for integration tests.
- No migration, `db push`, OAuth exchange, mailbox sync/send, or live AI request is permitted unless separately authorised.
- Priority: P0 blocks safe use; P1 blocks dependable demo/public readiness; P2 quality/documentation; P3 polish. Dependencies are plan IDs; `—` means none.

## Cross-cutting test foundation and configuration

| ID | Classification | Files | Pri | Dependencies | Acceptance criteria | Tests required | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TEST-001 | Planned Enhancement | `package.json`, Vitest config/setup, `src/**/__tests__`, test fixtures | P0 | — | npm exposes repeatable Vitest commands; network-denied mocked **unit** tests use Clerk/Aurinko/Gemini mocks and synthetic fixtures; separately configured **integration** tests use only a disposable local PostgreSQL DB; initial regression tests cover the first assigned security/sync work. | Demonstrate unit tests with network denied; demonstrate integration-test DB isolation without external-service calls. | IN PROGRESS |
| DB-001 | Planned Enhancement | `prisma/schema.prisma`, `prisma/migrations/**` | P1 | TEST-001 | Future schema changes have reviewed Prisma migrations that apply only to a disposable DB; no existing remote DB is touched. | Clean disposable-DB migration verification when a schema change is assigned. | TODO |
| DEP-001 | Risk Requiring Verification | `package-lock.json`, `package.json` | P0 | TEST-001 | Triage the reported 57 audit findings and React/react-virtual peer conflict by reachability/exploitability; remediate, replace, accept with documented expiry, or block public deployment. Do not blindly perform major upgrades. | Retained `npm audit` evidence; clean install, Vitest, typecheck, lint, and build after each approved remediation. | TODO |
| CFG-001 | Confirmed Bug | `.env.example`, `src/env.js`, README | P2 | — | Template and runtime validation document all required Clerk, Aurinko, URL, Gemini, and DB variables without values; unused variables are removed or documented. | Synthetic empty/invalid-env validation tests or explicit manual verification. | TODO |
| CFG-002 | Risk Requiring Verification | `package.json`, README, CI workflow | P2 | TEST-001 | A supported Node/npm policy is declared and verified; npm remains the sole workflow. | Clean install and full checks on declared versions. | TODO |

---

## Phase 1A — Security & Ownership

| ID | Classification | Files | Pri | Dependencies | Acceptance criteria | Tests required | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | Confirmed Bug | `src/app/api/clerk/webhook/route.ts`, webhook event handling | P0 | TEST-001 | Clerk/Svix verification occurs before parsing/persisting; invalid/absent signatures return real 4xx responses; relevant subscribed user event types have explicit handling; duplicate event delivery is idempotent; `user.deleted` has an explicit, documented cleanup/retention policy. Timestamp/replay protections are verified only to the extent supported by the selected Clerk/Svix verifier and documented accurately. | Vitest route tests for valid/invalid/missing signatures, duplicate event, supported event types, `user.deleted`, and verifier-supported timestamp/replay cases. | TODO |
| SEC-002 | Confirmed Bug | `src/app/api/initial-sync/route.ts`, callback/job boundary, `src/middleware.ts` | P0 | TEST-001 | Initial-sync cannot be invoked by arbitrary public JSON; it requires authenticated ownership or a signed replay-resistant internal-job request. | Route tests for unauthenticated, forged, cross-user, valid job, and replay cases. | TODO |
| SEC-003 | Confirmed Bug | `src/server/api/routers/account.ts` | P0 | TEST-001 | `getThreads` accepts only a closed inbox/sent/draft enum and always includes the authorised account ID in its query. Invalid categories cannot read any thread. | Router tests for each category, invalid input, and two users/accounts. | TODO |
| SEC-004 | Confirmed Bug | `src/server/api/routers/account.ts` | P0 | TEST-001 | Reply-detail lookup scopes `threadId` to the authorised account; a valid user cannot read another account's thread by ID. | Two-account IDOR integration test. | TODO |
| SEC-005 | Risk Requiring Verification | `src/lib/aurinko.ts`, `src/app/api/aurinko/callback/route.ts` | P0 | TEST-001 | OAuth callback has a state/nonce binding to the initiating authenticated user; an existing provider account cannot have its token changed or linked across owners. | Mocked OAuth-state and account-ownership tests. | TODO |
| SEC-006 | Risk Requiring Verification | `src/server/api/routers/account.ts`, `src/lib/account.ts` | P0 | TEST-001 | Send mutation derives/enforces `from` and `replyTo` from the authorised account and validates recipients; client data cannot spoof another sender. | Router tests for spoofed sender, empty/invalid recipients, and authorised mocked send. | TODO |
| SEC-007 | Confirmed Bug | `src/lib/aurinko.ts`, callback route, AI actions, logging/error utilities | P0 | TEST-001 | OAuth codes/tokens, mailbox bodies, AI context, keys, and secret-bearing provider errors are never logged or returned. | Logger-spy tests for success/provider failures and manual redacted-log review. | TODO |
| SEC-008 | Risk Requiring Verification | `prisma/schema.prisma`, `src/server/db.ts`, token storage service | P1 | SEC-007, DB-001 | Aurinko tokens are protected at rest with documented key management, excluded from normal query responses/logs, and have rotation/revocation policy. | Persistence-boundary tests and manual threat-model review. | TODO |
| HTTP-001 | Confirmed Bug | API routes (`aurinko/callback`, `initial-sync`, webhook) | P1 | TEST-001 | Error responses set HTTP status through `NextResponse` options, not only JSON body fields; error payloads are safe and consistent. | Route assertions for 400/401/403/404/500 status and body. | TODO |
| DATA-001 | Risk Requiring Verification | `prisma/schema.prisma`, `src/lib/sync-to-db.ts`, account router | P1 | DB-001, TEST-001 | Provider IDs are proven globally unique or persistence uses account-scoped unique keys; no cross-account upsert/reassignment is possible. | Collision fixture with identical provider IDs across two accounts. | TODO |

---

## Phase 1B — Sync Correctness

| ID | Classification | Files | Pri | Dependencies | Acceptance criteria | Tests required | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SYNC-001 | Confirmed Bug | `src/lib/account.ts` | P0 | TEST-001 | Initial-sync page retrieval advances the current page token, terminates deterministically, and returns each retrieved page once; it does not define persistence/delta-commit policy. | Mocked zero-page, one-page, multi-page, and repeated-page-token fixtures; loop guard and exact request/record assertions. | TODO |
| SYNC-002 | Confirmed Bug | `src/lib/account.ts`, `src/lib/sync-to-db.ts` | P0 | TEST-001 | Incremental sync awaits all persistence before advancing its delta; persistence failure leaves the prior token intact and returns a failure. | Injected write rejection and successful multi-page incremental tests. | TODO |
| SYNC-003 | Confirmed Bug | `src/app/api/initial-sync/route.ts`, `src/lib/account.ts`, persistence layer | P0 | SYNC-001, TEST-001 | Initial-sync persists all retrieved email changes durably before committing its delta token; failure is recoverable and idempotent retry does not skip or duplicate mail. | Persistence-failure/retry fixtures, final-token assertion, and idempotent retry integration test. | TODO |
| SYNC-004 | Confirmed Bug | `src/lib/account.ts`, sync job/lock module, account router | P0 | SYNC-002, TEST-001 | At most one sync per account runs at once; competing requests are coalesced/locked and cannot regress or race delta tokens. | Concurrent same-account sync integration test. | TODO |
| SYNC-005 | Confirmed Bug | `src/hooks/use-threads.ts`, `src/server/api/routers/account.ts` | P1 | SYNC-004 | Reading threads does not automatically invoke external sync on every five-second refetch; sync has explicit scheduling/trigger policy and UI refresh remains functional. | Router/UI test proving list reads make zero Aurinko calls; scheduler mock tests. | TODO |
| SYNC-006 | Risk Requiring Verification | `src/lib/account.ts` | P1 | SYNC-001, SYNC-002 | Aurinko delta-token semantics are documented against provider documentation/mock contract; one-page and final-page token selection is correct. | Contract fixtures for no-page, one-page, and final-page responses. | TODO |
| SYNC-007 | Risk Requiring Verification | `src/lib/account.ts`, sync job module | P1 | SYNC-004 | Sync has bounded readiness polling, request timeouts, retry/backoff policy, cancellation/observability, and no unbounded memory accumulation. | Fake-clock timeout/retry tests and large-fixture memory-bound test. | TODO |
| SYNC-008 | Confirmed Bug | `src/lib/sync-to-db.ts` | P1 | TEST-001 | Email/address/thread/attachment failures are propagated or recorded as retryable failures; declared concurrency is implemented safely or removed. | Per-entity injected-error tests and idempotent retry test. | TODO |

---

## Phase 1C — External Service Recovery & Integration

Offline integration is allowed only with the TEST-001 mocks/fixtures and disposable local PostgreSQL. Live recovery/integration remains blocked and must not recreate or touch removed Neon projects or real mailbox connections.

| ID | Classification | Files | Pri | Dependencies | Acceptance criteria | Tests required | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| INT-001 | Planned Enhancement | integration test setup, synthetic fixtures, integration runbook | P1 | TEST-001, SEC-003, SEC-004, SYNC-001, SYNC-002, SYNC-003, SYNC-004 | Reuse TEST-001 mocks/fixtures to run offline integration tests against disposable local PostgreSQL; document setup and prove no external network/service access. No test-only service-adapter architecture is introduced. | Network-denied Vitest integration suite with disposable local DB. | TODO |
| INT-002 | Planned Enhancement | integration runbook, observability | P1 | INT-001, SEC-001, SEC-002, SEC-005, SEC-007, SYNC-001, SYNC-002, SYNC-003, SYNC-004, SYNC-006, SYNC-007, SYNC-008 | Only after explicit authorisation, a dedicated disposable mailbox and **new development database** prove OAuth, initial/incremental sync, send, recovery, and supported revocation with redacted logs. | Explicit recorded manual verification; no personal mailbox and no removed Neon project. | BLOCKED |
| INT-003 | Planned Enhancement | deployment config, runbook | P1 | INT-002, DEP-001, SEC-008, LIFE-002, LIFE-003, DOC-002 | Production deployment review verifies secrets, signed endpoints, token protection, retention/deletion, privacy documentation, monitoring, rate limits, rollback, and verified security/sync fixes before any public real-mailbox access. | Recorded production-readiness review. | BLOCKED |

---

## Phase 2 — UI & Demo Lifecycle

| ID | Classification | Files | Pri | Dependencies | Acceptance criteria | Tests required | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UI-001 | Confirmed Bug | `src/app/mail/components/sidebar.tsx` | P1 | TEST-001 | Sent badge queries `sent`, not `draft`, and all category counts are correct. | Component/router mock test for three distinct counts. | TODO |
| UI-002 | Confirmed Bug | `src/app/mail/mail.tsx`, `sidebar.tsx`, KBar, `use-threads.ts` | P1 | TEST-001 | Inbox/Done controls share one persisted done-state key and produce distinct filtered lists; KBar state and tabs agree. | UI interaction test plus router-filter assertions. | TODO |
| UI-003 | Confirmed Bug | `reply-box/reply-box.tsx` | P1 | TEST-001 | Reply recipients/CC are not duplicated; changing selected thread always resets subject and recipients from that thread. | Component tests for reply, self-only thread, and thread switch. | TODO |
| UI-004 | Confirmed Bug | `email-editor/email-editor.tsx`, compose/reply callers | P1 | TEST-001 | Editor content clears only after successful send; Send is disabled/pending-safe while mutation is active and failure preserves draft. | Mutation success/failure/double-click component tests. | TODO |
| UI-005 | Confirmed Bug | `email-editor/email-editor.tsx` | P2 | TEST-001 | AI completion shortcut works on Cmd+J and Ctrl+J as advertised, without duplicate requests. | Keyboard interaction tests with mocked AI action. | TODO |
| UI-006 | Confirmed Bug | `src/app/mail/mail.tsx` | P2 | — | `text-xinc-600` is corrected and visual class output is reviewed. | Targeted component/manual visual verification. | TODO |
| LIFE-001 | Confirmed Bug | README, retention/deletion documentation | P2 | — | Existing README four-day retention/deletion claim is compared with implemented behaviour; unsupported claims are removed or corrected. This item does not claim to implement a retention system. | Explicit documentation/implementation review. | TODO |
| LIFE-002 | Planned Enhancement | `src/lib/account.ts`, OAuth/account lifecycle, schema/migration, README | P1 | DB-001, TEST-001, SYNC-003 | Initial sync imports only the most recent **three days**; each linked demo mailbox has a fixed 72-hour expiry from connection time, not rolling per-email deletion. | Fake-clock lifecycle tests for three-day import boundary and fixed 72-hour expiry. | TODO |
| LIFE-003 | Planned Enhancement | account deletion/cleanup service, scheduled job, schema/migration, UI/API, README/privacy docs | P1 | DB-001, TEST-001, LIFE-002, SEC-008 | Scheduled expiry cleanup and immediate user deletion remove account-related database data; tokens are revoked where provider support permits; documentation states limits for external processors, logs, and backups. | Fake-clock scheduled-cleanup tests, user-delete integration test, mocked revocation test, and manual documentation review. | TODO |
| DEMO-001 | Planned Enhancement | demo route/data provider, mail UI, synthetic fixtures, README | P1 | TEST-001, UI-001, UI-002 | Desktop demo provides useful synthetic mailbox data without OAuth or real email connection; demo state cannot invoke real mail APIs; any AI interaction is clearly marked mocked. | Network-denied end-to-end/component demo test and explicit desktop manual verification. | TODO |
| UX-001 | Planned Enhancement | mail UI action components, tRPC router | P2 | TEST-001 | Archive/delete/done controls presented as active either perform authorised persisted actions or are visibly disabled/labelled unavailable. | UI/router tests or manual verification. | TODO |

---

## Phase 3 — Portfolio Polish

| ID | Classification | Files | Pri | Dependencies | Acceptance criteria | Tests required | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DOC-001 | Planned Enhancement | README, `.env.example`, architecture/runbook docs | P2 | CFG-001, LIFE-001, INT-001 | README accurately states setup, supported services, offline demo limits, test commands, and no-live-service policy. | Documentation checklist/manual review. | TODO |
| DOC-002 | Planned Enhancement | README, privacy/data-flow documentation | P1 | LIFE-001, LIFE-002, LIFE-003, SEC-008 | Documentation accurately states what Clerk, Aurinko, database, and Gemini access/store; permissions, retention, deletion, external processors, and third-party flows. It makes no unverified security/deletion guarantee. | Manual privacy/data-flow review against implementation. | TODO |
| QUAL-001 | Confirmed Bug | `.github/workflows/**`, `package.json` | P2 | TEST-001, CFG-002 | GitHub Actions CI runs npm clean install, Vitest unit tests, disposable-DB integration tests, typecheck, lint, and production build without external-service access. | Successful recorded GitHub Actions run. | TODO |
| QUAL-002 | Planned Enhancement | linted source files | P3 | TEST-001 | Existing lint warnings are triaged; safety-relevant promise/error warnings are resolved or explicitly justified. | `npm run lint` warning baseline reduced/approved. | TODO |
| UX-002 | Planned Enhancement | sign-in/up pages, image components | P3 | TEST-001 | Decorative images have valid alt handling and image-performance warnings are intentionally addressed or documented. | Accessibility/component check and lint review. | TODO |
| UX-003 | Planned Enhancement | mail layout/components, styles | P3 | DEMO-001 | Mobile responsiveness is assessed and improved as a later desktop-first portfolio enhancement; it does not block the initial desktop demo milestone or disposable-mailbox integration. | Mobile viewport component/manual verification. | TODO |

## Release gates

1. **Offline/disposable-local integration (`INT-001`)** requires only its listed security/sync prerequisites and TEST-001. It does **not** require Phase 3 portfolio polish.
2. **Live disposable-mailbox integration (`INT-002`)** remains blocked pending explicit authorisation and its listed security/sync prerequisites. It requires a dedicated disposable mailbox and new development database only.
3. **Public real-mailbox access/deployment (`INT-003`)** is blocked until verified security and sync fixes, DEP-001 triage, SEC-008 token protection, LIFE-002/LIFE-003 retention/deletion, DOC-002 privacy documentation, and recorded production deployment review are complete. Portfolio polish is not a substitute for these gates.

## Consolidated backlog summary

- **P0:** Vitest/network-isolated foundation; webhook/internal-sync/account/OAuth/sender/secret controls; initial and incremental sync correctness/concurrency; dependency-security triage.
- **P1:** durable recovery, provider-ID and token protection verification, bounded sync, offline/live disposable integration, lifecycle cleanup, desktop demo, and privacy/release readiness.
- **P2/P3:** configuration policy, UI correctness, CI, accurate setup docs, lint/accessibility, and later mobile polish.

## Reconciliation and conflicts

There are no material conflicts between the two input documents; they are complementary. The supplied list identifies the arbitrary-category global `getThreads` query, while the baseline identifies reply-detail IDOR; both remain separate. The supplied list identifies unawaited incremental persistence, while the baseline adds initial-persistence ordering, failure propagation, concurrency, and recovery risks; these remain separate. The local private environment having variable names does not conflict with an incomplete committed template. Successful build/typecheck/lint verifies compile health only, not runtime security, ownership, sync, or service correctness.

## Smallest safe next implementation task

**TEST-001: introduce the npm/Vitest foundation with network-denied external mocks, synthetic fixtures, and separated disposable-local-PostgreSQL integration configuration.** It changes no production behaviour and supplies the evidence mechanism required for subsequent P0 fixes.
