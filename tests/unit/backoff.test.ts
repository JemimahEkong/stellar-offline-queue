/**
 * Backoff schedule tests (Phase 7 / Issue #8, architecture §6.6, ADR-0010).
 *
 * All math is deterministic: `random` is injected (no real jitter, no sleeps).
 */

import { describe, it, expect } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  computeBackoffDelay,
  expBackoffCeiling,
  nextAttemptTime,
} from '../../src/backoff.js';

describe('defaults (ADR-0010 #4/#5)', () => {
  it('base is 1 000 ms and cap is 60 000 ms', () => {
    expect(BACKOFF_BASE_MS).toBe(1_000);
    expect(BACKOFF_CAP_MS).toBe(60_000);
  });
});

describe('expBackoffCeiling', () => {
  it('doubles per consecutive failure until the cap', () => {
    expect(expBackoffCeiling(0)).toBe(1_000);
    expect(expBackoffCeiling(1)).toBe(2_000);
    expect(expBackoffCeiling(2)).toBe(4_000);
    expect(expBackoffCeiling(3)).toBe(8_000);
  });

  it('caps at capMs', () => {
    expect(expBackoffCeiling(6)).toBe(60_000);
    expect(expBackoffCeiling(20)).toBe(60_000);
    expect(expBackoffCeiling(1_000)).toBe(60_000);
  });

  it('never overflows on huge attempt counts', () => {
    expect(Number.isFinite(expBackoffCeiling(10_000))).toBe(true);
  });

  it('respects custom base/cap', () => {
    expect(expBackoffCeiling(0, { baseMs: 500, capMs: 4_000 })).toBe(500);
    expect(expBackoffCeiling(4, { baseMs: 500, capMs: 4_000 })).toBe(4_000);
  });

  it('rejects invalid options', () => {
    expect(() => expBackoffCeiling(0, { baseMs: 0 })).toThrow(RangeError);
    expect(() => expBackoffCeiling(0, { baseMs: -1 })).toThrow(RangeError);
    expect(() => expBackoffCeiling(0, { capMs: 0 })).toThrow(RangeError);
    expect(() => expBackoffCeiling(0, { baseMs: 2_000, capMs: 1_000 })).toThrow(RangeError);
  });
});

describe('computeBackoffDelay (full jitter)', () => {
  it('delay = ceiling * random(0,1) with an injected random', () => {
    expect(computeBackoffDelay(0, { random: () => 0 })).toBe(0);
    expect(computeBackoffDelay(0, { random: () => 0.5 })).toBe(500);
    expect(computeBackoffDelay(1, { random: () => 0.25 })).toBe(500);
    expect(computeBackoffDelay(3, { random: () => 1 })).toBeCloseTo(8_000 - Number.EPSILON);
  });

  it('delay is always < cap regardless of the random draw', () => {
    // random() ∈ [0,1) — at the extreme draw, delay must stay below the cap.
    expect(computeBackoffDelay(20, { random: () => 0.999999 })).toBeLessThan(60_000);
  });

  it('monotone growth in expectation (statistical, seeded)', () => {
    // Deterministic pseudo-random walk: mean delay at attempts n+1 should
    // exceed the mean at n for the exponential component.
    let seed = 42;
    const rand = (): number => {
      // xorshift-ish deterministic PRNG; stable across runs/platforms.
      seed = (seed * 1103515245 + 12345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const meanAt = (attempts: number, n: number): number => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += computeBackoffDelay(attempts, { random: rand });
      return sum / n;
    };
    const low = meanAt(2, 500);
    const high = meanAt(5, 500);
    expect(high).toBeGreaterThan(low);
  });

  it('monotone growth holds deterministically at the ceiling', () => {
    expect(expBackoffCeiling(0) < expBackoffCeiling(1)).toBe(true);
    expect(expBackoffCeiling(1) < expBackoffCeiling(2)).toBe(true);
    expect(expBackoffCeiling(2) <= expBackoffCeiling(3)).toBe(true);
  });
});

describe('nextAttemptTime', () => {
  it('persists now + delay as the scheduler gate', () => {
    expect(nextAttemptTime(1_000_000, 0, { random: () => 0.1 })).toBe(1_000_000 + 100);
    expect(nextAttemptTime(1_000_000, 2, { random: () => 0.5 })).toBe(1_000_000 + 2_000);
  });

  it('is bounded by the cap for any attempt count', () => {
    expect(nextAttemptTime(0, 50, { random: () => 0.999 })).toBeLessThan(60_000);
  });
});

describe('budget decrement points (§6.6 + ADR-0008 semantics)', () => {
  it('backoffAttempts drives the schedule; the engine resets it on progress', () => {
    // The schedule is a pure function of consecutive transient failures;
    // budget (attemptCount) is engine/accounting state (engine.test.ts
    // asserts the write-ahead increment). Here: distinct backoffAttempts
    // give distinct ceilings.
    expect(expBackoffCeiling(0)).toBeLessThan(expBackoffCeiling(1));
    expect(expBackoffCeiling(1)).toBeLessThan(expBackoffCeiling(2));
  });
});
