/**
 * Processing ownership: claims, leases, janitor reclamation, and the
 * lost-ownership abort rule (Phase 6 / Issue #7, ADR-0007).
 *
 * Ownership is exclusive, time-limited, and recoverable:
 *
 * - **Exclusive** — `claimEntry` wraps the store's CAS `claim`, so exactly one
 *   worker can hold an entry. A second claimant fails with a typed reason.
 * - **Time-limited** — a claim grants a lease (`claimExpiresAt`). The owner
 *   refreshes it via `refreshLease`; a stale owner's refresh fails with
 *   `OwnershipLostError`.
 * - **Recoverable** — the janitor core (`reclaimExpired`) returns
 *   expired-lease READY entries to QUEUED. A crashed worker's entry is
 *   re-claimable after `leaseMs`.
 * - **Abort-safe** — `withOwnership` runs a callback only while ownership is
 *   live, so callers (the engine, Phase 7) can enforce invariant §6.5.5:
 *   a worker that lost ownership aborts without side effects — it never
 *   submits, never races the new owner.
 *
 * The janitor **never touches** SUBMITTING/CONFIRMING entries (§6.5.3):
 * those carry possibly-sent envelope hashes and are only ever reconciled,
 * never reclaimed or rebuilt. This module only ever lists `READY` entries,
 * so the in-flight states are structurally out of its reach.
 *
 * Model contract: ADR-0007, architecture §6.5, §6.7, ADR-0010 (leaseMs).
 */

import { randomUUID } from 'node:crypto';
import type { QueueStore, QueueEntry } from './store/types.js';
import { isReclaimable } from './state.js';
import { OwnershipLostError } from './errors.js';

// ---------------------------------------------------------------------------
// Worker identity (T6.1)
// ---------------------------------------------------------------------------

/**
 * A worker id for claim calls. Config-supplied when the application wants
 * readable logs, otherwise `worker-<uuidv4>`.
 *
 * Generate this **once per process** (at queue construction) and reuse the
 * value for every claim the process makes — the id is only meaningful as a
 * stable claimant label for the process's lifetime.
 *
 * This identifies a claimant inside the store — it is **not** a security
 * identity: any process that can write the store can claim with any id. The
 * store's CAS version token, not the id, is what prevents two writers.
 */
export function createWorkerId(configured?: string): string {
  return configured ?? `worker-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Claim + lease (T6.2)
// ---------------------------------------------------------------------------

/** Parameters for `claimEntry`. */
export type ClaimParams = {
  /** Caller's worker identity (see `createWorkerId`). */
  workerId: string;
  /** Lease duration in ms (ADR-0010 default 60 000). */
  leaseMs: number;
  /** Current time (ms epoch) — injected for determinism, never sampled. */
  now: number;
};

/**
 * The claim outcome. Mirrors the store's CAS failure reasons verbatim so
 * callers can distinguish "someone else owns this" (`state`/`version`) from
 * scheduling (`not-due`) and data errors (`missing`).
 */
export type ClaimResult =
  | { ok: true; entry: QueueEntry }
  | { ok: false; reason: 'state' | 'not-due' | 'version' | 'missing' };

/**
 * Attempt to take exclusive ownership of an entry via the store's CAS claim:
 * only from `{QUEUED, NEEDS_RETRY}` while due (`nextAttemptAt ≤ now`).
 *
 * The expected version is taken from a fresh read; the store's atomic CAS
 * makes the read→claim window safe — if another worker wins in between, the
 * claim fails with `version` (or `state`). On success the caller holds
 * ownership until `now + leaseMs` and is recorded as `claimedBy`.
 *
 * Pure orchestration over `store.claim` — all exclusivity comes from the
 * store (ADR-0007 rules 1–2). Never throws for CAS losses.
 */
export async function claimEntry(
  store: QueueStore,
  id: string,
  params: ClaimParams,
): Promise<ClaimResult> {
  const current = await store.get(id);
  if (current === undefined) {
    return { ok: false, reason: 'missing' };
  }
  return store.claim(
    id,
    ['QUEUED', 'NEEDS_RETRY'],
    params.now,
    current.version,
    params.workerId,
    params.leaseMs,
  );
}

// ---------------------------------------------------------------------------
// Lease refresh (T6.2)
// ---------------------------------------------------------------------------

/**
 * Refresh the claim lease of an entry the caller owns.
 *
 * CAS `transition` from `READY` with the caller's current version, verifying
 * `claimedBy` still matches. Used by long owner phases (build and sign; the
 * engine wires it in Phase 7). Throws `OwnershipLostError` when ownership
 * was lost — lease expired and janitor reclaimed, another worker won a CAS
 * race, or the entry vanished.
 *
 * Returns the updated entry on success (with the refreshed lease).
 */
export async function refreshLease(
  store: QueueStore,
  id: string,
  workerId: string,
  leaseMs: number,
  now: number,
): Promise<QueueEntry> {
  // Read-modify-CAS: the store's version check makes this safe — a concurrent
  // reclaim or takeover bumps the version and the transition below fails.
  const current = await store.get(id);
  if (current === undefined) {
    throw new OwnershipLostError(id, workerId, 'entry no longer exists in the store');
  }
  if (current.status !== 'READY') {
    throw new OwnershipLostError(id, workerId, `entry is ${current.status}, not READY`);
  }
  if (current.claimedBy !== workerId) {
    throw new OwnershipLostError(
      id,
      workerId,
      `entry is claimed by "${current.claimedBy ?? 'nobody'}"`,
    );
  }

  const result = await store.transition(
    id,
    ['READY'],
    'READY',
    { claimExpiresAt: now + leaseMs },
    current.version,
    now,
  );
  if (!result.ok) {
    throw new OwnershipLostError(id, workerId, `CAS failed: ${result.reason}`);
  }
  return result.entry;
}

// ---------------------------------------------------------------------------
// Janitor reclamation (T6.2)
// ---------------------------------------------------------------------------

/**
 * Reclaim READY entries whose lease has expired back to QUEUED.
 *
 * Janitor core (ADR-0007 rule 4): scans via `listByState(['READY'])` — which
 * can never return SUBMITTING/CONFIRMING entries — and for each entry with
 * `claimExpiresAt < now` performs a CAS `READY → QUEUED` transition clearing
 * `claimedBy`/`claimExpiresAt`. Concurrent janitors race per entry; only the
 * version winner succeeds (the loser re-reads or skips — both fine, the
 * entry is QUEUED either way). Live leases are never stolen.
 *
 * Returns the ids reclaimed by **this** call.
 */
export async function reclaimExpired(store: QueueStore, now: number): Promise<string[]> {
  const ready = await store.listByState(['READY']);
  const reclaimed: string[] = [];

  for (const entry of ready) {
    if (!isReclaimable(entry, now)) continue;

    // Fresh read: the listing may already be stale; the CAS below still
    // guards the actual mutation, this just avoids guaranteed-loser calls.
    const current = await store.get(entry.intent.id);
    if (current === undefined || !isReclaimable(current, now)) continue;

    const result = await store.transition(
      entry.intent.id,
      ['READY'],
      'QUEUED',
      { claimedBy: undefined, claimExpiresAt: 0 },
      current.version,
      now,
    );
    if (result.ok) {
      reclaimed.push(entry.intent.id);
    }
    // CAS loss: another janitor (or a lease refresh) won. Skip — the entry
    // is either QUEUED already or back under a live lease.
  }

  return reclaimed;
}

// ---------------------------------------------------------------------------
// Abort discipline (T6.4)
// ---------------------------------------------------------------------------

/**
 * Run `fn` only while ownership is live (T6.4 abort-discipline helper).
 *
 * `fn` receives the claimed entry and the store. Every persisted step it
 * takes must go through CAS store calls, which fail once ownership is lost —
 * there is no way to mutate the entry that bypasses the version check. If
 * ownership is lost mid-flight, `fn` throws `OwnershipLostError` (from
 * `refreshLease` or its own CAS checks) and this helper propagates it: the
 * caller aborts without submitting (invariant §6.5.5 — the engine enforces
 * the no-submit rule structurally in Phase 7 by re-checking claim state
 * immediately before the write-ahead transition).
 *
 * A failed claim result handed in by the caller also throws
 * `OwnershipLostError` (attributed to `id`) — ownership was never acquired,
 * so there is nothing to run.
 *
 * @param store - The queue store; handed to `fn` for its CAS calls.
 * @param id - The claimed entry's intent id (used to attribute the thrown
 *   `OwnershipLostError` when `claimResult` is a failure).
 * @param claimResult - The result of a prior `claimEntry` call.
 * @param workerId - The worker that produced `claimResult`.
 * @param fn - The owner-phase work; receives the claimed entry and store.
 */
export async function withOwnership<T>(
  store: QueueStore,
  id: string,
  claimResult: ClaimResult,
  workerId: string,
  fn: (entry: QueueEntry, ownedStore: QueueStore) => T | Promise<T>,
): Promise<T> {
  if (!claimResult.ok) {
    throw new OwnershipLostError(
      id,
      workerId,
      `claim failed (${claimResult.reason}) — ownership was never acquired`,
    );
  }
  // Ownership is live; fn's own CAS store calls carry the abort rule.
  return fn(claimResult.entry, store);
}
