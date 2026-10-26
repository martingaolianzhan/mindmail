import type { Account, Prisma } from "@prisma/client";
import type { EmailMessage, SyncUpdatedEmailsReponse } from "~/type";
import { claimSyncExecution, completeSyncExecution, ownsSyncExecution, terminateSyncExecution, StaleSyncExecutionError, SyncNotAcquiredError, type SyncExecution } from "./sync-execution";
import { observeDatabase, SyncDatabaseObservationError, withSyncDatabase } from "./sync-database";
import { syncLimits, type SyncLimits } from "./sync-limits";
import { syncEmailsToDatabase } from "./sync-to-db";

export type SyncFailure =
  | { status: "retryable-failure"; reason: "provider-timeout" | "run-deadline" | "provider-transient" }
  | { status: "action-required"; reason: "provider-auth" | "provider-rejected" | "reinitialization-required" }
  | { status: "cancelled"; reason: "cancelled" }
  | { status: "ownership-lost"; reason: "ownership-lost" }
  | { status: "safety-limit"; reason: "readiness-limit" | "page-limit" | "record-limit" | "response-bytes-limit" }
  | { status: "not-acquired"; reason: "not-acquired" }
  | { status: "account-not-found"; reason: "account-not-found" }
  | { status: "internal-failure"; reason: "provider-contract" | "persistence-failure" | "internal-failure" }
  | { status: "indeterminate-completion"; reason: "completion-indeterminate" };
export type SyncDataset = { emails: EmailMessage[]; latestDeltaToken: string };
export type SyncOutcome = SyncFailure | ({ status: "completed" } & SyncDataset);
export type SyncRunOptions = { signal?: AbortSignal; limits?: Partial<SyncLimits> };
export type SyncRunState = "active" | "termination-pending" | "completed" | "terminated" | "indeterminate-completion";
const indeterminate = (): SyncFailure => ({ status: "indeterminate-completion", reason: "completion-indeterminate" });
const ownershipLost = (): SyncFailure => ({ status: "ownership-lost", reason: "ownership-lost" });

export class SyncRunFailure extends Error {
  constructor(readonly outcome: SyncFailure) { super("Sync run stopped."); }
}
export function contractFailure(): never {
  throw new SyncRunFailure({ status: "internal-failure", reason: "provider-contract" });
}

// Classify only structured fields. Never inspect error.message or preserve raw
// provider/DB errors in an outcome. Unknown failures are deliberately not retried.
export function classifySyncProviderError(error: unknown): SyncFailure {
  const e = error as { code?: unknown; response?: { status?: unknown } } | null;
  const status = e?.response?.status;
  if (status === 401 || status === 403) return { status: "action-required", reason: "provider-auth" };
  if (typeof status === "number") {
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return { status: "retryable-failure", reason: "provider-transient" };
    if (status >= 400 && status <= 499) return { status: "action-required", reason: "provider-rejected" };
  }
  if (e?.code === "ECONNABORTED" || e?.code === "ETIMEDOUT") return { status: "retryable-failure", reason: "provider-timeout" };
  if (["ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED", "ENOTFOUND", "ERR_NETWORK", "EHOSTUNREACH", "EPIPE"].includes(String(e?.code))) return { status: "retryable-failure", reason: "provider-transient" };
  return { status: "internal-failure", reason: "provider-contract" };
}

// Unlike DB observation, aborting this wait does not assert what happened at the
// remote provider. Late settlements are consumed and cannot restart orchestration.
function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stopped = () => reject(new SyncRunFailure({ status: "cancelled", reason: "cancelled" }));
    signal.addEventListener("abort", stopped, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", stopped)).catch(() => undefined);
    if (signal.aborted) stopped();
  });
}

export class SyncRun {
  readonly limits: SyncLimits;
  readonly controller = new AbortController();
  private currentState: SyncRunState = "active";
  private requested?: SyncFailure;
  private execution?: SyncExecution;
  private arbitration?: Promise<void>;
  private completion?: Promise<void>;
  private dataset?: SyncDataset;
  private mailboxPayloadBytes = 0;
  private deadline: ReturnType<typeof setTimeout>;
  private readonly expiresAt: number;
  private readonly externalSignal?: AbortSignal;
  private readonly onCancel = () => this.stop({ status: "cancelled", reason: "cancelled" });
  private resolveFinal!: (outcome: SyncOutcome) => void;
  readonly result = new Promise<SyncOutcome>((resolve) => { this.resolveFinal = resolve; });

  constructor(options: SyncRunOptions = {}) {
    this.limits = syncLimits(options.limits);
    this.externalSignal = options.signal;
    this.expiresAt = Date.now() + this.limits.deadlineMs;
    this.deadline = setTimeout(() => this.stop({ status: "retryable-failure", reason: "run-deadline" }), this.limits.deadlineMs);
    options.signal?.addEventListener("abort", this.onCancel, { once: true });
    if (options.signal?.aborted) this.onCancel();
  }
  get state() { return this.currentState; }
  get signal() { return this.controller.signal; }
  assertActive() {
    if (this.currentState === "active" && Date.now() >= this.expiresAt) this.stop({ status: "retryable-failure", reason: "run-deadline" });
    if (this.currentState !== "active") throw new SyncRunFailure(this.requested ?? ownershipLost());
  }
  attach(execution: SyncExecution) {
    this.execution = execution;
    if (this.currentState === "termination-pending") this.beginArbitration();
  }
  private finish(outcome: SyncOutcome) {
    if (["completed", "terminated", "indeterminate-completion"].includes(this.currentState)) return;
    this.currentState = outcome.status === "completed" ? "completed" : outcome.status === "indeterminate-completion" ? "indeterminate-completion" : "terminated";
    clearTimeout(this.deadline);
    this.externalSignal?.removeEventListener("abort", this.onCancel);
    this.resolveFinal(outcome);
  }
  stop(outcome: SyncFailure) {
    if (this.currentState !== "active") return;
    this.currentState = "termination-pending";
    this.requested = outcome;
    this.controller.abort();
    if (this.execution) this.beginArbitration();
  }
  private beginArbitration() {
    this.arbitration ??= this.arbitrate();
  }
  private async arbitrate() {
    const execution = this.execution!;
    try {
      const won = await observeDatabase(terminateSyncExecution(execution, this.limits), this.limits.dbObservationMs);
      if (won) { this.finish(this.requested!); return; }
      if (this.completion) {
        try {
          await this.completion;
          // Only this operation's definite acknowledgement is provenance.
          this.finish({ status: "completed", ...this.dataset! });
        } catch (error) {
          this.finish(error instanceof StaleSyncExecutionError ? ownershipLost() : indeterminate());
        }
      } else {
        // Zero alone has no explanation. A bounded authority observation can
        // establish supersession, but NEVER establishes completion by token equality.
        const owns = await observeDatabase(ownsSyncExecution(execution, this.limits), this.limits.dbObservationMs);
        this.finish(owns ? indeterminate() : ownershipLost());
      }
    } catch {
      // A timed-out/rejected revocation is not proof that it stopped or won.
      if (this.completion) {
        try { await this.completion; this.finish({ status: "completed", ...this.dataset! }); }
        catch { this.finish(indeterminate()); }
      } else this.finish(indeterminate());
    }
  }
  async boundary() {
    this.assertActive();
    if (this.execution) {
      let owns: boolean;
      try { owns = await observeDatabase(ownsSyncExecution(this.execution, this.limits), this.limits.dbObservationMs); }
      catch { throw new SyncDatabaseObservationError(); }
      if (!owns) this.stop(ownershipLost());
    }
    this.assertActive();
  }
  async wait(milliseconds: number) {
    await this.boundary();
    let timer!: ReturnType<typeof setTimeout>;
    try { await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); }), this.signal); }
    finally { clearTimeout(timer); }
    await this.boundary();
  }
  // Call once per parsed /sync/updated response, before retaining its records.
  // Readiness POSTs are excluded. Serialize only this response, never the dataset.
  // This cumulative UTF-8 payload proxy is not an exact Node/V8 heap ceiling.
  acceptMailboxResponse(response: SyncUpdatedEmailsReponse) {
    this.assertActive();
    const candidate = this.mailboxPayloadBytes + Buffer.byteLength(JSON.stringify(response), "utf8");
    if (candidate > this.limits.maxMailboxPayloadBytes) {
      throw new SyncRunFailure({ status: "safety-limit", reason: "response-bytes-limit" });
    }
    this.mailboxPayloadBytes = candidate;
  }
  async request<T>(operation: (signal: AbortSignal, timeout: number) => PromiseLike<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.limits.maxAttempts; attempt++) {
      await this.boundary();
      const attemptController = new AbortController();
      const abort = () => attemptController.abort();
      this.signal.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; attemptController.abort(); }, this.limits.requestTimeoutMs);
      let failure: SyncFailure;
      try {
        this.assertActive();
        const response = await abortable(operation(attemptController.signal, this.limits.requestTimeoutMs), attemptController.signal);
        clearTimeout(timer); // HTTP duration excludes the subsequent DB observation.
        await this.boundary();
        return response;
      } catch (error) {
        clearTimeout(timer);
        // Authority observation failures and intentional application safety bounds
        // must not enter the provider retry classifier. Attempt-timeout cancellation
        // still follows the timeout path below, rather than this safety-only guard.
        if (error instanceof SyncDatabaseObservationError || (error instanceof SyncRunFailure && error.outcome.status === "safety-limit")) throw error;
        await this.boundary(); // Includes ownership checks after failed provider work.
        failure = timedOut ? { status: "retryable-failure", reason: "provider-timeout" } : classifySyncProviderError(error);
      } finally {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
      }
      if (failure.status !== "retryable-failure" || attempt === this.limits.maxAttempts) throw new SyncRunFailure(failure);
      await this.wait(this.limits.backoffMs * attempt);
    }
    throw new Error("Unreachable sync attempt.");
  }
  async complete(dataset: SyncDataset) {
    await this.boundary();
    // No await/yield between this active check and submission. Only an already
    // submitted operation may race a later termination request.
    this.assertActive();
    this.dataset = dataset;
    this.completion = observeDatabase(completeSyncExecution(this.execution!, dataset.latestDeltaToken, this.limits), this.limits.dbObservationMs);
    try {
      await this.completion;
      this.finish({ status: "completed", ...dataset });
    } catch (error) {
      if (error instanceof StaleSyncExecutionError) this.stop(ownershipLost());
      else this.stop({ status: "internal-failure", reason: "persistence-failure" });
    }
  }
  fail(error: unknown, persistence = false) {
    if (error instanceof SyncDatabaseObservationError) {
      // Observation expired: neither rollback nor non-commit has been proven.
      this.stop(indeterminate());
    } else if (error instanceof SyncNotAcquiredError) this.stop({ status: "not-acquired", reason: "not-acquired" });
    else if (error instanceof StaleSyncExecutionError) this.stop(ownershipLost());
    else if (error instanceof SyncRunFailure) this.stop(error.outcome);
    else this.stop({ status: "internal-failure", reason: persistence ? "persistence-failure" : "internal-failure" });
    // Uncertain acquisition cannot become definite cancellation/deadline victory
    // merely because a local termination request preceded its observation expiry.
    if (!this.execution) this.finish(error instanceof SyncDatabaseObservationError ? indeterminate() : this.requested!);
  }
}

// Shared orchestration for initial/incremental runs. No later-run scheduling.
export function executeSync(
  load: (tx: Prisma.TransactionClient) => Promise<Account | null>,
  fetch: (account: Account, run: SyncRun) => Promise<SyncDataset>,
  options: SyncRunOptions = {},
  incremental = false,
): Promise<SyncOutcome> {
  const run = new SyncRun(options);
  void (async () => {
    let persistence = false;
    let acquiring = true;
    try {
      run.assertActive();
      const account = await withSyncDatabase(load, run.limits);
      run.assertActive();
      if (!account) throw new SyncRunFailure({ status: "account-not-found", reason: "account-not-found" });
      if (incremental && account.latestDeltaToken == null) throw new SyncRunFailure({ status: "action-required", reason: "reinitialization-required" });
      // The claim helper owns ONE observation and retains its original DB
      // settlement for exact-run cleanup. An outer observer would orphan it.
      const execution = await claimSyncExecution(account, run.limits);
      run.attach(execution);
      acquiring = false;
      await run.boundary();
      const dataset = await fetch(account, run);
      await run.boundary();
      persistence = true;
      // Each email has its own bounded transaction/observation. Do not impose
      // one per-operation DB timeout on the entire sequential mailbox batch.
      await syncEmailsToDatabase(dataset.emails, execution, run);
      await run.boundary();
      await run.complete(dataset);
    } catch (error) {
      run.fail(acquiring && !(error instanceof SyncRunFailure) && !(error instanceof SyncNotAcquiredError) ? new SyncDatabaseObservationError() : error, persistence);
    }
  })();
  return run.result;
}
