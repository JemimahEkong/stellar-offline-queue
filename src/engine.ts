/**
 * Engine: claim → payload check → BUILDING → SIGNING → atomic write-ahead →
 * submit → classify → confirm, for **one claimed entry**
 * (Phase 7 / Issue #8, architecture §4.2, §6.5–6.7, §8.2).
 *
 * The engine is the state-machine executor. Its structural rules:
 *
 * 1. **Write-ahead (§6.5.1):** the transition to `SUBMITTING` and the
 *    envelope hash are persisted in one atomic store call *before* the
 *    network adapter is called. A crash after this write leaves a journaled
 *    hash for reconciliation — "envelope possibly sent, no record of it" is
 *    impossible.
 * 2. **Lost-ownership abort (§6.5.5):** every persisted step is a CAS
 *    transition; a lost CAS (reclaim, takeover, stale version) throws
 *    `OwnershipLostError` and the caller aborts **without submitting** —
 *    the worker never races the new owner. Ownership is re-verified against
 *    the durable record immediately before the write-ahead transition.
 *
 * BUILDING and SIGNING are transient (in-memory) phases: they are validated
 * against the pure transition table logically but never persisted, so a
 * crash there leaves the entry READY under its lease for the janitor
 * (ADR-0007 rule 5). Consequently the write-ahead CAS runs from the durable
 * `READY` state while its trigger (`write-ahead`) is validated logically as
 * `SIGNING → SUBMITTING`.
 *
 * Submission classification (§8.2): PENDING/DUPLICATE/UNKNOWN → CONFIRMING;
 * TRY_AGAIN_LATER / transport errors / TIMEOUT → NEEDS_RETRY (backoff;
 * identical envelope on resume — see below); ERROR `tx_bad_auth`/
 * `tx_malformed` (structural) → FAILED; ERROR `tx_too_late` → CONFIRMING →
 * EXPIRED; all other ERRORs → CONFIRMING ("when in doubt, poll the hash").
 *
 * Identical-envelope resume (ADR-0008, Phase 8): the signed envelope is held
 * in memory for in-worker resume; the AttemptRecord additionally journals
 * the deterministic build parameters (`sequenceNumber`, `maxTime`, `fee`),
 * so a **post-restart** resume rebuilds the byte-identical envelope via
 * `buildDeterministic`, re-signs, and asserts the rebuilt hash equals the
 * journaled hash **before** submitting (`envelope-drift` → FAILED if it
 * does not). No signatures are ever persisted.
 *
 * Backoff progress rule (§6.6): `backoffAttempts` resets on any
 * **non-transient** progress — SUBMITTING→CONFIRMING (submit-ack),
 * CONFIRMING→verdict, NEEDS_RETRY→SUBMITTING (resume write-ahead), and
 * rebuild/manual-retry → QUEUED — and increments only on
 * SUBMITTING→NEEDS_RETRY transient failures.
 */

import type { QueueStore, QueueEntry, AttemptRecord } from './store/types.js';
import type { IntentStatus, TransitionTrigger } from './state.js';
import { validateTransition } from './state.js';
import type { QueueEvents } from './events.js';
import { claimEntry, refreshLease, type ClaimResult } from './ownership.js';
import {
  buildDeterministic,
  buildTransaction,
  type BuilderConfig,
  type BuildParams,
  type FlushParams,
} from './builder.js';
import type { Signer } from './signer.js';
import type { StellarAdapter, SubmitResult, TxStatus } from './adapters/types.js';
import { computePayloadHash } from './intent.js';
import {
  OwnershipLostError,
  AccountNotFoundError,
} from './errors.js';
import { computeBackoffDelay } from './backoff.js';
import type { Transaction } from '@stellar/stellar-sdk';

/** The signed envelope kept in memory for in-worker NEEDS_RETRY resume. */
export type RetryJournalRecord = {
  /** The signed transaction (memory only — never persisted, §11.2). */
  tx: Transaction;
  /** Envelope hash of `tx` (lowercase hex). */
  envelopeHash: string;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Terminal outcome of one engine run over one entry. */
export type ProcessOutcome =
  | { kind: 'settled'; status: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'INDETERMINATE' }
  | { kind: 'pending'; status: 'SUBMITTING' | 'CONFIRMING' | 'NEEDS_RETRY' }
  | { kind: 'scheduled-retry'; status: 'NEEDS_RETRY'; nextAttemptAt: number }
  | { kind: 'already-settled' }
  | { kind: 'not-claimed'; reason: Exclude<ClaimResult, { ok: true }>['reason'] };

/** Dependencies of the engine, resolved once per queue (see `OfflineQueue`). */
export type EngineDeps = {
  store: QueueStore;
  adapter: StellarAdapter;
  signer: Signer;
  events: QueueEvents;
  builderConfig: BuilderConfig;
  /** Claim lease duration (ADR-0010 #1). */
  leaseMs: number;
  /** Backoff knobs (ADR-0010 #4/#5) + injectable random for determinism. */
  backoff: { baseMs: number; capMs: number; random: () => number };
  /**
   * In-memory journal of signed envelopes awaiting identical-envelope
   * resubmission (ADR-0008 / §8.1 Case 3). One record per entry whose last
   * attempt ended in a scheduled retry. Process-lifetime only: after a
   * restart it is empty and NEEDS_RETRY entries are reconciled (Phase 13/14),
   * never rebuilt.
   */
  retryJournal: Map<string, RetryJournalRecord>;
};

/** Worker context for one pipeline run. */
export type WorkerContext = {
  workerId: string;
  /** Injected clock (ms epoch) — no wall-clock sampling anywhere. */
  now: number;
};

/** Result of the payload-integrity check (architecture §9.4). */
export type PayloadIntegrityResult =
  | { ok: true; payloadHash: string }
  | { ok: false; reason: 'payload-mismatch' };

/**
 * Verify the stored intent against its `payloadHash` (§9.4). A tampered or
 * corrupted payload is never rebuilt — it fails loudly.
 */
export function verifyPayloadIntegrity(entry: QueueEntry): PayloadIntegrityResult {
  const recomputed = computePayloadHash({
    sourceAccount: entry.intent.sourceAccount,
    operations: entry.intent.operations,
    memo: entry.intent.memo,
    timeBounds: entry.intent.timeBounds,
  });
  if (recomputed !== entry.intent.payloadHash) {
    return { ok: false, reason: 'payload-mismatch' };
  }
  return { ok: true, payloadHash: recomputed };
}

/** Compute the envelope hash of a built/signed transaction (lowercase hex). */
export function transactionHash(tx: { hash(): Uint8Array }): string {
  return Buffer.from(tx.hash()).toString('hex');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Persist one transition. Validates the move against the pure state table
 * (client-side enforcement of §6.3), aborts on CAS loss — a lost CAS is
 * ownership loss (§6.5.5) — and refreshes the lease (ADR-0007 rule 3:
 * every persisted transition refreshes it). Emits `intent:transition`.
 */
async function cas(
  deps: EngineDeps,
  current: QueueEntry,
  to: IntentStatus,
  trigger: TransitionTrigger,
  update: Partial<QueueEntry>,
  now: number,
): Promise<QueueEntry> {
  validateTransition(current.status, to, trigger);

  // Backoff progress rule (§6.6): every persisted move other than the
  // transient-failure row is non-transient progress — reset the consecutive
  // failure counter (the scheduleRetry row sets its own value explicitly).
  if (trigger !== 'transient-failure' && update.backoffAttempts === undefined && current.backoffAttempts !== 0) {
    update.backoffAttempts = 0;
  }

  const result = await deps.store.transition(
    current.intent.id,
    [current.status],
    to,
    { ...update, claimExpiresAt: now + deps.leaseMs },
    current.version,
    now,
  );
  if (!result.ok) {
    throw new OwnershipLostError(
      current.intent.id,
      current.claimedBy ?? 'unknown-worker',
      `CAS ${current.status} → ${to} failed (${result.reason})`,
    );
  }
  deps.events.emit('intent:transition', result.entry);
  return result.entry;
}

/** Persist a deterministic failure (`QUEUED`/`NEEDS_RETRY` → FAILED, §6.3 row 17). */
async function failEntry(
  deps: EngineDeps,
  current: QueueEntry,
  code: string,
  message: string,
  now: number,
): Promise<QueueEntry> {
  const updated = await cas(
    deps,
    current,
    'FAILED',
    'deterministic-failure',
    { lastError: { code, message, ts: now } },
    now,
  );
  emitSettled(deps, updated);
  return updated;
}

/** Fire `intent:settled` when an entry reaches a terminal state. */
function emitSettled(deps: EngineDeps, entry: QueueEntry): void {
  if (entry.status === 'SUCCESS' || entry.status === 'FAILED' || entry.status === 'INDETERMINATE') {
    deps.events.emit('intent:settled', entry);
  }
}

/** The newest journaled hash of an entry, if any. */
function lastInFlightHash(entry: QueueEntry): string | undefined {
  return entry.inFlightHashes[entry.inFlightHashes.length - 1];
}

/**
 * Stamp the newest AttemptRecord's outcome once it is definitively known
 * (attempt records are appended with `outcome: 'UNKNOWN'` at write-ahead).
 * A CAS loss here only loses an audit stamp — the state transition itself
 * already persisted the verdict — so failures are swallowed.
 */
async function recordOutcome(
  deps: EngineDeps,
  entry: QueueEntry,
  outcome: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'INDETERMINATE',
  now: number,
): Promise<void> {
  const attempts = entry.attempts.map((a, i) =>
    i === entry.attempts.length - 1 ? { ...a, outcome } : a,
  );
  await deps.store
    .transition(entry.intent.id, [entry.status], entry.status, { attempts }, entry.version, now)
    .then(
      () => undefined,
      () => undefined,
    );
}

// ---------------------------------------------------------------------------
// Engine pipeline
// ---------------------------------------------------------------------------

/**
 * Run one due entry through the full pipeline: claim, then (fresh path)
 * build → sign → write-ahead → submit → classify, or (resume path)
 * identical-envelope resubmit of a journaled NEEDS_RETRY entry.
 *
 * Throws `OwnershipLostError` when ownership was lost at any CAS — the
 * caller (sweep) counts it as an abort and moves on. Never throws for a
 * plain claim loss (returns `not-claimed`).
 */
export async function processEntry(
  deps: EngineDeps,
  candidate: QueueEntry,
  workerCtx: WorkerContext,
): Promise<ProcessOutcome> {
  const claimResult = await claimEntry(deps.store, candidate.intent.id, {
    workerId: workerCtx.workerId,
    leaseMs: deps.leaseMs,
    now: workerCtx.now,
  });
  if (!claimResult.ok) {
    return { kind: 'not-claimed', reason: claimResult.reason };
  }

  const entry = claimResult.entry;
  const now = workerCtx.now;

  // -- Resume path: identical-envelope resubmission (ADR-0008) ------------
  // The claim set the durable status to READY; the journaled signed envelope
  // from this worker's previous cycle is resubmitted byte-identical — no new
  // AttemptRecord, no attemptCount increment (identical-envelope
  // resubmissions do not create build cycles).
  const journaled = deps.retryJournal.get(entry.intent.id);
  if (journaled !== undefined) {
    return resumeSubmit(deps, entry, journaled, now);
  }

  // NEEDS_RETRY claimed but this worker holds no signed envelope (process
  // restart): rebuild the **byte-identical** envelope deterministically from
  // the journaled AttemptRecord parameters (ADR-0008, T8.3) and re-sign it.
  // Build is a pure function of (intent, sequence, fee, maxTime) — all three
  // journaled — so the rebuilt envelope hash must equal the journaled hash;
  // drift is a tamper/corruption signal and fails the entry without submit.
  //
  // Distinguish it from a *rebuilt* entry (EXPIRED → QUEUED via rebuild/
  // manual-retry, or a manual retry from FAILED): those legitimately start a
  // fresh cycle with a NEW envelope and no in-flight hashes. The durable
  // record marks a rebuild by clearing lastError — a fresh QUEUED entry has
  // none.
  if (candidate.status === 'NEEDS_RETRY' && entry.lastError !== undefined) {
    return resumeViaRebuild(deps, entry, now);
  }

  // -- 1. Payload integrity (§9.4, defense in depth post-claim) -----------
  // The sweep already fails tampered entries pre-claim; if corruption is
  // detected here — after the claim — the durable state is still READY (the
  // transient phases never wrote), and READY → FAILED via
  // deterministic-failure is the plan-T7.2 row for exactly this case. A
  // tampered intent is never rebuilt.
  const integrity = verifyPayloadIntegrity(entry);
  if (!integrity.ok) {
    await failEntry(deps, entry, 'payload-mismatch', 'stored payload does not match its payloadHash', now);
    return { kind: 'settled', status: 'FAILED' };
  }

  // -- No-rebuild-while-in-flight (§6.5.2) ---------------------------------
  // A new envelope is built only when every journaled hash has **resolved**
  // (its AttemptRecord outcome is SUCCESS/FAILED — terminal — or EXPIRED:
  // provably never included). A candidate with an unresolved hash must not
  // reach build — it is reconciled, never re-owned into a fresh envelope.
  // Prior hashes stamped EXPIRED (rebuilt entries) are resolved and legal.
  const resolvedOutcomes: ReadonlySet<string> = new Set(['SUCCESS', 'FAILED', 'EXPIRED', 'INDETERMINATE']);
  const resolvedHashes = new Set(
    entry.attempts.filter((a) => resolvedOutcomes.has(a.outcome)).map((a) => a.envelopeHash),
  );
  const unresolvedHashes = entry.inFlightHashes.filter((hash) => !resolvedHashes.has(hash));
  if (unresolvedHashes.length > 0) {
    throw new OwnershipLostError(
      entry.intent.id,
      workerCtx.workerId,
      'unresolved in-flight hashes present — entry must be reconciled, not rebuilt',
    );
  }

  // -- 2. BUILDING (transient) ---------------------------------------------
  // Refresh the lease before the long owner phases; the refresh is itself a
  // CAS write (version bump), so the refreshed record — not the claim-time
  // snapshot — backs every subsequent failure transition.
  const owned = await refreshLease(deps.store, entry.intent.id, workerCtx.workerId, deps.leaseMs, now);
  validateTransition('READY', 'BUILDING', 'build-started');

  let accountState;
  try {
    accountState = await deps.adapter.loadAccount(entry.intent.sourceAccount);
  } catch (error: unknown) {
    if (error instanceof AccountNotFoundError) {
      await failEntry(deps, owned, 'tx_no_account', 'source account not found on network', now);
      return { kind: 'settled', status: 'FAILED' };
    }
    // Transport failure: transient (§8.2) → NEEDS_RETRY with backoff.
    return scheduleRetry(deps, owned, now, 'loadAccount transport error');
  }

  let tx;
  try {
    tx = buildTransaction(
      entry.intent,
      accountState,
      deps.builderConfig,
      { flushTime: now } satisfies FlushParams,
    );
  } catch (error: unknown) {
    // Build validation error → deterministic failure (§6.3 row 17).
    await failEntry(deps, owned, 'build-failed', (error as Error).message, now);
    return { kind: 'settled', status: 'FAILED' };
  }
  validateTransition('BUILDING', 'SIGNING', 'draft-built');

  // -- 3. SIGNING (transient) ----------------------------------------------
  let signed: Transaction;
  try {
    signed = await deps.signer.sign(tx, {
      intentId: entry.intent.id,
      networkPassphrase: deps.builderConfig.networkPassphrase,
    });
  } catch {
    // Deterministic signer rejection → FAILED, no side effects (ADR-0002).
    await failEntry(deps, owned, 'signer-rejected', 'the application signer rejected the transaction', now);
    return { kind: 'settled', status: 'FAILED' };
  }

  // Malformed signing result: wrong network → FAILED `signer-malformed`.
  if (signed.networkPassphrase !== deps.builderConfig.networkPassphrase) {
    await failEntry(deps, owned, 'signer-malformed', 'signed envelope is for a different network', now);
    return { kind: 'settled', status: 'FAILED' };
  }
  const envelopeHash = transactionHash(signed);

  // -- 4. Write-ahead (atomic, §6.5.1) --------------------------------------
  // Re-read the durable record (still READY — transient phases never wrote)
  // and re-verify ownership immediately before the side-effecting transition
  // (§6.5.5). The AttemptRecord, the hash, and the state change are journaled
  // in the SAME atomic store write.
  const durable = await deps.store.get(entry.intent.id);
  if (durable === undefined) {
    throw new OwnershipLostError(entry.intent.id, workerCtx.workerId, 'entry removed before write-ahead');
  }
  if (durable.status !== 'READY' || durable.claimedBy !== workerCtx.workerId) {
    throw new OwnershipLostError(
      entry.intent.id,
      workerCtx.workerId,
      `durable record is ${durable.status} (claimed by "${durable.claimedBy ?? 'nobody'}") before write-ahead`,
    );
  }

  // Logical validation of the write-ahead row (§6.3 row 6); the durable CAS
  // runs from READY because transient phases are never persisted.
  validateTransition('SIGNING', 'SUBMITTING', 'write-ahead');
  // Deterministic build parameters (ADR-0008): journaled on the AttemptRecord
  // so a post-restart resume can rebuild this byte-identical envelope. The
  // per-op fee is the builder config's baseFee (tx.fee is the total).
  const buildParams: BuildParams = {
    sequence: tx.sequence,
    fee: deps.builderConfig.baseFee,
    maxTime:
      tx.timeBounds !== undefined
        ? Number(tx.timeBounds.maxTime)
        : Math.floor(now / 1000) + entry.intent.timeBounds.maxAgeSeconds,
  };
  const attempt: AttemptRecord = {
    envelopeHash,
    // Authoritative for identical rebuilds across restarts (decimal string,
    // 64-bit safe — sequences exceed Number.MAX_SAFE_INTEGER on mature
    // accounts).
    sequenceNumber: buildParams.sequence,
    maxTime: buildParams.maxTime,
    fee: buildParams.fee,
    submittedAt: now,
    outcome: 'UNKNOWN',
  };
  const writeAhead = await deps.store.transition(
    entry.intent.id,
    ['READY'],
    'SUBMITTING',
    {
      inFlightHashes: [...durable.inFlightHashes, envelopeHash],
      attempts: [...durable.attempts, attempt],
      attemptCount: durable.attemptCount + 1,
      lastError: undefined,
      claimExpiresAt: now + deps.leaseMs,
    },
    durable.version,
    now,
  );
  if (!writeAhead.ok) {
    throw new OwnershipLostError(
      entry.intent.id,
      workerCtx.workerId,
      `write-ahead CAS failed (${writeAhead.reason}) — aborting without submit`,
    );
  }
  deps.events.emit('intent:transition', writeAhead.entry);

  // Journal the signed envelope for identical-envelope resume, then submit.
  deps.retryJournal.set(entry.intent.id, { tx: signed, envelopeHash });

  // -- 5. Submit (§8.2 classification) --------------------------------------
  let submitResult: SubmitResult;
  try {
    submitResult = await deps.adapter.submitTransaction(signed);
  } catch (error: unknown) {
    // Transport failure after a journaled write-ahead: the send state is
    // ambiguous, but resubmitting the identical envelope is safe (network
    // dedupes by hash) → NEEDS_RETRY (§8.2).
    return scheduleRetry(deps, writeAhead.entry, now, `submit transport error: ${(error as Error).message}`);
  }

  return classifySubmitResult(deps, writeAhead.entry, signed, submitResult, now);
}

// ---------------------------------------------------------------------------
// Submit classification (§8.2)
// ---------------------------------------------------------------------------

/** Route a normalized submit result to its §8.2 outcome. */
async function classifySubmitResult(
  deps: EngineDeps,
  entry: QueueEntry,
  signed: Transaction,
  result: SubmitResult,
  now: number,
): Promise<ProcessOutcome> {
  switch (result.status) {
    case 'PENDING':
    case 'DUPLICATE':
    case 'UNKNOWN':
      // In flight / already known / ambiguous ack → poll the journaled hash.
      return toConfirming(deps, entry, now);

    case 'TRY_AGAIN_LATER':
      return scheduleRetry(deps, entry, now, 'endpoint returned TRY_AGAIN_LATER');

    case 'TIMEOUT':
      // Ambiguous — may still land; identical-envelope retry (§8.2).
      return scheduleRetry(deps, entry, now, 'submission timed out; outcome ambiguous');

    case 'ERROR': {
      const codes = result.errorCodes ?? [];
      if (codes.includes('tx_bad_auth') || codes.includes('tx_malformed')) {
        // Structural: provably never included (§8.2) → FAILED.
        deps.retryJournal.delete(entry.intent.id);
        const failedEntry = await failEntryProvable(deps, entry, codes[0] ?? 'tx_bad_auth', now);
        await recordOutcome(deps, failedEntry, 'FAILED', now);
        return { kind: 'settled', status: 'FAILED' };
      }
      if (codes.includes('tx_too_late')) {
        // Provably expired. The table routes expiry through the verdict row:
        // SUBMITTING → CONFIRMING (submit-ack) → EXPIRED (verdict-expired).
        deps.retryJournal.delete(entry.intent.id);
        const confirming = await cas(deps, entry, 'CONFIRMING', 'submit-ack', {}, now);
        const expired = await cas(deps, confirming, 'EXPIRED', 'verdict-expired', {}, now);
        // The attempt is definitively EXPIRED (provably never included).
        await recordOutcome(deps, expired, 'EXPIRED', now);
        return { kind: 'settled', status: 'EXPIRED' };
      }
      if (codes.includes('tx_bad_seq')) {
        // §7.3 decision table lands in Phase 14; the safe V1 default is to
        // poll the hash ("when in doubt, poll the hash", §8.2).
        deps.retryJournal.delete(entry.intent.id);
        return toConfirming(deps, entry, now);
      }
      // Other ERRORs (tx_insufficient_balance, …): inclusion cannot be ruled
      // out a priori → CONFIRMING.
      deps.retryJournal.delete(entry.intent.id);
      return toConfirming(deps, entry, now);
    }
  }
}

/** `SUBMITTING → FAILED` for provably-never-included errors (§6.3 row 10). */
async function failEntryProvable(
  deps: EngineDeps,
  current: QueueEntry,
  code: string,
  now: number,
): Promise<QueueEntry> {
  const updated = await cas(
    deps,
    current,
    'FAILED',
    'submit-error-provable',
    { lastError: { code, message: 'structural submission error; transaction provably never included', ts: now } },
    now,
  );
  emitSettled(deps, updated);
  return updated;
}

/** `SUBMITTING → CONFIRMING`: the entry awaits its verdict by polling. */
async function toConfirming(deps: EngineDeps, entry: QueueEntry, now: number): Promise<ProcessOutcome> {
  const updated = await cas(deps, entry, 'CONFIRMING', 'submit-ack', {}, now);
  // The signed envelope is no longer needed once in flight-and-acked:
  // CONFIRMING is poll-only (§6.2).
  deps.retryJournal.delete(updated.intent.id);
  return { kind: 'pending', status: 'CONFIRMING' };
}

/**
 * `SUBMITTING → NEEDS_RETRY` with `nextAttemptAt = now + backoff`.
 * Budget check: another cycle is scheduled only while
 * `attemptCount < maxAttempts`; an exhausted budget goes to CONFIRMING —
 * the entry already holds a journaled hash that must be reconciled, never
 * abandoned silently (§8.2: "exhausted → CONFIRMING").
 */
async function scheduleRetry(
  deps: EngineDeps,
  entry: QueueEntry,
  now: number,
  message: string,
): Promise<ProcessOutcome> {
  if (entry.attemptCount >= entry.maxAttempts) {
    return toConfirming(deps, entry, now);
  }
  const nextAttemptAt = now + computeBackoffDelay(entry.backoffAttempts, deps.backoff);
  await cas(
    deps,
    entry,
    'NEEDS_RETRY',
    'transient-failure',
    {
      backoffAttempts: entry.backoffAttempts + 1,
      nextAttemptAt,
      lastError: { code: 'transient-error', message, ts: now },
    },
    now,
  );
  return { kind: 'scheduled-retry', status: 'NEEDS_RETRY', nextAttemptAt };
}

// ---------------------------------------------------------------------------
// Identical-envelope resume (ADR-0008, in-worker)
// ---------------------------------------------------------------------------

/**
 * Resubmit the journaled identical envelope for a re-claimed NEEDS_RETRY
 * entry (this worker still holds the signed transaction). Write-ahead is a
 * pure state move (hash and AttemptRecord already journaled — no duplicate
 * record, no attemptCount increment), then submit + classify as usual.
 */
/**
 * Post-restart identical-envelope resume (ADR-0008, T8.3): the worker holds
 * no signed envelope (its process died), so rebuild the envelope
 * deterministically from the journaled AttemptRecord parameters
 * (`sequenceNumber`, `maxTime`, `fee`), re-sign, and assert the rebuilt hash
 * equals the journaled hash **before** submitting.
 *
 * The envelope is the identity: the network dedupes by hash, so a
 * byte-identical resubmission can never double-apply. A hash mismatch
 * (`envelope-drift`) means the stored intent no longer produces the journaled
 * envelope (tampering or a build-rule change) — the entry fails without
 * submitting; the journaled hash stays unresolved for reconciliation.
 */
async function resumeViaRebuild(
  deps: EngineDeps,
  entry: QueueEntry,
  now: number,
): Promise<ProcessOutcome> {
  const last = entry.attempts[entry.attempts.length - 1];
  const lastHash = lastInFlightHash(entry);
  if (
    last === undefined ||
    lastHash === undefined ||
    last.envelopeHash !== lastHash ||
    last.outcome !== 'UNKNOWN'
  ) {
    throw new OwnershipLostError(
      entry.intent.id,
      entry.claimedBy ?? 'unknown-worker',
      'NEEDS_RETRY entry lacks a consistent unresolved attempt record',
    );
  }

  let rebuilt: Transaction;
  try {
    const params: BuildParams = {
      sequence: last.sequenceNumber,
      fee: last.fee,
      maxTime: last.maxTime,
    };
    rebuilt = buildDeterministic(entry.intent, params, deps.builderConfig);
  } catch (error: unknown) {
    // Deterministic build failure → FAILED, no submission (§6.3 row 17).
    await failEntry(deps, entry, 'build-failed', (error as Error).message, now);
    return { kind: 'settled', status: 'FAILED' };
  }

  // Envelope identity check (ADR-0008): the rebuild must be byte-identical.
  const rebuiltHash = transactionHash(rebuilt);
  if (rebuiltHash !== lastHash) {
    await failEntry(deps, entry, 'envelope-drift', 'rebuilt envelope hash does not match the journaled hash', now);
    return { kind: 'settled', status: 'FAILED' };
  }

  // Re-sign the identical envelope. Signing does not change the hash
  // (Stellar hashes exclude signatures); the journal already carries it.
  let signed: Transaction;
  try {
    signed = await deps.signer.sign(rebuilt, {
      intentId: entry.intent.id,
      networkPassphrase: deps.builderConfig.networkPassphrase,
    });
  } catch {
    await failEntry(deps, entry, 'signer-rejected', 'the application signer rejected the transaction', now);
    return { kind: 'settled', status: 'FAILED' };
  }
  if (signed.networkPassphrase !== deps.builderConfig.networkPassphrase) {
    await failEntry(deps, entry, 'signer-malformed', 'signed envelope is for a different network', now);
    return { kind: 'settled', status: 'FAILED' };
  }
  if (transactionHash(signed) !== lastHash) {
    // Signing must not alter the transaction body (§11.2); treat any drift
    // as malformed — the journaled hash would no longer identify the
    // envelope being submitted.
    await failEntry(deps, entry, 'signer-malformed', 'signed envelope hash diverged from the journaled hash', now);
    return { kind: 'settled', status: 'FAILED' };
  }

  // The resume write-ahead: READY → SUBMITTING. Pure state move — the hash
  // and AttemptRecord are already journaled (no new record, no attemptCount
  // increment; identical-envelope resubmissions are not build cycles).
  await refreshLease(deps.store, entry.intent.id, entry.claimedBy ?? '', deps.leaseMs, now);
  const owned = await deps.store.get(entry.intent.id);
  if (owned === undefined) {
    throw new OwnershipLostError(entry.intent.id, entry.claimedBy ?? 'unknown-worker', 'entry removed before resume write-ahead');
  }
  validateTransition('SIGNING', 'SUBMITTING', 'write-ahead');
  const writeAhead = await deps.store.transition(
    entry.intent.id,
    ['READY'],
    'SUBMITTING',
    { claimExpiresAt: now + deps.leaseMs, backoffAttempts: 0 },
    owned.version,
    now,
  );
  if (!writeAhead.ok) {
    throw new OwnershipLostError(entry.intent.id, entry.claimedBy ?? 'unknown-worker', `resume write-ahead CAS failed (${writeAhead.reason})`);
  }
  deps.events.emit('intent:transition', writeAhead.entry);

  // Journal the freshly signed envelope for any in-worker resumption too.
  deps.retryJournal.set(entry.intent.id, { tx: signed, envelopeHash: lastHash });

  let submitResult: SubmitResult;
  try {
    submitResult = await deps.adapter.submitTransaction(signed);
  } catch (error: unknown) {
    return scheduleRetry(deps, writeAhead.entry, now, `submit transport error: ${(error as Error).message}`);
  }
  return classifySubmitResult(deps, writeAhead.entry, signed, submitResult, now);
}

async function resumeSubmit(
  deps: EngineDeps,
  entry: QueueEntry,
  journaled: RetryJournalRecord,
  now: number,
): Promise<ProcessOutcome> {
  // Defense: the journal must agree with the durable hash journal.
  if (!entry.inFlightHashes.includes(journaled.envelopeHash)) {
    deps.retryJournal.delete(entry.intent.id);
    throw new OwnershipLostError(
      entry.intent.id,
      entry.claimedBy ?? 'unknown-worker',
      'journaled envelope hash is not in the entry’s in-flight journal',
    );
  }

  await refreshLease(deps.store, entry.intent.id, entry.claimedBy ?? '', deps.leaseMs, now);
  const owned = await deps.store.get(entry.intent.id);
  if (owned === undefined) {
    throw new OwnershipLostError(entry.intent.id, entry.claimedBy ?? 'unknown-worker', 'entry removed before resume write-ahead');
  }
  validateTransition('SIGNING', 'SUBMITTING', 'write-ahead');
  const writeAhead = await deps.store.transition(
    entry.intent.id,
    ['READY'],
    'SUBMITTING',
    { claimExpiresAt: now + deps.leaseMs, backoffAttempts: 0 },
    owned.version,
    now,
  );
  if (!writeAhead.ok) {
    throw new OwnershipLostError(entry.intent.id, entry.claimedBy ?? 'unknown-worker', `resume write-ahead CAS failed (${writeAhead.reason})`);
  }
  deps.events.emit('intent:transition', writeAhead.entry);

  let submitResult: SubmitResult;
  try {
    submitResult = await deps.adapter.submitTransaction(journaled.tx);
  } catch (error: unknown) {
    return scheduleRetry(deps, writeAhead.entry, now, `submit transport error: ${(error as Error).message}`);
  }
  return classifySubmitResult(deps, writeAhead.entry, journaled.tx, submitResult, now);
}

// ---------------------------------------------------------------------------
// Confirm + recovery (§8.3 subset — the full verdict engine is Phase 14)
// ---------------------------------------------------------------------------

/** Poll a journaled hash; `undefined` on transport failure or empty journal. */
async function pollHash(deps: EngineDeps, hash: string | undefined): Promise<TxStatus | undefined> {
  if (hash === undefined) return undefined;
  try {
    return await deps.adapter.getTransactionStatus(hash);
  } catch {
    return undefined; // transport failure: no state change, retry later
  }
}

/**
 * Apply a definitive verdict to a CONFIRMING entry (§6.3 rows 12–13).
 * NOT_FOUND never resolves here — bounds/retention math is Phase 14; the
 * entry honestly stays CONFIRMING.
 */
async function applyVerdict(
  deps: EngineDeps,
  entry: QueueEntry,
  status: TxStatus,
  now: number,
): Promise<ProcessOutcome> {
  if (status.status === 'NOT_FOUND') {
    return { kind: 'pending', status: 'CONFIRMING' };
  }
  const verdict: 'SUCCESS' | 'FAILED' = status.status; // TxStatusValue narrowed
  const trigger: TransitionTrigger = verdict === 'SUCCESS' ? 'verdict-success' : 'verdict-failed';

  const attempts = entry.attempts.map((a, i) =>
    i === entry.attempts.length - 1
      ? {
          ...a,
          outcome: verdict,
          ...(verdict === 'FAILED' && status.resultXdr !== undefined ? { resultXdr: status.resultXdr } : {}),
        }
      : a,
  );
  const update: Partial<QueueEntry> = {
    attempts,
    ...(verdict === 'FAILED'
      ? { lastError: { code: 'verdict-failed', message: 'transaction confirmed failed on-chain', ts: now } }
      : {}),
  };
  const updated = await cas(deps, entry, verdict, trigger, update, now);
  emitSettled(deps, updated);
  return { kind: 'settled', status: verdict };
}

/**
 * Poll the newest journaled hash of a CONFIRMING entry and apply the verdict
 * transitions (§6.3 rows 12–15 subset).
 */
export async function confirmEntry(
  deps: EngineDeps,
  entry: QueueEntry,
  now: number,
): Promise<ProcessOutcome> {
  if (entry.status !== 'CONFIRMING') {
    return { kind: 'already-settled' };
  }
  const status = await pollHash(deps, lastInFlightHash(entry));
  if (status === undefined) {
    return { kind: 'pending', status: 'CONFIRMING' };
  }
  return applyVerdict(deps, entry, status, now);
}

/**
 * Recovery step for a SUBMITTING entry left behind by a crash between
 * write-ahead and submit (§6.7 crash table): reconcile the journaled hash —
 * never rebuild. A definitive verdict first moves the entry SUBMITTING →
 * CONFIRMING (submit-ack row), then applies the verdict. NOT_FOUND/transport
 * failure leaves the entry untouched (Phase 14 completes the classification).
 */
export async function reconcileSubmitting(
  deps: EngineDeps,
  entry: QueueEntry,
  now: number,
): Promise<ProcessOutcome> {
  if (entry.status !== 'SUBMITTING') {
    return { kind: 'already-settled' };
  }
  const status = await pollHash(deps, lastInFlightHash(entry));
  if (status === undefined || status.status === 'NOT_FOUND') {
    return { kind: 'pending', status: 'SUBMITTING' };
  }
  const confirming = await cas(deps, entry, 'CONFIRMING', 'submit-ack', {}, now);
  return applyVerdict(deps, confirming, status, now);
}
