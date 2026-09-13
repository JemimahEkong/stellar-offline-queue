/**
 * Processing-ownership tests (Phase 6 / Issue #7).
 *
 * Covers the concurrency matrix from the implementation plan on MemoryStore
 * with an injected clock (deterministic, no real sleeps):
 *
 * - two workers claim the same id → exactly one ok:true;
 * - expired lease: janitor reclaims to QUEUED, owner fields cleared, entry
 *   re-claimable;
 * - active lease: janitor leaves the entry untouched;
 * - lost ownership: a stale worker's refreshLease/transition fails with
 *   OwnershipLostError / CAS rejection — no store mutation succeeds;
 * - crash simulation: claim → abandon → clock advances past leaseMs →
 *   janitor reclaims → second worker processes;
 * - janitor race: two concurrent janitors reclaim the same entry → exactly
 *   one wins;
 * - never-reclaim guard: SUBMITTING/CONFIRMING entries are never touched by
 *   reclaimExpired even when their claimExpiresAt is stale.
 *
 * Named-test ↔ ADR-0007 rule mapping:
 * - rule 1/2 (exclusive CAS claim, loser aborts) → "two workers claim the
 *   same id: exactly one wins" + "lost ownership: stale worker cannot
 *   mutate the entry";
 * - rule 3 (lease, refresh) → "refreshLease extends the lease of the
 *   current owner";
 * - rule 4 (reclamation, never in-flight) → "janitor reclaims an expired
 *   lease…" + never-reclaim guard tests;
 * - rule 5 (crash recovery) → "crash simulation: …".
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import {
  claimEntry,
  refreshLease,
  reclaimExpired,
  withOwnership,
  createWorkerId,
} from '../../src/ownership.js';
import { OwnershipLostError } from '../../src/errors.js';
import { isInFlight } from '../../src/state.js';
import {
  TEST_LEASE_MS,
  TEST_NOW,
  makeQueueEntry,
  makeClaimedEntry,
} from '../helpers/factories.js';

// ---------------------------------------------------------------------------
// Worker identity (T6.1)
// ---------------------------------------------------------------------------

describe('createWorkerId', () => {
  it('uses the configured id when supplied', () => {
    expect(createWorkerId('payments-worker-1')).toBe('payments-worker-1');
  });

  it('generates a stable-format uuid id when not configured', () => {
    const id = createWorkerId();
    expect(id).toMatch(/^worker-[0-9a-f-]{36}$/);
    expect(createWorkerId()).not.toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Claim + lease (T6.2)
// ---------------------------------------------------------------------------

describe('claimEntry', () => {
  it('two workers claim the same id: exactly one wins (ADR-0007 rules 1–2)', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const a = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });
    const b = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-b',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) {
      // The loser hits the state conflict (entry is now READY under lease).
      expect(b.reason).toBe('state');
    }
    if (a.ok) {
      expect(a.entry.status).toBe('READY');
      expect(a.entry.claimedBy).toBe('worker-a');
      expect(a.entry.claimExpiresAt).toBe(TEST_NOW + TEST_LEASE_MS);
    }
  });

  it('claims from NEEDS_RETRY as well as QUEUED', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('NEEDS_RETRY');
    await store.insert(entry);

    const result = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.status).toBe('READY');
  });

  it('rejects a not-yet-due entry with reason not-due', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED', { nextAttemptAt: TEST_NOW + 5_000 });
    await store.insert(entry);

    const result = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-due');
  });

  it('rejects a missing entry with reason missing (never throws)', async () => {
    const store = new MemoryStore();
    const result = await claimEntry(store, 'no-such-id', {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing');
  });
});

describe('refreshLease', () => {
  it('extends the lease of the current owner', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const later = TEST_NOW + 30_000;
    const refreshed = await refreshLease(store, entry.intent.id, 'worker-a', TEST_LEASE_MS, later);
    expect(refreshed.claimExpiresAt).toBe(later + TEST_LEASE_MS);
    expect(refreshed.claimedBy).toBe('worker-a');
    expect(refreshed.status).toBe('READY');
  });

  it('throws OwnershipLostError after the janitor reclaimed the entry', async () => {
    const store = new MemoryStore();
    let clock = TEST_NOW;
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    // Lease expires; janitor reclaims before the owner refreshes.
    clock = TEST_NOW + TEST_LEASE_MS + 1;
    await reclaimExpired(store, clock);

    await expect(
      refreshLease(store, entry.intent.id, 'worker-a', TEST_LEASE_MS, clock),
    ).rejects.toThrow(OwnershipLostError);

    // And the rejection is the typed code, not a generic error.
    await expect(
      refreshLease(store, entry.intent.id, 'worker-a', TEST_LEASE_MS, clock),
    ).rejects.toMatchObject({ code: 'ownership-lost' });
  });

  it('throws OwnershipLostError when another worker holds the claim', async () => {
    const store = new MemoryStore();
    const entry = makeClaimedEntry({ claimedBy: 'worker-b' });
    await store.insert(entry);

    await expect(
      refreshLease(store, entry.intent.id, 'worker-a', TEST_LEASE_MS, TEST_NOW),
    ).rejects.toThrow(OwnershipLostError);
  });

  it('throws OwnershipLostError when the entry is not READY', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    await expect(
      refreshLease(store, entry.intent.id, 'worker-a', TEST_LEASE_MS, TEST_NOW),
    ).rejects.toThrow(OwnershipLostError);
  });

  it('throws OwnershipLostError when the entry no longer exists', async () => {
    const store = new MemoryStore();
    await expect(
      refreshLease(store, 'no-such-id', 'worker-a', TEST_LEASE_MS, TEST_NOW),
    ).rejects.toThrow(OwnershipLostError);
  });

  it('a refresh racing a reclaim loses: exactly one side-effecting winner', async () => {
    const store = new MemoryStore();
    let clock = TEST_NOW;
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    clock = TEST_NOW + TEST_LEASE_MS + 1;

    // Janitor and owner refresh race on the same version.
    const [reclaimed, refreshed] = await Promise.all([
      reclaimExpired(store, clock),
      refreshLease(store, entry.intent.id, 'worker-a', TEST_LEASE_MS, clock).then(
        () => 'refreshed' as const,
        () => 'lost' as const,
      ),
    ]);

    const final = await store.get(entry.intent.id);
    expect(final).toBeDefined();
    if (reclaimed.length === 1) {
      // Janitor won: entry is QUEUED, unclaimed, and the refresh lost.
      expect(final!.status).toBe('QUEUED');
      expect(final!.claimedBy).toBeUndefined();
      expect(refreshed).toBe('lost');
    } else {
      // Refresh won: lease is live again and the janitor skipped it.
      expect(refreshed).toBe('refreshed');
      expect(final!.status).toBe('READY');
      expect(final!.claimExpiresAt).toBe(clock + TEST_LEASE_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// Janitor reclamation (T6.2)
// ---------------------------------------------------------------------------

describe('reclaimExpired (janitor core)', () => {
  it('janitor reclaims an expired lease: QUEUED, owner fields cleared, re-claimable', async () => {
    const store = new MemoryStore();
    let clock = TEST_NOW;
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    clock = TEST_NOW + TEST_LEASE_MS + 1;
    const reclaimedIds = await reclaimExpired(store, clock);
    expect(reclaimedIds).toEqual([entry.intent.id]);

    const after = await store.get(entry.intent.id);
    expect(after!.status).toBe('QUEUED');
    expect(after!.claimedBy).toBeUndefined();
    expect(after!.claimExpiresAt).toBe(0);

    // Entry is re-claimable by a different worker.
    const reClaimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-b',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(reClaimed.ok).toBe(true);
    if (reClaimed.ok) expect(reClaimed.entry.claimedBy).toBe('worker-b');
  });

  it('janitor leaves a live lease untouched (active claims never stolen)', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    // Clock still inside the lease.
    const reclaimedIds = await reclaimExpired(store, TEST_NOW + TEST_LEASE_MS - 1);
    expect(reclaimedIds).toEqual([]);

    const after = await store.get(entry.intent.id);
    expect(after!.status).toBe('READY');
    expect(after!.claimedBy).toBe('worker-a');
    expect(after!.claimExpiresAt).toBe(TEST_NOW + TEST_LEASE_MS);
  });

  it('boundary: lease expiry is strict (claimExpiresAt < now, not ≤)', async () => {
    const store = new MemoryStore();
    const entry = makeClaimedEntry();
    await store.insert(entry);

    // Exactly at expiry: not yet reclaimable.
    expect(await reclaimExpired(store, TEST_NOW + TEST_LEASE_MS)).toEqual([]);
    // One ms past: reclaimable.
    expect(await reclaimExpired(store, TEST_NOW + TEST_LEASE_MS + 1)).toEqual([
      entry.intent.id,
    ]);
  });

  it('janitor race: two concurrent janitors reclaim the same entry → exactly one wins', async () => {
    const store = new MemoryStore();
    let clock = TEST_NOW;
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    clock = TEST_NOW + TEST_LEASE_MS + 1;
    const [idsA, idsB] = await Promise.all([
      reclaimExpired(store, clock),
      reclaimExpired(store, clock),
    ]);

    // Exactly one reclaimed it; the other returned nothing for this entry.
    const total = [...idsA, ...idsB].filter((id) => id === entry.intent.id);
    expect(total).toHaveLength(1);

    const after = await store.get(entry.intent.id);
    expect(after!.status).toBe('QUEUED');
    expect(after!.claimedBy).toBeUndefined();
  });

  it('never-reclaim guard: SUBMITTING entries are never touched even with stale claimExpiresAt', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('SUBMITTING', {
      claimedBy: 'worker-a',
      claimExpiresAt: TEST_NOW - 1_000_000, // long stale
      inFlightHashes: ['a'.repeat(64)],
    });
    await store.insert(entry);

    const reclaimedIds = await reclaimExpired(store, TEST_NOW);
    expect(reclaimedIds).toEqual([]);

    const after = await store.get(entry.intent.id);
    expect(after!.status).toBe('SUBMITTING');
    expect(after!.claimedBy).toBe('worker-a');
    expect(after!.claimExpiresAt).toBe(TEST_NOW - 1_000_000);
  });

  it('never-reclaim guard: CONFIRMING entries are never touched (regression)', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('CONFIRMING', {
      claimedBy: 'worker-a',
      claimExpiresAt: TEST_NOW - 1_000_000,
      inFlightHashes: ['b'.repeat(64)],
    });
    await store.insert(entry);

    const reclaimedIds = await reclaimExpired(store, TEST_NOW);
    expect(reclaimedIds).toEqual([]);

    const after = await store.get(entry.intent.id);
    expect(after!.status).toBe('CONFIRMING');
  });

  it('never-reclaim guard is structural: reclaimExpired only ever lists READY', async () => {
    const store = new MemoryStore();
    // Seed one entry in every in-flight state with long-stale leases.
    for (const status of ['SUBMITTING', 'CONFIRMING'] as const) {
      await store.insert(
        makeQueueEntry(status, {
          claimedBy: 'worker-a',
          claimExpiresAt: 1,
          inFlightHashes: ['c'.repeat(64)],
        }),
      );
    }
    expect(isInFlight('SUBMITTING')).toBe(true);
    expect(isInFlight('CONFIRMING')).toBe(true);
    expect(await reclaimExpired(store, TEST_NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lost-ownership abort (T6.4, invariant §6.5.5)
// ---------------------------------------------------------------------------

describe('lost-ownership abort', () => {
  it('lost ownership: stale worker cannot perform any successful store mutation', async () => {
    const store = new MemoryStore();
    let clock = TEST_NOW;
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const staleVersion = claimed.entry.version;

    // Ownership lost: janitor reclaims, second worker takes over.
    clock = TEST_NOW + TEST_LEASE_MS + 1;
    await reclaimExpired(store, clock);
    const taken = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-b',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(taken.ok).toBe(true);

    // The stale worker tries every mutation it would need to submit —
    // all must fail, so no submit-side effects are possible at API level.
    const staleTransition = await store.transition(
      entry.intent.id,
      ['READY'],
      'BUILDING',
      {},
      staleVersion,
      clock,
    );
    expect(staleTransition.ok).toBe(false);

    await expect(
      refreshLease(store, entry.intent.id, 'worker-a', TEST_LEASE_MS, clock),
    ).rejects.toThrow(OwnershipLostError);

    // Full proof of no submit lands in Phase 13/19; here the API-level
    // guarantee is: every store CAS the stale worker attempts fails.
  });

  it('withOwnership: runs fn only when ownership was acquired', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const failed: Awaited<ReturnType<typeof claimEntry>> = {
      ok: false,
      reason: 'state',
    };
    await expect(
      withOwnership(store, entry.intent.id, failed, 'worker-a', () => {
        throw new Error('must not run');
      }),
    ).rejects.toThrow(OwnershipLostError);

    // Entry untouched.
    const after = await store.get(entry.intent.id);
    expect(after!.status).toBe('QUEUED');
  });

  it('withOwnership: fn sees the claimed entry and store', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const result = await withOwnership(store, entry.intent.id, claimed, 'worker-a', (owned, ownedStore) => {
      expect(owned.intent.id).toBe(entry.intent.id);
      return ownedStore.get(owned.intent.id).then((fetched) => {
        expect(fetched).toBeDefined();
        expect(fetched!.claimedBy).toBe('worker-a');
        return 42;
      });
    });
    expect(result).toBe(42);
  });

  it('withOwnership: propagates OwnershipLostError thrown inside fn without wrapping', async () => {
    const store = new MemoryStore();
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: TEST_NOW,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    await expect(
      withOwnership(store, entry.intent.id, claimed, 'worker-a', () => {
        throw new OwnershipLostError(entry.intent.id, 'worker-a', 'lease expired mid-phase');
      }),
    ).rejects.toThrow(OwnershipLostError);
  });
});

// ---------------------------------------------------------------------------
// Crash recovery (ADR-0007 rule 5)
// ---------------------------------------------------------------------------

describe('crash simulation', () => {
  it('crashed worker: claim → abandon → clock passes leaseMs → janitor reclaims → second worker processes', async () => {
    const store = new MemoryStore();
    let clock = TEST_NOW;
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    // Worker A claims, then "crashes" — no further calls, clock moves on.
    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.entry.status).toBe('READY');

    clock = TEST_NOW + TEST_LEASE_MS + 1;
    const reclaimedIds = await reclaimExpired(store, clock);
    expect(reclaimedIds).toEqual([entry.intent.id]);

    // Worker B processes the entry from scratch.
    const b = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-b',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.entry.claimedBy).toBe('worker-b');
      expect(b.entry.claimExpiresAt).toBe(clock + TEST_LEASE_MS);
    }
  });

  it('crash during in-memory phases leaves the entry READY (transient states never persisted)', async () => {
    const store = new MemoryStore();
    let clock = TEST_NOW;
    const entry = makeQueueEntry('QUEUED');
    await store.insert(entry);

    const claimed = await claimEntry(store, entry.intent.id, {
      workerId: 'worker-a',
      leaseMs: TEST_LEASE_MS,
      now: clock,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    // "Crash" between claim and write-ahead: BUILDING/SIGNING are in-memory
    // only; the durable record is still READY under the lease.
    const durable = await store.get(entry.intent.id);
    expect(durable!.status).toBe('READY');

    clock = TEST_NOW + TEST_LEASE_MS + 1;
    await reclaimExpired(store, clock);
    const after = await store.get(entry.intent.id);
    expect(after!.status).toBe('QUEUED');
  });
});
