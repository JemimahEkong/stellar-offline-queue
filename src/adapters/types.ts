/**
 * Stellar network adapter interface and normalized result types
 * (Phase 7 seam / Issue #8; concrete adapters arrive in Phase 12).
 *
 * The engine depends only on this interface (ADR-0009): no SDK client type
 * leaks into core logic. Concrete `RpcAdapter`/`HorizonAdapter`
 * implementations live in `src/adapters/rpc.ts` / `src/adapters/horizon.ts`
 * and are the only modules allowed to import SDK network clients.
 *
 * Model contract: ADR-0009, architecture §4.6, §8.2. The normalized status
 * unions mirror the submission-error classification table (§8.2) so the
 * engine never parses transport-specific messages.
 */

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

/**
 * The account state needed at flush time: the current sequence number
 * (string, 64-bit — sequence numbers exceed JS safe integers) plus optional
 * ledger metadata for audit. Loaded by `loadAccount` before every build
 * (ADR-0005: sequences are resolved at flush time, never cached).
 */
export type AccountState = {
  /** Current sequence number of the account (decimal string). */
  sequence: string;

  /** Ledger number where the account was last modified (audit only). */
  lastModifiedTime?: number | undefined;
};

// ---------------------------------------------------------------------------
// Submission results (architecture §8.2)
// ---------------------------------------------------------------------------

/**
 * Normalized submission status. The engine classifies state transitions from
 * this value alone — never from transport-specific error text.
 */
export type SubmitStatus = 'PENDING' | 'DUPLICATE' | 'TRY_AGAIN_LATER' | 'ERROR' | 'TIMEOUT' | 'UNKNOWN';

/**
 * Normalized response to `submitTransaction`. All ambiguity is carried by
 * `status`, never thrown — a lost/ambiguous response is data (`UNKNOWN`,
 * `TIMEOUT`), not an exception, so the engine can journal and classify it.
 */
export type SubmitResult = {
  status: SubmitStatus;

  /** Envelope hash (hex) as acknowledged by the network, when known. */
  hash?: string | undefined;

  /** Latest ledger sequence known to the endpoint (audit/diagnostics). */
  latestLedger: number | undefined;

  /** Close time of the latest known ledger (ms epoch), for bounds math. */
  latestLedgerCloseTime: number | undefined;

  /**
   * Normalized operation/transaction result codes for `ERROR` responses
   * (e.g. `tx_bad_auth`, `tx_insufficient_balance`) or the operation-level
   * failure codes of a later-confirmed failed transaction.
   */
  errorCodes?: string[] | undefined;

  /** Raw transport error message (diagnostics only; never parsed by the engine). */
  detail?: string | undefined;
};

// ---------------------------------------------------------------------------
// Transaction status (for CONFIRMING polls and reconciliation)
// ---------------------------------------------------------------------------

/** Normalized transaction status from `getTransactionStatus`. */
export type TxStatusValue = 'SUCCESS' | 'FAILED' | 'NOT_FOUND';

/**
 * Normalized status query response. `latestLedgerCloseTime` and `oldestLedger`
 * are the reconciliation context the verdict engine needs (RPC provides both;
 * Horizon cannot — ADR-0009 verdict-quality caveat).
 */
export type TxStatus = {
  status: TxStatusValue;

  /** Result XDR of a confirmed-failed transaction (application diagnosis). */
  resultXdr?: string | undefined;

  /** Ledger number where the transaction was included, when confirmed. */
  ledger?: number | undefined;

  /** Close time of the latest known ledger (ms epoch). */
  latestLedgerCloseTime: number | undefined;

  /**
   * Sequence number of the oldest ledger still retained by the endpoint.
   * `undefined` when the transport cannot provide it (Horizon caveat).
   */
  oldestLedger: number | undefined;
};

// ---------------------------------------------------------------------------
// Adapter interface (ADR-0009)
// ---------------------------------------------------------------------------

/** The transaction shape the adapter submits. */
export type SubmitableTransaction = {
  /** Envelope hash (hex) — the write-ahead journal key. */
  hash: () => Uint8Array;

  /** Base64 XDR envelope — the wire format. */
  toXdr: () => string;
};

/**
 * Transport-agnostic access to Stellar: account loading, submission, and
 * status queries, with normalized responses (architecture §4.6).
 *
 * Errors: adapters surface transport failures as thrown `Error`s — the
 * engine treats a throw from any method as a transient condition and routes
 * it through the retry path. Never throw to express a *normalized* outcome;
 * resolved ambiguity belongs in `SubmitResult.status`.
 */
export interface StellarAdapter {
  /**
   * Load the current state of an account (sequence number). Throws when the
   * account does not exist (the engine maps this to a deterministic
   * `tx_no_account` failure — the account must be funded by the application,
   * architecture §15.1).
   */
  loadAccount(accountId: string): Promise<AccountState>;

  /**
   * Submit a signed transaction envelope. Resolves with a normalized
   * `SubmitResult` (see §8.2); throws only on transport failure before a
   * definite endpoint response.
   */
  submitTransaction(tx: SubmitableTransaction): Promise<SubmitResult>;

  /**
   * Query the status of a journaled envelope hash. Resolves with a
   * normalized `TxStatus` including retention context where available.
   */
  getTransactionStatus(hash: string): Promise<TxStatus>;
}
