/**
 * Engine pipeline tests (Phase 7 / Issue #8, implementation plan T7.2 tests).
 *
 * Driven entirely by fakes (no network, no sleeps — `now` is injected):
 *
 * - happy path: QUEUED → … → SUCCESS with the AttemptRecord journaled
 *   **before** submit (write-ahead invariant, asserted via the fake-adapter
 *   submission hook reading the store at send time);
 * - signer rejection → FAILED `signer-rejected`, zero write-ahead, zero
 *   submissions;
 * - malformed signer result (wrong network) → FAILED `signer-malformed`;
 * - payload-mismatch → FAILED `payload-mismatch`, nothing submitted;
 * - structural submit error (`tx_bad_auth`) → FAILED, attempt stamped;
 * - ambiguous ack (PENDING/UNKNOWN/DUPLICATE) → CONFIRMING; then verdicts;
 * - TRY_AGAIN_LATER → NEEDS_RETRY with persisted backoff, then
 *   identical-envelope resubmission (same hash, no new AttemptRecord);
 * - tx_too_late → CONFIRMING → EXPIRED;
 * - lost ownership before write-ahead → no submission (§6.5.5);
 * - no-rebuild-while-in-flight (§6.5.2);
 * - crash-between-write-ahead-and-submit recovery (`reconcileSubmitting`).
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/store/memory.js';
import type { QueueEntry } from '../../src/store/types.js';
import {
  processEntry,
  confirmEntry,
  reconcileSubmitting,
  verifyPayloadIntegrity,
  type EngineDeps,
} from '../../src/engine.js';
import { OwnershipLostError } from '../../src/errors.js';
import { reclaimExpired } from '../../src/ownership.js';
import { FakeAdapter, submitError, txFailed, txNotFound, txSuccess } from '../helpers/fake-adapter.js';
import { FakeSigner } from '../helpers/fake-signer.js';
import { TEST_LEASE_MS, TEST_NOW, makeQueueEntry, validAccountId } from '../helpers/factories.js';
import { QueueEvents } from '../../src/events.js';
import { Networks } from '../../src/builder.js';

function makeDeps(
  store: MemoryStore,
  adapter: FakeAdapter,
  signer: FakeSigner,
  overrides: Partial<EngineDeps> = {},
): EngineDeps {
  return {
    store,
    adapter,
    signer,
    events: new QueueEvents(),
    builderConfig: { networkPassphrase: Networks.TESTNET, baseFee: '100' },
    leaseMs: TEST_LEASE_MS,
    backoff: { baseMs: 1_000, capMs: 60_000, random: () => 0.5 },
    retryJournal: new Map(),
    ...overrides,
  };
}

const workerCtx = { workerId: 'worker-test', now: TEST_NOW };

/** Insert a QUEUED entry and return it (fresh intent per call). */
async function seedQueued(store: MemoryStore, overrides = {}): Promise<ReturnType<typeof makeQueueEntry>> {
  const entry = makeQueueEntry('QUEUED', overrides);
  await store.insert(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('QUEUED → … → SUCCESS with journaled hash + AttemptRecord', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const signer = new FakeSigner();
    const deps = makeDeps(store, adapter, signer);
    const entry = await seedQueued(store);

    // A PENDING ack leaves the entry CONFIRMING; the sweep then polls.
    const pending = await processEntry(deps, entry, workerCtx);
    expect(pending).toEqual({ kind: 'pending', status: 'CONFIRMING' });

    const confirming = (await store.get(entry.intent.id))!;
    expect(confirming.attemptCount).toBe(1);
    expect(confirming.inFlightHashes).toHaveLength(1);
    expect(confirming.attempts).toHaveLength(1);
    expect(confirming.attempts[0]!.outcome).toBe('UNKNOWN');
    expect(confirming.attempts[0]!.sequenceNumber).toBe(101); // account.seq + 1

    // Verdict poll → SUCCESS.
    adapter.statusFor(confirming.inFlightHashes[0]!, txSuccess());
    const outcome = await confirmEntry(deps, confirming, TEST_NOW + 1);
    expect(outcome).toEqual({ kind: 'settled', status: 'SUCCESS' });

    const settled = (await store.get(entry.intent.id))!;
    expect(settled.status).toBe('SUCCESS');
    expect(settled.attempts[0]!.outcome).toBe('SUCCESS');
    // Exactly one submission; the submitted hash is the journaled hash.
    expect(adapter.submittedHashes).toEqual(settled.inFlightHashes);
    // The signer produced a real signed envelope (hash computed by SDK).
    expect(signer.signedCount).toBe(1);
    expect(adapter.submittedHashes[0]).toBe(signer.signedHashes[0]);
  });

  it('write-ahead precedes submit (store state at send time already carries the hash)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    // Ground truth at send time: the journal must already be persisted.
    let journalAtSend: string[] | undefined;
    adapter.beforeSubmit = () => {
      void store.get(entry.intent.id).then((current) => {
        journalAtSend = current?.inFlightHashes;
      });
    };

    await processEntry(deps, entry, workerCtx);
    expect(journalAtSend).toHaveLength(1);
    expect(journalAtSend![0]).toBe(adapter.submittedHashes[0]);
  });

  it('call order: loadAccount → submit → status (verdict poll)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    // PENDING → CONFIRMING: the sweep would poll; confirm here.
    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'pending', status: 'CONFIRMING' });

    const confirming = await store.get(entry.intent.id);
    const hash = confirming!.inFlightHashes[0]!;
    adapter.statusFor(hash, txSuccess());
    const verdict = await confirmEntry(deps, confirming!, TEST_NOW + 1);
    expect(verdict).toEqual({ kind: 'settled', status: 'SUCCESS' });

    const ops = adapter.calls.map((c) => c.op);
    expect(ops).toEqual(['loadAccount', 'submit', 'status']);
  });

  it('events: intent:transition fires for every persisted move; intent:settled on SUCCESS', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    const transitions: string[] = [];
    let settled = 0;
    deps.events.on('intent:transition', (e) => transitions.push(e.status));
    deps.events.on('intent:settled', () => (settled += 1));

    await processEntry(deps, entry, workerCtx);
    // write-ahead (SUBMITTING) + submit-ack (CONFIRMING) — settled at verdict.
    expect(transitions).toEqual(['SUBMITTING', 'CONFIRMING']);
    expect(settled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deterministic failures (no side effects)
// ---------------------------------------------------------------------------

describe('deterministic failures before submission', () => {
  it('signer rejection → FAILED signer-rejected, zero write-ahead/submit', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const signer = new FakeSigner();
    signer.mode = 'reject';
    const deps = makeDeps(store, adapter, signer);
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'settled', status: 'FAILED' });

    const failed = await store.get(entry.intent.id);
    expect(failed!.status).toBe('FAILED');
    expect(failed!.lastError!.code).toBe('signer-rejected');
    // No side effects at all.
    expect(adapter.count('submit')).toBe(0);
    expect(adapter.submittedHashes).toHaveLength(0);
    expect(failed!.inFlightHashes).toHaveLength(0);
    expect(failed!.attempts).toHaveLength(0);
    expect(failed!.attemptCount).toBe(0);
  });

  it('malformed signer result (wrong network) → FAILED signer-malformed', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const signer = new FakeSigner();
    signer.mode = 'malformed-network';
    const deps = makeDeps(store, adapter, signer);
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'settled', status: 'FAILED' });

    const failed = await store.get(entry.intent.id);
    expect(failed!.lastError!.code).toBe('signer-malformed');
    expect(adapter.submittedHashes).toHaveLength(0);
  });

  it('payload-mismatch → FAILED payload-mismatch, nothing submitted', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const deps = makeDeps(store, adapter, new FakeSigner());

    // Seed a tampered entry directly: the store deliberately treats the
    // intent as immutable (applyUpdate skips it), so corruption is simulated
    // at insert — exactly the "honest-but-vulnerable store" model (§11).
    const base = makeQueueEntry('QUEUED');
    const tampered: QueueEntry = {
      ...base,
      intent: {
        ...base.intent,
        operations: [
          { type: 'payment', destination: validAccountId, asset: { code: 'XLM' }, amount: '999.0' },
        ],
      },
    };
    await store.insert(tampered);
    const stored = (await store.get(tampered.intent.id))!;

    // Sanity: the verifier flags the tampered entry.
    expect(verifyPayloadIntegrity(stored).ok).toBe(false);

    const outcome = await processEntry(deps, stored, workerCtx);
    expect(outcome).toEqual({ kind: 'settled', status: 'FAILED' });

    const failed = await store.get(tampered.intent.id);
    expect(failed!.lastError!.code).toBe('payload-mismatch');
    expect(adapter.submittedHashes).toHaveLength(0);
  });

  it('account not found → FAILED tx_no_account (deterministic, §15.1)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter(); // no account registered
    adapter.missingAccounts.add(validAccountId);
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'settled', status: 'FAILED' });

    const failed = await store.get(entry.intent.id);
    expect(failed!.lastError!.code).toBe('tx_no_account');
    expect(adapter.submittedHashes).toHaveLength(0);
  });

  it('build error → FAILED build-failed (deterministic)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, 'not-a-sequence');
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'settled', status: 'FAILED' });

    const failed = await store.get(entry.intent.id);
    expect(failed!.lastError!.code).toBe('build-failed');
    expect(adapter.submittedHashes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Submission classification (§8.2)
// ---------------------------------------------------------------------------

describe('submit classification', () => {
  it('structural ERROR (tx_bad_auth) → SUBMITTING→FAILED, attempt stamped FAILED', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    adapter.nextSubmit(submitError(['tx_bad_auth']));
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'settled', status: 'FAILED' });

    const failed = await store.get(entry.intent.id);
    expect(failed!.status).toBe('FAILED');
    expect(failed!.lastError!.code).toBe('tx_bad_auth');
    expect(failed!.attempts[0]!.outcome).toBe('FAILED');
    // One send happened (the envelope left, the endpoint rejected it).
    expect(adapter.submittedHashes).toHaveLength(1);
  });

  it('tx_too_late → CONFIRMING → EXPIRED (provably never included)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    adapter.nextSubmit(submitError(['tx_too_late']));
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'settled', status: 'EXPIRED' });

    const expired = await store.get(entry.intent.id);
    expect(expired!.status).toBe('EXPIRED');
    expect(expired!.attempts[0]!.outcome).toBe('EXPIRED');
    expect(adapter.submittedHashes).toHaveLength(1);
  });

  it('ambiguous ERROR (tx_insufficient_balance) → CONFIRMING ("poll the hash")', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    adapter.nextSubmit(submitError(['tx_insufficient_balance']));
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'pending', status: 'CONFIRMING' });

    const confirming = await store.get(entry.intent.id);
    expect(confirming!.status).toBe('CONFIRMING');
  });

  it('DUPLICATE → CONFIRMING; FAILED verdict attaches resultXdr', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    adapter.nextSubmit({ status: 'DUPLICATE', latestLedger: 100, latestLedgerCloseTime: 1 });
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'pending', status: 'CONFIRMING' });

    const confirming = await store.get(entry.intent.id);
    const hash = confirming!.inFlightHashes[0]!;
    adapter.statusFor(hash, txFailed('AAAA result=='));
    const verdict = await confirmEntry(deps, confirming!, TEST_NOW + 1);
    expect(verdict).toEqual({ kind: 'settled', status: 'FAILED' });

    const failed = await store.get(entry.intent.id);
    expect(failed!.attempts[0]!.resultXdr).toBe('AAAA result==');
    expect(failed!.lastError!.code).toBe('verdict-failed');
  });

  it('TRY_AGAIN_LATER → NEEDS_RETRY with persisted backoff', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    adapter.nextSubmit({ status: 'TRY_AGAIN_LATER', latestLedger: 100, latestLedgerCloseTime: 1 });
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({
      kind: 'scheduled-retry',
      status: 'NEEDS_RETRY',
      nextAttemptAt: TEST_NOW + 500, // ceiling 1000 × random 0.5
    });

    const retrying = await store.get(entry.intent.id);
    expect(retrying!.status).toBe('NEEDS_RETRY');
    expect(retrying!.nextAttemptAt).toBe(TEST_NOW + 500);
    expect(retrying!.backoffAttempts).toBe(1);
    // The signed envelope is journaled in memory for identical resubmission.
    expect(deps.retryJournal.has(entry.intent.id)).toBe(true);
    // Exactly one AttemptRecord — the resubmit must not add another.
    expect(retrying!.attempts).toHaveLength(1);
  });

  it('identical-envelope resubmission: same hash, no new AttemptRecord, no attemptCount bump', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    adapter.nextSubmit({ status: 'TRY_AGAIN_LATER', latestLedger: 100, latestLedgerCloseTime: 1 });
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    await processEntry(deps, entry, workerCtx); // → NEEDS_RETRY (journaled)
    expect(adapter.submittedHashes).toHaveLength(1);
    const firstHash = adapter.submittedHashes[0];

    // Due again; this worker still holds the signed envelope.
    const later = TEST_NOW + 5_000;
    const resumed = await processEntry(deps, entry, { workerId: 'worker-test', now: later });
    expect(resumed.kind === 'pending' || resumed.kind === 'settled').toBe(true);

    // Identical envelope: same hash resubmitted, no rebuild (signer called once).
    expect(adapter.submittedHashes).toEqual([firstHash, firstHash]);
    expect(signerCalls(deps)).toBe(1);

    const after = await store.get(entry.intent.id);
    expect(after!.attempts).toHaveLength(1);
    expect(after!.attemptCount).toBe(1);
  });

  it('budget exhausted → scheduleRetry routes to CONFIRMING (hash must be reconciled)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const deps = makeDeps(store, adapter, new FakeSigner());
    // Attempt budget already spent.
    const entry = await seedQueued(store, { attemptCount: 5, maxAttempts: 5 });

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'pending', status: 'CONFIRMING' });

    const confirming = await store.get(entry.intent.id);
    expect(confirming!.status).toBe('CONFIRMING');
  });
});

// ---------------------------------------------------------------------------
// Ownership + recovery invariants
// ---------------------------------------------------------------------------

describe('ownership + recovery invariants', () => {
  it('lost ownership before write-ahead → abort without submitting (§6.5.5)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    // Steal the entry between the claim and the pipeline run: simulate the
    // janitor reclaiming the candidate's pre-claim QUEUED state by a second
    // worker claiming it first.
    await store.transition(entry.intent.id, ['QUEUED'], 'QUEUED', {}, 1, TEST_NOW); // version 2
    // Claim by a rival worker directly (version from the fresh read).
    const rival = await store.get(entry.intent.id);
    const claim = await store.claim(
      entry.intent.id,
      ['QUEUED'],
      TEST_NOW,
      rival!.version,
      'worker-rival',
      TEST_LEASE_MS,
    );
    expect(claim.ok).toBe(true);

    const outcome = await processEntry(deps, entry, workerCtx);
    expect(outcome).toEqual({ kind: 'not-claimed', reason: 'state' });
    expect(adapter.submittedHashes).toHaveLength(0);
  });

  it('lost ownership mid-pipeline (before write-ahead) → throws, zero submissions', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const deps = makeDeps(store, adapter, new FakeSigner());
    const entry = await seedQueued(store);

    // Rival takeover while the owner is mid-phase: when the owner calls
    // loadAccount, the clock has moved past the lease — the janitor reclaims
    // and a rival worker claims. The owner's subsequent write-ahead re-read
    // must detect the loss and abort without submitting (§6.5.5).
    const originalLoad = adapter.loadAccount.bind(adapter);
    adapter.loadAccount = async (accountId: string) => {
      const rivalNow = TEST_NOW + TEST_LEASE_MS + 1;
      const reclaimedIds = await reclaimExpired(store, rivalNow);
      expect(reclaimedIds).toEqual([entry.intent.id]);
      const rivalVersion = (await store.get(entry.intent.id))!.version;
      const rivalClaim = await store.claim(
        entry.intent.id,
        ['QUEUED'],
        rivalNow,
        rivalVersion,
        'worker-rival',
        TEST_LEASE_MS,
      );
      expect(rivalClaim.ok).toBe(true);
      return originalLoad(accountId);
    };

    await expect(processEntry(deps, entry, workerCtx)).rejects.toThrow(OwnershipLostError);
    expect(adapter.submittedHashes).toHaveLength(0);
    expect(signerCalls(deps)).toBe(1); // signed, but never submitted

    // The entry is intact under the rival's live lease.
    const after = (await store.get(entry.intent.id))!;
    expect(after.status).toBe('READY');
    expect(after.claimedBy).toBe('worker-rival');
    expect(after.inFlightHashes).toHaveLength(0);
  });

  it('no-rebuild-while-in-flight: a rebuild candidate with unresolved hashes is not rebuilt (§6.5.2)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter().withAccount(validAccountId, '100');
    const deps = makeDeps(store, adapter, new FakeSigner());
    // Simulate a manual-retried entry that (illegally) still carries an
    // unresolved in-flight hash.
    const entry = await seedQueued(store, {
      inFlightHashes: ['f'.repeat(64)],
      lastError: undefined,
    });

    await expect(processEntry(deps, entry, workerCtx)).rejects.toThrow(OwnershipLostError);
    expect(adapter.submittedHashes).toHaveLength(0);
    expect(signerCalls(deps)).toBe(0);
  });

  it('crash between write-ahead and submit: reconcileSubmitting polls the hash, never rebuilds', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter();
    const deps = makeDeps(store, adapter, new FakeSigner());
    const hash = 'a'.repeat(64);
    const crashed = makeQueueEntry('SUBMITTING', {
      claimedBy: 'worker-dead',
      claimExpiresAt: TEST_NOW - 1,
      inFlightHashes: [hash],
      attemptCount: 1,
      attempts: [
        { envelopeHash: hash, sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: undefined,
    });
    await store.insert(crashed);
    adapter.statusFor(hash, txSuccess());

    const outcome = await reconcileSubmitting(deps, crashed, TEST_NOW + 1);
    expect(outcome).toEqual({ kind: 'settled', status: 'SUCCESS' });

    const settled = await store.get(crashed.intent.id);
    expect(settled!.status).toBe('SUCCESS');
    expect(settled!.attempts[0]!.outcome).toBe('SUCCESS');
    // Reconciliation, not rebuilding: status query only, no loadAccount/build/submit.
    expect(adapter.count('status')).toBe(1);
    expect(adapter.count('loadAccount')).toBe(0);
    expect(adapter.count('submit')).toBe(0);
  });

  it('reconcileSubmitting with NOT_FOUND leaves the entry honestly SUBMITTING', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter();
    const deps = makeDeps(store, adapter, new FakeSigner());
    const hash = 'b'.repeat(64);
    const crashed = makeQueueEntry('SUBMITTING', {
      inFlightHashes: [hash],
      attempts: [
        { envelopeHash: hash, sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: undefined,
    });
    await store.insert(crashed);
    adapter.statusFor(hash, txNotFound());

    const outcome = await reconcileSubmitting(deps, crashed, TEST_NOW + 1);
    expect(outcome).toEqual({ kind: 'pending', status: 'SUBMITTING' });

    const after = await store.get(crashed.intent.id);
    expect(after!.status).toBe('SUBMITTING');
  });

  it('confirmEntry on a CONFIRMING entry applies verdict-success and stamps the attempt', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter();
    const deps = makeDeps(store, adapter, new FakeSigner());
    const hash = 'c'.repeat(64);
    const confirming = makeQueueEntry('CONFIRMING', {
      inFlightHashes: [hash],
      attempts: [
        { envelopeHash: hash, sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: undefined,
    });
    await store.insert(confirming);
    adapter.statusFor(hash, txSuccess());

    const outcome = await confirmEntry(deps, confirming, TEST_NOW + 1);
    expect(outcome).toEqual({ kind: 'settled', status: 'SUCCESS' });

    const settled = await store.get(confirming.intent.id);
    expect(settled!.status).toBe('SUCCESS');
    expect(settled!.attempts[0]!.outcome).toBe('SUCCESS');
  });

  it('confirmEntry stays CONFIRMING on transport failure (no state churn)', async () => {
    const store = new MemoryStore();
    const adapter = new FakeAdapter();
    const deps = makeDeps(store, adapter, new FakeSigner());
    const hash = 'd'.repeat(64);
    const confirming = makeQueueEntry('CONFIRMING', {
      inFlightHashes: [hash],
      attempts: [
        { envelopeHash: hash, sequenceNumber: 101, submittedAt: TEST_NOW, outcome: 'UNKNOWN' },
      ],
      lastError: undefined,
    });
    await store.insert(confirming);
    // Script the status query to throw (transport failure).
    adapter.statusByHash.set(hash, txSuccess());
    const original = adapter.getTransactionStatus.bind(adapter);
    adapter.getTransactionStatus = async (h: string) => {
      if (h === hash) throw new Error('transport down');
      return original(h);
    };

    const outcome = await confirmEntry(deps, confirming, TEST_NOW + 1);
    expect(outcome).toEqual({ kind: 'pending', status: 'CONFIRMING' });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count signer invocations through the deps (fake signer counts itself). */
function signerCalls(deps: EngineDeps): number {
  return (deps.signer as FakeSigner).signedCount;
}
