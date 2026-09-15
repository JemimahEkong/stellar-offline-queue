/**
 * Signer boundary (Phase 7 seam / Issue #8; hardening in Phase 11).
 *
 * The single interface through which applications sign (ADR-0002): the
 * library receives an **unsigned** draft and hands it to the application's
 * signer; the application owns keys and returns a signed envelope. Private
 * keys are structurally absent from the library's types — it cannot store,
 * serialize, or log what it never receives.
 *
 * Invoked at exactly one lifecycle point (SIGNING), before the write-ahead
 * `SUBMITTING` transition. Signer rejection (throw/reject) is deterministic:
 * the engine maps it to `FAILED` (`signer-rejected`) with no side effects.
 *
 * Model contract: ADR-0002, architecture §4.5, §10 (`OfflineQueueConfig.signer`).
 */

import type { Transaction } from '@stellar/stellar-sdk';

/** Context handed to the signer with the unsigned draft. */
export type SigningContext = {
  /** Intent being signed (for the application's own audit/UI). */
  intentId: string;
  /** Network passphrase the envelope will be built for. */
  networkPassphrase: string;
};

/**
 * The application-owned signer (ADR-0002). The library defines and consumes
 * this interface; it never implements key storage, derivation, or selection.
 * A wallet-kit or Keypair adapter lives in application code (see examples in
 * Phase 11).
 */
export interface Signer {
  /**
   * Sign the given unsigned transaction and return the signed envelope.
   *
   * Implementations must complete within the claim lease (documented
   * constraint, ADR-0007 — interactive/human signing is out of V1 scope).
   * Throwing or rejecting is a deterministic rejection: no store mutation
   * has been made at this point, so the entry can fail safely with zero
   * side effects.
   */
  sign(transaction: Transaction, context: SigningContext): Promise<Transaction>;
}
