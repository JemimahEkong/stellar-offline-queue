/**
 * Lifecycle state machine (Phase 2 / Issue #3).
 *
 * The eleven-state lifecycle with exhaustive transition table from architecture
 * §6.3–6.4. This module is **pure** — no I/O, no store, no adapters. The
 * transition table is the contract the store CAS enforces (Phase 3) and the
 * engine obeys (Phase 7).
 *
 * Model contract: ADR-0006, architecture §6, ADR-0008 (retryable classification),
 * ADR-0011 (cancel rows).
 */

import { InvalidTransitionError } from './errors.js';

// ---------------------------------------------------------------------------
// States (architecture §6.2)
// ---------------------------------------------------------------------------

/**
 * The eleven lifecycle states of an intent. Discriminated by the queue engine
 * and enforced by store CAS transitions.
 */
export type IntentStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'READY'
  | 'BUILDING'
  | 'SIGNING'
  | 'SUBMITTING'
  | 'NEEDS_RETRY'
  | 'CONFIRMING'
  | 'SUCCESS'
  | 'FAILED'
  | 'EXPIRED'
  | 'INDETERMINATE';

/** All valid statuses as a const array. */
export const ALL_STATUSES: readonly IntentStatus[] = [
  'CREATED',
  'QUEUED',
  'READY',
  'BUILDING',
  'SIGNING',
  'SUBMITTING',
  'NEEDS_RETRY',
  'CONFIRMING',
  'SUCCESS',
  'FAILED',
  'EXPIRED',
  'INDETERMINATE',
] as const;

// ---------------------------------------------------------------------------
// State classification constants (architecture §6.2)
// ---------------------------------------------------------------------------

/**
 * Terminal states: no outgoing transitions except the documented manual-retry
 * escape rows (§6.3): `FAILED → QUEUED` and attempts-exhausted
 * `EXPIRED → QUEUED`, both via the app-driven `retry(id)` API (ADR-0008).
 * `SUCCESS` and `INDETERMINATE` have no outgoing transitions at all.
 */
export const TERMINAL_STATES: readonly IntentStatus[] = [
  'SUCCESS',
  'FAILED',
  'INDETERMINATE',
] as const;

/**
 * Durable states: persisted to the store; survive restarts.
 */
export const PERSISTED_STATES: readonly IntentStatus[] = [
  'QUEUED',
  'READY',
  'SUBMITTING',
  'NEEDS_RETRY',
  'CONFIRMING',
  'SUCCESS',
  'FAILED',
  'EXPIRED',
  'INDETERMINATE',
] as const;

/**
 * Transient states: exist only in-memory during owner phases; a crash here
 * leaves the entry in its previous durable state (READY under lease).
 */
export const TRANSIENT_STATES: readonly IntentStatus[] = [
  'CREATED',
  'BUILDING',
  'SIGNING',
] as const;

/**
 * Pre-submission states: no envelope hash is in flight yet. Entries in these
 * states may be removed (ADR-0011).
 */
export const PRE_SUBMISSION_STATES: readonly IntentStatus[] = [
  'CREATED',
  'QUEUED',
  'READY',
  'BUILDING',
  'SIGNING',
] as const;

/**
 * In-flight states: an envelope may have been submitted. The engine must
 * reconcile journaled hashes before taking any further action.
 */
export const IN_FLIGHT_STATES: readonly IntentStatus[] = ['SUBMITTING', 'CONFIRMING'] as const;

/**
 * Retryable states (ADR-0008): states from which an automatic or manual
 * retry path exists.
 * - `QUEUED`: scheduled (backoff/claim)
 * - `NEEDS_RETRY`: scheduled (identical-envelope resubmit)
 * - `EXPIRED`: rebuildable while attempts remain
 * - `FAILED`: manual retry only (via queue.retry())
 */
export const RETRYABLE_STATES: readonly IntentStatus[] = [
  'QUEUED',
  'NEEDS_RETRY',
  'EXPIRED',
  'FAILED',
] as const;

// ---------------------------------------------------------------------------
// Transition rules (architecture §6.3)
// ---------------------------------------------------------------------------

/** Trigger labels matching §6.3. */
export type TransitionTrigger =
  | 'add-intent'
  | 'claim'
  | 'janitor-reclaim'
  | 'build-started'
  | 'draft-built'
  | 'write-ahead'
  | 'submit-ack'
  | 'transient-failure'
  | 'submit-error-provable'
  | 'verdict-success'
  | 'verdict-failed'
  | 'verdict-expired'
  | 'verdict-indeterminate'
  | 'rebuild'
  | 'deterministic-failure'
  | 'cancel'
  | 'remove'
  | 'manual-retry';

export type TransitionRule = {
  /** Which trigger(s) activate this transition. */
  trigger: TransitionTrigger | TransitionTrigger[];
  /** Whether the CAS must carry a reason/update payload. */
  requiresReason?: boolean;
  /** Whether this transition increments the attempt count. */
  attemptsIncrement?: boolean;
};

/**
 * The exhaustive transition table from architecture §6.3.
 *
 * `TRANSITIONS[from][to]` is defined if and only if the transition is legal.
 * Each rule carries its allowed trigger label(s).
 */
export const TRANSITIONS: Readonly<
  Record<IntentStatus, Partial<Readonly<Record<IntentStatus, TransitionRule>>>>
> = {
  CREATED: {
    QUEUED: { trigger: 'add-intent' },
  },

  QUEUED: {
    READY: { trigger: 'claim' },
    FAILED: { trigger: ['deterministic-failure', 'cancel'] },
  },

  READY: {
    QUEUED: { trigger: 'janitor-reclaim' },
    BUILDING: { trigger: 'build-started' },
    // Deterministic failure detected after the claim (payload-mismatch,
    // signer rejection, `tx_no_account`): BUILDING/SIGNING are transient
    // phases that are never persisted, so the durable state at the moment of
    // such a failure is READY — the failure row routes it to FAILED from
    // there (implementation plan T7.2; ADR-0008 "deterministic, never
    // automatically retried"). No side effects have occurred (no write-ahead
    // happened), so FAILED here carries zero in-flight hashes.
    FAILED: { trigger: 'deterministic-failure' },
  },

  BUILDING: {
    SIGNING: { trigger: 'draft-built' },
  },

  SIGNING: {
    SUBMITTING: { trigger: 'write-ahead', requiresReason: true },
  },

  SUBMITTING: {
    CONFIRMING: { trigger: 'submit-ack' },
    NEEDS_RETRY: { trigger: 'transient-failure' },
    FAILED: { trigger: 'submit-error-provable' },
  },

  NEEDS_RETRY: {
    SUBMITTING: { trigger: 'write-ahead', requiresReason: true },
    FAILED: { trigger: ['deterministic-failure', 'cancel'] },
  },

  CONFIRMING: {
    SUCCESS: { trigger: 'verdict-success' },
    FAILED: { trigger: 'verdict-failed' },
    EXPIRED: { trigger: 'verdict-expired' },
    INDETERMINATE: { trigger: 'verdict-indeterminate' },
  },

  EXPIRED: {
    // Automatic rebuild (attempts remain) and manual retry of an
    // attempts-exhausted entry — §6.3 rows 18 and 20 (ADR-0008).
    QUEUED: { trigger: ['rebuild', 'manual-retry'], attemptsIncrement: true },
  },

  FAILED: {
    // Manual retry escape hatch — §6.3 row 19 (ADR-0008, ADR-0011 companion).
    QUEUED: { trigger: 'manual-retry' },
  },

  SUCCESS: {},
  INDETERMINATE: {},
} as const;

// ---------------------------------------------------------------------------
// Pure transition validation
// ---------------------------------------------------------------------------

export type TransitionResult = { ok: true } | { ok: false; reason: string };

/**
 * Check whether a transition is valid according to the transition table.
 * Pure function — no I/O, no store.
 *
 * @param from - Current state.
 * @param to - Target state.
 * @param trigger - The trigger attempting this transition.
 * @returns `{ ok: true }` if allowed, `{ ok: false; reason }` otherwise.
 */
export function canTransition(
  from: IntentStatus,
  to: IntentStatus,
  trigger?: TransitionTrigger,
): TransitionResult {
  const fromRules = TRANSITIONS[from];
  if (fromRules === undefined) {
    return { ok: false, reason: `unknown from-state "${from}"` };
  }

  const rule = fromRules[to];
  if (rule === undefined) {
    return {
      ok: false,
      reason: `transition ${from} → ${to} is not in the transition table`,
    };
  }

  if (trigger !== undefined) {
    const allowedTriggers = Array.isArray(rule.trigger) ? rule.trigger : [rule.trigger];
    if (!allowedTriggers.includes(trigger)) {
      return {
        ok: false,
        reason: `trigger "${trigger}" is not valid for ${from} → ${to} (expected: ${allowedTriggers.join(' | ')})`,
      };
    }
  }

  return { ok: true };
}

/**
 * Validate a transition, throwing `InvalidTransitionError` if invalid.
 * Convenience wrapper around `canTransition` for use in the engine.
 */
export function validateTransition(
  from: IntentStatus,
  to: IntentStatus,
  trigger?: TransitionTrigger,
): void {
  const result = canTransition(from, to, trigger);
  if (!result.ok) {
    throw new InvalidTransitionError(from, to, result.reason, trigger);
  }
}

// ---------------------------------------------------------------------------
// Recovery classification helpers (architecture §6.2, §6.7)
// ---------------------------------------------------------------------------

/**
 * Minimal entry shape needed by recovery predicates. Defined here to avoid
 * circular imports with store/types.ts.
 */
export type MinimalEntry = {
  status: IntentStatus;
  claimExpiresAt: number;
};

/**
 * Whether the entry is in an in-flight state (SUBMITTING or CONFIRMING).
 * Used by the recovery sweep and janitor guard.
 */
export function isInFlight(status: IntentStatus): boolean {
  return IN_FLIGHT_STATES.includes(status);
}

/**
 * Whether the entry is in a terminal state.
 */
export function isTerminal(status: IntentStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Whether the entry is in a pre-submission state (no envelope hash in flight).
 * Entries in these states may be removed (ADR-0011).
 */
export function isPreSubmission(status: IntentStatus): boolean {
  return PRE_SUBMISSION_STATES.includes(status);
}

/**
 * Whether the entry is reclaimable by the janitor: status is READY and the
 * lease has expired. Used by `reclaimExpired` in Phase 6.
 *
 * @param entry - The queue entry (minimal shape).
 * @param now - Current timestamp (ms).
 */
export function isReclaimable(entry: MinimalEntry, now: number): boolean {
  return entry.status === 'READY' && entry.claimExpiresAt < now;
}
