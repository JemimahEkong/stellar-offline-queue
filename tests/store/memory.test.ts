/**
 * MemoryStore tests (Phase 4 / Issue #5).
 *
 * Two layers:
 * 1. The full `runStoreContractTests` suite — MemoryStore must pass the same
 *    contract every other adapter passes (this is the point of the suite).
 * 2. Memory-specific tests mandated by the plan: clone isolation, mutex
 *    serialization under concurrent mutations, injected-clock lease/not-due
 *    behaviour without real sleeps, and deterministic ordering.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { isReclaimable } from '../../src/state.js';
import { TEST_LEASE_MS, TEST_NOW, makeQueueEntry, validIntent } from '../helpers/factories.js';
import { runStoreContractTests } from './contract.js';

// ---------------------------------------------------------------------------
// Layer 1: full contract suite
// ---------------------------------------------------------------------------

// (No `durable` option: MemoryStore makes no persistence claim — the suite's
// non-durable variant documents that, per architecture §15.5.)
runStoreContractTests('MemoryStore', () => Promise.resolve(new MemoryStore()));

// ---------------------------------------------------------------------------
// Layer 2: memory-specific behaviour
// ---------------------------------------------------------------------------

describe('MemoryStore: memory-specific', () => {
  it('clone isolation: mutating a returned entry does not affect the store', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');

    const inserted = await store.insert(entry);
    inserted.status = 'FAILED';
    inserted.attemptCount = 99;
    inserted.inFlightHashes.push('tampered');
    inserted.intent.sourceAccount = 'G tampered';

    const fetched = await store.get(entry.intent.id);
    expect(fetched).toBeDefined();
    expect(fetched!.status).toBe('QUEUED');
    expect(fetched!.attemptCount).toBe(0);
    expect(fetched!.inFlightHashes).toEqual([]);
    expect(fetched!.intent.sourceAccount).toBe(entry.intent.sourceAccount);

    // And the reverse direction: mutating the caller's own object before
    // insert must not leak into already-stored state on re-read.
    entry.status = 'FAILED';
    const again = await store.get(entry.intent.id);
    expect(again!.status).toBe('QUEUED');
  });

  it('clone isolation: mutating a claimed entry cannot mutate stored state', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await store.claim(
      entry.intent.id,
      ['QUEUED'],
      TEST_NOW,
      entry.version,
      'worker-a',
      TEST_LEASE_MS,
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    claimed.entry.claimedBy = 'worker-hijack';
    claimed.entry.claimExpiresAt = 0;

    const fetched = await store.get(entry.intent.id);
    expect(fetched!.status).toBe('READY');
    expect(fetched!.claimedBy).toBe('worker-a');
    expect(fetched!.claimExpiresAt).toBe(TEST_NOW + TEST_LEASE_MS);
  });

  it('mutex serialization: 50 concurrent transitions produce strictly sequential versions', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('READY');
    await store.insert(entry);
    expect(entry.version).toBe(1);

    // 50 racing transitions, all from version 1. CAS allows exactly one to
    // win from that version; the mutex guarantees no interleaved
    // read-modify-write silently merges them. Fire and await them all.
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.transition(entry.intent.id, ['READY'], 'BUILDING', {}, 1, TEST_NOW),
      ),
    );

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(49);
    for (const loss of losses) {
      if (!loss.ok) expect(['state', 'version']).toContain(loss.reason);
    }

    const final = await store.get(entry.intent.id);
    expect(final!.version).toBe(2);
    expect(final!.status).toBe('BUILDING');
  });

  it('mutex serialization: concurrent claims yield exactly one winner (50-way race)', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.claim(
          entry.intent.id,
          ['QUEUED'],
          TEST_NOW,
          entry.version,
          `worker-${i}`,
          TEST_LEASE_MS,
        ),
      ),
    );

    const wins = results.filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    const fetched = await store.get(entry.intent.id);
    expect(fetched!.status).toBe('READY');
    expect(fetched!.version).toBe(2);
  });

  it('clock injection: lease expiry driven without real sleeps', async () => {
    let clock = TEST_NOW;
    const store = new MemoryStore({ now: () => clock });
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await store.claim(
      entry.intent.id,
      ['QUEUED'],
      TEST_NOW,
      entry.version,
      'worker-a',
      TEST_LEASE_MS,
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    // Lease still live: not reclaimable.
    expect(claimed.entry.claimExpiresAt).toBe(TEST_NOW + TEST_LEASE_MS);
    expect(isReclaimable(claimed.entry, clock)).toBe(false);

    // Advance the injected clock past the lease — no real sleep involved.
    clock = TEST_NOW + TEST_LEASE_MS + 1;
    expect(isReclaimable(claimed.entry, clock)).toBe(true);

    // Janitor reclaim (READY → QUEUED) clears owner fields via CAS.
    const reclaimed = await store.transition(
      entry.intent.id,
      ['READY'],
      'QUEUED',
      { claimedBy: undefined, claimExpiresAt: 0 },
      claimed.entry.version,
      clock,
    );
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.entry.status).toBe('QUEUED');
    expect(reclaimed.entry.claimedBy).toBeUndefined();
    expect(reclaimed.entry.claimExpiresAt).toBe(0);

    // Entry is re-claimable by a different worker.
    const reClaimed = await store.claim(
      entry.intent.id,
      ['QUEUED'],
      clock,
      reclaimed.entry.version,
      'worker-b',
      TEST_LEASE_MS,
    );
    expect(reClaimed.ok).toBe(true);
    if (reClaimed.ok) expect(reClaimed.entry.claimedBy).toBe('worker-b');
  });

  it('clock injection: not-due claim gating driven without real sleeps', async () => {
    let clock = TEST_NOW;
    const store = new MemoryStore({ now: () => clock });
    // Backoff-scheduled entry: due at TEST_NOW + 30s.
    const entry = makeQueueEntry('NEEDS_RETRY', { nextAttemptAt: TEST_NOW + 30_000 });
    await store.insert(entry);

    // Not due yet at the current clock time.
    const early = await store.claim(
      entry.intent.id,
      ['QUEUED', 'NEEDS_RETRY'],
      clock,
      entry.version,
      'worker-a',
      TEST_LEASE_MS,
    );
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('not-due');

    // Advance the clock past the schedule — claim now succeeds.
    clock = TEST_NOW + 30_001;
    const due = await store.claim(
      entry.intent.id,
      ['QUEUED', 'NEEDS_RETRY'],
      clock,
      entry.version,
      'worker-a',
      TEST_LEASE_MS,
    );
    expect(due.ok).toBe(true);
    if (due.ok) expect(due.entry.status).toBe('READY');
  });

  it('clock injection: store.now() reflects the injected clock', () => {
    const clock = TEST_NOW + 42;
    const store = new MemoryStore({ now: () => clock });
    expect(store.now()).toBe(clock);
  });

  it('deterministic ordering: listDue/listByState/list sort by createdAt then id', async () => {
    const store = new MemoryStore();

    // Same createdAt, ids deliberately inserted out of lexicographic order.
    const later = makeQueueEntry('QUEUED', { intent: validIntent({ id: 'b-id' }, TEST_NOW) });
    const earlier = makeQueueEntry('QUEUED', {
      intent: validIntent({ id: 'a-id' }, TEST_NOW - 1000),
    });
    const tie = makeQueueEntry('QUEUED', { intent: validIntent({ id: 'a-id0' }, TEST_NOW) });

    await store.insert(later);
    await store.insert(earlier);
    await store.insert(tie);

    const expectedOrder = [earlier.intent.id, tie.intent.id, later.intent.id];

    const due = await store.listDue(['QUEUED'], TEST_NOW);
    expect(due.map((e) => e.intent.id)).toEqual(expectedOrder);

    const byState = await store.listByState(['QUEUED']);
    expect(byState.map((e) => e.intent.id)).toEqual(expectedOrder);

    const all = await store.list();
    expect(all.map((e) => e.intent.id)).toEqual(expectedOrder);

    // limit slices after sorting (deterministic prefix).
    const limited = await store.list({ limit: 2 });
    expect(limited.map((e) => e.intent.id)).toEqual(expectedOrder.slice(0, 2));
  });

  it('list() without a sort-stable tie cannot be broken by insertion order', async () => {
    const store = new MemoryStore();
    // Insert identical-createdAt entries in reverse id order; output must not
    // depend on insertion order.
    const ids = ['c-id', 'b-id', 'a-id'];
    for (const id of ids) {
      await store.insert(makeQueueEntry('QUEUED', { intent: validIntent({ id }, TEST_NOW) }));
    }
    const all = await store.list();
    expect(all.map((e) => e.intent.id)).toEqual(['a-id', 'b-id', 'c-id']);
  });

  it('defense-in-depth: remove refuses an in-flight entry even with permissive fromStates', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('SUBMITTING', {
      inFlightHashes: ['a'.repeat(64)],
    });
    await store.insert(entry);

    // Caller (incorrectly) passes SUBMITTING itself in fromStates; the store
    // still refuses because the hash is in flight (ADR-0011).
    const removed = await store.remove(entry.intent.id, ['SUBMITTING'], entry.version);
    expect(removed).toBe(false);
    const fetched = await store.get(entry.intent.id);
    expect(fetched).toBeDefined();
  });

  it('non-durable: close() discards state (documented, architecture §15.5)', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);
    await store.close();

    const fetched = await store.get(entry.intent.id);
    expect(fetched).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('is idempotently closeable (safe in afterAll)', async () => {
    const store = new MemoryStore();
    await store.insert(makeQueueEntry('QUEUED'));
    await store.close();
    await store.close(); // must not throw
    expect(await store.list()).toEqual([]);
  });

  it('insert rejects a corrupted duplicate the same as any duplicate: existing entry returned', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const bogus = makeQueueEntry('SUCCESS', { intent: entry.intent, version: 999 });
    const result = await store.insert(bogus);
    expect(result.status).toBe('QUEUED');
    expect(result.version).toBe(1);
  });
});
