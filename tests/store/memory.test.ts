/**
 * MemoryStore tests (Phase 4 / Issue #5).
 *
 * - Full contract suite via `runStoreContractTests`.
 * - Memory-specific: clone isolation, mutex serialization (50-way concurrent
 *   transitions), clock injection for lease/backoff.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { runStoreContractTests } from './contract.js';
import type { QueueEntry } from '../../src/store/types.js';
import type { Intent, CreateIntentInput } from '../../src/intent.js';
import { createIntent } from '../../src/intent.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function intentInput(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
  return {
    sourceAccount: 'GAZ4BOIRV2JO5TAIKI2V4VOMYX45BW3VA3FOXGS6GGX4TY5YCFXTFPLR',
    operations: [
      {
        type: 'payment',
        destination: 'GA5BXUVTHLJXAP5M4ZZ7JIM6DYGVC4KQRXL7NQMOBRCOM5GJYKJWFQ63',
        asset: { code: 'XLM' },
        amount: '10.50',
      },
    ],
    ...overrides,
  };
}

function makeIntent(overrides: Partial<CreateIntentInput> = {}, now = 1_700_000_000_000): Intent {
  return createIntent(intentInput(overrides), now);
}

function makeEntry(status: 'QUEUED' | 'READY' | 'SUBMITTING' = 'QUEUED'): QueueEntry {
  const intent = makeIntent();
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
    updatedAt: 1_700_000_000_000,
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

runStoreContractTests('MemoryStore', () => Promise.resolve(new MemoryStore()));

// ---------------------------------------------------------------------------
// Memory-specific tests
// ---------------------------------------------------------------------------

describe('MemoryStore — clone isolation', () => {
  it('mutating a returned entry does not affect the store', async () => {
    const store = new MemoryStore();
    const entry = makeEntry();
    await store.insert(entry);

    const fetched = await store.get(entry.intent.id);
    expect(fetched).toBeDefined();

    // Mutate the fetched clone
    fetched!.status = 'FAILED';
    fetched!.attemptCount = 999;

    // Original in store is unaffected
    const refetched = await store.get(entry.intent.id);
    expect(refetched!.status).toBe('QUEUED');
    expect(refetched!.attemptCount).toBe(0);
  });

  it('mutating an inserted entry does not affect the store', async () => {
    const store = new MemoryStore();
    const entry = makeEntry();
    const inserted = await store.insert(entry);

    // Mutate the returned copy
    inserted.status = 'SUCCESS';

    // Original in store is unaffected
    const fetched = await store.get(entry.intent.id);
    expect(fetched!.status).toBe('QUEUED');
  });
});

describe('MemoryStore — mutex serialization', () => {
  it('50 concurrent transitions on one entry: exactly one wins per version, versions sequential', async () => {
    const store = new MemoryStore();
    const entry = makeEntry('QUEUED');
    await store.insert(entry);

    // Launch 50 concurrent transitions from QUEUED → READY (claim)
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.claim(entry.intent.id, ['QUEUED'], 1_700_000_000_000, 1, `worker-${i}`, 60_000),
      ),
    );

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(49);

    // Version incremented exactly once (1 → 2)
    const after = await store.get(entry.intent.id);
    expect(after).toBeDefined();
    expect(after!.version).toBe(2);
    expect(after!.status).toBe('READY');
    expect(after!.claimedBy).toBe('worker-0'); // first to process wins
  });

  it('sequential transitions produce strictly increasing versions', async () => {
    const store = new MemoryStore();
    const entry = makeEntry('QUEUED');
    await store.insert(entry);

    // Sequential: QUEUED → READY → BUILDING → SIGNING
    const v1 = await store.claim(entry.intent.id, ['QUEUED'], 0, 1, 'w', 60_000);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    const v2 = await store.transition(v1.entry.intent.id, ['READY'], 'BUILDING', {}, v2_entry_version(v1), 1);
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;

    const v3 = await store.transition(v2.entry.intent.id, ['BUILDING'], 'SIGNING', {}, v2_entry_version(v2), 2);
    expect(v3.ok).toBe(true);
    if (!v3.ok) return;

    // Versions: 1 → 2 → 3 → 4
    expect(v1.entry.version).toBe(2);
    expect(v2.entry.version).toBe(3);
    expect(v3.entry.version).toBe(4);
  });
});

function v2_entry_version(r: { ok: true; entry: QueueEntry }): number {
  return r.entry.version;
}

describe('MemoryStore — clock injection', () => {
  it('clock injection drives claim not-due without sleeps', async () => {
    let time = 1_000;
    const store = new MemoryStore({ now: () => time });

    const entry = makeEntry('QUEUED');
    entry.nextAttemptAt = 5_000; // not due until time=5000
    await store.insert(entry);

    // Claim at time=1000 should fail (not-due)
    const early = await store.claim(entry.intent.id, ['QUEUED'], time, 1, 'w', 60_000);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('not-due');

    // Advance clock to 5000
    time = 5_000;
    const late = await store.claim(entry.intent.id, ['QUEUED'], time, 1, 'w', 60_000);
    expect(late.ok).toBe(true);
  });

  it('clock injection drives lease expiry without sleeps', async () => {
    let time = 1_000;
    const store = new MemoryStore({ now: () => time });

    const entry = makeEntry('QUEUED');
    await store.insert(entry);

    // Claim with 60s lease
    const claimed = await store.claim(entry.intent.id, ['QUEUED'], time, 1, 'w', 60_000);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    // At time=60000 (lease not expired), entry is still READY
    time = 60_000;
    const before = await store.get(entry.intent.id);
    expect(before!.status).toBe('READY');

    // At time=61001 (lease expired), entry is still READY in store
    // (janitor reclaim is a separate transition, not automatic)
    time = 61_001;
    const after = await store.get(entry.intent.id);
    expect(after!.status).toBe('READY');
    expect(after!.claimExpiresAt).toBe(1_000 + 60_000); // original lease
  });
});

describe('MemoryStore — now() accessor', () => {
  it('returns the current clock value', () => {
    let time = 42;
    const store = new MemoryStore({ now: () => time });
    expect(store.now()).toBe(42);
    time = 100;
    expect(store.now()).toBe(100);
  });
});
