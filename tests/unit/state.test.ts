/**
 * Phase 2 / Issue #3 unit tests: the lifecycle state machine.
 *
 * Coverage per implementation plan §Phase 2 Tests:
 * - Every valid transition: iterate TRANSITIONS, assert canTransition ok for
 *   each row with its trigger.
 * - Every invalid transition: iterate the full 12×12 cross product; assert
 *   every pair not in the table is rejected. Snapshot the accepted pair count.
 * - Trigger mismatch: a valid pair with wrong trigger is rejected.
 * - Recovery transitions present: READY→QUEUED, EXPIRED→QUEUED, FAILED→QUEUED
 *   (manual-retry escape rows, §6.3 rows 18–20).
 * - Terminal classification: SUCCESS, FAILED, INDETERMINATE are terminal
 *   (FAILED/EXPIRED keep only the documented manual-retry escape).
 * - Predicates: isInFlight, isPreSubmission, isReclaimable truth tables.
 * - InvalidTransitionError thrown by validateTransition.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_STATUSES,
  TERMINAL_STATES,
  PERSISTED_STATES,
  TRANSIENT_STATES,
  PRE_SUBMISSION_STATES,
  IN_FLIGHT_STATES,
  RETRYABLE_STATES,
  TRANSITIONS,
  canTransition,
  validateTransition,
  isInFlight,
  isTerminal,
  isPreSubmission,
  isReclaimable,
} from '../../src/state.js';
import type { IntentStatus, TransitionTrigger, MinimalEntry } from '../../src/state.js';
import { InvalidTransitionError } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count the total number of valid transitions in the table. */
function countTransitions(): number {
  let count = 0;
  for (const from of ALL_STATUSES) {
    const targets = TRANSITIONS[from];
    if (targets !== undefined) {
      count += Object.keys(targets).length;
    }
  }
  return count;
}

/** Get all valid (from, to) pairs from the transition table. */
function validPairs(): Array<[IntentStatus, IntentStatus]> {
  const pairs: Array<[IntentStatus, IntentStatus]> = [];
  for (const from of ALL_STATUSES) {
    const targets = TRANSITIONS[from];
    if (targets !== undefined) {
      for (const to of Object.keys(targets) as IntentStatus[]) {
        pairs.push([from, to]);
      }
    }
  }
  return pairs;
}

/** Get the allowed trigger(s) for a valid (from, to) pair. */
function getTriggers(from: IntentStatus, to: IntentStatus): TransitionTrigger[] {
  const rule = TRANSITIONS[from]?.[to];
  if (rule === undefined) return [];
  return Array.isArray(rule.trigger) ? [...rule.trigger] : [rule.trigger];
}

// ---------------------------------------------------------------------------
// State classification constants
// ---------------------------------------------------------------------------

describe('state classification constants', () => {
  it('ALL_STATUSES contains exactly 12 states', () => {
    expect(ALL_STATUSES).toHaveLength(12);
  });

  it('TERMINAL_STATES are a subset of ALL_STATUSES', () => {
    for (const s of TERMINAL_STATES) {
      expect(ALL_STATUSES).toContain(s);
    }
  });

  it('TERMINAL_STATES contains SUCCESS, FAILED, INDETERMINATE', () => {
    expect(TERMINAL_STATES).toContain('SUCCESS');
    expect(TERMINAL_STATES).toContain('FAILED');
    expect(TERMINAL_STATES).toContain('INDETERMINATE');
    expect(TERMINAL_STATES).toHaveLength(3);
  });

  it('PERSISTED_STATES are a subset of ALL_STATUSES', () => {
    for (const s of PERSISTED_STATES) {
      expect(ALL_STATUSES).toContain(s);
    }
  });

  it('TRANSIENT_STATES are CREATED, BUILDING, SIGNING', () => {
    expect(TRANSIENT_STATES).toEqual(['CREATED', 'BUILDING', 'SIGNING']);
  });

  it('PRE_SUBMISSION_STATES do not overlap with IN_FLIGHT_STATES', () => {
    for (const s of PRE_SUBMISSION_STATES) {
      expect(IN_FLIGHT_STATES).not.toContain(s);
    }
  });

  it('IN_FLIGHT_STATES are SUBMITTING and CONFIRMING', () => {
    expect(IN_FLIGHT_STATES).toEqual(['SUBMITTING', 'CONFIRMING']);
  });

  it('RETRYABLE_STATES includes QUEUED, NEEDS_RETRY, EXPIRED, FAILED', () => {
    expect(RETRYABLE_STATES).toContain('QUEUED');
    expect(RETRYABLE_STATES).toContain('NEEDS_RETRY');
    expect(RETRYABLE_STATES).toContain('EXPIRED');
    expect(RETRYABLE_STATES).toContain('FAILED');
    expect(RETRYABLE_STATES).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Every valid transition
// ---------------------------------------------------------------------------

describe('every valid transition', () => {
  const pairs = validPairs();

  it('snapshot: total valid transition count', () => {
    // §6.3 rows 1–17 (ordinary transitions) + rows 18–20 (EXPIRED→QUEUED,
    // FAILED→QUEUED manual-retry escapes). Row 17 (`SUBMITTING`/`CONFIRMING`
    // → recovery sweep) is a recovery procedure, not a table row.
    // Plus the implementation-plan T7.2 resolution: READY → FAILED via
    // deterministic-failure (post-claim deterministic failures happen from
    // the durable READY state, since BUILDING/SIGNING are transient).
    // This snapshot guards against accidental additions.
    // If you intentionally add a transition, update this count.
    expect(countTransitions()).toBe(19);
  });

  for (const [from, to] of pairs) {
    const triggers = getTriggers(from, to);
    for (const trigger of triggers) {
      it(`${from} → ${to} via ${trigger} is ok`, () => {
        expect(canTransition(from, to, trigger)).toEqual({ ok: true });
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Every invalid transition (full 11×11 cross product)
// ---------------------------------------------------------------------------

describe('every invalid transition', () => {
  it('full 12×12 cross product: every non-table pair is rejected', () => {
    let acceptedCount = 0;

    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const result = canTransition(from, to);
        const isValid = TRANSITIONS[from] !== undefined && to in TRANSITIONS[from];

        if (isValid) {
          acceptedCount++;
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
          expect(result).toHaveProperty('reason');
        }
      }
    }

    // Cross-check: accepted count matches the table
    expect(acceptedCount).toBe(countTransitions());
  });
});

// ---------------------------------------------------------------------------
// Trigger mismatch
// ---------------------------------------------------------------------------

describe('trigger mismatch', () => {
  it('QUEUED → READY with wrong trigger is rejected', () => {
    const result = canTransition('QUEUED', 'READY', 'write-ahead');
    expect(result.ok).toBe(false);
  });

  it('SIGNING → SUBMITTING with wrong trigger is rejected', () => {
    const result = canTransition('SIGNING', 'SUBMITTING', 'claim');
    expect(result.ok).toBe(false);
  });

  it('any valid pair with an unrelated trigger is rejected', () => {
    const result = canTransition('QUEUED', 'READY', 'verdict-success');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recovery transitions
// ---------------------------------------------------------------------------

describe('recovery transitions', () => {
  it('READY → QUEUED via janitor-reclaim', () => {
    expect(canTransition('READY', 'QUEUED', 'janitor-reclaim')).toEqual({ ok: true });
  });

  it('EXPIRED → QUEUED via rebuild', () => {
    expect(canTransition('EXPIRED', 'QUEUED', 'rebuild')).toEqual({ ok: true });
  });

  it('FAILED → QUEUED via manual-retry (§6.3 row 19, ADR-0008)', () => {
    expect(canTransition('FAILED', 'QUEUED', 'manual-retry')).toEqual({ ok: true });
  });

  it('FAILED → QUEUED with any other trigger is rejected', () => {
    expect(canTransition('FAILED', 'QUEUED', 'janitor-reclaim').ok).toBe(false);
    expect(canTransition('FAILED', 'QUEUED', 'rebuild').ok).toBe(false);
    expect(canTransition('FAILED', 'QUEUED', 'verdict-failed').ok).toBe(false);
  });

  it('EXPIRED → QUEUED via manual-retry (attempts-exhausted escape, §6.3 row 20)', () => {
    expect(canTransition('EXPIRED', 'QUEUED', 'manual-retry')).toEqual({ ok: true });
  });

  it('READY → FAILED via deterministic-failure (plan T7.2: post-claim deterministic failures)', () => {
    expect(canTransition('READY', 'FAILED', 'deterministic-failure')).toEqual({ ok: true });
    // Wrong triggers rejected.
    expect(canTransition('READY', 'FAILED', 'verdict-failed').ok).toBe(false);
    expect(canTransition('READY', 'FAILED', 'cancel').ok).toBe(false);
    expect(canTransition('READY', 'FAILED', 'submit-error-provable').ok).toBe(false);
  });

  it('FAILED → anything-but-QUEUED is rejected', () => {
    for (const to of ALL_STATUSES) {
      if (to === 'QUEUED') continue;
      expect(canTransition('FAILED', to).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal state classification
// ---------------------------------------------------------------------------

describe('terminal states', () => {
  it('SUCCESS has no outgoing transitions', () => {
    expect(canTransition('SUCCESS', 'QUEUED').ok).toBe(false);
    expect(canTransition('SUCCESS', 'READY').ok).toBe(false);
    expect(canTransition('SUCCESS', 'FAILED').ok).toBe(false);
  });

  it('FAILED has only the manual-retry escape row', () => {
    // §6.3 row 19: FAILED → QUEUED via explicit retry(id) (ADR-0008).
    expect(canTransition('FAILED', 'QUEUED', 'manual-retry').ok).toBe(true);
    expect(canTransition('FAILED', 'READY').ok).toBe(false);
    expect(canTransition('FAILED', 'SUCCESS').ok).toBe(false);
    expect(canTransition('FAILED', 'SUBMITTING').ok).toBe(false);
  });

  it('READY has reclaim, build, and deterministic-failure rows only', () => {
    // READY → QUEUED (janitor), READY → BUILDING (build), READY → FAILED
    // (deterministic failure, plan T7.2). Nothing else — in particular no
    // write-ahead from READY (that row is validated logically as
    // SIGNING → SUBMITTING while the durable CAS runs from READY).
    expect(canTransition('READY', 'QUEUED', 'janitor-reclaim').ok).toBe(true);
    expect(canTransition('READY', 'BUILDING', 'build-started').ok).toBe(true);
    expect(canTransition('READY', 'FAILED', 'deterministic-failure').ok).toBe(true);
    expect(canTransition('READY', 'SUBMITTING', 'write-ahead').ok).toBe(false);
  });

  it('FAILED → QUEUED with wrong trigger is rejected', () => {
    expect(canTransition('FAILED', 'QUEUED', 'claim').ok).toBe(false);
  });

  it('INDETERMINATE has no outgoing transitions', () => {
    expect(canTransition('INDETERMINATE', 'QUEUED').ok).toBe(false);
    expect(canTransition('INDETERMINATE', 'SUCCESS').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Specific §6.4 named prohibitions
// ---------------------------------------------------------------------------

describe('named prohibitions from §6.4', () => {
  it('CONFIRMING → SUBMITTING is forbidden', () => {
    expect(canTransition('CONFIRMING', 'SUBMITTING').ok).toBe(false);
  });

  it('CONFIRMING → NEEDS_RETRY is forbidden', () => {
    expect(canTransition('CONFIRMING', 'NEEDS_RETRY').ok).toBe(false);
  });

  it('BUILDING → CONFIRMING is forbidden', () => {
    expect(canTransition('BUILDING', 'CONFIRMING').ok).toBe(false);
  });

  it('BUILDING → SUBMITTING is forbidden (must go through SIGNING)', () => {
    expect(canTransition('BUILDING', 'SUBMITTING').ok).toBe(false);
  });

  it('SIGNING → CONFIRMING is forbidden (no envelope exists yet)', () => {
    expect(canTransition('SIGNING', 'CONFIRMING').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trigger mismatch (dedicated section)
// ---------------------------------------------------------------------------

describe('trigger mismatch — valid pair, wrong trigger', () => {
  it('QUEUED → READY only accepts claim', () => {
    expect(canTransition('QUEUED', 'READY', 'claim')).toEqual({ ok: true });
    expect(canTransition('QUEUED', 'READY', 'add-intent').ok).toBe(false);
    expect(canTransition('QUEUED', 'READY', 'write-ahead').ok).toBe(false);
  });

  it('SIGNING → SUBMITTING only accepts write-ahead', () => {
    expect(canTransition('SIGNING', 'SUBMITTING', 'write-ahead')).toEqual({ ok: true });
    expect(canTransition('SIGNING', 'SUBMITTING', 'submit-ack').ok).toBe(false);
  });

  it('SUBMITTING → CONFIRMING only accepts submit-ack', () => {
    expect(canTransition('SUBMITTING', 'CONFIRMING', 'submit-ack')).toEqual({ ok: true });
    expect(canTransition('SUBMITTING', 'CONFIRMING', 'verdict-success').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transition without trigger (trigger-agnostic check)
// ---------------------------------------------------------------------------

describe('transition without trigger', () => {
  it('canTransition without trigger returns ok for valid pairs', () => {
    expect(canTransition('QUEUED', 'READY')).toEqual({ ok: true });
    expect(canTransition('CREATED', 'QUEUED')).toEqual({ ok: true });
  });

  it('canTransition without trigger returns false for invalid pairs', () => {
    expect(canTransition('SUCCESS', 'QUEUED').ok).toBe(false);
    expect(canTransition('QUEUED', 'SUCCESS').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InvalidTransitionError
// ---------------------------------------------------------------------------

describe('validateTransition', () => {
  it('returns void for valid transitions', () => {
    expect(() => validateTransition('QUEUED', 'READY', 'claim')).not.toThrow();
  });

  it('throws InvalidTransitionError for invalid transitions', () => {
    expect(() => validateTransition('SUCCESS', 'QUEUED')).toThrow(InvalidTransitionError);
  });

  it('throws InvalidTransitionError for wrong trigger', () => {
    expect(() => validateTransition('QUEUED', 'READY', 'write-ahead')).toThrow(
      InvalidTransitionError,
    );
  });

  it('error carries from, to, trigger, and reason', () => {
    try {
      validateTransition('SUCCESS', 'QUEUED', 'claim');
      throw new Error('expected InvalidTransitionError');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.from).toBe('SUCCESS');
      expect(e.to).toBe('QUEUED');
      expect(e.trigger).toBe('claim');
      expect(e.code).toBe('invalid-transition');
      expect(typeof e.message).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe('isInFlight', () => {
  it('returns true for SUBMITTING and CONFIRMING', () => {
    expect(isInFlight('SUBMITTING')).toBe(true);
    expect(isInFlight('CONFIRMING')).toBe(true);
  });

  it('returns false for all other states', () => {
    for (const s of ALL_STATUSES) {
      if (s === 'SUBMITTING' || s === 'CONFIRMING') continue;
      expect(isInFlight(s)).toBe(false);
    }
  });
});

describe('isTerminal', () => {
  it('returns true for SUCCESS, FAILED, INDETERMINATE', () => {
    expect(isTerminal('SUCCESS')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('INDETERMINATE')).toBe(true);
  });

  it('returns false for all other states', () => {
    for (const s of ALL_STATUSES) {
      if (TERMINAL_STATES.includes(s)) continue;
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe('isPreSubmission', () => {
  it('returns true for CREATED, QUEUED, READY, BUILDING, SIGNING', () => {
    expect(isPreSubmission('CREATED')).toBe(true);
    expect(isPreSubmission('QUEUED')).toBe(true);
    expect(isPreSubmission('READY')).toBe(true);
    expect(isPreSubmission('BUILDING')).toBe(true);
    expect(isPreSubmission('SIGNING')).toBe(true);
  });

  it('returns false for in-flight and terminal states', () => {
    expect(isPreSubmission('SUBMITTING')).toBe(false);
    expect(isPreSubmission('CONFIRMING')).toBe(false);
    expect(isPreSubmission('SUCCESS')).toBe(false);
    expect(isPreSubmission('FAILED')).toBe(false);
    expect(isPreSubmission('EXPIRED')).toBe(false);
    expect(isPreSubmission('INDETERMINATE')).toBe(false);
  });
});

describe('isReclaimable', () => {
  const entry = (status: IntentStatus, claimExpiresAt: number): MinimalEntry => ({
    status,
    claimExpiresAt,
  });

  it('returns true for READY with expired lease', () => {
    expect(isReclaimable(entry('READY', 100), 200)).toBe(true);
  });

  it('returns false for READY with active lease', () => {
    expect(isReclaimable(entry('READY', 200), 100)).toBe(false);
  });

  it('returns false for READY with lease expiring exactly now', () => {
    expect(isReclaimable(entry('READY', 100), 100)).toBe(false);
  });

  it('returns false for any non-READY status even with expired lease', () => {
    for (const s of ALL_STATUSES) {
      if (s === 'READY') continue;
      expect(isReclaimable(entry(s, 0), 1000)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Purity: state.ts imports nothing from store/engine/adapters
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('TRANSITIONS is a plain data structure (no function values)', () => {
    for (const from of ALL_STATUSES) {
      const targets = TRANSITIONS[from];
      if (targets === undefined) continue;
      for (const [to, rule] of Object.entries(targets)) {
        expect(typeof rule).toBe('object');
        expect(rule).toHaveProperty('trigger');
        expect(to).toBeTruthy();
      }
    }
  });
});
