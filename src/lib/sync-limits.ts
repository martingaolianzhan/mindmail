// Application safety limits, not Aurinko service limits. No persistent retry state.
export const SYNC_LIMITS = {
  requestTimeoutMs: 15_000,
  deadlineMs: 120_000,
  readinessIntervalMs: 1_000,
  maxReadinessPolls: 30, // Includes the first POST (each POST has its own attempt budget).
  maxAttempts: 3,
  backoffMs: 250, // Linear: 250ms, 500ms; no jitter.
  maxPages: 50,
  maxRecords: 10_000,
  maxResponseBytes: 20_000_000, // Single-response Axios limit; intentionally decimal bytes.
  maxMailboxPayloadBytes: 128 * 1024 * 1024, // Per-run serialized UTF-8 GET payload proxy, not heap size.
  dbMaxWaitMs: 2_000,
  dbTransactionMs: 5_000,
  dbStatementMs: 4_000,
  dbLockMs: 2_000,
  dbObservationMs: 8_000, // Observation is NOT cancellation or proof of rollback.
} as const;
export type SyncLimits = { [K in keyof typeof SYNC_LIMITS]: number };
export function syncLimits(overrides: Partial<SyncLimits> = {}): SyncLimits {
  const limits = { ...SYNC_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid sync safety limit.");
  }
  return limits;
}
