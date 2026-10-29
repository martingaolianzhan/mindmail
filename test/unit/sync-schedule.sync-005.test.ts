import { describe, expect, it } from "vitest";
import { newGenerationSchedule, outcomeSchedule, replacementSchedule, SYNC_SCHEDULE, type SafeSyncOutcome } from "~/lib/sync-schedule-policy";

const now = new Date("2026-10-24T00:00:00Z");
const retry = { status: "retryable-failure", reason: "provider-transient" } as const;

describe("SYNC-005 shared cross-run policy", () => {
  it("names the initial application cadence, batch, success interval and lease", () => {
    expect(SYNC_SCHEDULE).toEqual({ targetCadenceMs: 60_000, successIntervalMs: 300_000, retryDelaysMs: [60_000, 300_000, 900_000, 3_600_000], maxReplacements: 4, staleOwnerLeaseMs: 300_000, batchSize: 1 });
  });
  it.each([0, 1, 2, 3])("replacement opportunity after count %s uses the single shared sequence", (count) => {
    const expected = { syncScheduleState: "retry_wait", syncRetryCount: count + 1, syncNextRunAt: new Date(now.getTime() + SYNC_SCHEDULE.retryDelaysMs[count]!) };
    expect(outcomeSchedule(retry, count, now)).toEqual(expected);
    expect(outcomeSchedule({ status: "cancelled", reason: "cancelled" }, count, now)).toEqual(expected);
    expect(replacementSchedule(count, now)).toEqual(expected);
  });
  it("never creates automatic replacement five", () => {
    expect(outcomeSchedule(retry, 4, now)).toEqual({ syncScheduleState: "blocked", syncNextRunAt: null });
    expect(replacementSchedule(4, now)).toEqual({ syncScheduleState: "blocked", syncNextRunAt: null });
  });
  it.each([0, 1, 2, 3, 4])("success resets the entire recovery episode (count %s)", (count) => {
    expect(outcomeSchedule({ status: "completed" }, count, now)).toEqual({ syncRetryCount: 0, syncScheduleState: "scheduled", syncNextRunAt: new Date(now.getTime() + 300_000) });
  });
  it.each<SafeSyncOutcome>([
    { status: "action-required", reason: "provider-auth" }, { status: "action-required", reason: "provider-rejected" },
    { status: "safety-limit", reason: "readiness-limit" }, { status: "safety-limit", reason: "page-limit" },
    { status: "safety-limit", reason: "record-limit" }, { status: "safety-limit", reason: "response-bytes-limit" },
    { status: "internal-failure", reason: "provider-contract" }, { status: "internal-failure", reason: "persistence-failure" }, { status: "internal-failure", reason: "internal-failure" },
  ])("$status/$reason blocks without automatic retries", (outcome) => {
    expect(outcomeSchedule(outcome, 2, now)).toEqual({ syncScheduleState: "blocked", syncNextRunAt: null });
  });
  it.each<SafeSyncOutcome>([
    { status: "ownership-lost", reason: "ownership-lost" }, { status: "account-not-found", reason: "account-not-found" },
    { status: "not-acquired", reason: "not-acquired" }, { status: "indeterminate-completion", reason: "completion-indeterminate" },
  ])("$status gives no authority for a normal scheduling outcome", (outcome) => {
    expect(outcomeSchedule(outcome, 2, now)).toBeNull();
  });
  it("reinitialization uses the same bounded replacement episode, not permanent blocking", () => {
    expect(outcomeSchedule({ status: "action-required", reason: "reinitialization-required" }, 2, now)).toEqual(replacementSchedule(2, now));
  });
  it("relink resets recovery, advances scheduling identity, clears lease/outcome and is immediately due", () => {
    expect(newGenerationSchedule(now)).toEqual({ activeSyncLeaseExpiresAt: null, syncScheduleState: "scheduled", syncNextRunAt: now, syncRetryCount: 0, syncScheduleVersion: { increment: 1 }, syncLastOutcomeStatus: null, syncLastOutcomeReason: null });
  });
});
