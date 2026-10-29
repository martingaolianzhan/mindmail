# SYNC-007 — one bounded synchronization run

References in this document to SYNC-005 as “not yet implemented” or “the next task” reflect its status when SYNC-007 was completed. The SYNC-005 durable scheduling core and Cloudflare wake-up adapter have since been implemented, but deployment acceptance is still pending. SYNC-005 remains TODO; see FIX_PLAN.md for its current status.

## Scope and production paths

One run only. There is no queue, scheduler, lease, continuous ownership watcher,
retry timestamp, persistent retry budget, restart worker, schema change or history
recovery. `daysWithin: 2`, `Mail.Read Mail.Send`, and relink's four-field atomic
credential/generation/owner/checkpoint transition are unchanged.

`Account.syncEmails()` and trusted `performInitialSync({ accountId, userId })`
share `executeSync` / `SyncRun`. The initial Account method is now only an internal
provider phase requiring that control object. Neither production path bypasses
execution acquisition, complete-dataset fetching, fenced sequential persistence,
or conditional checkpoint completion.

## Reviewable defaults (`src/lib/sync-limits.ts`)

All are application safety choices, **not Aurinko's official limits**. Internal
`SyncRunOptions` allows deterministic test overrides; no new environment variables.

| Control | Default |
| --- | --- |
| Each sync HTTP attempt | 15,000ms timeout, AbortSignal |
| Overall provider/control deadline | 120,000ms, beginning before account lookup |
| Readiness interval | 1,000ms abortable delay |
| Readiness maximum | 30 polls, including first POST; retries belong to that poll |
| Attempts per provider request | 3 total, including first attempt |
| Retry delay | Linear 250ms, then 500ms; no jitter |
| Pages | 50 per run, including first updated response (formerly 100) |
| Accumulated records | 10,000 |
| One buffered HTTP response | 20,000,000 bytes (`maxContentLength`), unchanged decimal limit |
| Cumulative mailbox payload | 128 MiB = 134,217,728 serialized UTF-8 bytes per run |
| DB transaction acquisition (`maxWait`) | 2,000ms |
| DB transaction execution (`timeout`) | 5,000ms |
| PostgreSQL local `statement_timeout` | 4,000ms |
| PostgreSQL local `lock_timeout` | 2,000ms |
| Each DB acknowledgement observation | 8,000ms |
| Final arbitration observation envelope | Up to two sequential 8,000ms observations |

Every sync account lookup, claim, ownership check, email transaction, completion,
revocation, required reread and best-effort legacy release has a native bounded
interactive transaction and a finite observation bound. Email transactions retain
Read Committed and the original Account `FOR UPDATE` fence; authority-only
transactions use PostgreSQL's default Read Committed isolation. No provider work
runs in a DB transaction. A batch does **not** inherit one 8-second timeout for all
emails: each email has its own bounds, with the overall control deadline stopping
new units.

The deadline is not a hard realtime return/DB-cancellation guarantee. A conservative
configured envelope is **120s control + up to 8s already-started DB observation/drain
+ up to 16s required arbitration = 144s**, assuming a responsive process/event loop.
These phases can overlap (revocation begins immediately); usual completion is
sooner. A native DB operation may outlive JS observation if acknowledgement is
uncertain. Its late effects remain fenced; they are not declared rolled back.
Process exit/restart and future reconciliation are SYNC-005, not a JS timer promise.

## Resource-limit close-out patch

Each initial or incremental run now allows **50 pages**, resetting on every new
run, not per Account lifetime. A terminal page 50 is allowed; page 50 announcing
continuation fails immediately without page 51. `maxRecords` remains **10,000**.
The existing Axios single-response limit stays exactly **20_000_000 bytes**, not
20 MiB; no HTTP adapter, transform, raw-body capture or parser behaviour changes.
All request/retry/readiness/deadline/DB/claim bounds remain unchanged.

A fresh `SyncRun` also starts with a zero cumulative mailbox-payload counter. The
metric is **the UTF-8 serialized byte size of each successfully received
`GET /v1/email/sync/updated` JSON response, measured once per current response
before its records are retained in the accumulated dataset**. It includes the
whole response data object (records and metadata), not Axios headers/config.
Readiness/start-sync `POST /v1/email/sync` responses are **not counted**. They still
have their existing per-response Axios limit.

`SyncRun.acceptMailboxResponse(currentResponseData)` computes:

```ts
const candidate = previousBytes + Buffer.byteLength(JSON.stringify(currentResponseData), "utf8");
```

It serializes only the current response, never `allEmails` or any accumulated
workset. If candidate **> 128 * 1024 * 1024** bytes, it throws the existing small
`SyncRunFailure` with `{ status: "safety-limit", reason: "response-bytes-limit" }`
before updating the counter or appending that page's records. Equality is allowed.
The shared pagination path invokes the check outside the provider retry wrapper.
`SyncRun.request()` additionally preserves typed safety-limit errors if they cross
that wrapper, rather than reclassifying them as provider-contract/transient errors.
There is no retry, next page, persistence, checkpoint advancement or truncated
completed result after this resource failure (subject to the existing truthful
durable termination/arbitration contract). The counter is per run, including when
the same Account client is reused. Content-Length is neither required nor trusted.

This is a **cumulative serialized mailbox-payload safety budget**, a practical
resource-use proxy, **not an exact Node/V8 heap ceiling**. Actual heap use can be
higher because of parsed object overhead, temporary response serialization,
runtime allocations and Axios/Node internals. The controls are complementary: the
unchanged 20,000,000-byte response limit bounds one HTTP response; the 128 MiB
budget bounds accepted cumulative serialized mailbox work across many pages.
**INT-002 owns future tuning against explicitly authorised real Aurinko behaviour**;
this mocked/offline patch makes no exact production memory-consumption claim and
does not perform live-service validation.

`test/unit/sync-resources.sync-007.test.ts` adds 19 tiny-fixture cases: exact defaults
(and unchanged timing/record values), terminal/continuing actual page 50 for both
paths with zero page-51 calls, 1000/1001-byte boundaries without Content-Length,
400+400+201-byte overflow (each far below the single-response limit), Unicode byte
versus character count, exactly one serialization per response and no dataset
serialization, per-run reset, readiness exclusion, unchanged Axios limits, safe
logs/outcomes, and actual measurement-triggered safety failure inside `request()`
without retry/reclassification. Array-iterator spies show accepted pages' records
are retained but the overflow page's records are not. Three real-PostgreSQL cases
in `test/integration/sync-resources.sync-007.test.ts` prove initial/incremental
failure retains null/prior durable checkpoint with zero persistence/completion,
and exact-boundary success/reset on a reused client using the newly stored token.
No 128 MiB or 20 MB test fixture is allocated.

Patch files: `src/lib/{sync-limits,account,sync-run}.ts`, the two new sync-resources
test files, `FIX_PLAN.md` and this document. The late-claim correction below and
its regression tests remain intact; SYNC-005/009 are not begun.

Resource-patch validation: **246 unit tests / 23 files**, **102 integration tests /
16 files** passed. The 19 resource unit cases and three new PostgreSQL cases pass,
as do all 17 unit/five PostgreSQL late-claim cases, SYNC-001/004/006/007 timeout,
retry/cancellation/race, SEC-007 logging and caller/send/OAuth regressions. Validated
migration deployment reported no pending migrations; the full integration suite
used the same verified authorised disposable local PostgreSQL URL. Typecheck,
explicit changed/new patch-file ESLint, all-worktree changed/new-file ESLint, full
lint and offline-safe `npm run build` passed (pre-existing warnings/deprecation
only). Synthetic configuration/local fonts/network denial recorded **zero network
attempts**. `git diff --check` passed. No schema/migration change, `db push`, live
provider, remote DB or historical credential. SYNC-007 resource patch is DONE;
SYNC-005/009 remain unimplemented.

## Close-out correction: late claim confirmation

`claimSyncExecution()` generates the full `SyncExecution` (Account ID, user ID,
original credential, generation and a UUID runId) **before submitting** any claim
transaction. It also captures the original checkpoint in a scalar snapshot. The
conditional claim is unchanged:

```text
WHERE id = accountId AND userId = userId AND accessToken = originalAccessToken
  AND syncGeneration = generation AND activeSyncRunId IS NULL
  AND latestDeltaToken = originalCheckpointSnapshot
SET activeSyncRunId = R1
```

The claim path now has **one** JS observation, owned by `claimSyncExecution()`:

```text
executeSync -> await claimSyncExecution
  -> retain original submitSyncDatabase transaction Promise + R1 identity
  -> observeDatabase(originalPromise, dbObservationMs)
```

`submitSyncDatabase()` is the existing native bounded transaction body, extracted
without changing pool/transaction/statement/lock limits. It does not hide settlement
behind another observer. `withSyncDatabase()` still wraps this body with observation
for every other helper; their behaviour is unchanged. `executeSync()` no longer
wraps the claim in an outer observer. Thus neither the former inner-observation
failure mode nor a redundant outer claim observer remains.

* Definite count=1 within observation: R1 acquired; normal run control applies.
* Definite count=0: not-acquired; no R1 cleanup.
* Observation expiry or uncertain original rejection: the run returns
  `{ status: "indeterminate-completion", reason: "completion-indeterminate" }`.
  This existing safe category also represents acquisition uncertainty; it does not
  assert that completion was submitted. Earlier local cancellation/deadline is not
  promoted into proven durable termination of an unconfirmed claim.
* The original Promise remains reachable. Before propagating an unknown claim
  result, the helper attaches a settlement handler to **that original transaction**,
  not to an already-rejected observed/claim Promise. Fulfilled Promises retain their
  definitive result, so settlement racing handler installation is not lost.
* Only a definitive original count=1 triggers one immediate bounded
  `terminateSyncExecution(R1)` attempt. No blind early cleanup is issued: that could
  update zero rows before the delayed claim commits. Late zero/rejection never
  triggers cleanup or reactivates the ended run.
* Cleanup uses the exact original account/user/credential/generation/runId predicate.
  New-generation G2/R2 and same-generation/different-run R2 cannot be cleared. No
  checkpoint is changed. Zero, rejection or cleanup observation expiry logs only
  `Late sync claim cleanup not confirmed.`; the returned result stays indeterminate,
  never completed, with no claim that the owner was cleared.

The caller's observation/run-return bound is unchanged. This post-return handler
may execute later if the original acknowledgement arrives; its cleanup has the
existing native DB bounds and 8-second observation. That is not an extension of the
run, a watcher, retry scheduler or recovery worker. Process/host lifetime ending,
permanent loss of the original result, or unconfirmed cleanup can still strand an
owner. **SYNC-005 owns those durable recovery/reconciliation cases.**

Regression evidence: the first PostgreSQL test was added and run **before production
changes**. A gate held the original `db.$transaction()` acknowledgement only after
real PostgreSQL COMMIT. The former inner observer permanently rejected, the run
returned indeterminate, R1 remained persisted, and R2 returned not-acquired; release
of the successful acknowledgement failed the expected cleanup assertion (zero calls).
The fixed tests retain that same raw transaction gate, not a delayed return from
`claimSyncExecution()` after its DB helper succeeded. Both initial/incremental runs
now show zero provider/persistence/completion calls, R2 blocked before release,
actual exact-R1 cleanup count=1 after release, owner=null, then successful R2 claim.
Separate native UPDATE observations show cleanup count=0 with G2/R2 and with a
same-generation R2 established after a definite conditional R1 revocation. A lost
post-commit transaction result deliberately remains indeterminate with R1 still
blocking R2, documenting the permanent-uncertainty limitation rather than masking it.

`test/unit/claim-confirmation.sync-007.test.ts` has 17 fake-clock cases: original
Promise/single observer and native bounds, pre-submission identity/checkpoint
snapshots, initial/incremental late zero/one, expiry-versus-settlement microtask race,
definite zero, cancellation/deadline with unknown claim, timely confirmed claim
following cancellation, early/late uncertain rejection, and zero/rejected/expired
late cleanup. Outcomes/logs omit run IDs, credentials, checkpoint tokens and raw DB
errors. `test/integration/claim-confirmation.sync-007.test.ts` has five deterministic
real-PostgreSQL cases described above. Other limits, cumulative-memory behaviour,
sending, fencing and completion-versus-termination arbitration are untouched.

Patch files: `src/lib/sync-{execution,database,run}.ts`,
`test/mocks/sync-database.ts`, `test/unit/sync-execution.sync-004.test.ts`, the two
new claim-confirmation test files, `FIX_PLAN.md` and this document. Existing
uncommitted SYNC-007 work was preserved. Patch validation is recorded below and in
FIX_PLAN; no SYNC-005/009 implementation is included.

## Exact local state machine

```
active -> completed
active -> termination-pending -> completed
active -> termination-pending -> terminated
active -> termination-pending -> indeterminate-completion
```

All three final states are immutable. Cancellation, deadline, safety limits and
known ownership loss first set `termination-pending`, abort the run signal, stop
ordinary new provider/retry/poll/page/persistence work and begin bounded durable
arbitration. A deadline/cancel request is **not** a declaration of durable victory.
If acquisition is still being observed, its finite observation settles before
claim authority can be attached/revoked; uncertain acquisition is indeterminate.

Immediately before final completion, a bounded ownership check and synchronous
active/deadline check precede submission, with no intervening yield. After
`termination-pending`, **no new completion may be submitted**, even if the email
transaction that was already in flight commits successfully. Only a completion
already submitted while active may race termination.

### Durable linearization

`terminateSyncExecution` conditionally clears the owner using the same Account
ID, user ID, original credential, generation and UUID run identity as completion.
It does not touch the checkpoint or newer ownership. Completion atomically writes
the checkpoint and releases that same execution identity.

* Revocation acknowledges count=1 first: authority is gone, late completion is
  rejected by its predicate, and the requested non-success becomes final.
* R1's own completion receives a definite successful commit acknowledgement:
  completed wins; a subsequent timeout/revocation cannot undo the checkpoint.
* Completion acknowledgement is missing/expired and revocation cannot prove
  prior victory: `indeterminate-completion`. Completion is never blindly retried.
* Revocation acknowledges zero: do not infer a cause. Without submitted
  completion, a bounded authority reread can establish loss of authority; if it
  cannot, return indeterminate. With submitted completion, its own definite
  acknowledgement is required for completed; generic failure/expired observation
  is indeterminate (a definite zero-row completion instead establishes lost authority).
* Revocation observation fails/expires: only a definite successful R1 completion
  acknowledgement can establish completed; otherwise return indeterminate.

There is **no checkpoint-equality comparison for provenance**, and no
`completedByRunId` schema addition. The tests include an R2 writing the same token
before R1's lost acknowledgement is resolved. Matching visible state still does
not establish R1's completion.

`observeDatabase` attaches settlement handlers and expires observation only. It
never cancels SQL, asserts rollback, or schedules a retry. Late conditional updates
remain bound to their original identity. Indeterminate outcomes do not claim that
the checkpoint stayed unchanged. A definitely acknowledged revocation can prove
prior victory even if a previously submitted completion's observation was uncertain.

## Structured server-only result contract

| `status` | Typed `reason` |
| --- | --- |
| completed | No reason; incremental internal result retains `emails`, `latestDeltaToken` |
| retryable-failure | provider-timeout / run-deadline / provider-transient |
| action-required | provider-auth / provider-rejected / reinitialization-required |
| cancelled | cancelled |
| ownership-lost | ownership-lost |
| safety-limit | readiness-limit / page-limit / record-limit / response-bytes-limit |
| not-acquired | not-acquired |
| account-not-found | account-not-found |
| internal-failure | provider-contract / persistence-failure / internal-failure |
| indeterminate-completion | completion-indeterminate |

Non-success results contain **only status and reason**, never exceptions, provider
bodies, credentials, delta/page tokens or mail. Initial service success is only
`{ status: "completed" }`; it does not forward the dataset/checkpoint. The trusted
incremental success data stays server-side. Neither browser/API caller returns or
logs that successful token. Failure orchestration never parses error messages.

`getThreads` still starts background sync (removing that trigger is SYNC-005), but
now consumes resolved structured results explicitly and logs only the category.
Safe background failure does not fail the thread query. OAuth background initial
sync similarly consumes the category. Both retain generic unexpected-rejection
handlers; no unhandled rejection or assumed all-purpose `sync-failed` string.
Prisma automatic raw query/error logging is disabled because it could bypass the
sanitized sync error boundary; operation-level logs remain generic.

## Retry and cancellation details

Retry uses structured fields only:

* HTTP 408, 429 and 500–599: transient/retryable.
* `ECONNABORTED`, `ETIMEDOUT`, or the local per-attempt timeout: provider-timeout.
* `ECONNRESET`, `EAI_AGAIN`, `ENETUNREACH`, `ECONNREFUSED`, `ENOTFOUND`,
  `ERR_NETWORK`, `EHOSTUNREACH`, `EPIPE`: transient/retryable.
* 401/403: safe action-required provider-auth category, without asserting the
  precise cause of every 403 or implementing reconnect UX.
* Other 4xx: action-required provider-rejected. Unknown/unstructured provider
  errors and invalid provider contracts are not automatically retried.
* Reinitialization, authority loss, cancellation, safety bounds and persistence
  failure are not retried. Exhausting transient attempts remains retryable-failure.
* Persistence and completion have no automatic retry. `sendEmail()` has **no sync
  retry, signal, request-timeout or response-limit policy** added.

Every sync POST/GET gets an explicit Axios timeout and per-attempt AbortSignal
linked to the run controller. Abort-aware delays clear their timeout on abort.
Provider settlement handlers consume late responses/rejections without restarting
orchestration; aborting observation is not a claim that remote work was undone.

Bounded authority predicates run before/after provider requests, waits and attempts,
and before/after persistence units and final completion. Production relink advances
generation; the next meaningful boundary detects invalid authority, aborts the
controller, and starts no more avoidable work. There is no continuous watcher.
An already-in-flight provider request may settle before this observation.

Page N with a continuation at the configured maximum fails immediately, without
N+1. Record overflow fails on that response before appending/requesting more.
Repeated cursors remain rejected. No truncated dataset is persisted as success.
Null incremental checkpoint maps to action-required/reinitialization-required before
claim/provider work. S0 and terminal delta runtime validation remain mandatory.

An already-started email K may commit under its finite DB bounds; cancellation does
not promise its rollback. The next boundary prevents K+1 and new completion. Prior
per-email commits remain part of the documented idempotent retry model.

## Evidence and validation

* `test/unit/sync-run.sync-007.test.ts`: deterministic fake-clock retry matrix,
  exact 10/20ms injected backoff, 3-attempt exhaustion, initial/incremental request
  timeouts/abort, readiness success/limit/retry/cancel/loss/deadline, whole-run versus
  request timeout, explicit cancel, late provider, exact/over page and record bounds,
  accumulated overflow, malformed contracts, DB observation and bounds, sanitized
  results/logs, immutable final state, no persistence/completion retry, send no-retry.
* `test/unit/database-logging.sync-007.test.ts`: actual Prisma construction config
  disables automatic raw query/error output.
* SEC-003 and SEC-005 unit caller matrices: five resolved non-success categories
  each plus unexpected rejection; thread reads/redirects remain usable, safe logs.
  Completed incremental mail/checkpoint data is also explicitly proved absent from
  the thread-query response and logs.
* `test/integration/sync-run.sync-007.test.ts`: **16 real PostgreSQL cases** covering
  both initial/incremental completion-vs-termination directions, lost ack with/without
  later same-token run, pending versus final revocation, production relink during
  page/readiness/retry work (AbortSignal and zero avoidable writes/completion),
  cancellation/deadline during email K (K commits, K+1/completion do not start),
  completion/revocation/required-reread observation expiry and late fenced effects.
  Native PostgreSQL lock timeout is additionally exercised at an injected 25ms;
  JS timing tests use fake clocks, not real multi-second sleeps.
* Legacy SYNC-001/002/003/004/006/008, SEC-005/007, OAuth least-privilege and router
  tests migrate to the new outcomes without dropping durable ordering/fencing,
  S0/terminal validation, partial-persistence or security assertions. Legacy direct
  token-replacement ordering now observes loss **before** completion submission;
  direct stale conditional updates remain covered separately by SYNC-004.

Original SYNC-007 validation: **210 unit tests / 21 files**, **94 integration tests / 14 files**
passed, including **55** targeted run-control unit cases, one Prisma logging case,
13 additional caller-contract cases and **16** new PostgreSQL cases. Typecheck,
explicit changed/new-file ESLint, full lint and offline-safe `npm run build` passed
(existing warnings/deprecation only). `git diff --check` passed. Synthetic build
configuration/local font mocks/network denial recorded **zero network attempts**.
The validated migration initializer reported no pending migrations and integration
used the same verified target URL. Full close-out is also recorded in FIX_PLAN.
No live provider,
remote DB, historical credential or `db push` is used. Integration targets only the
verified `mindmail-test-pg` PostgreSQL 16 container at
`127.0.0.1:55432/mindmail_test`, after validated migration deployment.

Late-claim correction validation: **227 unit tests / 22 files**, **99 integration
tests / 15 files** passed, including all 17 new unit and five new PostgreSQL claim
cases plus SYNC-004/006/007, caller/security and send-no-retry regressions. The
validated migration initializer reported no pending migrations, followed by the
integration suite with the same verified disposable local target. Typecheck,
explicit patch-file ESLint (no warnings/errors), all-worktree changed/new-file
ESLint, full lint and offline-safe `npm run build` passed; only pre-existing source
warnings/deprecation remain. The synthetic/local-font/network-denied build recorded
**zero network attempts**. `git diff --check` passed. No schema/migration, `db push`,
remote DB, historical credential or live provider call. The in-process late-claim
confirmation defect is closed; permanent uncertainty/lifetime-loss recovery remains
SYNC-005. SYNC-007 is DONE; SYNC-005/009 remain unimplemented.

## Changed-file inventory

Production: `src/lib/{account,initial-sync,sync-execution,sync-to-db,sync-run,sync-limits,sync-database}.ts`,
`src/server/db.ts`, `src/server/api/routers/account.ts`,
`src/app/api/aurinko/callback/route.ts`.

Test support: `test/helpers/transactions.ts`, `test/mocks/sync-database.ts`.
The legacy transaction interception now distinguishes bounded authority transactions
from mail transactions; checkpoint fault injection wraps the completion boundary.
New SYNC-007 race tests wrap the **real bounded production helpers** and assert
actual durable PostgreSQL checkpoint/owner state, not merely local flags.

Unit: `account-router.sec-003`, `account.sync-001`, `account.sync-002`,
`account.sync-006`, `aurinko-callback.sec-002`, `aurinko-callback.sec-005`,
`initial-sync.sync-003`, `logging.sec-007`, `sync-execution.sync-004`,
`sync-run.sync-007`, `database-logging.sync-007` (`test/unit/*.test.ts`).

Integration: `account-router.sec-003`, `account.sync-002`,
`aurinko-callback.sec-005`, `initial-sync-order.sync-003`,
`initial-sync-retry.sync-003`, `initial-sync.sec-002`,
`relink-checkpoint.sync-006`, `sync-execution.sync-004`, `sync-to-db.sync-008`,
`sync-run.sync-007` (`test/integration/*.test.ts`).

Plan/docs: `FIX_PLAN.md`, this document.

## Remaining responsibilities

SYNC-005: durable triggering/scheduling, restart recovery, stale-owner recovery,
cross-run retry state/budgets, due-work consumption, and indeterminate-run
reconciliation. Failed/uncertain cleanup or process exit can still strand ownership;
this run controller does not reclaim it or schedule another run.

SYNC-009: recovery-history completeness beyond the unchanged initial-sync window.
No claim of arbitrary-downtime completeness is made. Its conditional INT-003/public
release gate remains unchanged. Live integration remains INT-002 and blocked.

**Stop after SYNC-007. The next safe implementation task is SYNC-005.**
