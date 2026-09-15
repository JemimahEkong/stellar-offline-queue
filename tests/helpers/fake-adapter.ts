/**
 * Scriptable `StellarAdapter` fake (Phase 7 test substrate).
 *
 * Features the engine/sweep tests rely on:
 *
 * - **Call-order recording** — every adapter call is appended to `calls`
 *   with a monotonically increasing sequence number, so tests can assert
 *   exact ordering (e.g. the write-ahead store transition precedes the
 *   first submit; per-account submissions never interleave).
 * - **Submission log** — `submittedHashes` records envelopes that actually
 *   left the process (used to assert at-most-once / zero-submission aborts).
 * - **Scripting** — per-account sequences, per-hash status answers, and a
 *   FIFO submit-result queue (default: `PENDING`).
 * - **Failure injection** — `beforeSubmit` (throws: transport failure
 *   before the envelope was sent), `afterSend` (throws: transport failure
 *   after send — the ambiguous case), and scripted `TIMEOUT` results.
 *
 * No network, no timers — `now` is injectable for deterministic timestamps.
 */

import type {
  AccountState,
  StellarAdapter,
  SubmitResult,
  SubmitableTransaction,
  TxStatus,
} from '../../src/adapters/types.js';
import { AccountNotFoundError } from '../../src/errors.js';

/** One scripted response for `submitTransaction` (FIFO-queued). */
export type ScriptedSubmit = { result?: SubmitResult; throw?: Error };

/** One recorded adapter call, in global call order. */
export type AdapterCall = {
  seq: number;
  op: 'loadAccount' | 'submit' | 'status';
  /** Account id (loadAccount) or envelope hash (submit/status). */
  target: string;
};

// ---------------------------------------------------------------------------
// Scripting helpers (terse fixtures for the common §8.2/§8.3 outcomes)
// ---------------------------------------------------------------------------

/** A `PENDING` submission ack for `hash` (the default script). */
export function submitPending(hash: string, at = 1): SubmitResult {
  return {
    status: 'PENDING',
    hash,
    latestLedger: 100,
    latestLedgerCloseTime: at,
    errorCodes: undefined,
    detail: undefined,
  };
}

/** A `DUPLICATE` ack — the endpoint already knows this envelope. */
export function submitDuplicate(hash: string, at = 1): SubmitResult {
  return { ...submitPending(hash, at), status: 'DUPLICATE' };
}

/** An ambiguous ack — the send state is unknown. */
export function submitUnknown(at = 1): SubmitResult {
  return { ...submitPending('unknown', at), status: 'UNKNOWN', hash: undefined };
}

/** `TRY_AGAIN_LATER` — transient, safe to resubmit the identical envelope. */
export function submitTryAgainLater(at = 1): SubmitResult {
  return { ...submitPending('try-again', at), status: 'TRY_AGAIN_LATER', hash: undefined };
}

/** A `TIMEOUT` — ambiguous, may still land. */
export function submitTimeout(at = 1): SubmitResult {
  return { ...submitPending('timeout', at), status: 'TIMEOUT', hash: undefined };
}

/** A structural submission error (provably never included). */
export function submitError(codes: string[], at = 1): SubmitResult {
  return { ...submitPending('error', at), status: 'ERROR', hash: undefined, errorCodes: codes };
}

/** Confirmed-success status answer for a polled hash. */
export function txSuccess(at = 1): TxStatus {
  return {
    status: 'SUCCESS',
    resultXdr: undefined,
    ledger: 101,
    latestLedgerCloseTime: at,
    oldestLedger: undefined,
  };
}

/** Confirmed-failed status answer (with result XDR for diagnosis). */
export function txFailed(resultXdr = 'AAAAAAAAAAA=', at = 1): TxStatus {
  return {
    status: 'FAILED',
    resultXdr,
    ledger: 101,
    latestLedgerCloseTime: at,
    oldestLedger: undefined,
  };
}

/** Not-yet-retained status answer (the endpoint never saw the hash). */
export function txNotFound(at = 1): TxStatus {
  return {
    status: 'NOT_FOUND',
    resultXdr: undefined,
    ledger: undefined,
    latestLedgerCloseTime: at,
    oldestLedger: undefined,
  };
}

// ---------------------------------------------------------------------------
// FakeAdapter
// ---------------------------------------------------------------------------

export class FakeAdapter implements StellarAdapter {
  /** Every adapter call in global order — the engine test's ground truth. */
  readonly calls: AdapterCall[] = [];

  /** Envelope hashes of submissions that actually left this process. */
  readonly submittedHashes: string[] = [];

  /** Hashes passed to `getTransactionStatus`, in order. */
  readonly statusQueries: string[] = [];

  /** Account ids passed to `loadAccount`, in order. */
  readonly accountLoads: string[] = [];

  private seqCounter = 0;

  /** Account → current sequence number (decimal string). */
  readonly accounts = new Map<string, string>();

  /** Accounts that do not exist on the network (`AccountNotFoundError`). */
  readonly missingAccounts = new Set<string>();

  /** Accounts whose `loadAccount` throws a transport error. */
  readonly transportFailAccounts = new Set<string>();

  /** Per-hash status answers for `getTransactionStatus`. */
  readonly statusByHash = new Map<string, TxStatus>();

  /** FIFO submit script; consumed one entry per `submitTransaction` call. */
  submitQueue: ScriptedSubmit[] = [];

  /**
   * Fallback status when `statusByHash` has no entry for the polled hash.
   * `undefined` (default) → `NOT_FOUND`.
   */
  statusDefault: TxStatus | undefined;

  /** Injection point: throws simulate a transport failure before send. */
  beforeSubmit: ((tx: SubmitableTransaction) => void) | undefined;

  /**
   * Injection point: throws simulate a transport failure after send —
   * the ambiguous "envelope possibly sent, no response" case.
   */
  afterSend: ((tx: SubmitableTransaction) => void) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  private record(op: AdapterCall['op'], target: string): void {
    this.calls.push({ seq: this.seqCounter++, op, target });
  }

  async loadAccount(accountId: string): Promise<AccountState> {
    await Promise.resolve(); // the real adapter is async; keep the shape
    this.record('loadAccount', accountId);
    this.accountLoads.push(accountId);
    if (this.missingAccounts.has(accountId)) {
      throw new AccountNotFoundError(accountId);
    }
    if (this.transportFailAccounts.has(accountId)) {
      throw new Error(`transport failure loading account state`);
    }
    const sequence = this.accounts.get(accountId);
    if (sequence === undefined) {
      throw new AccountNotFoundError(accountId);
    }
    return { sequence, lastModifiedTime: undefined };
  }

  async submitTransaction(tx: SubmitableTransaction): Promise<SubmitResult> {
    await Promise.resolve(); // the real adapter is async; keep the shape
    const hash = Buffer.from(tx.hash()).toString('hex');
    this.record('submit', hash);

    // Injection point 1: transport failure BEFORE the envelope was sent.
    if (this.beforeSubmit !== undefined) this.beforeSubmit(tx);

    // From here on the envelope has left the process.
    this.submittedHashes.push(hash);

    // Injection point 2: transport failure AFTER send (ambiguous outcome).
    if (this.afterSend !== undefined) this.afterSend(tx);

    const scripted = this.submitQueue.shift();
    if (scripted?.throw !== undefined) throw scripted.throw;
    if (scripted?.result !== undefined) {
      // The ack's hash defaults to the submitted envelope's hash unless the
      // script says otherwise (e.g. UNKNOWN acks carry no hash).
      return { ...scripted.result, hash: scripted.result.hash ?? hash };
    }
    return submitPending(hash, this.now());
  }

  async getTransactionStatus(hash: string): Promise<TxStatus> {
    await Promise.resolve(); // the real adapter is async; keep the shape
    this.record('status', hash);
    this.statusQueries.push(hash);
    const scripted = this.statusByHash.get(hash) ?? this.statusDefault;
    if (scripted !== undefined) return scripted;
    return txNotFound(this.now());
  }

  // -- Test conveniences ----------------------------------------------------

  /** Queue a submit response for the next `submitTransaction` call. */
  nextSubmit(result: SubmitResult): this {
    this.submitQueue.push({ result });
    return this;
  }

  /** Queue a transport throw for the next `submitTransaction` call. */
  nextSubmitThrows(error: Error): this {
    this.submitQueue.push({ throw: error });
    return this;
  }

  /** Script the status answer for a specific envelope hash. */
  statusFor(hash: string, status: TxStatus): this {
    this.statusByHash.set(hash, status);
    return this;
  }

  /** Register a funded account with the given sequence number. */
  withAccount(accountId: string, sequence = '100'): this {
    this.accounts.set(accountId, sequence);
    return this;
  }

  /** Number of recorded calls of one op kind. */
  count(op: AdapterCall['op']): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  /** Clear scripts and hooks; keep the recorded logs. */
  resetScripts(): void {
    this.submitQueue = [];
    this.statusByHash.clear();
    this.statusDefault = undefined;
    this.beforeSubmit = undefined;
    this.afterSend = undefined;
  }
}
