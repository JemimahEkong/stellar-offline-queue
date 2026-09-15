/**
 * Reconciliation result types (Phase 7 / Issue #8 seam; the full pure verdict
 * engine arrives in Phase 14 / Issue #15).
 *
 * The recovery sweep and CONFIRMING polling in this phase produce honest
 * verdicts for the subset of cases the engine can decide with a fake/real
 * adapter: confirmed `SUCCESS`/`FAILED`, provable expiry (`tx_too_late`,
 * ledger time past `maxTime`), and — when evidence is unavailable — the
 * entry simply stays pending rather than guessing. `INDETERMINATE` requires
 * retention context (Phase 14).
 *
 * Model contract: ADR-0004, architecture §5.4, §8.1, §8.3.
 */

/**
 * Queue-level reconciliation outcomes (architecture §5.4). `NOT_SUBMITTED`
 * is the queue-level pseudo-outcome used only by the recovery sweep: the
 * entry never reached `SUBMITTING`, so it resumes building — it is not a
 * network verdict.
 */
export type ReconciliationOutcome = 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'INDETERMINATE' | 'NOT_SUBMITTED';

/** Per-intent reconciliation result (architecture §5.4). */
export type ReconciliationResult =
  | { outcome: 'SUCCESS'; transactionHash: string; ledger?: number | undefined }
  | { outcome: 'FAILED'; transactionHash: string; resultXdr?: string | undefined; reason: string }
  | { outcome: 'EXPIRED'; reason: string }
  | { outcome: 'INDETERMINATE'; reason: string }
  | { outcome: 'NOT_SUBMITTED'; reason: string };

/** Outcome → `AttemptRecord.outcome` narrowing (NOT_SUBMITTED never recorded). */
export function isRecordedOutcome(
  outcome: ReconciliationOutcome,
): outcome is 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'INDETERMINATE' {
  return outcome !== 'NOT_SUBMITTED';
}
