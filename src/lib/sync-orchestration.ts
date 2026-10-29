import type { Account, Prisma } from "@prisma/client";
import { Account as ProviderAccount } from "./account";
import { withSyncDatabase } from "./sync-database";
import type { ScheduledExecution, SyncScheduleClaim } from "./sync-execution";
import { executeSync, type SyncRunOptions } from "./sync-run";
import { outcomeSchedule, replacementSchedule, SYNC_SCHEDULE, type SafeSyncOutcome } from "./sync-schedule-policy";

// All snapshots/identities in this module are server-only. Discovery is NOT a
// grant of authority. Mutations recheck the exact current durable work identity.
function snapshotPredicate(a: Account): Prisma.AccountWhereInput {
  return {
    id: a.id, userId: a.userId, accessToken: a.accessToken,
    syncGeneration: a.syncGeneration, syncScheduleVersion: a.syncScheduleVersion,
    syncScheduleState: a.syncScheduleState, syncRetryCount: a.syncRetryCount,
    activeSyncRunId: a.activeSyncRunId,
    activeSyncLeaseExpiresAt: a.activeSyncLeaseExpiresAt,
    latestDeltaToken: a.latestDeltaToken, syncNextRunAt: a.syncNextRunAt,
  };
}

export async function discoverSyncWork(now = new Date(), identity?: { accountId: string; userId: string }) {
  return withSyncDatabase(async (tx) => {
    const scope = identity ? { id: identity.accountId, userId: identity.userId } : {};
    const expired = await tx.account.findMany({ where: { ...scope, activeSyncRunId: { not: null }, activeSyncLeaseExpiresAt: { lte: now } }, orderBy: { activeSyncLeaseExpiresAt: "asc" }, take: SYNC_SCHEDULE.batchSize });
    if (expired.length) return expired;
    const incomplete = await tx.account.findMany({ where: { ...scope, syncScheduleState: { in: ["running", "reconciling"] }, activeSyncRunId: null }, orderBy: { id: "asc" }, take: SYNC_SCHEDULE.batchSize });
    if (incomplete.length) return incomplete;
    return tx.account.findMany({ where: { ...scope, syncScheduleState: { in: ["scheduled", "retry_wait"] }, activeSyncRunId: null, syncNextRunAt: { lte: now } }, orderBy: [{ syncNextRunAt: "asc" }, { id: "asc" }], take: SYNC_SCHEDULE.batchSize });
  });
}

// Exact observed incident is consumed once, even with simultaneous consumers.
// An uncertain transition is NOT retried locally; later ticks reread durable state.
export async function recoverSyncSnapshot(a: Account, now = new Date(), supersedeUnconfirmedDue = false) {
  if (a.syncScheduleState === "blocked") return 0;
  const owner = a.activeSyncRunId !== null;
  if (owner && (!a.activeSyncLeaseExpiresAt || a.activeSyncLeaseExpiresAt > now)) return 0;
  const incomplete = a.syncScheduleState === "running" || a.syncScheduleState === "reconciling";
  const due = (a.syncScheduleState === "scheduled" || a.syncScheduleState === "retry_wait") && a.syncNextRunAt !== null && a.syncNextRunAt <= now;
  if (!owner && !incomplete && !(supersedeUnconfirmedDue && due)) return 0;
  const result = await withSyncDatabase((tx) => tx.account.updateMany({
    where: {
      ...snapshotPredicate(a),
      ...(owner ? { activeSyncLeaseExpiresAt: { equals: a.activeSyncLeaseExpiresAt, lte: now } } : {}),
    },
    data: {
      ...replacementSchedule(a.syncRetryCount, now),
      activeSyncRunId: null, activeSyncLeaseExpiresAt: null,
      syncScheduleVersion: { increment: 1 },
      syncLastOutcomeStatus: "indeterminate-completion",
      syncLastOutcomeReason: owner ? "stale-owner" : "incomplete-orchestration",
    },
  }));
  return result.count;
}

function readCurrentSyncWork(candidate: Account) {
  return withSyncDatabase((tx) => tx.account.findFirst({ where: { id: candidate.id, userId: candidate.userId, syncGeneration: candidate.syncGeneration } }));
}

// No attempted runId is accepted here. Only durable state can settle uncertainty.
export async function reconcileSyncWork(candidate: Account, now = new Date(), unconfirmedClaim = false) {
  const current = await readCurrentSyncWork(candidate);
  if (!current) return 0;
  // V is the opportunity; V+1 can be its consumed running attempt. Anything
  // newer belongs to another orchestration operation and cannot be superseded.
  if (current.syncScheduleVersion !== candidate.syncScheduleVersion &&
      !(current.syncScheduleVersion === candidate.syncScheduleVersion + 1 && current.syncScheduleState === "running")) return 0;
  return recoverSyncSnapshot(current, now, unconfirmedClaim && current.syncScheduleVersion === candidate.syncScheduleVersion);
}

export async function applySyncOutcome(a: Account, execution: ScheduledExecution, outcome: SafeSyncOutcome, now = new Date()) {
  const policy = outcomeSchedule(outcome, a.syncRetryCount, now);
  if (!policy) return 0;
  // Reinitialization can only replace current-generation null-checkpoint work.
  const reinitialize = outcome.status === "action-required" && outcome.reason === "reinitialization-required";
  const result = await withSyncDatabase((tx) => tx.account.updateMany({
    where: {
      id: execution.accountId, userId: execution.userId,
      accessToken: execution.originalAccessToken, syncGeneration: execution.generation,
      syncScheduleVersion: execution.scheduleVersion,
      syncScheduleState: "running", activeSyncRunId: null,
      syncRetryCount: a.syncRetryCount,
      ...(reinitialize ? { latestDeltaToken: null } : {}),
    },
    data: {
      ...policy, syncScheduleVersion: { increment: 1 },
      activeSyncLeaseExpiresAt: null,
      syncLastOutcomeStatus: outcome.status,
      syncLastOutcomeReason: outcome.status === "completed" ? null : outcome.reason,
    },
  }));
  return result.count;
}

export async function consumeSyncCandidate(candidate: Account, options: SyncRunOptions = {}): Promise<SafeSyncOutcome | null> {
  if (candidate.activeSyncRunId !== null || candidate.syncScheduleState === "running" || candidate.syncScheduleState === "reconciling") {
    await recoverSyncSnapshot(candidate);
    return null;
  }
  if (candidate.syncScheduleState !== "scheduled" && candidate.syncScheduleState !== "retry_wait") return null;
  const claim: SyncScheduleClaim = {
    generation: candidate.syncGeneration, version: candidate.syncScheduleVersion,
    state: candidate.syncScheduleState, checkpoint: candidate.latestDeltaToken,
  };
  let acquired: ScheduledExecution | undefined;
  const outcome = await executeSync(
    (tx) => tx.account.findFirst({ where: { id: candidate.id, userId: candidate.userId } }),
    (a, run) => {
      const provider = new ProviderAccount(a.accessToken);
      return a.latestDeltaToken === null ? provider.performInitialSync(run) : provider.fetchIncrementalSync(a.latestDeltaToken, run);
    },
    options, false, { claim, acquired: (execution) => { acquired = execution; } },
  );
  // Even the successful dataset/checkpoint is stripped at this boundary.
  const safe: SafeSyncOutcome = outcome.status === "completed" ? { status: "completed" } : outcome;
  if (safe.status === "not-acquired") {
    // A losing consumer never charges recovery, even if it observes the winner's
    // release/outcome crash window. A subsequent recovery tick owns that incident.
    await readCurrentSyncWork(candidate);
  } else if (safe.status === "indeterminate-completion") {
    await reconcileSyncWork(candidate, new Date(), !acquired);
  } else if (safe.status === "action-required" && safe.reason === "reinitialization-required") {
    const current = await readCurrentSyncWork(candidate);
    if (current?.latestDeltaToken === null) {
      if (acquired) await applySyncOutcome(candidate, acquired, safe);
      else await reconcileSyncWork(candidate, new Date(), true);
    }
  } else if (acquired) {
    await applySyncOutcome(candidate, acquired, safe);
  }
  return safe;
}

// Shared OAuth fast path / future approved external wake-up entry. No HTTP route,
// arbitrary-account scheduler API, timer, global lock or deployment vendor added.
export async function orchestrateAccountSync(identity: { accountId: string; userId: string }): Promise<SafeSyncOutcome> {
  const candidates = await discoverSyncWork(new Date(), identity);
  const candidate = candidates[0];
  return candidate ? (await consumeSyncCandidate(candidate)) ?? { status: "not-acquired", reason: "not-acquired" } : { status: "not-acquired", reason: "not-acquired" };
}
export async function consumeDueSyncWork() {
  const candidates = await discoverSyncWork();
  for (const candidate of candidates) await consumeSyncCandidate(candidate);
}
