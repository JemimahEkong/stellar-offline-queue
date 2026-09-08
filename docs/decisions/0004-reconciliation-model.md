# ADR-0004: Reconciliation Model

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

After a submission attempt, the only honest question an application can ask is: **did the payment happen?** Stellar's answer is often "we don't know yet" and sometimes "we will never know" — and the SDK does not help: `pollTransaction` returns `NOT_FOUND` for three structurally different situations (still pending, never accepted, aged out of the RPC retention window), and SDF's own issue #1615 describes the builder's real question as _"is it safe to retry without paying twice"_ — currently unanswered by the SDK.

The reconciliation engine is the differentiator of this project. It must produce a verdict for every submitted envelope and, critically, **never fabricate certainty**.

Stellar facts that make verdicts computable:

- Ledger close times are monotonic. Once `latestLedgerCloseTime > tx.maxTime`, the envelope **can never be included** (its sequence number was never consumed) → `EXPIRED` is final and rebuild is provably safe.
- RPC keeps a bounded history (`oldestLedger`; default retention ≈ 120,960 ledgers ≈ 7 days). Beyond it, `getTransaction` returns `NOT_FOUND` even for a landed transaction → outcome is **unknowable**, not "failed".
- `tx_bad_seq` can be fully disambiguated by comparing `account.seq` to the envelope's `tx.seq` (§7.3 of the architecture doc).
- Resubmitting the **identical** envelope is always safe (the network dedupes by hash — `DUPLICATE`); only a _new_ envelope is a new transaction.

## Options considered

### Option A — Two-value model (`SUCCESS` / `FAILED`)

- **Pros:** familiar.
- **Cons:** forces guesses. `NOT_FOUND` after a lost response would be classified "failed", and the app would rebuild — the exact double-payment path the project exists to prevent. Unacceptable.

### Option B — Three-value model (`SUCCESS` / `FAILED` / `UNKNOWN`)

- **Pros:** adds an escape hatch.
- **Cons:** `UNKNOWN` conflates "still pending" (actionable: keep polling/resubmitting) with "provably expired" (actionable: safe rebuild) with "evidence gone" (actionable: external resolution). The engine would have nowhere to put each case.

### Option C — Four-value model with reasons (recommended)

`SUCCESS | FAILED | EXPIRED | INDETERMINATE`, each carrying a machine-readable `reason` (and, for terminal on-chain outcomes, the transaction hash / result XDR):

```typescript
type ReconciliationResult =
  | { outcome: 'SUCCESS'; transactionHash: string; ledger?: number }
  | { outcome: 'FAILED'; transactionHash: string; resultXdr?: string; reason: string }
  | { outcome: 'EXPIRED'; reason: string } // provably never included → safe to rebuild
  | { outcome: 'INDETERMINATE'; reason: string }; // evidence window closed → outcome unknowable
```

- `SUCCESS` / `FAILED`: confirmed on-chain (via `getTransaction`), with the hash as receipt.
- `EXPIRED`: provably never included; the **only** state from which rebuilding is permitted.
- `INDETERMINATE`: the retention window closed while the outcome was unknown. Never guessed, surfaced to the application (check an explorer / Hubble / own indexer).
- A fifth queue-level pseudo-outcome, `NOT_SUBMITTED`, exists only inside the recovery sweep (entry never reached `SUBMITTING` → resume building). It is not a network verdict and is not exposed as one.

## Decision

Adopt Option C: the four-value verdict with structured reasons, implemented as a **pure function** `verdict(hash, tx, status)` (§8.3 of the architecture doc) over:

- `getTransaction` status (`SUCCESS` / `FAILED` / `NOT_FOUND`),
- `latestLedgerCloseTime` vs `tx.maxTime` (expiry),
- `oldestLedger` vs the inclusion window (retention).

Submission-error classification follows the rule **"when in doubt, poll the hash"**: only structural errors (`tx_bad_auth`, malformed XDR) are `FAILED` immediately; everything else transitions to `CONFIRMING` and lets `getTransaction` decide.

## Consequences

- The "did it happen?" question gets a definitive answer wherever the protocol permits one, and an honest `INDETERMINATE` wherever it does not.
- Rebuild-on-expiry is safe by construction: `EXPIRED` is the only rebuild trigger, and it is derived from ledger time, never device time.
- The engine aligns with SDF's proposed `confirmTransaction` verdict (issue #1615) — when the SDK ships it, `reconciliation.ts` swaps internals without changing the public result model.
- Cost: the engine needs bounds + retention context, which is why RPC is the primary adapter (Horizon lacks `oldestLedger`; its verdicts are documented as weaker).
