/**
 * Contract test suite for QueueStore adapters (Phase 3 / Issue #4).
 *
 * Every adapter (MemoryStore, SqliteStore) must pass this suite. The suite is
 * parameterized: each adapter's test file calls `runStoreContractTests` with
 * a factory that creates a fresh store instance.
 *
 * Coverage per implementation plan §Phase 3 Tests:
 * - insert/get round-trip; duplicate id insert returns existing
 * - get missing → undefined
 * - claim: success from QUEUED/NEEDS_RETRY; fail reasons (state, not-due, version, missing)
 * - transition: success applies update atomically; fail reasons (state, version, missing)
 * - write-ahead shape: transition from SIGNING to SUBMITTING with inFlightHashes
 * - listDue filtering and ordering
 * - listByState
 * - list with opts
 * - remove: success pre-submission; rejects in-flight, stale version, missing
 * - lease fields: janitor-reclaim clears claimedBy/claimExpiresAt
 * - restart durability variant (adapter-specific)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { QueueStore, QueueEntry, AttemptRecord } from '../../src/store/types.js';
import type { IntentStatus } from '../../src/state.js';
import type { Intent, CreateIntentInput } from '../../src/intent.js';
import { createIntent } from '../../src/intent.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WORKER_A = 'worker-a';
const WORKER_B = 'worker-b';
const LEASE_MS = 60_000;
const NOW = 1_700_000_000_000;

/** Minimal valid intent input for fixtures. */
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

/** Create a valid intent. */
function makeIntent(overrides: Partial<CreateIntentInput> = {}, now = NOW): Intent {
  return createIntent(intentInput(overrides), now);
}

/** Create a QueueEntry with default values. */
function makeEntry(
  status: IntentStatus = 'QUEUED',
  overrides: Partial<QueueEntry> = {},
): QueueEntry {
  const intent = overrides.intent ?? makeIntent();
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
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

/** Sample attempt record for write-ahead tests. */
function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    envelopeHash: randomUUID().replace(/-/g, '').slice(0, 64),
    sequenceNumber: 100,
    submittedAt: NOW,
    outcome: 'UNKNOWN',
    maxTime: NOW + 300_000,
    fee: '100',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract test runner
// ---------------------------------------------------------------------------

export type StoreFactory = () => Promise<QueueStore & { close?(): Promise<void> }>;

/**
 * Run the full contract test suite against a store factory.
 * Each adapter's test file calls this with its own factory.
 */
export function runStoreContractTests(name: string, makeStore: StoreFactory): void {
  describe(`${name} contract suite`, () => {
    let store: QueueStore & { close?(): Promise<void> };

    beforeAll(async () => {
      store = await makeStore();
    });

    afterAll(async () => {
      await store.close?.();
    });

    // -----------------------------------------------------------------------
    // insert / get
    // -----------------------------------------------------------------------

    describe('insert and get', () => {
      it('insert returns the entry and get retrieves it', async () => {
        const entry = makeEntry('QUEUED');
        const inserted = await store.insert(entry);
        expect(inserted.intent.id).toBe(entry.intent.id);
        expect(inserted.status).toBe('QUEUED');

        const fetched = await store.get(entry.intent.id);
        expect(fetched).toBeDefined();
        expect(fetched!.intent.id).toBe(entry.intent.id);
        expect(fetched!.status).toBe('QUEUED');
      });

      it('duplicate insert returns the existing entry without mutating', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        // Insert again with same id
        const duplicate = makeEntry('QUEUED', { intent: entry.intent });
        const result = await store.insert(duplicate);
        expect(result.intent.id).toBe(entry.intent.id);
        expect(result.version).toBe(1); // unchanged

        // Original is still there unchanged
        const fetched = await store.get(entry.intent.id);
        expect(fetched!.version).toBe(1);
      });

      it('get missing returns undefined', async () => {
        const result = await store.get('nonexistent-' + randomUUID());
        expect(result).toBeUndefined();
      });
    });

    // -----------------------------------------------------------------------
    // claim
    // -----------------------------------------------------------------------

    describe('claim', () => {
      it('claims a QUEUED entry successfully', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const result = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          entry.version,
          WORKER_A,
          LEASE_MS,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.entry.status).toBe('READY');
          expect(result.entry.claimedBy).toBe(WORKER_A);
          expect(result.entry.claimExpiresAt).toBe(NOW + LEASE_MS);
          expect(result.entry.version).toBe(2);
        }
      });

      it('claims a NEEDS_RETRY entry successfully', async () => {
        const entry = makeEntry('NEEDS_RETRY');
        await store.insert(entry);

        const result = await store.claim(
          entry.intent.id,
          ['QUEUED', 'NEEDS_RETRY'],
          NOW,
          entry.version,
          WORKER_A,
          LEASE_MS,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.entry.status).toBe('READY');
        }
      });

      it('rejects claim with wrong status', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        // Try to claim from SUBMITTING (wrong state)
        const result = await store.claim(
          entry.intent.id,
          ['SUBMITTING'],
          NOW,
          entry.version,
          WORKER_A,
          LEASE_MS,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('state');
        }
      });

      it('rejects claim when not due (nextAttemptAt > now)', async () => {
        const entry = makeEntry('QUEUED', { nextAttemptAt: NOW + 100_000 });
        await store.insert(entry);

        const result = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          entry.version,
          WORKER_A,
          LEASE_MS,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('not-due');
        }
      });

      it('rejects claim with stale version', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const result = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          entry.version + 1, // stale
          WORKER_A,
          LEASE_MS,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('version');
        }
      });

      it('rejects claim for missing entry', async () => {
        const result = await store.claim(
          'nonexistent-' + randomUUID(),
          ['QUEUED'],
          NOW,
          1,
          WORKER_A,
          LEASE_MS,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('missing');
        }
      });

      it('double claim fails: second worker gets state conflict', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const a = await store.claim(entry.intent.id, ['QUEUED'], NOW, entry.version, WORKER_A, LEASE_MS);
        expect(a.ok).toBe(true);
        if (!a.ok) return;

        const b = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          a.entry.version, // version is now stale (2, but entry was claimed so status is READY)
          WORKER_B,
          LEASE_MS,
        );
        // Should fail because status is now READY, not QUEUED
        expect(b.ok).toBe(false);
        if (!b.ok) {
          expect(b.reason).toBe('state');
        }
      });
    });

    // -----------------------------------------------------------------------
    // transition
    // -----------------------------------------------------------------------

    describe('transition', () => {
      it('transitions READY → BUILDING and applies update', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const claimed = await store.claim(entry.intent.id, ['QUEUED'], NOW, entry.version, WORKER_A, LEASE_MS);
        expect(claimed.ok).toBe(true);
        if (!claimed.ok) return;

        const result = await store.transition(
          claimed.entry.intent.id,
          ['READY'],
          'BUILDING',
          { updatedAt: NOW + 1 },
          claimed.entry.version,
          NOW + 1,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.entry.status).toBe('BUILDING');
          expect(result.entry.version).toBe(3);
          expect(result.entry.updatedAt).toBe(NOW + 1);
        }
      });

      it('rejects transition with wrong status', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const result = await store.transition(
          entry.intent.id,
          ['SUBMITTING'], // wrong: entry is QUEUED
          'READY',
          {},
          entry.version,
          NOW,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('state');
        }
      });

      it('rejects transition with stale version', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const result = await store.transition(
          entry.intent.id,
          ['QUEUED'],
          'FAILED',
          {},
          entry.version + 1, // stale
          NOW,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('version');
        }
      });

      it('rejects transition for missing entry', async () => {
        const result = await store.transition(
          'nonexistent-' + randomUUID(),
          ['QUEUED'],
          'FAILED',
          {},
          1,
          NOW,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('missing');
        }
      });

      it('atomic transition: inFlightHashes append in one write', async () => {
        const entry = makeEntry('SIGNING');
        await store.insert(entry);

        const hash1 = randomUUID().replace(/-/g, '').slice(0, 64);
        const attempt = makeAttempt({ envelopeHash: hash1 });

        const result = await store.transition(
          entry.intent.id,
          ['SIGNING'],
          'SUBMITTING',
          {
            inFlightHashes: [hash1],
            attempts: [attempt],
            attemptCount: 1,
          },
          entry.version,
          NOW,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.entry.status).toBe('SUBMITTING');
          expect(result.entry.inFlightHashes).toEqual([hash1]);
          expect(result.entry.attempts).toHaveLength(1);
          const attempt = result.entry.attempts[0];
          expect(attempt).toBeDefined();
          expect(attempt!.envelopeHash).toBe(hash1);
        }
      });
    });

    // -----------------------------------------------------------------------
    // listDue
    // -----------------------------------------------------------------------

    describe('listDue', () => {
      it('returns entries in QUEUED/NEEDS_RETRY with nextAttemptAt ≤ dueBefore', async () => {
        const e1 = makeEntry('QUEUED', { nextAttemptAt: NOW - 1000 });
        const e2 = makeEntry('QUEUED', { nextAttemptAt: NOW + 100_000 }); // not due
        const e3 = makeEntry('NEEDS_RETRY', { nextAttemptAt: NOW });

        await store.insert(e1);
        await store.insert(e2);
        await store.insert(e3);

        const due = await store.listDue(['QUEUED', 'NEEDS_RETRY'], NOW);
        const ids = due.map((e) => e.intent.id);
        expect(ids).toContain(e1.intent.id);
        expect(ids).toContain(e3.intent.id);
        expect(ids).not.toContain(e2.intent.id);
      });

      it('orders by createdAt then id (deterministic)', async () => {
        const e1 = makeEntry('QUEUED', { nextAttemptAt: 0 });
        const e2 = makeEntry('QUEUED', { nextAttemptAt: 0 });

        // Ensure different createdAt
        e1.intent = makeIntent({ id: e1.intent.id }, NOW - 1000);
        e2.intent = makeIntent({ id: e2.intent.id }, NOW);

        await store.insert(e1);
        await store.insert(e2);

        const due = await store.listDue(['QUEUED'], NOW);
        expect(due.length).toBeGreaterThanOrEqual(2);
        // First entry should have earlier createdAt
        const first = due[0];
        const second = due[1];
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(first!.intent.createdAt).toBeLessThanOrEqual(second!.intent.createdAt);
      });
    });

    // -----------------------------------------------------------------------
    // listByState
    // -----------------------------------------------------------------------

    describe('listByState', () => {
      it('returns all entries in the given states', async () => {
        const e1 = makeEntry('SUBMITTING');
        const e2 = makeEntry('CONFIRMING');
        const e3 = makeEntry('QUEUED');

        await store.insert(e1);
        await store.insert(e2);
        await store.insert(e3);

        const result = await store.listByState(['SUBMITTING', 'CONFIRMING']);
        const ids = result.map((e) => e.intent.id);
        expect(ids).toContain(e1.intent.id);
        expect(ids).toContain(e2.intent.id);
        expect(ids).not.toContain(e3.intent.id);
      });
    });

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------

    describe('list', () => {
      it('returns all entries when no opts', async () => {
        const e1 = makeEntry('QUEUED');
        const e2 = makeEntry('FAILED');
        await store.insert(e1);
        await store.insert(e2);

        const all = await store.list();
        expect(all.length).toBeGreaterThanOrEqual(2);
      });

      it('filters by status', async () => {
        const e1 = makeEntry('QUEUED');
        const e2 = makeEntry('FAILED');
        await store.insert(e1);
        await store.insert(e2);

        const queued = await store.list({ status: 'QUEUED' });
        expect(queued.every((e) => e.status === 'QUEUED')).toBe(true);
      });

      it('filters by account', async () => {
        const account = 'GA5BXUVTHLJXAP5M4ZZ7JIM6DYGVC4KQRXL7NQMOBRCOM5GJYKJWFQ63';
        const intent = makeIntent({ sourceAccount: account });
        const entry = makeEntry('QUEUED', { intent });
        await store.insert(entry);

        const result = await store.list({ account });
        expect(result.some((e) => e.intent.sourceAccount === account)).toBe(true);
      });

      it('respects limit', async () => {
        for (let i = 0; i < 5; i++) {
          await store.insert(makeEntry('QUEUED'));
        }

        const result = await store.list({ limit: 2 });
        expect(result.length).toBeLessThanOrEqual(2);
      });
    });

    // -----------------------------------------------------------------------
    // remove
    // -----------------------------------------------------------------------

    describe('remove', () => {
      it('removes a pre-submission entry', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const result = await store.remove(entry.intent.id, ['QUEUED'], entry.version);
        expect(result).toBe(true);

        const fetched = await store.get(entry.intent.id);
        expect(fetched).toBeUndefined();
      });

      it('rejects remove with wrong status', async () => {
        const entry = makeEntry('SUBMITTING');
        await store.insert(entry);

        const result = await store.remove(entry.intent.id, ['QUEUED'], entry.version);
        expect(result).toBe(false);
      });

      it('rejects remove with stale version', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const result = await store.remove(entry.intent.id, ['QUEUED'], entry.version + 1);
        expect(result).toBe(false);
      });

      it('rejects remove for missing entry', async () => {
        const result = await store.remove('nonexistent-' + randomUUID(), ['QUEUED'], 1);
        expect(result).toBe(false);
      });
    });

    // -----------------------------------------------------------------------
    // Lease fields and janitor reclaim
    // -----------------------------------------------------------------------

    describe('lease and janitor reclaim', () => {
      it('claim sets claimedBy and claimExpiresAt', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const claimed = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          entry.version,
          WORKER_A,
          LEASE_MS,
        );
        expect(claimed.ok).toBe(true);
        if (claimed.ok) {
          expect(claimed.entry.claimedBy).toBe(WORKER_A);
          expect(claimed.entry.claimExpiresAt).toBe(NOW + LEASE_MS);
        }
      });

      it('janitor reclaim clears claimedBy and claimExpiresAt', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        // Claim
        const claimed = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          entry.version,
          WORKER_A,
          LEASE_MS,
        );
        expect(claimed.ok).toBe(true);
        if (!claimed.ok) return;

        // Reclaim (janitor transition READY → QUEUED)
        const reclaimed = await store.transition(
          claimed.entry.intent.id,
          ['READY'],
          'QUEUED',
          {
            claimedBy: undefined,
            claimExpiresAt: 0,
          },
          claimed.entry.version,
          NOW + LEASE_MS + 1,
        );
        expect(reclaimed.ok).toBe(true);
        if (reclaimed.ok) {
          expect(reclaimed.entry.status).toBe('QUEUED');
          expect(reclaimed.entry.claimedBy).toBeUndefined();
          expect(reclaimed.entry.claimExpiresAt).toBe(0);
        }
      });
    });

    // -----------------------------------------------------------------------
    // CAS conflict race: two workers, exactly one wins
    // -----------------------------------------------------------------------

    describe('concurrent claims', () => {
      it('two workers race the same claim: exactly one wins', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const a = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          entry.version,
          WORKER_A,
          LEASE_MS,
        );
        const b = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          entry.version,
          WORKER_B,
          LEASE_MS,
        );

        const wins = [a, b].filter((r) => r.ok);
        const losses = [a, b].filter((r) => !r.ok);
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);
      });

      it('two concurrent transitions: exactly one wins', async () => {
        const entry = makeEntry('QUEUED');
        await store.insert(entry);

        const claimed = await store.claim(
          entry.intent.id,
          ['QUEUED'],
          NOW,
          entry.version,
          WORKER_A,
          LEASE_MS,
        );
        expect(claimed.ok).toBe(true);
        if (!claimed.ok) return;

        // Two workers try to transition from READY simultaneously
        const v = claimed.entry.version;
        const [a, b] = await Promise.all([
          store.transition(claimed.entry.intent.id, ['READY'], 'BUILDING', {}, v, NOW + 1),
          store.transition(claimed.entry.intent.id, ['READY'], 'BUILDING', {}, v, NOW + 1),
        ]);

        const wins = [a, b].filter((r) => r.ok);
        const losses = [a, b].filter((r) => !r.ok);
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);
        const loser = losses[0];
        expect(loser).toBeDefined();
        expect(loser!.ok).toBe(false);
        // The loser fails with either 'state' (status already changed) or
        // 'version' (stale version), depending on timing. Both are correct CAS
        // rejections. The important thing is that exactly one wins.
        if (!loser!.ok) {
          expect(['state', 'version']).toContain(loser!.reason);
        }
      });
    });

    // -----------------------------------------------------------------------
    // insert/get round-trip with full entry shape
    // -----------------------------------------------------------------------

    describe('full entry shape round-trip', () => {
      it('preserves all fields through insert → get', async () => {
        const intent = makeIntent({ id: 'round-trip-test' });
        const entry: QueueEntry = {
          intent,
          status: 'SUBMITTING',
          attemptCount: 2,
          maxAttempts: 5,
          nextAttemptAt: NOW + 1000,
          backoffAttempts: 3,
          claimedBy: WORKER_A,
          claimExpiresAt: NOW + LEASE_MS,
          lastError: { code: 'transient-error', message: 'network timeout', ts: NOW },
          inFlightHashes: ['abc123'],
          attempts: [makeAttempt()],
          updatedAt: NOW,
          version: 4,
        };

        await store.insert(entry);
        const fetched = await store.get(entry.intent.id);
        expect(fetched).toBeDefined();
        expect(fetched!.status).toBe('SUBMITTING');
        expect(fetched!.attemptCount).toBe(2);
        expect(fetched!.backoffAttempts).toBe(3);
        expect(fetched!.claimedBy).toBe(WORKER_A);
        expect(fetched!.lastError).toEqual(entry.lastError);
        expect(fetched!.inFlightHashes).toEqual(['abc123']);
        expect(fetched!.attempts).toHaveLength(1);
        expect(fetched!.version).toBe(4);
      });
    });
  });
}
