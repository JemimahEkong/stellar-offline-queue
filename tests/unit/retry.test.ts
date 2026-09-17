/**
 * Retry + attempt model tests (Phase 8 / Issue #9; ADR-0008, §6.6, §8.2).
 *
 * Coverage mapping (implementation plan T8 tests):
 *
 * - identical-envelope resubmission: TRY_AGAIN_LATER → NEEDS_RETRY → the
 *   **same hash** resubmitted; no new AttemptRecord; no attemptCount bump;
 * - cross-restart deterministic identical rebuild (T8.3): a fresh
 *   `OfflineQueue` (empty in-memory retry journal, shared durable store)
 *   rebuilds the envelope from the journaled AttemptRecord parameters
 *   (`sequenceNumber`/`maxTime`/`fee`), re-signs, and resubmits the
 *   byte-identical envelope — **without** re-reading the account;
 * - `envelope-drift`: journaled params that no longer rebuild the journaled
 *   hash → FAILED without submission (ADR-0008 hash-match assertion);
 * - resume guards: an inconsistent/resolved attempt record aborts with
 *   `OwnershipLostError`; signer rejection and build failure on the resume
 *   path are deterministic FAILEDs, never submissions;
 * - rebuild-on-expiry accounting: each rebuild journals a NEW AttemptRecord
 *   (new hash, fresh sequence) and increments `attemptCount`; identical
 *   resubmissions never do (build cycles vs resubmits, T8.1);
 * - `retry()` itself creates no AttemptRecord — the next build cycle does.
 *
 * Driven by fakes with an injected clock — no network, no sleeps.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { OfflineQueue } from '../../src/queue.js';
import type { OfflineQueueConfig } from '../../src/queue.js';
import { FakeAdapter, submitError, submitTryAgainLater } from '../helpers/fake-adapter.js';
import { FakeSigner } from '../helpers/fake-signer.js';
import {
  TEST_NOW,
  makeQueueEntry,
  validAccountId,
  otherAccountId,
} from '../helpers/factories.js';
import { Networks } from '../../src/builder.js';
import { processEntry, type EngineDeps } from '../../src/engine.js';
import { QueueEvents } from '../../src/events.js';
import { OwnershipLostError } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Harness (same shape as queue-sweep.test.ts)
// ---------------------------------------------------------------------------

/** Fixed clock the tests advance manually (no real sleeps). */
let clock: number;

/** A fresh queue over a fresh store (one "process"). */
function makeQueue(
  overrides: { maxAttempts?: number } = {},
): { queue: OfflineQueue; store: MemoryStore; adapter: FakeAdapter; signer: FakeSigner } {
  clock = TEST_NOW;
  const store = new MemoryStore({ now: () => clock });
  const adapter = new FakeAdapter(() => clock);
  adapter.withAccount(validAccountId, '100');
  const signer = new FakeSigner();
  const queue = makeQueueWith(store, adapter, signer, overrides.maxAttempts);
  return { queue, store, adapter, signer };
}

/**
 * A fresh `OfflineQueue` instance over the SAME durable store — simulates a
 * process restart: the new instance's in-memory retry journal is empty while
 * the journaled hashes/AttemptRecords survive in the store.
 */
function makeQueueWith(
  store: MemoryStore,
  adapter: FakeAdapter,
  signer: FakeSigner,
  maxAttempts?: number,
): OfflineQueue {
  const config: OfflineQueueConfig = {
    store,
    adapter,
    signer,
    networkPassphrase: Networks.TESTNET,
    now: () => clock,
  };
  if (maxAttempts !== undefined) config.maxAttempts = maxAttempts;
  return new OfflineQueue(config);
}

/** Add an intent through the public API (fully offline). */
function addPayment(queue: OfflineQueue, overrides = {}): Promise<unknown> {
  return queue.addIntent({
    sourceAccount: validAccountId,
    operations: [
      {
        type: 'payment',
        destination: otherAccountId,
        asset: { code: 'XLM' },
        amount: '1.0000000',
      },
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Engine-level deps (guard test only — mirrors engine.test.ts)
// ---------------------------------------------------------------------------

function makeDeps(store: MemoryStore, adapter: FakeAdapter, signer: FakeSigner): EngineDeps {
  return {
    store,
    adapter,
    signer,
    events: new QueueEvents(),
    builderConfig: { networkPassphrase: Networks.TESTNET, baseFee: '100' },
    leaseMs: 60_000,
    backoff: { baseMs: 1_000, capMs: 60_000, random: () => 0.5 },
    retryJournal: new Map(),
  };
}

const workerCtx = { workerId: 'worker-test', now: TEST_NOW };

// ---------------------------------------------------------------------------
// Identical-envelope resubmission (ADR-0008, in-worker)
// ---------------------------------------------------------------------------

describe('identical-envelope resubmission (ADR-0008)', () => {
  it('TRY_AGAIN_LATER → NEEDS_RETRY → same hash resubmitted; no new AttemptRecord', async () => {
    const { queue, store, adapter, signer } = makeQueue();
    const added = (await addPayment(queue)) as { intent: { id: string } };
    adapter.nextSubmit(submitTryAgainLater());

    const first = await queue.process();
    expect(first.retried).toBe(1);
    const retrying = (await store.get(added.intent.id))!;
    expect(retrying.status).toBe('NEEDS_RETRY');
    const firstHash = adapter.submittedHashes[0]!;
    expect(retrying.inFlightHashes).toEqual([firstHash]);
    expect(retrying.attempts).toHaveLength(1);

    // Due again (clock past the worst-case backoff cap), same worker: the
    // in-memory journal supplies the identical envelope — no rebuild.
    clock = TEST_NOW + 61_000;
    adapter.nextSubmit({ status: 'PENDING', latestLedger: 100, latestLedgerCloseTime: 1 });
    const second = await queue.process();
    expect(second.claimed).toBe(1);

    expect(adapter.submittedHashes).toEqual([firstHash, firstHash]);
    expect(signer.signedCount).toBe(1); // signed once, submitted twice
    const after = (await store.get(added.intent.id))!;
    expect(after.attempts).toHaveLength(1); // no new AttemptRecord
    expect(after.attemptCount).toBe(1); // identical resubmit ≠ build cycle
    expect(after.status).toBe('CONFIRMING');
  });
});

// ---------------------------------------------------------------------------
// Cross-restart identical-envelope rebuild (ADR-0008 T8.3)
// ---------------------------------------------------------------------------

describe('cross-restart identical-envelope rebuild (ADR-0008 T8.3)', () => {
  it('rebuilds byte-identical from the journaled params and resubmits the same hash', async () => {
    const { queue, store, adapter, signer } = makeQueue();
    const added = (await addPayment(queue)) as { intent: { id: string } };
    adapter.nextSubmit(submitTryAgainLater());
    await queue.process();

    // The journal carries the complete deterministic build parameter set.
    const journaled = (await store.get(added.intent.id))!;
    const record = journaled.attempts[0]!;
    const firstHash = adapter.submittedHashes[0]!;
    expect(record.envelopeHash).toBe(firstHash);
    expect(record.sequenceNumber).toBe('101'); // account.seq + 1
    expect(record.fee).toBe('100'); // per-op fee (baseFee)
    expect(record.maxTime).toBe(Math.floor(TEST_NOW / 1000) + 300); // flush-time bounds
    expect(record.outcome).toBe('UNKNOWN');

    // -- restart: fresh queue instance, same durable store; the in-memory
    // retry journal is empty, so the resume path must rebuild+re-sign.
    clock = TEST_NOW + 61_000;
    const revived = makeQueueWith(store, adapter, signer);
    adapter.nextSubmit({ status: 'PENDING', latestLedger: 100, latestLedgerCloseTime: 1 });
    const summary = await revived.process();
    expect(summary.claimed).toBe(1);

    // Byte-identical resubmission — rebuilt from the journal parameters.
    expect(adapter.submittedHashes).toEqual([firstHash, firstHash]);
    expect(signer.signedCount).toBe(2); // re-signed once for the rebuild
    // The rebuild never re-reads the account: params come from the journal.
    expect(adapter.count('loadAccount')).toBe(1);
    // No new AttemptRecord, no attemptCount bump: identical resubmission.
    const after = (await store.get(added.intent.id))!;
    expect(after.status).toBe('CONFIRMING');
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]!.envelopeHash).toBe(firstHash);
    expect(after.attemptCount).toBe(1);
  });

  it('journaled params that no longer rebuild the journaled hash → FAILED envelope-drift, no submit', async () => {
    const { queue, store, adapter } = makeQueue();
    // Tampered/corrupted journal: the record is internally consistent
    // (hash matches the in-flight journal, outcome unresolved) but the
    // parameters cannot reproduce the journaled hash (bogus hash here).
    const bogusHash = 'a'.repeat(64);
    const entry = makeQueueEntry('NEEDS_RETRY', {
      lastError: { code: 'transient-error', message: 'stalled', ts: TEST_NOW },
      inFlightHashes: [bogusHash],
      attemptCount: 1,
      attempts: [
        {
          envelopeHash: bogusHash,
          sequenceNumber: '101',
          maxTime: Math.floor(TEST_NOW / 1000) + 300,
          fee: '100',
          submittedAt: TEST_NOW,
          outcome: 'UNKNOWN',
        },
      ],
    });
    await store.insert(entry);

    const summary = await queue.process();
    expect(summary.failed).toBe(1);

    const failed = (await store.get(entry.intent.id))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError!.code).toBe('envelope-drift');
    // The journaled hash stays unresolved for reconciliation — no submission.
    expect(adapter.submittedHashes).toHaveLength(0);
    expect(adapter.count('submit')).toBe(0);
    expect(failed.attempts).toHaveLength(1); // audit trail intact
  });

  it('NEEDS_RETRY without a consistent unresolved attempt record aborts (ownership guard)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter();
    const signer = new FakeSigner();
    const deps = makeDeps(store, adapter, signer);
    const hash = 'b'.repeat(64);
    const entry = makeQueueEntry('NEEDS_RETRY', {
      lastError: { code: 'transient-error', message: 'stalled', ts: TEST_NOW },
      inFlightHashes: [hash],
      attempts: [
        {
          envelopeHash: hash,
          sequenceNumber: '101',
          maxTime: Math.floor(TEST_NOW / 1000) + 300,
          fee: '100',
          submittedAt: TEST_NOW,
          outcome: 'SUCCESS', // already resolved — nothing to resume
        },
      ],
    });
    await store.insert(entry);

    await expect(processEntry(deps, entry, workerCtx)).rejects.toThrow(OwnershipLostError);
    expect(adapter.submittedHashes).toHaveLength(0);
    expect(signer.signedCount).toBe(0);
    // The claim already moved the entry to READY (under this worker's lease);
    // the abort is the throw itself — no submission, no journal mutation —
    // and the janitor reclaims the READY entry after the lease expires.
    const after = (await store.get(entry.intent.id))!;
    expect(after.status).toBe('READY');
    expect(after.inFlightHashes).toEqual([hash]);
  });

  it('signer rejection during the resume rebuild → FAILED signer-rejected, no resubmission', async () => {
    const { queue, store, adapter } = makeQueue();
    const added = (await addPayment(queue)) as { intent: { id: string } };
    adapter.nextSubmit(submitTryAgainLater());
    await queue.process();
    const firstHash = adapter.submittedHashes[0]!;

    // Restart; the app signer now refuses to sign.
    const refusingSigner = new FakeSigner();
    refusingSigner.mode = 'reject';
    clock = TEST_NOW + 61_000;
    const revived = makeQueueWith(store, adapter, refusingSigner);
    const summary = await revived.process();
    expect(summary.failed).toBe(1);

    const failed = (await store.get(added.intent.id))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError!.code).toBe('signer-rejected');
    expect(adapter.submittedHashes).toEqual([firstHash]); // never resubmitted
  });

  it('corrupted build parameters on resume → FAILED build-failed, no submit', async () => {
    const { queue, store, adapter } = makeQueue();
    const hash = 'c'.repeat(64);
    const entry = makeQueueEntry('NEEDS_RETRY', {
      lastError: { code: 'transient-error', message: 'stalled', ts: TEST_NOW },
      inFlightHashes: [hash],
      attemptCount: 1,
      attempts: [
        {
          envelopeHash: hash,
          sequenceNumber: 'not-a-sequence', // journal corruption
          maxTime: Math.floor(TEST_NOW / 1000) + 300,
          fee: '100',
          submittedAt: TEST_NOW,
          outcome: 'UNKNOWN',
        },
      ],
    });
    await store.insert(entry);

    const summary = await queue.process();
    expect(summary.failed).toBe(1);

    const failed = (await store.get(entry.intent.id))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError!.code).toBe('build-failed');
    expect(adapter.submittedHashes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rebuild-on-expiry attempt accounting (ADR-0008, T8.1)
// ---------------------------------------------------------------------------

describe('rebuild-on-expiry attempt accounting (ADR-0008)', () => {
  it('each rebuild journals a NEW AttemptRecord (new hash, fresh sequence) and increments attemptCount', async () => {
    const { queue, store, adapter } = makeQueue({ maxAttempts: 5 });
    const added = (await addPayment(queue)) as { intent: { id: string } };

    // Cycle 1 → tx_too_late → EXPIRED (provably never included).
    adapter.nextSubmit(submitError(['tx_too_late']));
    const s1 = await queue.process();
    expect(s1.expired).toBe(1);
    const after1 = (await store.get(added.intent.id))!;
    expect(after1.status).toBe('EXPIRED');
    expect(after1.attemptCount).toBe(1);
    const firstHash = after1.attempts[0]!.envelopeHash;
    expect(after1.attempts[0]!.sequenceNumber).toBe('101');

    // Cycle 2 (automatic rebuild): recovery returns EXPIRED → QUEUED; the
    // fresh envelope gets a fresh sequence from the advanced account.
    clock += 1_000;
    adapter.withAccount(validAccountId, '101');
    adapter.nextSubmit(submitError(['tx_too_late']));
    const s2 = await queue.process();
    expect(s2.expired).toBe(1);
    const after2 = (await store.get(added.intent.id))!;
    expect(after2.status).toBe('EXPIRED');
    expect(after2.attemptCount).toBe(2);
    expect(after2.attempts).toHaveLength(2);
    expect(after2.attempts[1]!.envelopeHash).not.toBe(firstHash); // NEW envelope
    expect(after2.attempts[1]!.sequenceNumber).toBe('102'); // fresh sequence
    expect(after2.attempts[0]!.outcome).toBe('EXPIRED'); // audit intact

    // Cycle 3 (rebuild): settles in flight → CONFIRMING.
    clock += 1_000;
    adapter.withAccount(validAccountId, '102');
    adapter.nextSubmit({ status: 'PENDING', latestLedger: 100, latestLedgerCloseTime: 1 });
    const s3 = await queue.process();
    expect(s3.claimed).toBe(1);
    const after3 = (await store.get(added.intent.id))!;
    expect(after3.status).toBe('CONFIRMING');
    expect(after3.attemptCount).toBe(3);
    expect(after3.attempts).toHaveLength(3);
    expect(new Set(after3.attempts.map((a) => a.envelopeHash)).size).toBe(3); // all distinct
  });
});

// ---------------------------------------------------------------------------
// Manual retry (ADR-0008)
// ---------------------------------------------------------------------------

describe('manual retry() (ADR-0008)', () => {
  it('retry() itself creates no AttemptRecord; the next build cycle does', async () => {
    const { queue, store, adapter } = makeQueue();
    const failed = makeQueueEntry('FAILED', {
      lastError: { code: 'signer-rejected', message: 'x', ts: TEST_NOW },
      claimedBy: undefined,
    });
    await store.insert(failed);

    const retried = await queue.retry(failed.intent.id);
    expect(retried.status).toBe('QUEUED');
    // No attempt was created by the retry itself — the audit trail starts
    // at the next write-ahead transition.
    expect(retried.attempts).toHaveLength(0);
    expect(retried.inFlightHashes).toHaveLength(0);
    expect(retried.attemptCount).toBe(0);

    // The next build cycle journals exactly one AttemptRecord.
    adapter.nextSubmit({ status: 'PENDING', latestLedger: 100, latestLedgerCloseTime: 1 });
    await queue.process();
    const after = (await store.get(failed.intent.id))!;
    expect(after.attempts).toHaveLength(1);
    expect(after.attemptCount).toBe(1);
    expect(after.attempts[0]!.outcome).toBe('UNKNOWN');
    expect(after.status).toBe('CONFIRMING');
  });
});
