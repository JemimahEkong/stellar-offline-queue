/**
 * QueueStore CAS interface and result types (Phase 3 / Issue #4, architecture §9.2).
 *
 * This module defines the storage contract: the `QueueStore` interface with
 * compare-and-set primitives that make "no double submission" structural.
 * The interface is frozen before adapters are written; every adapter passes
 * the same contract test suite (tests/store/contract.ts).
 *
 * Model contract: ADR-0003, architecture §5.3, §9.2, ADR-0007 (claim/lease),
 * ADR-0011 (remove restrictions).
 */

import type { IntentStatus } from '../state.js';
import type { Intent } from '../intent.js';

// ---------------------------------------------------------------------------
// Queue entry (architecture §5.3)
// ---------------------------------------------------------------------------

/**
 * The mutable record wrapping an immutable intent. This is what the store
 * persists; every field except `intent` mutates over the entry's lifecycle.
 */
export type QueueEntry = {
  /** The immutable, hash-protected intent (ADR-0001). */
  intent: Intent;

  /** Current lifecycle state (§6.2). */
  status: IntentStatus;

  /** Number of build cycles started (each write-ahead transition increments). */
  attemptCount: number;

  /** Snapshot of config.maxAttempts at enqueue time. */
  maxAttempts: number;

  /** Next eligible processing time (ms epoch); 0 = due immediately. */
  nextAttemptAt: number;

  /** Consecutive transient failures driving backoff (resets on progress). */
  backoffAttempts: number;

  /**
   * Worker id holding the claim lease (§6.7); `undefined` when unclaimed.
   * Declared `| undefined` so janitor reclaims can clear it under
   * `exactOptionalPropertyTypes`.
   */
  claimedBy?: string | undefined;

  /** Lease expiry (ms epoch); 0 = unclaimed. */
  claimExpiresAt: number;

  /**
   * Last error, if any. Declared `| undefined` so transitions can clear it.
   */
  lastError?: { code: string; message: string; ts: number } | undefined;

  /** Envelope hashes possibly sent to the network — write-ahead journal. */
  inFlightHashes: string[];

  /** Audit log of attempt records (one per build cycle). */
  attempts: AttemptRecord[];

  /** Last update timestamp (ms epoch). */
  updatedAt: number;

  /** Optimistic concurrency token; incremented on every successful mutation. */
  version: number;
};

// ---------------------------------------------------------------------------
// Attempt record (architecture §5.3)
// ---------------------------------------------------------------------------

/**
 * Audit record for one build cycle (one envelope). Created at the write-ahead
 * transition; one AttemptRecord per envelope submitted.
 *
 * Phase 8 (ADR-0008): the record also carries the flush parameters the
 * envelope was built from (`sequenceNumber`, `maxTime`, `fee`), so a
 * post-restart resume can rebuild the **byte-identical** envelope
 * deterministically — build is a pure function of (intent, sequence, fee,
 * maxTime) — and assert the rebuilt hash equals the journaled hash before
 * resubmitting (`envelope-drift` failure otherwise). Signatures are never
 * persisted; only these build parameters are.
 */
export type AttemptRecord = {
  /** Envelope hash (hex) — dedupe key, journaled before submit. */
  envelopeHash: string;

  /**
   * Sequence number used in this envelope (decimal string, 64-bit safe).
   * Authoritative for identical rebuilds: the resume path rebuilds with this
   * exact sequence and asserts hash equality before resubmitting.
   */
  sequenceNumber: string;

  /**
   * `maxTime` (unix seconds) of this envelope's time bounds — the second
   * deterministic build parameter (flush time resolved at build, §6.6).
   */
  maxTime: number;

  /**
   * Per-operation fee (stroops string) used in this envelope — the third
   * deterministic build parameter.
   */
  fee: string;

  /** When the envelope was submitted (ms epoch). */
  submittedAt: number;

  /** Outcome of this attempt (updated by reconciliation). */
  outcome: 'UNKNOWN' | 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'INDETERMINATE';

  /** Result XDR (on FAILED, for application diagnosis). */
  resultXdr?: string;
};

// ---------------------------------------------------------------------------
// QueueStore interface (architecture §9.2)
// ---------------------------------------------------------------------------

/**
 * The storage contract for the durable queue. Every method is idempotency-
 * aware by construction. CAS methods (`claim`, `transition`, `remove`) fail
 * with typed reasons rather than corrupting state.
 *
 * - `version` is an optimistic-concurrency token incremented on every
 *   successful mutation.
 * - `insert` with a duplicate id returns the existing entry (never corrupts).
 * - `claim` grants the processing lease (§6.7).
 * - `transition` atomically applies field updates with the state change.
 * - `listDue` / `listByState` support the scheduler and recovery sweep.
 * - `remove` is CAS-restricted to pre-submission states (ADR-0011).
 */
export interface QueueStore {
  /**
   * Insert a new entry. Duplicate `id` returns the existing entry without
   * mutating it (idempotent insert).
   */
  insert(entry: QueueEntry): Promise<QueueEntry>;

  /** Get an entry by id; returns undefined if not found. */
  get(id: string): Promise<QueueEntry | undefined>;

  /**
   * CAS claim: succeeds only if `status ∈ fromStates` AND `nextAttemptAt ≤ now`
   * AND `version` matches. On success, atomically sets `status = READY`,
   * `claimedBy = workerId`, `claimExpiresAt = now + leaseMs`, and increments
   * version.
   */
  claim(
    id: string,
    fromStates: IntentStatus[],
    now: number,
    expectedVersion: number,
    workerId: string,
    leaseMs: number,
  ): Promise<
    | { ok: true; entry: QueueEntry }
    | { ok: false; reason: 'state' | 'not-due' | 'version' | 'missing' }
  >;

  /**
   * CAS transition: `fromStates` must include current status and `version` must
   * match. Atomically applies `update` (shallow merge; arrays replaced
   * wholesale), sets `updatedAt`, and increments version.
   */
  transition(
    id: string,
    fromStates: IntentStatus[],
    to: IntentStatus,
    update: Partial<QueueEntry>,
    expectedVersion: number,
    now: number,
  ): Promise<
    { ok: true; entry: QueueEntry } | { ok: false; reason: 'state' | 'version' | 'missing' }
  >;

  /**
   * Scheduler scan: entries in `fromStates` with `nextAttemptAt ≤ dueBefore`,
   * ordered by `createdAt` then `id` (deterministic).
   */
  listDue(fromStates: IntentStatus[], dueBefore: number): Promise<QueueEntry[]>;

  /** Recovery sweep: all entries in any of the given states. */
  listByState(states: IntentStatus[]): Promise<QueueEntry[]>;

  /** Generic list with optional filters. */
  list(opts?: { status?: IntentStatus; account?: string; limit?: number }): Promise<QueueEntry[]>;

  /**
   * CAS remove: deletes an entry, but only if its status is in `fromStates`
   * and `version` matches. Pre-submission only per ADR-0011.
   *
   * @returns `true` if deleted, `false` if CAS failed (state, version, or missing).
   */
  remove(id: string, fromStates: IntentStatus[], expectedVersion: number): Promise<boolean>;
}
