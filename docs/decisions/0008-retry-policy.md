# ADR-0008: Retry Policy

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

"Retry" is the most dangerous word in the project: the difference between a safe retry and a double payment is a single state distinction. The policy must answer four questions precisely:

1. Which states/errors are **automatically retried**, and how?
2. Which failures are **permanent** (never auto-retried)?
3. What does **manual** `retry(id)` do — who may call it, from which states, and with what limits?
4. What is the **attempt budget**, and what happens when it runs out?

Stellar constraints that shape the answers:

- Resubmitting the **identical** envelope is always safe (the network dedupes by hash). Rebuilding a **new** envelope is only safe after provable expiry (`EXPIRED`), because a new envelope is a new transaction.
- Time bounds bound how long an envelope may still land; beyond `maxTime` an envelope can never be included.
- `FAILED` from a confirmed on-chain failure (or a provably-never-included submission error) is permanent — the transaction did not happen (or happened and failed), and retrying it automatically would re-run the same doomed or dangerous path.
- Money-moving code needs a hard stop: silent unlimited retries are how double-payments and fee bleed happen.

## Options considered

### Option A — Automatic retries only (no manual API)

- **Pros:** smallest surface; the pipeline decides everything.
- **Cons:** applications need a human/operational escape hatch ("the RPC was misconfigured, now it's fixed, re-run this") that doesn't require deleting and re-creating intents (which would lose the id/audit trail).

### Option B — Automatic + unlimited manual retry

- **Pros:** maximally permissive.
- **Cons:** an unlimited manual retry is an unbounded money-movement loop. A bug or a stuck operator could re-fire a permanently-failed payment arbitrarily many times. Rejected.

### Option C — Automatic + limited manual retry (recommended)

Automatic retries stay inside the pipeline; manual `retry(id)` is explicit, app-invoked, and shares the same attempt budget.

## Decision

Adopt Option C.

### Retryable (automatic, inside the pipeline)

| Situation                                                           | Behavior                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `SUBMITTING` transient failures (`TRY_AGAIN_LATER`, network errors) | identical-envelope resubmission via `NEEDS_RETRY`, exponential backoff (§6.6) |
| Envelope still within time bounds                                   | identical-envelope resubmission is always safe                                |
| `EXPIRED` (ledger time > `maxTime`), attempts remain                | automatic rebuild with fresh sequence + fresh bounds; `attemptCount++`        |
| `CONFIRMING`                                                        | not a retry — poll-only until a verdict                                       |

### Non-retryable (permanent, never automatic)

| State / failure                                                        | Why                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `FAILED` — on-chain failure (`getTransaction` → `FAILED`)              | the transaction was applied and failed; nothing to retry                           |
| `FAILED` — provably never included (malformed envelope, `tx_bad_auth`) | deterministic; resubmitting is meaningless                                         |
| `FAILED` — `payload-mismatch` (store corruption)                       | do not rebuild a tampered intent; surface to the application                       |
| `INDETERMINATE`                                                        | outcome unknowable; retrying would risk a duplicate — external resolution required |
| `SUCCESS`                                                              | already settled                                                                    |

### Manual `retry(id)`

- **Manual, never automatic:** only `queue.retry(id)` re-queues a terminal entry.
- **Allowed from:** `FAILED` and attempts-exhausted `EXPIRED`.
- **Not allowed from:** `SUCCESS`, `INDETERMINATE`, `SUBMITTING`, `CONFIRMING`, `QUEUED`, `NEEDS_RETRY` (already scheduled), `READY` (owned).
- **Limited:** permitted only while `attemptCount < maxAttempts`; otherwise throws `AttemptsExhaustedError`. It schedules the _next_ attempt immediately; it never extends the budget.
- **Creates a new attempt record:** the retried cycle builds a fresh envelope and journals a new `AttemptRecord` (and hash) at the write-ahead transition, preserving the full audit trail (`attempts[]`).
- **Effect:** `FAILED → QUEUED` or `EXPIRED → QUEUED` with `nextAttemptAt = now` and `backoffAttempts` reset.

### Attempt budget

- `maxAttempts` (default 5) counts **build cycles** (each `EXPIRED` rebuild increments it); identical-envelope resubmissions within one cycle do not.
- The in-bounds resubmit loop is additionally bounded by `maxAgeSeconds` — whichever bound comes first sends the entry to `CONFIRMING` (poll) or `EXPIRED` (rebuild).
- When the budget is exhausted: `EXPIRED` becomes terminal, `FAILED` stays terminal. The application may create a **new** intent (new id) if it genuinely wants to re-run the payment — a deliberate, auditable act, not an accidental loop.

## Consequences

- Safe retries (identical envelope, rebuild-after-expiry) happen automatically; dangerous retries (rebuilding ambiguous outcomes, unlimited re-fires) are structurally impossible.
- Operators have an explicit, budgeted escape hatch that preserves the audit trail.
- Cost: one error type (`AttemptsExhaustedError`), the state restrictions on `retry(id)`, and clear documentation of what "attempt" means.
