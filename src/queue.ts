/**
 * `OfflineQueue` — the public API and sweep orchestration
 * (Phase 7 / Issue #8, architecture §10, §6.5–6.7, §8.1 Case 3; ADR-0010
 * defaults; ADR-0011 cancel/remove).
 *
 * One sweep of `process()`:
 *
 * 1. **Janitor** — reclaim `READY` entries whose lease expired (ADR-0007).
 * 2. **Recovery sweep** — reconcile `SUBMITTING`/`CONFIRMING` entries from
 *    their journaled hashes (never rebuild, §8.1 Case 3); return
 *    `EXPIRED` entries with attempts remaining to `QUEUED` (rebuild).
 * 3. **Claim + process** — pick due entries FIFO (`createdAt`, then id),
 *    **at most one per account per sweep** (per-account single-writer,
 *    §6.7 layer 3: an account with an active entry — READY, SUBMITTING,
 *    CONFIRMING, or NEEDS_RETRY — is blocked until that entry resolves),
 *    then run the engine pipeline, parallel across accounts.
 *
 * Concurrency safety: repeated and concurrent `process()` calls are safe —
 * every ownership transfer is a store CAS; a loser is counted, never raced.
 * The timer in `start()` owns no hidden work: it only calls `process()`.
 *
 * Model contract: architecture §6.3–6.7, §8.1–8.3, §10; ADR-0007, ADR-0008,
 * ADR-0010, ADR-0011.
 */

import type { QueueStore, QueueEntry } from './store/types.js';
import type { IntentStatus } from './state.js';
import type { StellarAdapter } from './adapters/types.js';
import type { Signer } from './signer.js';
import type { CreateIntentInput } from './intent.js';
import { createIntent } from './intent.js';
import { BASE_FEE } from './builder.js';
import type { BuilderConfig } from './builder.js';
import {
  MAX_MAX_AGE_SECONDS,
  MIN_MAX_AGE_SECONDS,
  DEFAULT_MAX_AGE_SECONDS,
} from './intent.js';
import {
  AttemptsExhaustedError,
  EntryNotFoundError,
  InvalidCancelStateError,
  InvalidRetryStateError,
  OwnershipLostError,
  QueueConfigError,
} from './errors.js';
import { QueueEvents } from './events.js';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
} from './backoff.js';
import type { QueueEventType } from './events.js';
import type { ReconciliationResult } from './reconciliation.js';
import {
  confirmEntry,
  processEntry,
  reconcileSubmitting,
  type EngineDeps,
  type ProcessOutcome,
} from './engine.js';
import { createWorkerId, reclaimExpired } from './ownership.js';

// ---------------------------------------------------------------------------
// Defaults + internal constants (ADR-0010, frozen for 1.x)
// ---------------------------------------------------------------------------

/** Default attempt budget (ADR-0010 #2). */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Default claim lease (ADR-0010 #1). */
export const DEFAULT_LEASE_MS = 60_000;
/** Default `start()` polling interval (ADR-0010 #7). */
export const DEFAULT_INTERVAL_MS = 5_000;
/** Max in-flight entries reconciled per sweep (ADR-0010 #8; internal). */
export const RECONCILE_BATCH_LIMIT = 200;
/** Max due entries examined for claiming per sweep (ADR-0010 #8; internal). */
export const DUE_SCAN_PAGE_SIZE = 100;

/** States that block an account (per-account single-writer, §6.7 layer 3). */
const ACTIVE_STATES: readonly IntentStatus[] = [
  'READY',
  'SUBMITTING',
  'CONFIRMING',
  'NEEDS_RETRY',
] as const;

// ---------------------------------------------------------------------------
// Config + summary types (architecture §10, T7.4)
// ---------------------------------------------------------------------------

/** Constructor configuration for `OfflineQueue` (architecture §10). */
export type OfflineQueueConfig = {
  /** Durable queue store (MemoryStore for tests/dev, SqliteStore in prod). */
  store: QueueStore;

  /** Stellar network adapter (RPC or Horizon — concrete adapters Phase 12). */
  adapter: StellarAdapter;

  /** Application-owned signer (ADR-0002); the library never touches keys. */
  signer: Signer;

  /** Network passphrase, e.g. `Networks.TESTNET`. */
  networkPassphrase: string;

  /** Attempt budget per intent (build cycles); default 5 (ADR-0010 #2). */
  maxAttempts?: number;

  /**
   * Enqueue-time default for `timeBounds.maxAgeSeconds` when an intent input
   * omits it; default 300 (ADR-0010 #3).
   */
  timeBounds?: { maxAgeSeconds: number };

  /** Per-operation fee in stroops; default SDK `BASE_FEE` (ADR-0010 #9). */
  baseFee?: string;

  /** Backoff schedule knobs; defaults 1 000 / 60 000 ms (ADR-0010 #4/#5). */
  backoff?: { baseMs?: number; capMs?: number };

  /** Parallel accounts processed per sweep; default 1 (ADR-0010 #6). */
  concurrency?: number;

  /** Claim lease duration; default 60 000 ms (ADR-0010 #1). */
  leaseMs?: number;

  /** Stable worker id used for claim ownership; default `worker-<uuidv4>`. */
  workerId?: string;

  /**
   * Clock for all scheduling decisions (`nextAttemptAt`, leases, flush time).
   * Defaults to `Date.now`; inject a fixed/advanced clock for deterministic
   * tests (no real sleeps anywhere in the library).
   */
  now?: () => number;

  /**
   * Error sink for exceptions thrown by sweeps started by `start()`'s timer
   * (a timer callback cannot propagate to a caller). Direct `process()`
   * callers see throws normally; this hook only covers the polling loop.
   */
  onError?: (error: unknown) => void;
};

/** Result summary of one `process()` sweep (architecture §10). */
export type ProcessSummary = {
  /** Entries returned to QUEUED by the janitor (expired leases). */
  reclaimed: number;
  /** In-flight entries examined by the recovery sweep (verdict or poll). */
  reconciled: number;
  /** Entries this sweep claimed and ran through the pipeline. */
  claimed: number;
  /** Entries that reached `SUCCESS` during this sweep. */
  succeeded: number;
  /** Entries that reached `FAILED` during this sweep. */
  failed: number;
  /** Entries that reached `EXPIRED` during this sweep. */
  expired: number;
  /** Entries scheduled for identical-envelope retry (NEEDS_RETRY + backoff). */
  retried: number;
  /** Due entries not claimed this sweep (conflict, not due, or awaiting recovery). */
  skipped: number;
  /** Workers that lost ownership mid-pipeline and aborted without submitting. */
  aborted: number;
};

/** Internal fully-resolved configuration (defaults wired from ADR-0010). */
type ResolvedConfig = {
  maxAttempts: number;
  defaultMaxAgeSeconds: number;
  baseFee: string;
  backoffBaseMs: number;
  backoffCapMs: number;
  concurrency: number;
  leaseMs: number;
};

// ---------------------------------------------------------------------------
// Config validation (construction is the single validation point)
// ---------------------------------------------------------------------------

/** Validate one integer option; throws `QueueConfigError` on violation. */
function requireInt(
  value: number,
  field: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new QueueConfigError(field, `${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** Validate and resolve the optional parts of the config. */
function resolveConfig(config: OfflineQueueConfig): ResolvedConfig {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  requireInt(maxAttempts, 'maxAttempts', 1);

  const defaultMaxAgeSeconds =
    config.timeBounds?.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  requireInt(defaultMaxAgeSeconds, 'timeBounds.maxAgeSeconds', MIN_MAX_AGE_SECONDS, MAX_MAX_AGE_SECONDS);

  const baseFee = config.baseFee ?? BASE_FEE;
  if (typeof baseFee !== 'string' || !/^[0-9]+$/.test(baseFee)) {
    throw new QueueConfigError('baseFee', 'baseFee must be a non-negative integer string (stroops)');
  }

  const backoffBaseMs = config.backoff?.baseMs ?? BACKOFF_BASE_MS;
  const backoffCapMs = config.backoff?.capMs ?? BACKOFF_CAP_MS;
  requireInt(backoffBaseMs, 'backoff.baseMs', 1);
  requireInt(backoffCapMs, 'backoff.capMs', 1);
  if (backoffCapMs < backoffBaseMs) {
    throw new QueueConfigError('backoff.capMs', 'backoff.capMs must be >= backoff.baseMs');
  }

  const concurrency = config.concurrency ?? 1;
  requireInt(concurrency, 'concurrency', 1);

  const leaseMs = config.leaseMs ?? DEFAULT_LEASE_MS;
  requireInt(leaseMs, 'leaseMs', 1);

  return {
    maxAttempts,
    defaultMaxAgeSeconds,
    baseFee,
    backoffBaseMs,
    backoffCapMs,
    concurrency,
    leaseMs,
  };
}

// ---------------------------------------------------------------------------
// OfflineQueue
// ---------------------------------------------------------------------------

/**
 * The offline payment queue (architecture §10). The application drives
 * progress via `process()` (directly, or through the optional `start()`
 * polling loop); the library never spawns hidden background work.
 */
export class OfflineQueue {
  private readonly store: QueueStore;
  private readonly deps: EngineDeps;
  private readonly resolved: ResolvedConfig;
  private readonly workerId: string;
  private readonly nowFn: () => number;
  private readonly onError: ((error: unknown) => void) | undefined;

  /** Typed lifecycle events (`intent:transition`, `intent:settled`). */
  readonly events: QueueEvents = new QueueEvents();

  /** The `start()` polling timer, when running. */
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(config: OfflineQueueConfig) {
    if (config.store === undefined || config.store === null) {
      throw new QueueConfigError('store', 'store is required');
    }
    if (config.adapter === undefined || config.adapter === null) {
      throw new QueueConfigError('adapter', 'adapter is required');
    }
    if (config.signer === undefined || config.signer === null) {
      throw new QueueConfigError('signer', 'signer is required');
    }
    if (typeof config.networkPassphrase !== 'string' || config.networkPassphrase.length === 0) {
      throw new QueueConfigError('networkPassphrase', 'networkPassphrase must be a non-empty string');
    }

    this.resolved = resolveConfig(config);
    this.store = config.store;
    this.nowFn = config.now ?? Date.now;
    this.onError = config.onError;
    this.workerId = createWorkerId(config.workerId);

    const builderConfig: BuilderConfig = {
      networkPassphrase: config.networkPassphrase,
      baseFee: this.resolved.baseFee,
    };

    this.deps = {
      store: this.store,
      adapter: config.adapter,
      signer: config.signer,
      events: this.events,
      builderConfig,
      leaseMs: this.resolved.leaseMs,
      backoff: {
        baseMs: this.resolved.backoffBaseMs,
        capMs: this.resolved.backoffCapMs,
        random: Math.random,
      },
      retryJournal: new Map(),
    };

    // Route event-handler throws to the application sink as well.
    this.events.onError(config.onError);
  }

  // -------------------------------------------------------------------------
  // Intent management (§10)
  // -------------------------------------------------------------------------

  /**
   * Create + validate + persist an intent as `QUEUED` (transition
   * CREATED → QUEUED via add-intent, §6.3 row 1). Fully offline; invalid
   * input throws `ValidationError` and nothing is persisted (§4.1).
   * Duplicate id → returns the existing entry unchanged (idempotent).
   */
  async addIntent(input: CreateIntentInput): Promise<QueueEntry> {
    const intent = createIntent(
      {
        ...input,
        timeBounds: input.timeBounds ?? { maxAgeSeconds: this.resolved.defaultMaxAgeSeconds },
      },
      this.nowFn(),
    );
    const now = this.nowFn();
    const entry: QueueEntry = {
      intent,
      status: 'QUEUED',
      attemptCount: 0,
      maxAttempts: this.resolved.maxAttempts,
      nextAttemptAt: 0,
      backoffAttempts: 0,
      claimedBy: undefined,
      claimExpiresAt: 0,
      lastError: undefined,
      inFlightHashes: [],
      attempts: [],
      updatedAt: now,
      version: 1,
    };
    // Idempotent insert: a duplicate id returns the existing entry (§9.2),
    // in which case no transition happened and no event fires.
    const stored = await this.store.insert(entry);
    if (stored.version === entry.version && stored.updatedAt === now && stored.status === 'QUEUED') {
      this.emit('intent:transition', stored);
    }
    return stored;
  }

  /** Get one entry by intent id (or `undefined`). */
  async getIntent(id: string): Promise<QueueEntry | undefined> {
    return this.store.get(id);
  }

  /** List entries with optional filters (`status`, `account`, `limit`). */
  async list(opts?: { status?: IntentStatus; account?: string; limit?: number }): Promise<QueueEntry[]> {
    return this.store.list(opts);
  }

  // -------------------------------------------------------------------------
  // The sweep (§10 process(), §8.1 Case 3 recovery)
  // -------------------------------------------------------------------------

  /**
   * One processing sweep: (1) janitor, (2) recovery, (3) claim + process due
   * entries — per-account single-writer, parallel across accounts. Safe to
   * call concurrently and repeatedly; CAS protects every ownership transfer.
   */
  async process(): Promise<ProcessSummary> {
    const now = this.nowFn();
    const summary: ProcessSummary = {
      reclaimed: 0,
      reconciled: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      expired: 0,
      retried: 0,
      skipped: 0,
      aborted: 0,
    };

    // -- 1. Janitor: expired leases → QUEUED (ADR-0007 rule 4). ------------
    summary.reclaimed = await this.runJanitor(now);

    // -- 2. Recovery sweep (§8.1 Case 3). -----------------------------------
    await this.recover(now, summary);

    // -- 3. Claim + process due entries. ------------------------------------
    const due = (await this.store.listDue(['QUEUED', 'NEEDS_RETRY'], now)).slice(
      0,
      DUE_SCAN_PAGE_SIZE,
    );
    const batch = await this.selectBatch(due);

    await Promise.all(batch.map((candidate) => this.processOne(candidate, now, summary)));

    return summary;
  }

  /**
   * Janitor run + event emission. Returns the number of entries reclaimed
   * by this run.
   */
  private async runJanitor(now: number): Promise<number> {
    const reclaimedIds = await reclaimExpired(this.store, now);
    for (const id of reclaimedIds) {
      const entry = await this.store.get(id);
      if (entry !== undefined) this.emit('intent:transition', entry);
    }
    return reclaimedIds.length;
  }

  /**
   * Per-account single-writer batch selection (§6.7 layer 3): FIFO by
   * `createdAt` (listDue order), at most one entry per account per sweep,
   * and an account whose entry is already active (READY/SUBMITTING/
   * CONFIRMING/NEEDS_RETRY anywhere in the store) is blocked until it
   * resolves — this is what keeps two envelopes of one account from ever
   * being in flight at once.
   */
  private async selectBatch(due: QueueEntry[]): Promise<QueueEntry[]> {
    const blocked = new Map<string, Set<string>>();
    for (const active of await this.store.listByState([...ACTIVE_STATES])) {
      let ids = blocked.get(active.intent.sourceAccount);
      if (ids === undefined) {
        ids = new Set<string>();
        blocked.set(active.intent.sourceAccount, ids);
      }
      ids.add(active.intent.id);
    }

    const batch: QueueEntry[] = [];
    for (const entry of due) {
      if (batch.length >= this.resolved.concurrency) break;
      const account = entry.intent.sourceAccount;
      const activeIds = blocked.get(account);
      if (activeIds !== undefined) {
        // Only the candidate itself may count as "its account's" active
        // entry — a second due entry of the same account waits.
        const others = [...activeIds].filter((id) => id !== entry.intent.id);
        if (others.length > 0) continue;
      }
      batch.push(entry);
      if (activeIds === undefined) {
        blocked.set(account, new Set([entry.intent.id]));
      } else {
        activeIds.add(entry.intent.id);
      }
    }
    return batch;
  }

  /**
   * Recovery sweep, every `process()`/`reconcile()` (§8.1 Case 3):
   * - `SUBMITTING`: crash between write-ahead and submit → reconcile the
   *   journaled hash (never rebuild);
   * - `CONFIRMING`: poll for the verdict;
   * - `EXPIRED` with attempts remaining → `QUEUED` (rebuild; due now).
   * `NEEDS_RETRY` resumes through the normal claim path on schedule.
   */
  private async recover(now: number, summary: ProcessSummary): Promise<void> {
    const inFlight = await this.store.listByState(['SUBMITTING', 'CONFIRMING']);
    for (const entry of inFlight.slice(0, RECONCILE_BATCH_LIMIT)) {
      // A concurrent sweep may reconcile the same entry; the CAS verdict
      // transition of the loser fails with an ownership loss — count it and
      // move on (the winner settled the entry).
      try {
        const outcome =
          entry.status === 'SUBMITTING'
            ? await reconcileSubmitting(this.deps, entry, now)
            : await confirmEntry(this.deps, entry, now);
        summary.reconciled += 1;
        this.countSettlement(outcome, summary);
      } catch (error: unknown) {
        if (!(error instanceof OwnershipLostError)) throw error;
        summary.aborted += 1;
      }
    }

    // EXPIRED with attempts remaining → QUEUED (rebuild, §6.3 row 15/18):
    // due immediately (nextAttemptAt 0), fresh backoff budget; attemptCount
    // increments at the next write-ahead (build cycle), per ADR-0008.
    const expired = await this.store.listByState(['EXPIRED']);
    for (const entry of expired.slice(0, RECONCILE_BATCH_LIMIT)) {
      if (entry.attemptCount >= entry.maxAttempts) continue; // terminal; manual retry only
      const result = await this.store.transition(
        entry.intent.id,
        ['EXPIRED'],
        'QUEUED',
        {
          nextAttemptAt: 0,
          backoffAttempts: 0,
          claimedBy: undefined,
          claimExpiresAt: 0,
        },
        entry.version,
        now,
      );
      if (result.ok) {
        this.emit('intent:transition', result.entry);
      }
    }
  }

  /** Count a settled outcome into the summary (used by recover/process). */
  private countSettlement(outcome: ProcessOutcome, summary: ProcessSummary): void {
    if (outcome.kind !== 'settled') return;
    if (outcome.status === 'SUCCESS') summary.succeeded += 1;
    else if (outcome.status === 'FAILED') summary.failed += 1;
    else if (outcome.status === 'EXPIRED') summary.expired += 1;
  }

  /**
   * Run one candidate through the engine pipeline and fold the outcome into
   * the summary. Ownership losses (CAS conflicts — the expected concurrency
   * noise) are counted as aborted/skipped; unexpected errors propagate.
   */
  private async processOne(candidate: QueueEntry, now: number, summary: ProcessSummary): Promise<void> {
    let outcome: ProcessOutcome;
    try {
      outcome = await processEntry(this.deps, candidate, { workerId: this.workerId, now });
    } catch (error: unknown) {
      if (error instanceof OwnershipLostError) {
        // Abort-without-submit (§6.5.5): the entry belongs to someone else
        // now (or is contested); this worker moved on without side effects.
        summary.aborted += 1;
        return;
      }
      throw error;
    }

    switch (outcome.kind) {
      case 'not-claimed':
        summary.skipped += 1;
        return;
      case 'already-settled':
        summary.skipped += 1;
        return;
      case 'pending':
        // CONFIRMING stays pending (a later sweep's recovery pass polls it);
        // NEEDS_RETRY-without-journal awaits reconciliation (§8.1 Case 3).
        if (outcome.status === 'NEEDS_RETRY') summary.skipped += 1;
        summary.claimed += 1;
        return;
      case 'scheduled-retry':
        summary.retried += 1;
        summary.claimed += 1;
        return;
      case 'settled':
        summary.claimed += 1;
        this.countSettlement(outcome, summary);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Manual retry (ADR-0008)
  // -------------------------------------------------------------------------

  /**
   * Manual retry: re-queues a FAILED (or EXPIRED) entry for one more
   * processing cycle. Manual, never automatic; throws
   * `AttemptsExhaustedError` once `attemptCount >= maxAttempts` and
   * `InvalidRetryStateError` from any other state (SUCCESS, INDETERMINATE,
   * SUBMITTING, CONFIRMING, QUEUED, NEEDS_RETRY, READY). The next build
   * cycle creates the new attempt record (ADR-0008).
   */
  async retry(id: string): Promise<QueueEntry> {
    const entry = await this.store.get(id);
    if (entry === undefined) throw new EntryNotFoundError(id);
    if (entry.status !== 'FAILED' && entry.status !== 'EXPIRED') {
      throw new InvalidRetryStateError(id, entry.status);
    }
    if (entry.attemptCount >= entry.maxAttempts) {
      throw new AttemptsExhaustedError(id, entry.attemptCount, entry.maxAttempts);
    }
    const now = this.nowFn();
    const result = await this.store.transition(
      id,
      ['FAILED', 'EXPIRED'],
      'QUEUED',
      {
        nextAttemptAt: 0,
        backoffAttempts: 0,
        claimedBy: undefined,
        claimExpiresAt: 0,
      },
      entry.version,
      now,
    );
    if (!result.ok) {
      // Raced with another retry()/sweep — explicit over silent (ADR-0008).
      throw new InvalidRetryStateError(id, entry.status);
    }
    this.emit('intent:transition', result.entry);
    return result.entry;
  }

  // -------------------------------------------------------------------------
  // Cancel + remove (ADR-0011)
  // -------------------------------------------------------------------------

  /**
   * Soft-cancel a pre-submission intent: `QUEUED`/`NEEDS_RETRY` → `FAILED`
   * with `lastError.code = 'cancelled'`. Auditable and reversible via
   * `retry(id)`. Rejected (typed error, no mutation) for any other state and
   * for any entry carrying an unresolved in-flight hash (ADR-0011 invariants
   * — in practice NEEDS_RETRY entries always carry one, so cancel is
   * effectively a QUEUED-state verb).
   */
  async cancel(id: string): Promise<QueueEntry> {
    const entry = await this.store.get(id);
    if (entry === undefined) throw new EntryNotFoundError(id);
    if (entry.status !== 'QUEUED' && entry.status !== 'NEEDS_RETRY') {
      throw new InvalidCancelStateError(id, entry.status);
    }
    if (entry.inFlightHashes.length > 0) {
      throw new InvalidCancelStateError(id, entry.status);
    }
    const now = this.nowFn();
    const result = await this.store.transition(
      id,
      ['QUEUED', 'NEEDS_RETRY'],
      'FAILED',
      {
        lastError: { code: 'cancelled', message: 'cancelled by the application', ts: now },
        nextAttemptAt: 0,
        claimedBy: undefined,
        claimExpiresAt: 0,
      },
      entry.version,
      now,
    );
    if (!result.ok) {
      throw new InvalidCancelStateError(id, entry.status);
    }
    this.emit('intent:transition', result.entry);
    return result.entry;
  }

  /**
   * Delete an entry that has never been submitted (CAS delete, pre-submission
   * only per ADR-0011). Returns `false` when the CAS fails (raced, wrong
   * state, in-flight hash, or stale version); throws `EntryNotFoundError`
   * for an unknown id.
   */
  async remove(id: string): Promise<boolean> {
    const entry = await this.store.get(id);
    if (entry === undefined) throw new EntryNotFoundError(id);
    const now = this.nowFn();
    const deleted = await this.store.remove(id, ['QUEUED', 'NEEDS_RETRY'], entry.version);
    if (deleted) {
      // The entry is gone; emit its last known state so observers learn.
      this.emit('intent:transition', { ...entry, status: 'QUEUED', updatedAt: now });
    }
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Reconciliation (§10; full verdict engine is Phase 14)
  // -------------------------------------------------------------------------

  /**
   * Run the reconciliation verdict for all in-flight entries (or one, by id).
   * Idempotent; call on startup and periodically. Returns a result per
   * target that received a **definitive verdict** this run (entries still
   * pending — NOT_FOUND/transport failure — are omitted honestly rather
   * than guessed); non-in-flight targets yield `NOT_SUBMITTED`.
   */
  async reconcile(id?: string): Promise<ReconciliationResult[]> {
    const now = this.nowFn();
    await this.runJanitor(now);

    let targets: QueueEntry[];
    if (id !== undefined) {
      const entry = await this.store.get(id);
      if (entry === undefined) throw new EntryNotFoundError(id);
      targets = [entry];
    } else {
      targets = (await this.store.listByState(['SUBMITTING', 'CONFIRMING'])).slice(
        0,
        RECONCILE_BATCH_LIMIT,
      );
    }

    const results: ReconciliationResult[] = [];
    for (const entry of targets) {
      if (entry.status !== 'SUBMITTING' && entry.status !== 'CONFIRMING') {
        results.push({
          outcome: 'NOT_SUBMITTED',
          reason: `entry is ${entry.status}; nothing to reconcile`,
        });
        continue;
      }
      const hash = entry.inFlightHashes[entry.inFlightHashes.length - 1];
      if (hash === undefined) {
        results.push({ outcome: 'NOT_SUBMITTED', reason: 'in-flight entry has no journaled hash' });
        continue;
      }

      const outcome =
        entry.status === 'SUBMITTING'
          ? await reconcileSubmitting(this.deps, entry, now)
          : await confirmEntry(this.deps, entry, now);

      if (outcome.kind === 'settled') {
        // Re-read for the audit stamp (resultXdr is attached to the newest
        // attempt record on a FAILED verdict).
        const settled = await this.store.get(entry.intent.id);
        const newestAttempt = settled?.attempts[settled.attempts.length - 1];
        if (outcome.status === 'SUCCESS') {
          results.push({ outcome: 'SUCCESS', transactionHash: hash });
        } else if (outcome.status === 'FAILED') {
          results.push({
            outcome: 'FAILED',
            transactionHash: hash,
            resultXdr: newestAttempt?.resultXdr,
            reason: 'transaction confirmed failed on-chain',
          });
        } else if (outcome.status === 'EXPIRED') {
          results.push({ outcome: 'EXPIRED', reason: 'envelope provably never included' });
        } else {
          results.push({ outcome: 'INDETERMINATE', reason: 'evidence window closed' });
        }
      }
      // `pending` / `already-settled` / `not-claimed`: no verdict this run —
      // omitted (honesty over guessing, §8.3).
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Events + polling loop (§10)
  // -------------------------------------------------------------------------

  /** Subscribe to a lifecycle event; returns the unsubscribe function. */
  on(event: QueueEventType, handler: (entry: QueueEntry) => void): () => void {
    return this.events.on(event, handler);
  }

  /**
   * Optional convenience loop around `process()` (ADR-0010 #7: 5 s default).
   * The timer owns no hidden work — it only calls `process()`; sweep errors
   * are routed to the configured `onError` hook. Idempotent while running.
   */
  start(opts?: { intervalMs?: number }): void {
    if (this.timer !== undefined) return;
    const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new QueueConfigError('intervalMs', 'intervalMs must be a positive integer');
    }
    this.timer = setInterval(() => {
      this.process().catch((error: unknown) => {
        if (this.onError !== undefined) this.onError(error);
      });
    }, intervalMs);
    // A library timer must never keep the host process alive.
    this.timer.unref?.();
  }

  /** Stop the polling loop started by `start()`. Idempotent. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Emit through the event hub (handler throws are isolated there). */
  private emit(event: QueueEventType, entry: QueueEntry): void {
    this.events.emit(event, entry);
  }
}
