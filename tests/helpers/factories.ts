/**
 * Intent factories for tests (Phase 1 / Issue #2 and later phases).
 *
 * `validIntentInput` and `validIntent` are the canonical valid fixtures: all
 * other tests build on them and mutate one field at a time to probe a single
 * validation rule. `validAccountId` is a fixed, SDK-valid G… address so tests
 * that only need "a valid address" stay deterministic.
 */

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { createIntent } from '../../src/intent.js';
import type { CreateIntentInput, Intent } from '../../src/intent.js';
import type { IntentStatus } from '../../src/state.js';
import type { AttemptRecord, QueueEntry } from '../../src/store/types.js';

/** A fixed, SDK-valid Ed25519 public key (G… address) for tests. */
export const validAccountId = 'GAZ4BOIRV2JO5TAIKI2V4VOMYX45BW3VA3FOXGS6GGX4TY5YCFXTFPLR';

/** A second valid address, for destinations/issuers that must differ. */
export const otherAccountId = 'GA5BXUVTHLJXAP5M4ZZ7JIM6DYGVC4KQRXL7NQMOBRCOM5GJYKJWFQ63';

/** Canonical valid input: a single native-XLM payment. */
export function validIntentInput(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
  const base: CreateIntentInput = {
    sourceAccount: validAccountId,
    operations: [
      {
        type: 'payment',
        destination: otherAccountId,
        asset: { code: 'XLM' },
        amount: '10.50',
      },
    ],
  };
  return { ...base, ...overrides };
}

/** Canonical valid, fully-materialized intent (id + payloadHash set). */
export function validIntent(
  overrides: Partial<CreateIntentInput> = {},
  now: number = 1_700_000_000_000,
): Intent {
  return createIntent(validIntentInput(overrides), now);
}

/**
 * Canonical test timestamp (ms epoch). Store/ownership tests pass this (and
 * offsets from it) as the explicit `now` argument required by architecture
 * §9.2, keeping every test deterministic — no wall-clock sampling.
 */
export const TEST_NOW = 1_700_000_000_000;

/** Canonical lease duration for store/ownership tests (ADR-0010 default). */
export const TEST_LEASE_MS = 60_000;

/** 64-hex-char envelope-hash-shaped placeholder for write-ahead tests. */
export function fakeEnvelopeHash(): string {
  return randomUUID().replace(/-/g, '').repeat(2);
}

/** AttemptRecord fixture (one build cycle, write-ahead journal entry). */
export function makeAttemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    envelopeHash: fakeEnvelopeHash(),
    sequenceNumber: 100,
    submittedAt: TEST_NOW,
    outcome: 'UNKNOWN',
    ...overrides,
  };
}

/**
 * QueueEntry fixture: a fresh valid intent plus the given status. Each call
 * generates a new intent id (UUIDv4), so entries never collide unless the
 * caller supplies `overrides.intent` explicitly.
 */
export function makeQueueEntry(
  status: IntentStatus = 'QUEUED',
  overrides: Partial<QueueEntry> = {},
): QueueEntry {
  const intent = overrides.intent ?? validIntent();
  return {
    intent,
    status,
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: 0,
    backoffAttempts: 0,
    claimedBy: undefined,
    claimExpiresAt: 0,
    lastError: undefined,
    inFlightHashes: [],
    attempts: [],
    updatedAt: TEST_NOW,
    version: 1,
    ...overrides,
  };
}

/** A valid issued-asset config (USDC on the fixed issuer). */
export function issuedAsset(overrides: { code?: string; issuer?: string } = {}) {
  return { code: overrides.code ?? 'USDC', issuer: overrides.issuer ?? otherAccountId };
}

/** Assertion helper: expect `fn` to throw a `ValidationError` with `code`. */
export function expectValidationError(fn: () => unknown, code: string, field?: string): void {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; field?: string };
    expect(e.code).toBe(code);
    if (field !== undefined) {
      expect(e.field).toBe(field);
    }
    return;
  }
  throw new Error(`expected ValidationError with code "${code}" but nothing was thrown`);
}
