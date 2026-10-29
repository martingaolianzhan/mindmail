# SYNC-005 — durable Account orchestration

## Status / deployment acceptance blocker

**Durable core and approved Cloudflare wake-up adapter implemented; SYNC-005 is
NOT DONE. Actual scheduled deployment and function-duration verification remain
pending.** See [external wake-up close-out](#external-wake-up-close-out--deployment-checklist).

`CURRENT.md` was absent. The initial worktree was clean. Inspection covered
`AGENTS.md`, all of `FIX_PLAN.md`, [SYNC-007](SYNC-007.md), current execution,
provider, persistence, callback, router/hook, Prisma, migrations and test setup,
and existing SYNC-004/006/007 regression tests before implementation.

The original core inspection found Next.js build/start/preview scripts,
`@vercel/functions`/`waitUntil`, but no configured scheduler or deployed-runtime
proof. The owner has now approved Cloudflare Cron + a tiny Worker as the wake-up
clock, with MindMail deployed separately (currently expected on Vercel). Source
and authenticated HTTP integration are present; no Cloudflare/Vercel account or
API action was performed. Real Cron delivery, restart discovery without
UI/manual/incidental traffic, and sufficient deployed duration are still unverified.
Target cadence is one minute. The original plan row remains open.

## Architecture / ownership boundaries

```text
Account durable schedule
  -> Cloudflare Cron / Worker (manual deployment verification pending)
  -> x-vercel-protection-bypass -> Vercel protected Preview
  -> POST /api/cron/sync (independent MindMail Bearer auth)
  -> consumeDueSyncWork / discoverSyncWork
  -> consumeSyncCandidate
  -> existing executeSync / claimSyncExecution (one conditional UPDATE)
  -> bounded SYNC-007 run with existing SYNC-004 fenced persistence/completion
  -> version-qualified outcome, or durable-state reconciliation
  -> next durable opportunity / blocked
```

OAuth `waitUntil(orchestrateAccountSync({accountId,userId}))` is a fast path only.
It discovers the persisted opportunity and uses exactly the same candidate
consumer/claim as the future scheduled consumer. It cannot force a future retry
due, unblock an Account, or bypass the current generation, version or checkpoint.
`consumeDueSyncWork()` takes at most **one Account per invocation**. Recovery is
also one candidate action; scheduling replacement does not immediately execute it.
Overlapping invocations require no global mutex. Discovery does zero provider work.
The conditional mutation, not the discovery snapshot, grants authority.

Existing SYNC-007 single-run APIs remain useful bounded execution primitives.
Their claims are now schedule-qualified too, including callers without an explicit
orchestration context. They do not independently invent a new opportunity after
release. Application triggers use the durable orchestrator. Legacy execution-only
regressions explicitly create later test opportunities with `scheduleTestRun`;
this helper is test-only, not an application backoff override.

SYNC-004 generation + UUID execution owner remains the authoritative child-write,
checkpoint and completion boundary. SYNC-006 null checkpoint means fresh initial
sync. SYNC-007 still owns timeout, in-run retry, resource bounds and durable
completion/termination arbitration. DB observation expiry never establishes that
SQL failed, rolled back, or did not later commit. None of those mechanisms is
reimplemented by the scheduler.

## Schema and reviewed migration

`20261024000000_sync_scheduling` adds the following to Account:

| Field | Responsibility |
| --- | --- |
| `syncScheduleState SyncScheduleState` | scheduled / running / retry_wait / reconciling / blocked |
| `syncNextRunAt DateTime?` | earliest eligibility; null when running or blocked |
| `syncRetryCount Int @default(0)` | one shared automatic replacement/recovery episode |
| `syncLastOutcomeStatus String?` | safe structured last result |
| `syncLastOutcomeReason String?` | safe structured reason (including recovery/adoption categories) |
| `syncScheduleVersion Int @default(0)` | monotonically increasing current orchestration identity |
| `activeSyncLeaseExpiresAt DateTime?` | explicit stale-owner recovery deadline |

Indexes cover `(syncScheduleState,syncNextRunAt)` and lease expiry. New rows
outside the authorised link flow default blocked/null-next-run, not implicitly due.
The production new-link flow explicitly creates scheduled-now work at version 1.
There is no job/history/dead-letter table.

### Existing-row adoption policy (review before any future non-test deployment)

The reviewed migration retains credentials, Account identity and all existing
mail/children. It increments every existing Account’s generation, clears old owner
and checkpoint, and adopts it **blocked**, retryCount=0, version=0, nextRunAt=null,
with `action-required / adoption-relink-required`. This fences old executions and
does not silently assume historical checkpoint/credential continuity. Existing
Accounts require successful relink before automatic work. This intentionally
prefers explicit remediation over automatic unsafe continuation. No live adoption
or relink was performed. A synthetic isolated-schema PostgreSQL regression executes
the actual migration SQL and verifies fencing, null checkpoint, blocked adoption
and retained Thread data. Baseline migration is unchanged.

## Identities / exact claim boundary

* `syncGeneration`: credential/relink epoch (including repeated token text).
* `activeSyncRunId`: current SYNC-004 execution UUID.
* `latestDeltaToken`: trusted terminal provider checkpoint only.
* `syncScheduleVersion`: **current scheduling opportunity/orchestration version**,
  distinct from execution generation; incremented at claim and every authoritative
  outcome/recovery/relink scheduling mutation. No wrap/reset is implemented;
  database integer overflow fails closed rather than reusing an identity.

A due snapshot carries Account/user/credential, expected generation/version/state
and checkpoint. Claim prechecks generation/state and then submits one conditional
UPDATE in the existing bounded transaction:

```text
WHERE id = account AND userId = owner AND accessToken = loaded credential
  AND syncGeneration = expected generation
  AND syncScheduleVersion = discovered version V
  AND syncScheduleState = discovered scheduled/retry_wait state
  AND syncNextRunAt <= claim application time
  AND activeSyncRunId IS NULL
  AND latestDeltaToken = discovered checkpoint (including NULL)
SET activeSyncRunId = new UUID R,
    syncScheduleState = running, syncNextRunAt = NULL,
    activeSyncLeaseExpiresAt = claim application time + 300s,
    syncScheduleVersion = V + 1
```

Eligibility time is freshly sampled inside transaction submission, not discovery
time. Native SQL/lock bounds remain unchanged. Successful count=1 acknowledges
owner/running/lease/version **together**. Zero means no acquisition and no provider
work. Competing/stale candidates cannot run after the first owner releases,
even with an unchanged checkpoint. State and due-time predicates independently
protect blocked/backoff work, not just the version or discovery query.

After **definite** acquisition, trusted `executeSync` invokes an internal acquired
callback with `ScheduledExecution` (original credential/generation/run + V+1).
The orchestrator retains it in a local closure. The public SYNC-007 safe outcome
union is unchanged; no run ID, scheduling version, credential, checkpoint or page
token is added. Even successful mail/checkpoint data is stripped to completed at
the orchestration boundary.

Normal post-run writes require exact Account/user/original credential/generation,
**execution’s orchestration version V+1**, state=running, owner=null and expected
retry count. They increment version again. Reinitialization additionally requires
a null current checkpoint. A delayed R1 result cannot overwrite R2 or recovery
within the same generation, and G1 cannot overwrite G2. Checkpoint equality is
never completion provenance.

## Unconfirmed acquisition / indeterminate reconciliation

The existing SYNC-007 retained original transaction Promise and **one** claim
observer remain in use. Unknown acknowledgement never invokes the acquired
callback and never authorises a normal outcome write. No attempted UUID is passed
to reconciliation. A local timeout proves neither claim success nor failure.
Only definite late original count=1 permits SYNC-007’s one exact-UUID cleanup;
late zero/rejection cannot launch provider work or reactivate the ended run.

Indeterminate results first reread durable Account/user/current generation state:

1. Current owner + valid lease: do nothing, charge nothing, start no competitor.
2. Expired owner: exact snapshot/version-qualified stale reclaim (below).
3. Running/reconciling + null owner: incomplete orchestration, not proof of success
   or failure; one conditional replacement/recovery transition.
4. Unconfirmed claim with original due V still current and owner=null: conditional
   supersession of that opportunity, advancing version and scheduling bounded
   replacement. If this wins first, the original pending V claim must update zero.
5. A newer operation already advanced state: no mutation. A candidate may reconcile
   its own V, or its immediately consumed running V+1 only; anything newer belongs
   to another operation. Mutations also recheck the entire observed snapshot.

`not-acquired` only rereads current durable state: it never charges the loser’s
retry/recovery budget, even if the winner has just released and not handled its
outcome yet. A later recovery tick may separately consume that incomplete incident.
Ownership-lost/account-not-found cannot create future scheduling state.

A committed uncertain claim with valid lease is left running. Late exact cleanup
clears owner/lease but leaves running/version intact; a subsequent recovery tick
schedules replacement. If acknowledgement is permanently lost, the expired lease
provides recovery. If recovery/R2 advances first, late exact old cleanup updates
zero and cannot alter the newer version/owner/schedule. No checkpoint comparison
is used to guess which run completed.

## Shared retry/recovery episode and policy

`syncRetryCount` is **the number of automatic cross-run replacement opportunities
already scheduled/consumed in the current episode**, not in-run provider attempts.
Initial/periodic work starts at zero. Every real replacement run gets a fresh UUID;
no old SyncRun object, in-memory timer or intermediate page token is resumed.

Replacement causes share the same counter:

* retryable SYNC-007 provider-timeout/provider-transient/run-deadline;
* generic cancelled/cancelled interruption (no permanent user-cancel feature);
* exact expired-owner recovery;
* running/reconciling null-owner incomplete-orchestration recovery;
* indeterminate original-opportunity/null-owner replacement;
* current-generation null-checkpoint reinitialization replacement, if needed.

| Prior count | New count | Earliest replacement |
| --- | --- | --- |
| 0 | 1 | +1 minute |
| 1 | 2 | +5 minutes |
| 2 | 3 | +15 minutes |
| 3 | 4 | +60 minutes |
| 4 | 4 | blocked; nextRunAt=null; **no replacement #5** |

These are named/testable **application defaults**, not provider requirements.
Switching failure mode does not reset this episode. A successful current run or
new credential generation resets it to zero. Passing time never unblocks blocked
work; currently only successful linking/relinking is an approved new-work event.
No notifications, final UX, manual retry button or silent auto-unblock was added.

### Exactly one charge per recovery incident

Recovery UPDATE matches Account/user/credential/generation, **observed version**,
state, retryCount, exact owner/null, exact lease, checkpoint and nextRunAt snapshot.
Expired-owner recovery additionally requires the same lease still <= recovery time.
It clears that exact owner/lease, preserves checkpoint, increments version, and
atomically applies one replacement increment/delay or blocked exhaustion. A second
consumer of the same incident updates zero, even if both observed retryCount=2.
The result is count=3, never 4. Old authoritative child writes/completion remain
fenced by the existing Account lock and old UUID predicate after revocation.
Blocked work is never revived by recovery.

### Lease and discovery

Lease = **5 minutes**, no heartbeat or renewal. SYNC-007’s conservative responsive
control/DB/arbitration envelope is about 144 seconds; 300 seconds provides margin.
Lease is liveness metadata, not write authority. A delayed old process is still
fenced by SYNC-004. Completion, termination and legacy release clear lease under
the same exact execution-owner boundary; an old runner cannot clear a newer lease.

Discovery priority is expired owner, then running/reconciling null-owner work,
then due scheduled/retry_wait work. It never infers staleness from updatedAt,
process identity, UI activity or checkpoint provenance. `running + owner=null` is
a valid crash window after execution release and before outcome persistence.
Recovery consumes the same bounded episode; repeated incomplete runs eventually
block rather than resetting the counter or stranding forever.

## Outcome mapping

| Structured result | Durable policy |
| --- | --- |
| completed | count=0, scheduled at completion observation +5m, completed/null reason, new version |
| retryable-failure | shared replacement delay/count, then blocked |
| cancelled | same bounded shared recovery |
| safety-limit | blocked/null-next; deterministic oversized work is not retried automatically |
| action-required/provider-auth or provider-rejected | blocked/null-next |
| internal-failure (contract/persistence/internal) | blocked/null-next; no crash loop |
| ownership-lost | no authoritative future schedule from old work |
| account-not-found | no work; never recreate Account |
| not-acquired | durable reread only; no charge/new immediate schedule |
| indeterminate-completion | durable reread/reconciliation, never blind normal result write |
| action-required/reinitialization-required | reread/current-generation null-checkpoint bounded replacement, not permanent auth blocking |

Initial versus incremental is selected from the current loaded Account checkpoint:
null -> fresh initial; non-null -> incremental. Claim rechecks its discovered safe
checkpoint snapshot, so a stale selection cannot proceed. A legitimate replacement
uses whatever checkpoint SYNC-007 safely left durable, without guessing the old
run’s completion provenance.

## Relink, reads and safe status

Both same-owner credential replacement branches atomically write credential,
generation increment, owner=null, checkpoint=null, lease=null, scheduled-now,
retryCount=0, scheduleVersion increment, and clear old outcome. The new Account
create writes the equivalent initial state (generation=0, version=1). Existing
ownership checks, uniqueness-race ownership recheck and OAuth scopes are unchanged.
The callback may die immediately after this commit without losing durable work.

`getThreads` has **no sync/provider side effect**, once or repeatedly. The existing
five-second React Query refetch is local DB refresh only. `getSyncStatus` is an
authenticated Account/user-scoped SELECT exposing exactly state, retry count,
nextRunAt, last safe status/reason. It selects no credentials, checkpoint, mail,
run UUID, lease or orchestration version. DB failures get a generic tRPC error,
not a raw exception. The cron route below only wakes server-selected due work;
there is no arbitrary-account public sync API, UI redesign or secret-bearing log.

## Evidence and validation

New unit tests cover named policy values, success/reset, all blocking result
families, cancellation, reinitialization, all four shared delays, exhaustion,
non-authoritative outcomes and bounded priority discovery. Router tests prove
repeated reads call sync zero times and status DB errors are redacted.

New real-PostgreSQL tests cover:

* Atomic V -> owner/running/lease/V+1 -> success/+5m/V+2.
* Stale discovery after completion, retry backoff and blocked state, **with the
  same checkpoint**, zero losing provider calls and preserved newer schedule.
* State/time revalidation even with unchanged generation/version/checkpoint.
* Same-generation delayed completed and retryable R1 outcomes after R2: zero rows.
* G1 delayed completed/retryable writes after G2: zero rows.
* Concurrent consumers: exactly one provider run and one successful opportunity.
* Persisted D20 retry, new consumer after simulated restart, real mail persistence,
  D22 convergence/reset, no immediate duplicate and no duplicate logical mail.
* Two null-owner consumers: exactly one count 2 -> 3/version increment, both null
  (future initial) and non-null (future incremental) checkpoints.
* Separate genuine claim/release interruptions: counts 1/2/3/4, then blocked;
  no fifth replacement after restart or passage of time.
* Exact expired owners at count 0 and 4: retry/block once, checkpoint preserved;
  old completion/persistence/outcome fenced; valid leases untouched.
* Indeterminate null-owner dual reconciliation at count 2 and 4, one charge only.
* Recovery invalidates delayed old outcomes before replacement runs.
* Unconfirmed committed claim: indeterminate result, durable reread, owner/lease
  untouched, zero competitor/provider work. Exact late cleanup then one recovery
  converges through a new bounded run.
* Recovery/R2 first: late old claim acknowledgement cleanup updates zero and
  preserves newer same-generation version/schedule. Stale reconciliation no-ops.
* Opposite ordering: reconciliation supersedes V before the original UPDATE;
  original claim count=0 and never resurrects or launches provider work.
* Production new-link/relink/create-race commit with lost fast path: new consumer
  discovers initial work and mocked initial sync establishes G2 checkpoint.
* Safe status projection and cross-user rejection; actual migration adoption SQL.

The uncertain-claim tests share `test/helpers/claim-acknowledgement.ts` with the
existing SYNC-007 regression. This is the original native-transaction gate and
single production observer/late cleanup, not a second claim model.

Core-only validation before the wake-up patch: **284 unit tests / 26 files** and
**133 integration tests / 19 files**
pass. The targeted SYNC-005 set is 36 new unit tests (plus 16 router regressions)
and 31 new PostgreSQL cases. SYNC-001/002/003/004/006/007/008, SEC-005/007,
OAuth/relink, late-claim cleanup, completion/termination arbitration, resource
limits and send-no-retry regressions all pass. Typecheck, explicit changed/new-file
ESLint, full lint, offline-safe build and git diff --check pass (existing warnings
only). The reviewed additive migration applies through the guarded initializer;
schema diff reports no difference. Exact command evidence is also appended to
FIX_PLAN.
Validation uses only network-denied mocks/synthetic fixtures and the verified
`mindmail-test-pg` PostgreSQL 16 container bound to 127.0.0.1:55432/mindmail_test,
user mindmail_test. The guarded initializer runs migrate deploy, schema diff is
clean, and integration uses the same URL. No db push, baseline rewrite, remote DB
or historical credential use. Offline build uses synthetic configuration, local
font responses, environment-file shielding and network-denial preload outside the
repository; zero network attempts are recorded. Existing lint warnings remain.

## Changed-file inventory

Production/schema: `prisma/schema.prisma`,
`prisma/migrations/20261024000000_sync_scheduling/migration.sql`,
`src/lib/{sync-orchestration,sync-schedule-policy,sync-execution,sync-run,account}.ts`,
`src/app/api/aurinko/callback/route.ts`, `src/server/api/routers/account.ts`,
`src/hooks/use-threads.ts`.

New tests/support: `test/helpers/{scheduling,claim-acknowledgement}.ts`,
`test/unit/{sync-schedule,sync-discovery,sync-orchestration}.sync-005.test.ts`,
`test/integration/{sync-schedule,sync-relink,sync-migration}.sync-005.test.ts`.

Updated regressions: `test/helpers/transactions.ts`; unit
`account-router.sec-003`, `account.sync-002/006`, `aurinko-callback.sec-002/005`,
`claim-confirmation.sync-007`, `initial-sync.sync-003`, `logging.sec-007`,
`sync-execution.sync-004`, `sync-resources.sync-007`, `sync-run.sync-007`;
integration `account-router.sec-003`, `account.sync-002`,
`aurinko-callback.sec-005`, `claim-confirmation.sync-007`,
`initial-sync-order.sync-003`, `initial-sync-retry.sync-003`, `initial-sync.sec-002`,
`relink-checkpoint.sync-006`, `sync-execution.sync-004`,
`sync-resources.sync-007`, `sync-run.sync-007`, `sync-to-db.sync-008`.
They retain their correctness assertions, with explicit test scheduling, added
lease clearing, and callback mocks now targeting the durable entry point.
Documentation: this file and appended `FIX_PLAN.md` evidence; original plan row
is not rewritten or marked DONE.

## Unchanged scope / limitations

No Redis/queue/history table, cluster, leader election, global scheduler lock,
heartbeat, extra provider scope, in-memory durable timer, or notification subsystem.
SYNC-007’s resource limits, retries, timeouts, persistence/checkpoint semantics and
completion/termination arbitration remain unchanged. Sending still has no retry.
No batching/streaming persistence was implemented. No page token is durable.
`daysWithin: 2` is unchanged; scheduling initial work does **not** establish
arbitrary-downtime historical completeness. SYNC-009 was not started. No live
Aurinko, Clerk, Gmail, Gemini, remote PostgreSQL or removed infrastructure was
contacted. Stop after SYNC-005; actual external wake-up and deployed-duration
verification remain the acceptance blockers.

## External wake-up close-out / deployment checklist

```text
Cloudflare Cron (* * * * *)
  -> tiny Worker
  -> HTTPS POST with x-vercel-protection-bypass
  -> Vercel Deployment Protection / protected Preview
  -> Authorization: Bearer <SYNC_CRON_SECRET>
  -> /api/cron/sync
  -> existing consumeDueSyncWork()
  -> PostgreSQL scheduling state
```

Cloudflare is only a wake-up clock. MindMail remains separately deployed; the
Worker holds no Account/mailbox/retry/lease/checkpoint/schedule-version state and
needs no database, Clerk, Aurinko or Account credentials. The route does not
accept Account/user/generation authority from query, body, headers or path; it
passes no arguments to the existing bounded consumer. Batch size remains one;
no drain loop, mutex, queue, retry policy or core scheduling change was added.
An authorized no-due invocation returns `200 {"ok":true}`. Blocked and future-due
work remains untouched. Duplicate/overlapping wakes rely on the existing atomic
schedule-qualified claim; missed ticks leave durable work due for a later tick.

`src/middleware.ts` bypasses Clerk only when `request.nextUrl.pathname` equals
`/api/cron/sync`. `/api/cron/example`, `/api/cron/sync/extra` and trailing-slash
extensions remain Clerk-protected. Bypassing Clerk is **not authorization**: the
handler compares the full Bearer credential with the configured secret using
constant-time equality for equal-length buffers. Missing/wrong caller credentials
return 401; missing/empty/whitespace-containing server configuration returns 503.
Success returns only `{"ok":true}`; scheduler exceptions return a generic
`500 {"ok":false}` and one generic log, never the exception, credentials or
internal scheduling state. Only POST is exported.

The route explicitly selects Node.js and `maxDuration = 300`. Current Next.js
supports this App Router configuration: the offline build emits
`.next/server/functions-config-manifest.json` with `/api/cron/sync.maxDuration=300`.
This repository evidence is **not proof** that the deployed Vercel project/plan/runtime accepts it. Deployment must verify the intended 300-second allowance,
which exceeds the unchanged ~144s conservative responsive SYNC-007 envelope.
An allowance is not proof that a real provider-backed ~144s sync completed remotely;
that live-provider verification is not required for SYNC-005 close-out.
If sufficient deployed duration cannot be verified, leave SYNC-005 open; do not
shorten SYNC-007 or select replacement infrastructure.

Worker source: `infra/cloudflare/mindmail-sync-wakeup/worker.js` (plain module JS;
no Wrangler dependency, CI/CD or GitHub connection required). It reads:

* `MINDMAIL_SYNC_URL`: normal Worker variable/non-secret configuration; the exact
  protected Preview deployment HTTPS URL, pathname exactly `/api/cron/sync`.
* `MINDMAIL_CRON_SECRET`: Cloudflare Worker secret, configured later by the user,
  matching MindMail/Vercel `SYNC_CRON_SECRET` for application authorization.
* `VERCEL_AUTOMATION_BYPASS_SECRET`: separate required Cloudflare Worker secret,
  configured later by the user from Vercel Protection Bypass for Automation.
  The Worker sends it in the exact `x-vercel-protection-bypass` header.

This patch defines bindings and request behavior only: it does not generate or
configure real credentials, deploy MindMail or update a Cloudflare resource.
Vercel bypass passes the infrastructure deployment-protection layer; it is **not
scoped by MindMail to the cron route**. It may permit bypass for deployment URLs
within the Vercel project's configured scope. Treat it as a sensitive infrastructure
credential, never expose it to browser/client code, and never reuse its value for
MindMail cron authentication. Passing that layer does not authorize scheduler work:
`/api/cron/sync` still independently validates only its existing Bearer credential.

MindMail application code does not read, validate, authorize with or depend on
`VERCEL_AUTOMATION_BYPASS_SECRET`; do not add an application-managed configuration
requirement for it. Vercel may independently expose one configured automation
bypass secret inside deployments as the same-named **system environment variable**.
Its possible presence does not make it a MindMail dependency; application code
must not rely on that platform-provided variable.

Before constructing/sending either credential header, the Worker parses the URL and requires
exact `https:` and exact pathname. Invalid URL, plaintext/non-HTTPS, wrong path,
`/api/cron/sync/extra`, URL userinfo/query/fragment, or empty/whitespace-containing
MindMail or bypass secret fails before fetch. Bypass secrets also reject ASCII
control characters and DEL. Neither credential is transmitted on validation
failure. It never rewrites/appends a path. Configure the intended
MindMail hostname carefully: HTTPS/path validation is not a hostname allowlist.
It sends one POST with `redirect: "manual"`. Only 2xx succeeds; redirects and all
other status codes fail. Network rejections are caught and **replaced**, with no
`cause`, by `Error("MindMail sync wake-up failed.")`. Every failure class uses that
same generic error, containing no URL, either secret/header value, response body
or raw network text. It does not read/log response bodies or retry requests.

The owner will later configure two distinct credentials: a fresh high-entropy
MindMail cron secret shared between MindMail and the Worker, and a dedicated
Vercel-generated automation bypass secret stored separately in the Worker.
No real secret is generated, configured or committed here. Do not put real values in
Git, Worker source, command history, screenshots or logs. `.env.example` contains
only an empty server-side placeholder; runtime route configuration fails closed
without it. Worker source in Git does not configure the already-created Worker
or its Cron Trigger.

### Manual post-Pi acceptance checklist (not performed)

Use an approved environment. This checklist is not permission to reconnect removed
infrastructure or use historical credentials. Existing migration adoption is
unchanged: pre-SYNC-005 Accounts advance generation, invalidate owner/checkpoint,
become blocked and require relink. **Separately review this adoption policy before
applying it to any supported environment with real existing linked users.**

1. After separate authorization, create a new empty non-production PostgreSQL
   database and apply the committed migrations **before application traffic**.
   Do not reuse historical infrastructure/credentials or the local test database.
2. Create/prepare the intended Vercel project without an unprotected public product
   deployment; configure **Preview Deployment Protection before exposure**.
3. Configure the minimum Preview build/cron environment: `DATABASE_URL`, required
   Clerk configuration (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`),
   and server-only `SYNC_CRON_SECRET`. Keep real provider credentials unset unless
   separately authorized. The exact cron exception skips Clerk protect, not the
   surrounding SDK's configuration requirements; no active Clerk user is required.
4. Configure Vercel Protection Bypass for Automation for the intended project and
   obtain a dedicated Vercel-generated bypass secret. This is a future user action.
5. Deploy the **protected Preview** with those settings. If Vercel configuration
   changes afterward, create a new deployment before testing changed settings;
   environment changes do not update an existing deployment.
6. Record the **exact Preview deployment URL and commit** being accepted. Verify
   the deployed route/runtime provides the intended `maxDuration = 300` allowance.
   Do not confuse allowance verification with observed real-provider run completion.
7. Deploy/update the Cloudflare Worker source.
8. Set Worker `MINDMAIL_SYNC_URL` to that specific Preview deployment's HTTPS
   `/api/cron/sync` URL, with no query, fragment or userinfo.
9. Set Cloudflare secret `MINDMAIL_CRON_SECRET` equal to MindMail/Vercel
   `SYNC_CRON_SECRET`.
10. Set Cloudflare secret `VERCEL_AUTOMATION_BYPASS_SECRET` to the dedicated
    Vercel-generated automation bypass value, **different from the cron secret**.
11. Confirm credentials remain undisplayed/unlogged and are never committed.
12. **Outer boundary A:** request the exact protected Preview cron URL **without**
    `x-vercel-protection-bypass` (even if using a valid MindMail Bearer). Verify
    Vercel blocks it before MindMail route authorization. Record actual Vercel
    protection behavior; do not assume an application-level HTTP status.
13. **Inner boundary B:** send valid `x-vercel-protection-bypass` but omit/use invalid
    MindMail Authorization. Verify Vercel passes the request to `/api/cron/sync`,
    where MindMail returns its existing **401**. Vercel bypass is not scheduler auth.
14. **Both-valid boundary C:** use the exact Preview URL, valid Vercel bypass and
    valid MindMail Bearer. Verify the route invokes the durable scheduler, reaches
    the fresh PostgreSQL database and returns safe **2xx/no-op** for empty/no-due
    work. No Clerk user session should be involved.
15. Manually test the Worker's scheduled-handler request using platform test
    facilities, not merely visiting workers.dev (no fetch handler exists).
    Confirm only MindMail 2xx succeeds; redirect/non-2xx/network errors fail.
16. Verify invalid/non-HTTPS/wrong-path Worker targets and missing/invalid bypass
    configuration fail before either secret is sent; restore valid configuration.
17. Configure Cloudflare Cron Trigger `* * * * *` (approximately once per minute).
18. Observe and record at least one **genuine scheduled** successful wake-up without
    an active Clerk session, UI reads, manual requests or incidental app traffic.
    Confirm the existing scheduler reached PostgreSQL and safely no-op'd.
19. Assemble compositional evidence: existing disposable-local-PostgreSQL durable
    semantics tests + deployed automatic protected-Preview/DB no-op + verified
    300-second platform allowance. An empty/no-due 2xx does **not directly prove**
    that a real provider-backed ~144-second sync completed remotely.
20. Only after actual evidence exists, obtain the final Review Gate decision and,
    if accepted, close SYNC-005. Remote real-provider mailbox sync is **not required**
    for that closure; future live-provider unattended sync belongs to INT-002 under
    its separate authorization, dependencies and BLOCKED status.

If redeployment changes the Preview URL, update `MINDMAIL_SYNC_URL` and repeat
relevant protection, authentication and connectivity checks against the **new exact
URL**. Evidence from an earlier Preview does not automatically accept a later one.
None of states A/B/C, a Vercel deployment, Cloudflare configuration, actual Cron
invocation or deployed duration support has been verified/performed by this patch.
SYNC-005 remains TODO until deployed evidence is collected and reviewed.

### Wake-up patch automated evidence

Tests execute the actual middleware callback and Clerk route matcher with a mocked
unauthenticated Clerk boundary, then dispatch to the actual cron handler. Exact
cron requests reach route-level 401; sibling/prefix extensions call Clerk protect
and cannot reach scheduler work. Route tests cover credentials, missing server
configuration, no-argument dispatch, ignored caller authority, safe response/logs
and duration configuration. Isolated Worker tests mock fetch only and verify URL
validation before fetch, 2xx, redirects/non-2xx, network sanitization, no cause and
non-leak assertions. Thin real-PostgreSQL route-to-core tests verify no-due success,
blocked/future-due no-ops, two authorized consumers of the same opportunity with
one provider call, and batch size one. Existing core and migration files are
untouched by this close-out patch. Results: **20 route/middleware unit tests,
27 Worker unit tests, 5 PostgreSQL bridge tests passed**. Full suites: **331 unit
/ 28 files; 138 integration / 20 files passed**, including SYNC-005, getThreads
zero-sync and SEC-007 regressions. The verified disposable local PostgreSQL
initializer reports no pending migrations. Typecheck, explicit patch-file ESLint,
full lint, offline-safe build (zero network attempts), and git diff --check pass;
only pre-existing full-lint warnings remain. See appended FIX_PLAN evidence.
Deployed Cron/duration verification remains pending.

Wake-up patch files: `src/app/api/cron/sync/route.ts`, `src/middleware.ts`,
`infra/cloudflare/mindmail-sync-wakeup/worker.js`, `.env.example`, `README.md`,
`test/unit/{cron-route,cron-worker}.sync-005.test.ts`,
`test/integration/cron-route.sync-005.test.ts`, this document and `FIX_PLAN.md`.
No core, schema, migration, policy, dependency or deployment-account changes.

Protected-Preview header follow-up validation: **35 Worker cases and 20 unchanged
cron/middleware cases passed (55 targeted); all 339 unit tests / 28 files passed**.
Typecheck, explicit changed-source/test ESLint, full lint (existing warnings only),
offline-safe build (synthetic configuration/local fonts/network denial; zero
network attempts) and git diff --check pass. Only Worker source/tests and these
SYNC-005/FIX_PLAN notes changed; application auth, middleware and core are untouched.
No redundant PostgreSQL tests were added/run for this Worker-only header patch;
no database action occurred. Deployed outcomes, Cloudflare configuration and
Vercel duration support remain unverified.
