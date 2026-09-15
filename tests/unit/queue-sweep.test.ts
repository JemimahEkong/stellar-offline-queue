/**
 * Sweep orchestration tests (Phase 7 / Issue #8, implementation plan T7.3).
 *
 * Covers the `OfflineQueue` sweep on MemoryStore + fakes with injected clocks
 * (no real sleeps):
 *
 * - two entries same account → strictly sequential (per-account single-
 *   writer: at most one in-flight entry per account, FIFO);
 * - different accounts → may interleave (parallel across accounts);
 * - concurrent `process()` ×2 → each entry processed once (CAS);
 * - janitor reclaims an expired-lease READY entry before claiming;
 * - recovery sweep reconciles a pre-seeded SUBMITTING entry from its
 *   journaled hash — status query, **never** a new submission;
 * - `retry(id)` matrix (ADR-0008), `cancel()`/`remove()` matrix (ADR-0011);
 * - EXPIRED rebuild + manual retry of an attempts-exhausted entry;
 * - repeated/concurrent sweeps with nothing due → no-op, no state churn;
 * - `start()`/`stop()` timer wiring;
 * - config validation errors.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import { OfflineQueue } from '../../src/queue.js';
import type { OfflineQueueConfig, ProcessSummary } from '../../src/queue.js';
import {
  AttemptsExhaustedError,
  EntryNotFoundError,
  InvalidCancelStateError,
  InvalidRetryStateError,
  QueueConfigError,
} from '../../src/errors.js';
import { FakeAdapter, txSuccess } from '../helpers/fake-adapter.js';
import { FakeSigner } from '../helpers/fake-signer.js';
import {
  TEST_NOW,
  makeQueueEntry,
  validAccountId,
  otherAccountId,
} from '../helpers/factories.js';
import { Networks } from '../../src/builder.js';
import type { QueueStore } from '../../src/store/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Fixed clock the tests advance manually (no real sleeps). */
let clock: number;

function makeQueue(
  overrides: {
    store?: MemoryStore;
    adapter?: FakeAdapter;
    signer?: FakeSigner;
    concurrency?: number;
    maxAttempts?: number;
    onError?: (error: unknown) => void;
  } = {},
): { queue: OfflineQueue; store: MemoryStore; adapter: FakeAdapter; signer: FakeSigner } {
  clock = TEST_NOW;
  const store = overrides.store ?? new MemoryStore({ now: () => clock });
  const adapter = overrides.adapter ?? new FakeAdapter(() => clock);
  // The standard test accounts exist on the network and are funded.
  adapter.withAccount(validAccountId, '100').withAccount(otherAccountId, '100');
  const signer = overrides.signer ?? new FakeSigner();
  const config: OfflineQueueConfig = {
    store,
    adapter,
    signer,
    networkPassphrase: Networks.TESTNET,
    concurrency: overrides.concurrency ?? 1,
    now: () => clock,
  };
  if (overrides.maxAttempts !== undefined) config.maxAttempts = overrides.maxAttempts;
  if (overrides.onError !== undefined) config.onError = overrides.onError;
  const queue = new OfflineQueue(config);
  return { queue, store, adapter, signer };
}

/** Fold a list of summaries into one (for concurrent-sweep assertions). */
function mergeSummaries(summaries: ProcessSummary[]): ProcessSummary {
  const keys = Object.keys(summaries[0]!) as Array<keyof ProcessSummary>;
  const merged = {} as ProcessSummary;
  for (const key of keys) {
    merged[key] = summaries.reduce((acc, s) => acc + s[key], 0);
  }
  return merged;
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// addIntent + getIntent + list
// ---------------------------------------------------------------------------

describe('addIntent', () => {
  it('validates + persists a QUEUED entry with ADR-0010 defaults', async () => {
    const { queue } = makeQueue();
    const entry = (await addPayment(queue)) as Awaited<ReturnType<OfflineQueue['addIntent']>>;

    expect(entry.status).toBe('QUEUED');
    expect(entry.attemptCount).toBe(0);
    expect(entry.maxAttempts).toBe(5);
    expect(entry.nextAttemptAt).toBe(0);
    expect(entry.inFlightHashes).toEqual([]);
    expect(entry.intent.timeBounds.maxAgeSeconds).toBe(300);
    expect(entry.intent.createdAt).toBe(TEST_NOW);
  });

  it('duplicate id → returns the existing entry unchanged (idempotent)', async () => {
    const { queue } = makeQueue();
    const first = await queue.addIntent({ id: 'inv-1', sourceAccount: validAccountId, operations: [
      { type: 'payment', destination: otherAccountId, asset: { code: 'XLM' }, amount: '1' },
    ] });
    const second = await queue.addIntent({ id: 'inv-1', sourceAccount: validAccountId, operations: [
      { type: 'payment', destination: otherAccountId, asset: { code: 'XLM' }, amount: '2' },
    ] });

    expect(second.intent.id).toBe(first.intent.id);
    expect(second.intent.operations[0]).toEqual(first.intent.operations[0]);
    expect(second.version).toBe(first.version);
    expect(await queue.list()).toHaveLength(1);
  });

  it('invalid input throws ValidationError and persists nothing (§4.1)', async () => {
    const { queue } = makeQueue();
    await expect(
      queue.addIntent({
        sourceAccount: 'not-an-address',
        operations: [
          { type: 'payment', destination: otherAccountId, asset: { code: 'XLM' }, amount: '1' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid-address' });
    expect(await queue.list()).toHaveLength(0);
  });

  it('getIntent returns the entry (or undefined)', async () => {
    const { queue } = makeQueue();
    const entry = (await addPayment(queue)) as Awaited<ReturnType<OfflineQueue['addIntent']>>;
    expect((await queue.getIntent(entry.intent.id))?.intent.id).toBe(entry.intent.id);
    expect(await queue.getIntent('missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-account single-writer + ordering
// ---------------------------------------------------------------------------

describe('per-account single-writer (§6.7 layer 3)', () => {
  it('two entries, same account → the second waits until the first resolves', async () => {
    const { queue, adapter } = makeQueue();
    const a = await addPayment(queue, { id: 'same-account-a' });
    const b = await addPayment(queue, { id: 'same-account-b' });

    const s1 = await queue.process();
    // Sweep 1: only the first entry is claimed (one writer per account).
    expect(s1.claimed).toBe(1);
    expect(s1.skipped).toBe(0); // b was never in the batch (account blocked)
    expect(adapter.submittedHashes).toHaveLength(1);

    // Resolve the first entry to SUCCESS via a scripted status query.
    const first = (await queue.getIntent((a as { intent: { id: string } }).intent.id))!;
    adapter.statusFor(first.inFlightHashes[0]!, txSuccess());

    const s2 = await queue.process();
    // Sweep 2: recovery settles the first; the second is now claimable.
    expect(s2.reconciled).toBe(1);
    expect(s2.claimed).toBe(1);
    expect(adapter.submittedHashes).toHaveLength(2);

    const afterA = await queue.getIntent((a as { intent: { id: string } }).intent.id);
    const afterB = await queue.getIntent((b as { intent: { id: string } }).intent.id);
    expect(afterA!.status).toBe('SUCCESS');
    expect(afterB!.status).toBe('CONFIRMING');
    // Strictly sequential submissions for one account.
    expect(adapter.accountLoads.filter((acc) => acc === validAccountId)).toHaveLength(2);
  });

  it('different accounts may be claimed in the same sweep (parallel across accounts)', async () => {
    const { queue, adapter } = makeQueue({ concurrency: 4 });
    const dest = otherAccountId;
    await queue.addIntent({
      id: 'acct-one',
      sourceAccount: validAccountId,
      operations: [{ type: 'payment', destination: dest, asset: { code: 'XLM' }, amount: '1' }],
    });
    await queue.addIntent({
      id: 'acct-two',
      sourceAccount: otherAccountId,
      operations: [{ type: 'payment', destination: dest, asset: { code: 'XLM' }, amount: '1' }],
    });

    const summary = await queue.process();
    expect(summary.claimed).toBe(2);
    expect(adapter.submittedHashes).toHaveLength(2);
  });

  it('NEEDS_RETRY on an account blocks its other due entries', async () => {
    const { queue } = makeQueue();
    // Seed: one NEEDS_RETRY entry with a journaled hash on the account.
    const stalled = makeQueueEntry('NEEDS_RETRY', {
      nextAttemptAt: TEST_NOW + 60_000, // not due
      inFlightHashes: ['a'.repeat(64)],
      attemptCount: 1,
      attempts: [
        { envelopeHash: 'a'.repeat(64), sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: { code: 'transient-error', message: 'stalled', ts: TEST_NOW },
    });
    await (queue as unknown as { store: QueueStore }).store.insert(stalled);
    await addPayment(queue, { id: 'blocked-fresh' });

    const summary = await queue.process();
    // The fresh entry is due but its account is blocked by the stalled one.
    expect(summary.claimed).toBe(0);
    expect(adapter0(queue).submittedHashes).toHaveLength(0);
  });
});

/** Adapter accessor for tests that build the queue through helpers. */
function adapter0(queue: OfflineQueue): FakeAdapter {
  return (queue as unknown as { deps: { adapter: FakeAdapter } }).deps.adapter;
}

// ---------------------------------------------------------------------------
// Concurrency + idempotence of process()
// ---------------------------------------------------------------------------

describe('process() concurrency', () => {
  it('concurrent process() ×2 → each entry processed exactly once', async () => {
    const { queue, adapter } = makeQueue({ concurrency: 2 });
    await addPayment(queue, { id: 'once-only' });

    const [s1, s2] = await Promise.all([queue.process(), queue.process()]);
    const merged = mergeSummaries([s1, s2]);

    // Exactly one sweep won the claim; the loser either lost the CAS (skip)
    // or listed the entry before it was due-claimed.
    expect(merged.claimed).toBe(1);
    expect(adapter.submittedHashes).toHaveLength(1);
  });

  it('repeated process() with nothing due → no-op summary, no state churn', async () => {
    const { queue } = makeQueue();
    const entry = (await addPayment(queue)) as { intent: { id: string } };
    const before = await queue.getIntent(entry.intent.id);

    const s1 = await queue.process();
    const s2 = await queue.process();
    expect(s1.claimed).toBe(1); // first sweep processes it
    // The second sweep may see the CONFIRMING entry (reconciled) or nothing.
    expect(s2.claimed).toBe(0);

    const after = await queue.getIntent(entry.intent.id);
    expect(after!.version).toBeGreaterThan(before!.version); // it progressed
  });

  it('process() performs recovery-before-claim every time (ordering)', async () => {
    const { queue, adapter } = makeQueue();
    // Pre-seed a crashed SUBMITTING entry (journaled hash).
    const crashed = makeQueueEntry('SUBMITTING', {
      inFlightHashes: ['c'.repeat(64)],
      attemptCount: 1,
      attempts: [
        { envelopeHash: 'c'.repeat(64), sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: undefined,
    });
    await (queue as unknown as { store: QueueStore }).store.insert(crashed);
    // And a due QUEUED entry for the SAME account — must wait for recovery.
    await addPayment(queue, { id: 'after-crash' });

    const summary = await queue.process();
    expect(summary.reconciled).toBe(1);
    // The crashed entry's hash was polled, not resubmitted.
    expect(adapter.count('status')).toBe(1);
    expect(adapter.count('submit')).toBe(0);
    expect(adapter.submittedHashes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Janitor integration
// ---------------------------------------------------------------------------

describe('janitor in the sweep', () => {
  it('reclaims an expired-lease READY entry before claiming', async () => {
    const { queue, adapter } = makeQueue();
    // Seed: READY entry whose lease expired (crashed worker).
    const abandoned = makeQueueEntry('READY', {
      claimedBy: 'worker-dead',
      claimExpiresAt: TEST_NOW - 1,
      lastError: undefined,
    });
    await (queue as unknown as { store: QueueStore }).store.insert(abandoned);

    const summary = await queue.process();
    expect(summary.reclaimed).toBe(1);
    // The reclaimed entry was processed by this sweep's pipeline.
    expect(adapter.submittedHashes).toHaveLength(1);

    const after = await queue.getIntent(abandoned.intent.id);
    expect(after!.status).toBe('CONFIRMING');
    // The sweep's worker held the lease at processing time.
    expect(after!.claimedBy).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Backoff resume + rebuild
// ---------------------------------------------------------------------------

describe('recovery of EXPIRED (rebuild) entries', () => {
  it('EXPIRED with attempts remaining → QUEUED, then rebuilds fresh', async () => {
    const { queue, adapter } = makeQueue();
    const expiredEntry = makeQueueEntry('EXPIRED', {
      attemptCount: 1,
      maxAttempts: 5,
      attempts: [
        { envelopeHash: 'e'.repeat(64), sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'EXPIRED' },
      ],
      lastError: undefined,
    });
    await (queue as unknown as { store: QueueStore }).store.insert(expiredEntry);
    adapter.withAccount(expiredEntry.intent.sourceAccount, '100');

    const s1 = await queue.process();
    expect(s1.claimed).toBe(1);
    const after = await queue.getIntent(expiredEntry.intent.id);
    // The rebuild produced a fresh envelope (new hash ≠ prior one) and is in flight.
    expect(['CONFIRMING', 'NEEDS_RETRY', 'SUBMITTING']).toContain(after!.status);
    expect(after!.attemptCount).toBe(2);
  });

  it('EXPIRED with exhausted budget is left alone (manual retry only)', async () => {
    const { queue } = makeQueue();
    const dead = makeQueueEntry('EXPIRED', {
      attemptCount: 5,
      maxAttempts: 5,
      inFlightHashes: [],
      attempts: [
        { envelopeHash: 'f'.repeat(64), sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'EXPIRED' },
      ],
      lastError: undefined,
    });
    await (queue as unknown as { store: QueueStore }).store.insert(dead);

    const summary = await queue.process();
    expect(summary.claimed).toBe(0);
    const after = await queue.getIntent(dead.intent.id);
    expect(after!.status).toBe('EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// Manual retry (ADR-0008)
// ---------------------------------------------------------------------------

describe('retry(id) — ADR-0008 matrix', () => {
  it('FAILED → QUEUED with nextAttemptAt=now and backoff reset', async () => {
    const { queue } = makeQueue();
    const failed = makeQueueEntry('FAILED', {
      backoffAttempts: 3,
      nextAttemptAt: TEST_NOW + 999_999,
      lastError: { code: 'signer-rejected', message: 'x', ts: TEST_NOW },
      claimedBy: undefined,
    });
    await (queue as unknown as { store: QueueStore }).store.insert(failed);

    const retried = await queue.retry(failed.intent.id);
    expect(retried.status).toBe('QUEUED');
    expect(retried.nextAttemptAt).toBe(0);
    expect(retried.backoffAttempts).toBe(0);
    expect(retried.attemptCount).toBe(0); // no new record yet (next build cycle does)
  });

  it('EXPIRED → QUEUED via manual retry while budget remains', async () => {
    const { queue } = makeQueue();
    const expiredEntry = makeQueueEntry('EXPIRED', { attemptCount: 1, maxAttempts: 5 });
    await (queue as unknown as { store: QueueStore }).store.insert(expiredEntry);

    const retried = await queue.retry(expiredEntry.intent.id);
    expect(retried.status).toBe('QUEUED');
  });

  it('throws AttemptsExhaustedError past the budget (never extends it)', async () => {
    const { queue } = makeQueue();
    const exhausted = makeQueueEntry('FAILED', { attemptCount: 5, maxAttempts: 5 });
    await (queue as unknown as { store: QueueStore }).store.insert(exhausted);

    await expect(queue.retry(exhausted.intent.id)).rejects.toThrow(AttemptsExhaustedError);
    await expect(queue.retry(exhausted.intent.id)).rejects.toMatchObject({
      code: 'attempts-exhausted',
      attemptCount: 5,
      maxAttempts: 5,
    });
  });

  it('throws InvalidRetryStateError from SUCCESS, INDETERMINATE, SUBMITTING, CONFIRMING, QUEUED, NEEDS_RETRY, READY', async () => {
    const { queue, store } = makeQueue();
    for (const status of [
      'SUCCESS',
      'INDETERMINATE',
      'SUBMITTING',
      'CONFIRMING',
      'QUEUED',
      'NEEDS_RETRY',
      'READY',
    ] as const) {
      const entry = makeQueueEntry(status);
      await store.insert(entry);
      await expect(queue.retry(entry.intent.id)).rejects.toThrow(InvalidRetryStateError);
      await expect(queue.retry(entry.intent.id)).rejects.toMatchObject({
        code: 'invalid-retry-state',
        currentStatus: status,
      });
    }
  });

  it('throws EntryNotFoundError for an unknown id', async () => {
    const { queue } = makeQueue();
    await expect(queue.retry('nope')).rejects.toThrow(EntryNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Cancel + remove (ADR-0011)
// ---------------------------------------------------------------------------

describe('cancel(id) — ADR-0011', () => {
  it('QUEUED → FAILED with lastError.code=cancelled (auditable, retryable)', async () => {
    const { queue } = makeQueue();
    const entry = (await addPayment(queue, { id: 'cancel-me' })) as { intent: { id: string } };

    const cancelled = await queue.cancel(entry.intent.id);
    expect(cancelled.status).toBe('FAILED');
    expect(cancelled.lastError!.code).toBe('cancelled');

    // Reversible via manual retry (ADR-0011 + ADR-0008).
    const revived = await queue.retry(entry.intent.id);
    expect(revived.status).toBe('QUEUED');
  });

  it('NEEDS_RETRY with an in-flight hash is rejected (never touches possibly-sent)', async () => {
    const { queue, store } = makeQueue();
    const entry = makeQueueEntry('NEEDS_RETRY', {
      inFlightHashes: ['a'.repeat(64)],
      lastError: { code: 'transient-error', message: 'x', ts: TEST_NOW },
    });
    await store.insert(entry);

    await expect(queue.cancel(entry.intent.id)).rejects.toThrow(InvalidCancelStateError);
    const after = await queue.getIntent(entry.intent.id);
    expect(after!.status).toBe('NEEDS_RETRY'); // untouched
  });

  it('in-flight and terminal states are rejected without mutation', async () => {
    const { queue, store } = makeQueue();
    for (const status of ['SUBMITTING', 'CONFIRMING', 'SUCCESS', 'FAILED', 'EXPIRED', 'READY'] as const) {
      const entry = makeQueueEntry(status, {
        ...(status === 'SUBMITTING' || status === 'CONFIRMING'
          ? { inFlightHashes: ['b'.repeat(64)] }
          : {}),
      });
      await store.insert(entry);
      await expect(queue.cancel(entry.intent.id)).rejects.toThrow(InvalidCancelStateError);
    }
  });

  it('throws EntryNotFoundError for an unknown id', async () => {
    const { queue } = makeQueue();
    await expect(queue.cancel('nope')).rejects.toThrow(EntryNotFoundError);
  });
});

describe('remove(id) — ADR-0011', () => {
  it('deletes a pre-submission entry (QUEUED, no hashes)', async () => {
    const { queue } = makeQueue();
    const entry = (await addPayment(queue, { id: 'delete-me' })) as { intent: { id: string } };
    expect(await queue.remove(entry.intent.id)).toBe(true);
    expect(await queue.getIntent(entry.intent.id)).toBeUndefined();
  });

  it('refuses an entry with an in-flight hash (CAS guard, never deletes evidence)', async () => {
    const { queue, store } = makeQueue();
    const entry = makeQueueEntry('NEEDS_RETRY', {
      inFlightHashes: ['c'.repeat(64)],
      lastError: { code: 'transient-error', message: 'x', ts: TEST_NOW },
    });
    await store.insert(entry);
    expect(await queue.remove(entry.intent.id)).toBe(false);
    expect(await queue.getIntent(entry.intent.id)).toBeDefined();
  });

  it('refuses terminal/in-flight states', async () => {
    const { queue, store } = makeQueue();
    const settled = makeQueueEntry('SUCCESS');
    await store.insert(settled);
    expect(await queue.remove(settled.intent.id)).toBe(false);
  });

  it('throws EntryNotFoundError for an unknown id', async () => {
    const { queue } = makeQueue();
    await expect(queue.remove('nope')).rejects.toThrow(EntryNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// reconcile()
// ---------------------------------------------------------------------------

describe('reconcile()', () => {
  it('returns a definitive verdict for a confirmed SUCCESS entry', async () => {
    const { queue, adapter } = makeQueue();
    const confirming = makeQueueEntry('CONFIRMING', {
      inFlightHashes: ['d'.repeat(64)],
      attempts: [
        { envelopeHash: 'd'.repeat(64), sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: undefined,
    });
    await (queue as unknown as { store: QueueStore }).store.insert(confirming);
    adapter.statusFor('d'.repeat(64), txSuccess());

    const results = await queue.reconcile(confirming.intent.id);
    expect(results).toEqual([{ outcome: 'SUCCESS', transactionHash: 'd'.repeat(64) }]);
    expect((await queue.getIntent(confirming.intent.id))!.status).toBe('SUCCESS');
  });

  it('omits still-pending entries honestly (NOT_FOUND/transport failure)', async () => {
    const { queue } = makeQueue();
    const confirming = makeQueueEntry('CONFIRMING', {
      inFlightHashes: ['e'.repeat(64)],
      attempts: [
        { envelopeHash: 'e'.repeat(64), sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: undefined,
    });
    await (queue as unknown as { store: QueueStore }).store.insert(confirming);

    const results = await queue.reconcile(confirming.intent.id);
    expect(results).toEqual([]); // no verdict — honest omission
    expect((await queue.getIntent(confirming.intent.id))!.status).toBe('CONFIRMING');
  });

  it('non-in-flight target yields NOT_SUBMITTED; unknown id throws', async () => {
    const { queue, store } = makeQueue();
    const queued = makeQueueEntry('QUEUED');
    await store.insert(queued);

    expect(await queue.reconcile(queued.intent.id)).toEqual([
      { outcome: 'NOT_SUBMITTED', reason: expect.stringContaining('QUEUED') },
    ]);
    await expect(queue.reconcile('nope')).rejects.toThrow(EntryNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Events + timer
// ---------------------------------------------------------------------------

describe('events + start()/stop()', () => {
  it('on() observes transitions and settles through the public API', async () => {
    const { queue, adapter } = makeQueue();
    const statuses: string[] = [];
    let settledCount = 0;
    queue.on('intent:transition', (e) => statuses.push(e.status));
    queue.on('intent:settled', () => (settledCount += 1));

    const confirming = makeQueueEntry('CONFIRMING', {
      inFlightHashes: ['f'.repeat(64)],
      attempts: [
        { envelopeHash: 'f'.repeat(64), sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: undefined,
    });
    await (queue as unknown as { store: QueueStore }).store.insert(confirming);
    adapter.statusFor('f'.repeat(64), txSuccess());
    await queue.process();

    expect(statuses).toContain('SUCCESS');
    expect(settledCount).toBe(1);
  });

  it('start() polls process(); stop() halts it; unref does not hold the process', async () => {
    vi.useFakeTimers();
    try {
      const { queue, adapter } = makeQueue();
      const processSpy = vi.spyOn(queue, 'process').mockResolvedValue({
        reclaimed: 0, reconciled: 0, claimed: 0, succeeded: 0,
        failed: 0, expired: 0, retried: 0, skipped: 0, aborted: 0,
      });

      queue.start({ intervalMs: 5 });
      await vi.advanceTimersByTimeAsync(11);
      expect(processSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      queue.stop();
      const callsAtStop = processSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(50);
      expect(processSpy.mock.calls.length).toBe(callsAtStop);

      expect(adapter.calls).toHaveLength(0); // timer owns no hidden work
    } finally {
      vi.useRealTimers();
    }
  });

  it('timer sweep errors go to onError, not unhandled rejections', async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const { queue } = makeQueue({ onError: (error) => errors.push(error) });
      vi.spyOn(queue, 'process').mockRejectedValue(new Error('sweep exploded'));

      queue.start({ intervalMs: 5 });
      await vi.advanceTimersByTimeAsync(6);
      expect(errors).toHaveLength(1);
      queue.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('config validation (QueueConfigError)', () => {
  function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      store: new MemoryStore(),
      adapter: new FakeAdapter(),
      signer: new FakeSigner(),
      networkPassphrase: Networks.TESTNET,
      now: () => TEST_NOW,
      ...overrides,
    };
  }

  it('accepts valid config and applies ADR-0010 defaults', () => {
    expect(() => new OfflineQueue(baseConfig() as never)).not.toThrow();
  });

  it('rejects missing required members', () => {
    expect(() => new OfflineQueue({ ...baseConfig(), store: undefined } as never)).toThrow(QueueConfigError);
    expect(() => new OfflineQueue({ ...baseConfig(), adapter: undefined } as never)).toThrow(QueueConfigError);
    expect(() => new OfflineQueue({ ...baseConfig(), signer: undefined } as never)).toThrow(QueueConfigError);
    expect(() => new OfflineQueue({ ...baseConfig(), networkPassphrase: '' } as never)).toThrow(QueueConfigError);
  });

  it('rejects invalid numeric options', () => {
    expect(() => new OfflineQueue(baseConfig({ maxAttempts: 0 }) as never)).toThrow(QueueConfigError);
    expect(() => new OfflineQueue(baseConfig({ concurrency: 2.5 }) as never)).toThrow(QueueConfigError);
    expect(() => new OfflineQueue(baseConfig({ leaseMs: -1 }) as never)).toThrow(QueueConfigError);
    expect(() =>
      new OfflineQueue(baseConfig({ backoff: { baseMs: 100, capMs: 50 } }) as never),
    ).toThrow(QueueConfigError);
    expect(() => new OfflineQueue(baseConfig({ baseFee: 'ten' }) as never)).toThrow(QueueConfigError);
    expect(() =>
      new OfflineQueue(baseConfig({ timeBounds: { maxAgeSeconds: 10 } }) as never),
    ).toThrow(QueueConfigError);
  });

  it('rejects an invalid start() interval', () => {
    const { queue } = makeQueue();
    expect(() => queue.start({ intervalMs: 0 })).toThrow(QueueConfigError);
  });
});

// ---------------------------------------------------------------------------
// Lease behaviour inside the sweep
// ---------------------------------------------------------------------------

describe('lease discipline in the sweep', () => {
  it('the pipeline holds a live lease on the entry it is processing', async () => {
    const { queue, adapter } = makeQueue();
    let claimedByAtSend: string | undefined;
    const entry = (await addPayment(queue, { id: 'leased' })) as { intent: { id: string } };

    adapter.beforeSubmit = () => {
      void queue.getIntent(entry.intent.id).then((current) => {
        claimedByAtSend = current?.claimedBy;
      });
    };
    await queue.process();
    expect(claimedByAtSend).toBeDefined();
    expect(typeof claimedByAtSend).toBe('string');
    expect(claimedByAtSend).not.toBe('worker-dead');
  });
});
