# ADR-0006: Lifecycle State Machine

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

Every intent needs a formal lifecycle: the queue must distinguish successful, failed, expired, and uncertain outcomes; know which states are retryable; survive crashes mid-processing; and expose an auditable trail. The state machine is the contract between the engine, the store, and the application's observers.

Two design questions drive the shape:

1. **Which states must be durable?** A crash can happen at any instant. The store is the only memory that survives — so the _side-effect boundaries_ (about to send to the network, sent and unconfirmed) must be durable, while mechanical phases (building, signing) do not need to be.
2. **How is "waiting" represented?** Retry delays (backoff, waiting for connectivity) are real, durable waits. They can be a state or a field.

## Options considered

### Option A — The naïve pipeline (CREATED → QUEUED → READY → BUILDING → SIGNING → SUBMITTING → CONFIRMING → SUCCESS, with FAILED/EXPIRED/INDETERMINATE/NEEDS_RETRY)

- **Pros:** familiar, matches the prompt's sketch.
- **Cons:** without persisting _which_ states are durable and _when_ transitions are written, it is just a diagram. `NEEDS_RETRY` as a catch-all hides two different retry kinds (resubmit-identical vs rebuild); `EXPIRED` as a terminal state hides the rebuild path.

### Option B — Explicit durable/transient split + CAS transitions (recommended)

- **Persisted states:** `QUEUED`, `READY` (claimed, under lease — see ADR-0007), `NEEDS_RETRY`, `SUBMITTING`, `CONFIRMING`, `SUCCESS`, `FAILED`, `EXPIRED`, `INDETERMINATE`.
- **Transient (in-memory phases only):** `CREATED`, `BUILDING`, `SIGNING` — a crash here is harmless because nothing has reached the network; the entry remains `READY` under its lease and is reclaimed to `QUEUED` once the lease expires (ADR-0007, §6.7).
- **Write-ahead invariant:** the transition into `SUBMITTING` plus the envelope-hash journal is one atomic store operation **before** the network call. A crash after that write leaves a hash to reconcile; a crash before it leaves nothing sent.
- **Ownership invariant:** entry processing is exclusive via CAS claim + lease; a lost owner aborts without submitting (ADR-0007).
- **Retry semantics made explicit:**
  - `SUBMITTING → NEEDS_RETRY → SUBMITTING`: identical-envelope resubmission (transient submit failures), governed by backoff and bounded by time bounds.
  - `CONFIRMING → EXPIRED → QUEUED`: rebuild with fresh sequence + bounds, governed by `maxAttempts`. `EXPIRED` is transitional while attempts remain, terminal otherwise.
  - `SUBMITTING → CONFIRMING` on any ambiguous ack (`PENDING`, `DUPLICATE`, exhausted `TRY_AGAIN_LATER`, 504) — once possibly-sent, only polling decides.
  - `CONFIRMING → INDETERMINATE` when the retention window closes the evidence — never a guess.
- **CAS enforcement:** every persisted transition is a store CAS on `(fromStates, version)` (§9.2, ADR-0003), so the diagram is enforced, not aspirational.
- **Exhaustive transition table** (valid, invalid, triggers) in §6.3–6.4 of `docs/architecture.md`, unit-tested in full.

## Decision

Adopt Option B. The V1 machine has eleven states with the durable/transient split, the write-ahead invariant, the ownership/lease model (ADR-0007), and the CAS-enforced transition table defined in §6 of `docs/architecture.md`. The prompt's `NEEDS_RETRY` is retained as a first-class durable state for scheduled identical-envelope resubmission; `EXPIRED` is transitional (rebuild) while attempts remain and terminal after; `FAILED` is terminal with an explicit app-driven `retry(id)` escape.

## Consequences

- Crash recovery is mechanical and provable: sweep `SUBMITTING`/`CONFIRMING` → reconcile journaled hashes; reset transient states; resume scheduled retries (§8.3).
- The "at most once per intent" guarantee is testable as a state-machine property (no path from an unresolved in-flight hash to a fresh build).
- Costs: eleven states (a few more than the minimum), one atomic store primitive per persisted transition, and the discipline that transient phases never touch the network.
- Applications get a precise, auditable status vocabulary — including honest `INDETERMINATE` — which is the project's core value proposition.
