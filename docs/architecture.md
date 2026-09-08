# stellar-offline-queue — V1 Architecture

**Status:** Proposed for review (no implementation)
**Date:** September 5, 2026
**Supersedes:** docs/research.md (research phase). This document is the design phase deliverable.
**Related:** ADRs in `docs/decisions/` — 0001 (intent model), 0002 (signer boundary), 0003 (storage), 0004 (reconciliation), 0005 (sequence strategy), 0006 (state machine), 0007 (processing ownership), 0008 (retry policy), 0009 (network adapter).

---

## 1. Purpose

`stellar-offline-queue` is a MIT-licensed TypeScript library providing **offline-first transaction workflow management with eventual Stellar settlement**. It is a reliability layer above `@stellar/stellar-sdk`, not a replacement for it, not a wallet, and not a payment network.

The library lets applications:

- create durable payment intents with zero network access,
- persist and queue those intents across restarts,
- process queued intents when connectivity returns,
- submit Stellar transactions safely (no double payments),
- track transaction lifecycle through an explicit state machine,
- retry with bounded, Stellar-correct semantics,
- and reconcile uncertain outcomes (`did the payment happen?`).

**The core promise:** for any intent that reaches a `SUCCESS` state, exactly one on-chain application occurred. The library never guarantees _when_ settlement happens — only that it happens **at most once per intent**, and that uncertainty is always surfaced honestly as `INDETERMINATE` rather than guessed.

---

## 2. Goals, Non-Goals, and Design Principles

### 2.1 Goals (V1)

1. Durable offline intent creation and storage (Node first: in-memory + SQLite; browser via adapter interface).
2. A formal, documented lifecycle state machine with crash recovery.
3. A reconciliation engine that returns one of `SUCCESS | FAILED | EXPIRED | INDETERMINATE` for any submitted intent, using Stellar time-bounds and RPC retention semantics — not guesswork.
4. Sequence-number correctness for multiple queued intents on the same account (serialization, rebuild-on-expiry, `tx_bad_seq` handling).
5. Duplicate-payment prevention via envelope-hash journaling and write-ahead persistence.
6. A clean signer boundary: the library never touches private keys.
7. Minimal, stable public API.

### 2.2 Non-goals (V1)

- Soroban / smart-contract transactions (simulation, `prepareTransaction`, footprint management). _V2._
- Channel-account pooling for parallel throughput. _V2_ (track SDF js-stellar-sdk #1599).
- Automatic fee-bump recovery. _V2_ (track SDF #1602).
- Off-chain payment channels (that is `@stellar/mpp`'s problem).
- A background daemon, CLI, or hosted service.
- A wallet, key storage, or key management.
- Consensus, validation, or any on-chain logic.
- Reimplementing anything the SDK already provides (XDR, signing primitives, network clients, fee math).

### 2.3 Design principles

1. **Stellar correctness over convenience.** Where an easy implementation conflicts with safe retry semantics, choose safety (see ADR-0005).
2. **Durability before side effects.** Any state that precedes a network call must be persisted first (write-ahead). A crash must never leave "envelope possibly sent, no record of it."
3. **Never guess.** When the network cannot answer definitively, the library says `INDETERMINATE` and tells the application why. It never auto-rebuilds on ambiguous outcomes.
4. **Fewest moving parts.** One package, one state machine, three storage adapters in scope, two network adapters.
5. **Everything an implementer needs is in this document** — no guessing about transitions, fields, or edge cases.

---

## 3. System Context

```
┌──────────────────────────┐
│       Application        │  calls addIntent() / process() / reconcile(); owns keys
└───────────┬──────────────┘
            │ intents / events / queries
┌───────────▼──────────────┐
│    Payment Intent Layer  │  intent model, validation, payload hashing, factories
└───────────┬──────────────┘
┌───────────▼──────────────┐
│       Queue Engine       │  public API, worker sweep, scheduler, backoff
└───────┬───────────┬──────┘
        │           │
┌───────▼───────┐  ┌▼────────────────────┐
│ Storage Layer │  │ Transaction Builder │  intent → SDK TransactionBuilder draft
│ (store)       │  └───────┬─────────────┘
└───────┬───────┘          │ unsigned transaction
        │ durable state    ▼
┌───────▼────────────────────────────────┐
│          Signer Boundary (interface)   │  application wallet signs; library never sees keys
└───────────────────┬───────────────────┘
                    │ signed envelope
┌───────────────────▼───────────────────┐
│       Stellar Network Adapter         │  RPC / Horizon transport, normalized responses
└───────────────────┬───────────────────┘
                    │ submit / getTransaction / loadAccount
┌───────────────────▼───────────────────┐
│      Reconciliation Engine            │  verdicts: SUCCESS | FAILED | EXPIRED | INDETERMINATE
└───────────────────────────────────────┘
```

The layers are **conceptual** — in code they collapse into ~8 modules (see §14). Arrows are the only allowed dependency direction; lower layers never call upward.

---

## 4. Component Specifications

### 4.1 Payment Intent Layer

|                    |                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Responsibility** | Define, validate, and serialize what an application wants to happen on-chain. The intent is the durable, immutable "what".                                                                                   |
| **Purpose**        | Offline creation of side-effect-free descriptions; the unit of idempotency and audit.                                                                                                                        |
| **Inputs**         | `CreateIntentInput` (id?, sourceAccount, operations, memo?, timeBounds?, metadata?)                                                                                                                          |
| **Outputs**        | Validated `Intent` record + `payloadHash`                                                                                                                                                                    |
| **Dependencies**   | `@stellar/stellar-sdk` (operation config types, address/asset parsing)                                                                                                                                       |
| **Failure cases**  | Malformed address, invalid asset, non-positive amount, unsupported operation type, memo over length limit, missing source. All deterministic → `ValidationError` at `addIntent` time; entry never persisted. |
| **Testing**        | Unit: field validation matrix, payload-hash stability (same input → same hash; any build-relevant change → different hash), JSON round-trip, supported-op coverage.                                          |

See §5 for the model and ADR-0001.

### 4.2 Queue Engine

|                    |                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Responsibility** | Orchestrate the lifecycle: claim due entries, run them through build → sign → submit → confirm, schedule retries, and expose the public API.                                         |
| **Purpose**        | The state machine executor; turns stored intents into settled (or honestly-uncertain) outcomes.                                                                                      |
| **Inputs**         | Public API calls (`addIntent`, `getIntent`, `list`, `process`, `retry`, `reconcile`, `remove`), store, adapters, signer, config                                                      |
| **Outputs**        | State transitions (persisted), events, `ProcessSummary`                                                                                                                              |
| **Dependencies**   | Intent Layer, Storage Layer, Builder, Signer, Network Adapter, Reconciliation Engine                                                                                                 |
| **Failure cases**  | Crash mid-flight (handled by recovery sweep), concurrent `process()` (handled by store CAS claim), signer rejection, adapter outages (bounded retry), config errors at construction. |
| **Testing**        | Unit: sweep logic with fake store/adapter; integration: full lifecycle on testnet; reliability: crash/restart and double-processing scenarios (§13).                                 |

### 4.3 Storage Layer

|                    |                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Responsibility** | Durable, atomic persistence of queue entries; the source of truth for recovery.                                                  |
| **Purpose**        | Make the queue crash-safe and multi-process-safe via compare-and-set primitives.                                                 |
| **Inputs**         | `QueueEntry` records, CAS operations (`insert`, `claim`, `transition`, `listByState`, `get`, `remove`)                           |
| **Outputs**        | Persisted records; conflict results on CAS failure                                                                               |
| **Dependencies**   | None (interface); adapters: in-memory (tests/dev), SQLite (Node).                                                                |
| **Failure cases**  | Disk full, file lock contention, corrupted store (detected via payload-hash verification + schema version), duplicate id insert. |
| **Testing**        | Contract test suite run against every adapter: CAS conflict behavior, atomic transition semantics, restart durability.           |

See §9 and ADR-0003.

### 4.4 Transaction Builder

|                    |                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Responsibility** | Convert a validated intent + current account state into an **unsigned** SDK transaction draft at flush time.                                                        |
| **Purpose**        | Keep envelopes fresh: sequence and time bounds are resolved when connectivity exists, never at intent creation.                                                     |
| **Inputs**         | `Intent`, `AccountState` (sequence number), network passphrase, base fee, resolved time bounds                                                                      |
| **Outputs**        | `TransactionBuilder` draft (unsigned)                                                                                                                               |
| **Dependencies**   | SDK `TransactionBuilder`, `Account`, `Network`                                                                                                                      |
| **Failure cases**  | Unsupported operation combination, fee below network minimum (config), account missing (account must be funded — documented prerequisite), build validation errors. |
| **Testing**        | Unit: intent→draft mapping for every supported operation, sequence assignment, time-bound application.                                                              |

### 4.5 Signer Boundary

|                    |                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Responsibility** | Delegate all signing to the application; receive a signed envelope.                                                                                                        |
| **Purpose**        | Guarantee the library never holds, stores, or serializes private keys (see §10, ADR-0002).                                                                                 |
| **Inputs**         | Unsigned `Transaction` (or fee-bump in V2), signing context (network passphrase, intent id)                                                                                |
| **Outputs**        | Signed envelope or rejection error                                                                                                                                         |
| **Dependencies**   | None (application-provided)                                                                                                                                                |
| **Failure cases**  | Signer throws (key unavailable, user cancelled) → deterministic `SIGNING → FAILED` (no side effects, safe). Wrong-network signing detected at submission as `tx_bad_auth`. |
| **Testing**        | Fake signer in unit tests; wallet-kit-based signer in examples; rejection-path tests.                                                                                      |

### 4.6 Stellar Network Adapter

|                    |                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Responsibility** | Transport-agnostic access to Stellar: account loading, submission, and status queries, with normalized responses.                                               |
| **Purpose**        | One interface so reconciliation logic is transport-independent; isolate SDK client details.                                                                     |
| **Inputs**         | Operations + a `Transaction`/envelope + hashes                                                                                                                  |
| **Outputs**        | Normalized `SubmitResult`, `TxStatus`, `AccountState`                                                                                                           |
| **Dependencies**   | SDK `rpc.Server` / `Horizon.Server`                                                                                                                             |
| **Failure cases**  | Network down, HTTP 5xx, rate limits (429), timeouts, malformed responses. All surfaced as typed adapter errors the engine can classify (transient vs terminal). |
| **Testing**        | Contract tests against a recording fake adapter (reliability suite) + real testnet integration tests.                                                           |

Normalized response shapes (see §6.3, §6.4). Capability differences between RPC and Horizon are documented in §6.4.3 — RPC is the primary adapter because it exposes `oldestLedger`/`latestLedgerCloseTime`, which the reconciliation verdict requires.

### 4.7 Reconciliation Engine

|                    |                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Responsibility** | Answer "did the payment happen?" for any submitted envelope, and classify the outcome.                                                                                                             |
| **Purpose**        | The differentiator of the project: the `SUCCESS                                                                                                                                                    | FAILED | EXPIRED | INDETERMINATE` verdict (ADR-0004). |
| **Inputs**         | Recorded in-flight hashes, intent time bounds, `TxStatus` results (incl. `oldestLedger`, `latestLedgerCloseTime`)                                                                                  |
| **Outputs**        | `ReconciliationResult` per intent                                                                                                                                                                  |
| **Dependencies**   | Network Adapter, time-bound math (pure)                                                                                                                                                            |
| **Failure cases**  | Transport unavailable during reconciliation → retry later (no state change); retention window exceeded → `INDETERMINATE` (never fabricated success/failure).                                       |
| **Testing**        | **Table-driven unit tests are the priority of the project**: every combination of (submit response, status query, bounds state, retention state) → expected verdict. Plus reliability tests (§13). |

---

## 5. Data Models

### 5.1 Intent (the immutable "what")

```typescript
interface Intent {
  /** Stable identity. App-supplied (for business idempotency) or library-generated UUIDv4. */
  id: string;

  /** Account that will be the transaction source (consumes the sequence number). */
  sourceAccount: string; // G... address

  /** The payload. Ordered array of SDK operation configs — NOT flat destination/asset/amount. */
  operations: OperationConfig[]; // discriminated union, see §5.2

  /** Optional transaction-level memo. */
  memo?: MemoConfig; // { type: 'text'|'id'|'hash'|'return', value: string }

  /** Relative validity window, resolved to absolute time bounds at BUILD time (never at creation). */
  timeBounds: { maxAgeSeconds: number }; // default 300; enforced ≥ floor (default 60)

  /** App-owned opaque JSON. Never affects the built envelope. */
  metadata?: Record<string, unknown>;

  /** Creation timestamp (ms). */
  createdAt: number;

  /**
   * SHA-256 hex of the canonical JSON of { sourceAccount, operations, memo, timeBounds }.
   * Verified before every build. Guards against accidental or malicious payload drift.
   */
  payloadHash: string;
}
```

**Field justification (see ADR-0001):**

- **Required:** `id` (idempotency + recovery), `sourceAccount` (authorization + sequence ownership), `operations` (the actual on-chain effect), `timeBounds` (safe retry window), `createdAt` (audit + FIFO), `payloadHash` (integrity).
- **Optional:** `memo` (application references, e.g. invoice IDs; validated against SDK limits), `metadata` (app context; excluded from payload hash so it never changes the envelope).
- **Never stored:** private keys/seed phrases, secrets, RPC credentials, and **full signed envelopes** (see ADR-0002/0005). Sequence numbers are never stored as authoritative intent data — only recorded per attempt for audit (§5.3).

**Why `operations`, not flat `destination/asset/amount`:** the library is a transaction-workflow layer, not a payments-only layer. The operation list is the durable truth; flat fields would be a lossy, drifting duplicate of it. A `createPaymentIntent()` helper (see §10) restores flat ergonomics for the common case while the model stays general.

### 5.2 Supported operation configs (V1)

Discriminated union over SDK operation descriptors:

- `payment` (destination, asset, amount)
- `createAccount` (destination, startingBalance)
- `pathPaymentStrictSend` / `pathPaymentStrictReceive`
- `changeTrust` (asset, limit?)
- `manageSellOffer` / `manageBuyOffer`
- `setOptions` (subset: inflationDest?, homeDomain?, signer?, thresholds)

Extensible by adding union members in later versions; validation lives in one switch.

### 5.3 QueueEntry (the mutable "how far we got")

```typescript
interface QueueEntry {
  intent: Intent; // embedded; payload section treated as immutable
  status: IntentStatus; // §7 state machine
  attemptCount: number; // number of BUILD attempts started
  maxAttempts: number; // snapshot of config at enqueue
  nextAttemptAt: number; // ms epoch; scheduler gate (0 = due now)
  backoffAttempts: number; // consecutive transient failures (drives backoff)
  claimedBy?: string; // worker id holding the claim lease (§6.7)
  claimExpiresAt: number; // ms epoch; 0 = unclaimed; lease reclamation (§6.7)
  lastError?: { code: string; message: string; ts: number };
  inFlightHashes: string[]; // envelope hashes possibly sent to the network — write-ahead
  attempts: AttemptRecord[]; // audit log
  updatedAt: number;
  version: number; // optimistic concurrency for CAS
}
```

```typescript
interface AttemptRecord {
  envelopeHash: string; // hex — dedupe key, journaled before submit
  sequenceNumber: number; // audit only; never authoritative
  submittedAt: number;
  outcome: 'UNKNOWN' | 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'INDETERMINATE';
  resultXdr?: string; // on FAILED, for application diagnosis
}
```

**Recovery fields:** `status`, `inFlightHashes`, `nextAttemptAt`, `attemptCount`, `attempts` — everything a restart sweep needs.
**Idempotency fields:** `intent.id` (unique in store; `addIntent` with an existing id returns the existing entry) + `payloadHash` + `inFlightHashes` (never build a new envelope while an in-flight hash is unresolved).

### 5.4 Reconciliation result

```typescript
type ReconciliationResult =
  | { outcome: 'SUCCESS'; transactionHash: string; ledger?: number }
  | { outcome: 'FAILED'; transactionHash: string; resultXdr?: string; reason: string }
  | { outcome: 'EXPIRED'; reason: string } // provably never included; safe to rebuild
  | { outcome: 'INDETERMINATE'; reason: string }; // evidence window closed; outcome unknowable
```

Plus a queue-level pseudo-outcome used only by the recovery sweep: `NOT_SUBMITTED` (entry never reached `SUBMITTING`; resume building — this is not a network verdict).

---

## 6. Lifecycle State Machine

### 6.1 States

```
                    ┌───────────────────────────────────────────────┐
                    │      TRANSIENT (in-memory phases only)        │
                    │        CREATED → BUILDING → SIGNING           │
                    └───────────────────────────────────────────────┘
                                        ▲
              claim (lease)             │ owner's phases run while holding the lease
              QUEUED ───────────────────┴──► READY (durable, leased)
                                        │
                                        │ (persist SUBMITTING + hashes BEFORE network call)
                                        ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                    PERSISTED INTERMEDIATE                        │
  │   QUEUED · READY (leased) · SUBMITTING ⇄ NEEDS_RETRY · CONFIRMING │
  └──────────────────────────────────────────────────────────────────┘
                                        │
              ┌──────────────┬───────────┴───────────┬────────────────┐
              ▼              ▼                       ▼                ▼
          SUCCESS         FAILED                EXPIRED         INDETERMINATE
          (terminal)      (terminal)      (rebuild if attempts   (terminal)
                                             remain, else
                                             terminal)
```

### 6.2 State semantics

Every state below is justified by the problem it solves; none exists for symmetry. "Durable" means the transition is persisted to the store and survives restarts; "transient" means it exists only in the owning worker's memory (a crash there leaves the entry in its previous durable state).

| State           | Why it exists (problem it solves)                                                                                                                                                                                                                 | Durable or transient  | Retryable                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------- |
| `CREATED`       | Gives `addIntent()` a pre-validated in-memory object and a single persist point, so half-valid intents can never reach the store.                                                                                                                 | transient             | n/a                                     |
| `QUEUED`        | The durable "waiting" state: intents survive restarts and form a well-defined pool the scheduler scans. Solves: losing intents on crash; giving the scheduler a claimable set.                                                                    | durable               | yes (scheduled)                         |
| `READY`         | Claimed: marks **exclusive ownership** by one worker (`claimedBy`, `claimExpiresAt`). Solves: two workers processing the same intent — the duplicate-processing root cause. The lease makes dead workers' claims recoverable.                     | durable (lease)       | n/a (owned)                             |
| `BUILDING`      | Owner-phase: resolve account/sequence, build the draft. Not persisted because no side effects exist yet — a crash here simply lets the lease expire and the entry be reprocessed from scratch.                                                    | transient             | n/a                                     |
| `SIGNING`       | Owner-phase: await the application signer. Same reasoning as `BUILDING`; the lease must cover signer latency (documented constraint, ADR-0007).                                                                                                   | transient             | n/a                                     |
| `SUBMITTING`    | The **write-ahead** state: persisted _with_ the envelope hash before the network call. Solves the project's core problem — "envelope possibly sent, no record of it" is impossible. Any take-over must reconcile journaled hashes, never rebuild. | durable (write-ahead) | yes — identical envelope, within bounds |
| `NEEDS_RETRY`   | Durable wait for a scheduled identical-envelope resubmission (transient failures, backoff). Solves: persisting the retry schedule so restarts neither lose nor double-fire retries.                                                               | durable               | yes (scheduled)                         |
| `CONFIRMING`    | Awaiting the final verdict by polling. Solves: the post-submission ambiguity (`PENDING`/`DUPLICATE`/timeout) by refusing to guess — only `getTransaction` decides.                                                                                | durable               | no (polling only)                       |
| `SUCCESS`       | Terminal: confirmed on-chain. Solves: giving the app a receipt-grade endpoint for the workflow.                                                                                                                                                   | durable               | no                                      |
| `FAILED`        | Terminal: definitively failed with no on-chain effect (or on-chain failure). Solves: distinguishing "don't touch it" from "retry it"; the app may call `retry(id)` manually if the budget remains (ADR-0008).                                     | durable               | manual only                             |
| `EXPIRED`       | Provably never included (ledger time > `maxTime`). Solves: the only _safe_ rebuild trigger — the sequence was never consumed, so a fresh envelope cannot double-apply; also bounds automatic retries so a dead intent cannot loop forever.        | durable               | yes — rebuild while attempts remain     |
| `INDETERMINATE` | The evidence window closed (retention); the outcome is unknowable. Solves: the honesty requirement — never fabricate success/failure; surface to the app for external resolution.                                                                 | durable               | no                                      |

### 6.3 Transition table (valid)

| From                           | To               | Trigger                                                                                                                 | Notes                                                                       |
| ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `CREATED`                      | `QUEUED`         | `addIntent()` persists entry                                                                                            | unique on `id`; duplicate id → return existing entry                        |
| `QUEUED`                       | `READY`          | worker claim: CAS on status + version, `nextAttemptAt ≤ now`; sets `claimedBy` + `claimExpiresAt` (lease, default 60 s) | grants exclusive ownership; per-account single-writer enforced here (§6.7)  |
| `READY`                        | `QUEUED`         | janitor reclaim: `claimExpiresAt` passed; CAS from `READY`                                                              | owner lost the lease (crash/overshoot); no side effects had occurred (§6.7) |
| `READY`                        | `BUILDING`       | claim succeeded                                                                                                         | owner-phase; transient                                                      |
| `BUILDING`                     | `SIGNING`        | draft built                                                                                                             | transient                                                                   |
| `SIGNING`                      | `SUBMITTING`     | **persist state + `inFlightHashes` atomically, then call adapter**                                                      | the write-ahead invariant (§6.5)                                            |
| `SUBMITTING`                   | `CONFIRMING`     | submit ack: `PENDING`, `DUPLICATE`, or ambiguous (`UNKNOWN`/`TIMEOUT` after exhausted in-bounds retries)                |                                                                             |
| `SUBMITTING`                   | `NEEDS_RETRY`    | transient submit failure (`TRY_AGAIN_LATER`, network error) with attempts/backoff remaining                             | identical envelope on resume                                                |
| `NEEDS_RETRY`                  | `SUBMITTING`     | backoff elapsed; resubmit identical envelope                                                                            |                                                                             |
| `SUBMITTING`                   | `FAILED`         | submission error that **provably** rules out inclusion (malformed envelope, `tx_bad_auth`)                              | all other errors go to `CONFIRMING` (§8.2)                                  |
| `CONFIRMING`                   | `SUCCESS`        | `getTransaction` → `SUCCESS`                                                                                            |                                                                             |
| `CONFIRMING`                   | `FAILED`         | `getTransaction` → `FAILED`                                                                                             | attach `resultXdr`                                                          |
| `CONFIRMING`                   | `EXPIRED`        | `latestLedgerCloseTime > maxTime` (or `tx_too_late`)                                                                    | provably never included → rebuild                                           |
| `CONFIRMING`                   | `INDETERMINATE`  | `NOT_FOUND` and `oldestLedger` advanced past the inclusion window                                                       | evidence gone; do not guess                                                 |
| `EXPIRED`                      | `QUEUED`         | rebuild attempt: attempts remain                                                                                        | fresh sequence + fresh bounds; `attemptCount++`                             |
| `SUBMITTING`/`CONFIRMING`      | (recovery sweep) | restart                                                                                                                 | reconcile each `inFlightHash` first (§8.3)                                  |
| `QUEUED`/`NEEDS_RETRY`         | `FAILED`         | deterministic failure (validation at build, signer rejection)                                                           |                                                                             |
| any pre-`SUBMITTING`           | (removed)        | `remove(id)`                                                                                                            | only legal while no hash is in flight                                       |
| `FAILED`                       | `QUEUED`         | explicit `retry(id)`                                                                                                    | manual, limited by `maxAttempts`; new attempt record (ADR-0008)             |
| `EXPIRED` (attempts exhausted) | `QUEUED`         | explicit `retry(id)`                                                                                                    | manual, limited by `maxAttempts`; new attempt record (ADR-0008)             |

### 6.4 Invalid transitions

- `SUCCESS`, `FAILED`, `INDETERMINATE` → anything (terminal, except documented `retry()` from `FAILED`).
- `CONFIRMING` → `SUBMITTING` / `NEEDS_RETRY` (once submitted, the state must remain `CONFIRMING` until a verdict; rebuilding a new envelope requires `EXPIRED` first).
- Reclaiming or rebuilding an entry in `SUBMITTING`/`CONFIRMING` — those entries are **never re-owned or rebuilt**; they are only reconciled (§6.7).
- `BUILDING`/`SIGNING` → `CONFIRMING` (no envelope exists yet).
- Any transition that would build a **new** envelope while `inFlightHashes` is non-empty and unresolved.
- Any transition not listed in §6.3 — enforced by the store CAS on `(fromStates, version)`.

### 6.5 Durability invariants (the safety backbone)

1. **Write-ahead:** the transition to `SUBMITTING` and the envelope hash are persisted **in the same atomic store operation, before** the network adapter is called. If the process dies after this write, the hash exists; recovery polls it.
2. **No rebuild while in flight:** a new envelope is built for an intent only when every recorded in-flight hash has resolved to `SUCCESS`/`FAILED` (terminal) or `EXPIRED` (provably never included).
3. **Crash resume / lease reclaim:** `BUILDING` and `SIGNING` are in-memory phases with no persisted state — a crash there leaves the entry as `READY` under a lease. The recovery sweep (startup) and the janitor (runtime, §6.7) reclaim `READY` entries whose `claimExpiresAt` has passed, returning them to `QUEUED` (no side effects had occurred). Entries in `SUBMITTING`/`CONFIRMING` are never reclaimed or rebuilt — they require reconciliation of their recorded hashes before any further action.
4. **One envelope per ledger per account** is the network's rule; the library's serialization (§7.1) guarantees we never submit two envelopes for the same account in the same sweep window.
5. **Lost ownership aborts:** if a worker's lease expires (or another process wins a CAS conflict) while it is mid-phase, its next store transition fails with a version conflict and the worker **aborts the entry without submitting**. It never races the new owner (§6.7).

### 6.6 Backoff policy (V1)

Exponential with full jitter: `delay = min(cap, base * 2^backoffAttempts) * random(0,1)`, defaults `base = 1s`, `cap = 60s`, `maxAttempts = 5` (all configurable). `nextAttemptAt = now + delay`. The identical-envelope resubmit loop inside time bounds is bounded by both `maxAttempts` and `maxAgeSeconds` — whichever comes first sends the entry to `CONFIRMING` (poll) or `EXPIRED` (rebuild).

### 6.7 Processor Ownership and Concurrency Model

(Full analysis: ADR-0007.)

**Who can process an intent:** only the queue engine, and only by acquiring ownership through the store's CAS `claim()`. Ownership is never assumed — it is granted by the store and revocable.

**How duplicate processing is prevented (four independent layers):**

1. **CAS claim** — `claim(id, fromStates, now, version, workerId, leaseMs)` succeeds only if the entry is in `{QUEUED, NEEDS_RETRY}`, is due (`nextAttemptAt ≤ now`), and the version matches; it atomically sets `status = READY`, `claimedBy = workerId`, `claimExpiresAt = now + leaseMs`.
2. **CAS transitions** — every persisted state change is `transition(id, fromStates, to, update, version)`: a stale owner's write fails on version.
3. **Single-writer per account** — the scheduler never holds two entries of the same `sourceAccount` in-flight at once (§7.1).
4. **No-rebuild-while-in-flight** — a new envelope is built only after every journaled hash resolved (§6.5.2).

**Worker locking / claiming behaviour:**

- A successful claim grants a **lease** (default 60 s, configurable `leaseMs`). Every persisted transition refreshes it; the owner's in-memory phases (`BUILDING`, `SIGNING`) run inside it.
- The signer must complete within the lease (documented constraint — interactive/human signing is out of V1 scope).
- A worker whose lease expires or who loses any CAS conflict **aborts the entry without submitting** (invariant §6.5.5).

**Reclamation (janitor):** run at the start of `process()` and `reconcile()`; scans `READY` entries, and for each with `claimExpiresAt < now` performs a CAS `READY → QUEUED` (clearing `claimedBy`/`claimExpiresAt`). Only one reclaim wins per entry (version CAS); the loser re-reads. `SUBMITTING`/`CONFIRMING` entries are outside the janitor's reach — taking them over means _reconciling_ their journaled hashes, never rebuilding.

**Crash recovery during processing (per crash instant):**

| Crash happens while…                 | Durable state left behind | Recovery action                                                                                       |
| ------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `BUILDING`/`SIGNING` (in-memory)     | `READY` (lease)           | lease expires → janitor reclaims → `QUEUED` → reprocessed from scratch (no side effects had occurred) |
| Between write-ahead and network call | `SUBMITTING` + hash       | reconcile hash (`NOT_FOUND` + in bounds → resubmit identical)                                         |
| After submit, before response        | `SUBMITTING` + hash       | reconcile hash → verdict                                                                              |
| During `CONFIRMING` polling          | `CONFIRMING` + hash       | reconcile hash → verdict                                                                              |

Multi-process note: leases make shared-store deployments safe — a live worker's claim is never stolen; only expired claims are reclaimed, and the version-conflict-abort rule closes the takeover race.

---

## 7. Sequence Number Strategy

**Decision: Option B — queue unsigned intents; materialize envelopes at flush time.** (Full analysis: ADR-0005.)

Why A (queue signed envelopes) is rejected: a pre-signed envelope binds a sequence number and a `maxTime` at signing time. Any other transaction from the account — or simply time passing offline — invalidates it. The queue would be a row of landmines: the first lands, the rest fail `tx_bad_seq`, and "fixing" them requires re-signing anyway. Time bounds are also wrong offline: too short and intents expire while queued; too long and the retry window is unsafe. Option A optimizes a step (submit) that happens _last_, at the exact moment connectivity exists.

Why B: sequence numbers must equal `account.seq + 1` **at apply time**. Resolving them at flush time — when the account state is actually reachable — is the only Stellar-correct choice. Rebuilding is cheap (no network needed for building/signing beyond the one `loadAccount`), and the intent's `payloadHash` + `inFlightHashes` journal make rebuilds safe.

### 7.1 Per-account serialization (V1)

- The scheduler processes at most **one entry per source account at a time** (single-writer). Entries for different accounts may be processed concurrently (configurable worker count; default 1).
- Within an account, entries are claimed in FIFO order by `createdAt`, and each is built with the account's _current_ sequence at its own flush moment. FIFO is a predictability choice, not a correctness requirement — because each envelope is built fresh, any order is sequence-safe. Rebuild-on-expiry (§7.2) therefore cannot poison later entries.
- **Concurrent processing is structurally prevented**: the store's `claim()` is a CAS on `(status = QUEUED|NEEDS_RETRY, nextAttemptAt ≤ now, version)` that also grants the lease (§6.7); a second worker claiming the same entry gets a conflict, and a lost owner aborts without submitting.

### 7.2 Stale transactions and expiry

- Every envelope gets `maxTime = flushTime + maxAgeSeconds` (ledger time semantics handled by the reconciliation engine — verdicts use `latestLedgerCloseTime`, never the device clock).
- If an envelope reaches `CONFIRMING` and ledger time passes `maxTime` without inclusion, it is provably dead (`EXPIRED`): sequence never consumed. The library rebuilds with a fresh sequence and fresh bounds (attempt budget permitting) — safe by construction.
- **Cancellation:** V1 has no on-chain cancellation. `remove(id)` deletes entries **before** any submission (no in-flight hashes). Once submitted, an intent runs to `SUCCESS`, `FAILED`, `EXPIRED`, or `INDETERMINATE` — matching Stellar's own semantics. `bumpSequence`-based invalidation is V2.

### 7.3 `tx_bad_seq` reconciliation rule

On `tx_bad_seq` from submission, the engine reloads the account and compares `account.seq` against the envelope's `tx.seq`:

| Relationship                | Meaning                                   | Action                                                 |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `account.seq == tx.seq`     | this envelope **was included**            | `getTransaction(hash)` → definitive `SUCCESS`/`FAILED` |
| `account.seq == tx.seq − 1` | still the expected next transaction       | retry the identical envelope (transient)               |
| `account.seq < tx.seq − 1`  | submitted too early; earlier tx in flight | keep `CONFIRMING`; poll hash                           |
| `account.seq > tx.seq`      | can never be included now                 | poll hash to confirm absence, then `EXPIRED`/rebuild   |

This turns the SDK's most dangerous error into a deterministic decision procedure.

---

## 8. Reconciliation Engine

### 8.1 The three cases

**Case 1 — response lost after submission.** "Did the payment happen?"
The answer is never guessed. The hash was journaled write-ahead (§6.5), so recovery is: `getTransaction(hash)`.

- `SUCCESS`/`FAILED` → terminal verdict.
- `NOT_FOUND` + `latestLedgerCloseTime ≤ maxTime` + within retention → still possible: resubmit the **identical** envelope (network dedupes by hash — cannot double-apply) or keep polling.
- `NOT_FOUND` + `latestLedgerCloseTime > maxTime` → `EXPIRED`: can never be included; safe to rebuild.
- `NOT_FOUND` + evidence window gone (`oldestLedger` past inclusion window) → `INDETERMINATE`.

**Case 2 — RPC returns `NOT_FOUND`.** The four meanings and how the engine disambiguates:

| Possible meaning                      | How the engine decides                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Never accepted                        | If bounds passed (ledger time > `maxTime`) → `EXPIRED` (never included).                            |
| Still pending                         | Within bounds + within retention → treat as pending; resubmit identical envelope / poll.            |
| Outside available history (retention) | `oldestLedger` advanced past the window in which inclusion was possible → `INDETERMINATE` + reason. |
| Expired                               | `latestLedgerCloseTime > maxTime` → `EXPIRED`.                                                      |

`NOT_FOUND` alone is **never** terminal. The library always needs bounds + retention context to classify it (why the RPC adapter is primary).

**Case 3 — crash during processing.** On restart:

1. Sweep all entries in `SUBMITTING`/`CONFIRMING` → run the reconciliation verdict on each `inFlightHash` (Case 1 logic). No new envelope is built until these resolve.
2. `READY` entries whose lease has expired → reclaimed to `QUEUED` (no side effects had occurred; §6.7). Live leases are never stolen.
3. Entries in `NEEDS_RETRY` → resume on their `nextAttemptAt` schedule.
4. Entries in `EXPIRED` with attempts remaining → re-queue for rebuild.
5. Everything else is terminal; nothing to do.

**Duplicate avoidance across crash:** invariant §6.5.2 — a rebuilt envelope for an intent is only produced after every journaled hash resolved to a terminal or provably-never-included outcome. The journal itself is durable, so "the response was lost" can never become "the payment happened twice."

### 8.2 Submission error classification

| Submit response                                                     | Classification                         | Action                                                           |
| ------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `PENDING` (RPC)                                                     | in flight                              | `CONFIRMING`                                                     |
| `DUPLICATE` (RPC)                                                   | this exact envelope already known      | `CONFIRMING` (poll hash)                                         |
| `TRY_AGAIN_LATER` (RPC)                                             | transient                              | identical-envelope retry (backoff); exhausted → `CONFIRMING`     |
| 504 / timeout (Horizon)                                             | ambiguous — may still land             | identical-envelope retry within bounds; exhausted → `CONFIRMING` |
| `ERROR` with structural cause (malformed XDR, `tx_bad_auth`)        | **provably never included**            | `FAILED`                                                         |
| `ERROR` with `tx_bad_seq`                                           | see §7.3 decision table                | per table                                                        |
| `ERROR` with `tx_too_late`                                          | provably expired                       | `EXPIRED`                                                        |
| `ERROR` other (`tx_insufficient_fee`, `tx_insufficient_balance`, …) | **cannot rule out inclusion a priori** | `CONFIRMING` → poll hash → definitive verdict                    |

Rule of thumb: **when in doubt, poll the hash.** The cost of one `getTransaction` is a request; the cost of wrongly declaring failure is a double payment.

### 8.3 Verdict algorithm (per in-flight hash)

```
verdict(hash, tx, status):
  if status == SUCCESS → SUCCESS
  if status == FAILED  → FAILED
  # NOT_FOUND / TRY_AGAIN_LATER / ambiguous
  if ledgerTime(latestLedgerCloseTime) > tx.maxTime → EXPIRED          # can never be included
  if oldestLedger advanced beyond possible-inclusion window → INDETERMINATE
  if tx is still within bounds → PENDING (poll / resubmit identical)
```

For multiple recorded hashes (an intent rebuilt after expiry), the **final** verdict is the verdict of the last in-flight hash; prior hash outcomes are retained in `attempts` for audit. The pure function `verdict()` is unit-tested exhaustively (§13).

---

## 9. Storage Architecture

### 9.1 Why the naive CRUD interface is insufficient

`add/get/list/update/remove` cannot express two things the library's safety promises depend on:

1. **Atomic compare-and-set transitions** — `transition(id, fromStates, toState)` must fail if the entry is not in an expected state. Without CAS, two workers (or a worker and a recovery sweep) can both believe they own an entry and both submit. CAS is the mechanism that makes "no double submission" structural rather than hopeful.
2. **Conditional queries** — the scheduler needs "entries in {QUEUED, NEEDS_RETRY} with `nextAttemptAt ≤ now`", the recovery sweep needs "entries in {SUBMITTING, CONFIRMING}". A flat `list()` forces the engine to filter in memory, which races with other processes.

### 9.2 Store interface (V1)

```typescript
interface QueueStore {
  // uniqueness is enforced by the store — duplicate id must fail or return existing
  insert(entry: QueueEntry): Promise<QueueEntry>; // resolves existing entry on duplicate id

  get(id: string): Promise<QueueEntry | undefined>;

  /**
   * CAS claim: succeeds only if status ∈ fromStates AND nextAttemptAt ≤ now AND version matches.
   * On success, atomically sets status = READY, claimedBy = workerId, claimExpiresAt = now + leaseMs.
   */
  claim(
    id: string,
    fromStates: IntentStatus[],
    now: number,
    expectedVersion: number,
    workerId: string,
    leaseMs: number,
  ): Promise<
    | { ok: true; entry: QueueEntry }
    | { ok: false; reason: 'state' | 'not-due' | 'version' | 'missing' }
  >;

  /** CAS transition: fromStates must include current status and version must match. Atomic with any field updates. */
  transition(
    id: string,
    fromStates: IntentStatus[],
    to: IntentStatus,
    update: Partial<QueueEntry>,
    expectedVersion: number,
    now: number,
  ): Promise<
    { ok: true; entry: QueueEntry } | { ok: false; reason: 'state' | 'version' | 'missing' }
  >;

  /** Scheduler scan. */
  listDue(fromStates: IntentStatus[], dueBefore: number): Promise<QueueEntry[]>;

  /** Recovery sweep. */
  listByState(states: IntentStatus[]): Promise<QueueEntry[]>;

  list(opts?: { status?: IntentStatus; account?: string; limit?: number }): Promise<QueueEntry[]>;

  /** CAS remove — only legal for pre-submission states (caller passes fromStates; store enforces). */
  remove(id: string, fromStates: IntentStatus[], expectedVersion: number): Promise<boolean>;
}
```

Notes:

- The **write-ahead transition** (`SIGNING → SUBMITTING` + `inFlightHashes` append) is a single `transition()` call whose `update` carries the hash — atomic by contract.
- `version` is an optimistic-concurrency token (monotonic counter per entry) so even a single-process SQLite store is safe against interleaved async operations, and multi-process setups (Postgres/Redis adapters later) work without interface changes.
- `claim()` grants the processing lease (§6.7); `listByState(['READY'])` + a `claimExpiresAt` check gives the janitor its reclaim scan (reclaim itself is a CAS `transition` from `READY`).
- All store methods are **idempotency-aware by construction**: duplicate `insert` returns the existing entry rather than corrupting state.

### 9.3 Adapters (V1)

| Adapter          | Runtime    | Status                                                   |
| ---------------- | ---------- | -------------------------------------------------------- |
| `MemoryStore`    | tests, dev | ships in V1                                              |
| `SqliteStore`    | Node.js    | ships in V1 (recommended production default)             |
| `IndexedDbStore` | browser    | designed-for (interface complete); first post-V1 adapter |

Serialization: entries are plain JSON (operation configs and memos are JSON-safe). Store adapters are responsible for durable writes (SQLite transactions / WAL for crash safety, `fsync` semantics as appropriate).

### 9.4 Integrity

`payloadHash` is verified immediately before every build. A stored entry whose hash doesn't match its payload is **not** rebuilt — it transitions to `FAILED` with code `payload-mismatch` and is surfaced to the application. This detects both accidental corruption and malicious local-store tampering (see §11).

---

## 10. Public API (V1)

```typescript
interface OfflineQueueConfig {
  store: QueueStore;
  adapter: StellarAdapter;                 // RpcAdapter | HorizonAdapter
  signer: Signer;                          // application-owned
  networkPassphrase: string;               // e.g. StellarSdk.Networks.TESTNET
  maxAttempts?: number;                    // default 5
  timeBounds?: { maxAgeSeconds: number };  // default 300
  baseFee?: string;                        // default SDK BASE_FEE
  backoff?: { baseMs?: number; capMs?: number };  // defaults 1000 / 60000
  concurrency?: number;                    // worker count, default 1
  leaseMs?: number;                        // claim lease, default 60000 (§6.7)
  workerId?: string;                       // defaults to random id; used for claim ownership
}

interface OfflineQueue {
  /** Create + validate + persist an intent. Duplicate id → returns the existing entry. Fully offline. */
  addIntent(input: CreateIntentInput): Promise<QueueEntry>;

  getIntent(id: string): Promise<QueueEntry | undefined>;

  list(opts?: { status?: IntentStatus; account?: string }): Promise<QueueEntry[]>;

  /**
   * One processing sweep: (1) reconcile in-flight entries, (2) claim + process due entries.
   * Returns a summary. Safe to call concurrently (CAS protects). No background loop.
   */
  process(): Promise<ProcessSummary>;

  /**
   * Manual retry: re-queues a FAILED (or attempts-exhausted EXPIRED) entry for one more
   * processing cycle. Manual, never automatic; limited by maxAttempts (throws
   * AttemptsExhaustedError); creates a new attempt record. See ADR-0008.
   */
  retry(id: string): Promise<QueueEntry>;

  /** Run the reconciliation verdict for all in-flight entries (or one). Idempotent; call on startup + periodically. */
  reconcile(id?: string): Promise<ReconciliationResult[]>;

  /** Delete an entry that has never been submitted. Rejects if a hash is in flight. */
  remove(id: string): Promise<boolean>;

  /** Typed lifecycle events. */
  on(event: 'intent:transition' | 'intent:settled', handler: (entry: QueueEntry, result?: ReconciliationResult) => void): () => void;

  /** Optional convenience loop around process() for apps that want polling. */
  start(opts?: { intervalMs?: number }): void;
  stop(): void;
}

/** Convenience factory — the 90% case, expands to a single payment operation. */
createPaymentIntent(input: {
  id?: string; source: string; destination: string;
  asset: AssetLike; amount: string; memo?: MemoConfig;
  metadata?: Record<string, unknown>;
}): CreateIntentInput;
```

**API rationale (minimal by design):**

- `process()` is the one verb that makes progress; it reconciles **and** processes so a single "online" callback (or timer, or `start()`) is enough to run the whole queue.
- No `cancel()`, no batch ops, no plugin hooks, no `pause()` — V1 scope. `remove()` covers the only legal cancellation (pre-submission).
- `retry(id)` is **manual, never automatic, and budget-limited** — it re-queues a `FAILED` (or attempts-exhausted `EXPIRED`) entry for one more cycle, throws `AttemptsExhaustedError` past `maxAttempts`, and creates a new attempt record (full semantics: ADR-0008). It is app-driven because "should a failed payment be retried" is a business decision.
- The event emitter is intentionally tiny (two events) to support UI integration without a notification system.

**Confirmed in review — the `createPaymentIntent` factory stays in V1.** It improves both API safety and developer experience: it parses and normalizes asset shorthand (`XLM`, `USDC:issuer`) and decimal amounts eagerly, eliminating a class of misuse (wrong issuer format, native-vs-issued confusion, non-string amounts) that raw operation-config construction invites; and it is a pure factory — validation still runs exactly once, at `addIntent`, over the canonical operations model (ADR-0001).

---

## 11. Security Architecture

Threat model: the store is treated as **honest-but-vulnerable** (corruption, tampering, other processes) — the library must detect manipulation it can, and the application controls physical security of the store. The library never protects keys it never holds.

1. **Private keys are never handled.** Signing is 100% behind the `Signer` interface (ADR-0002). The library has no key type, no seed parsing, no keystore. It cannot leak what it does not possess.
2. **Never persist:** keys/seed phrases, RPC credentials, or full signed envelopes. Only envelope **hashes** are journaled (hashes are public knowledge anyway). Signed envelopes live in memory only for the duration of a submission attempt.
3. **Payload integrity:** `payloadHash` verified before every build (§9.4). Detects accidental corruption and local-store tampering; a tampered intent fails loudly instead of being silently submitted.
4. **Replay protection:** the network's sequence consumption is the ultimate replay defense; the library adds (a) envelope-hash journaling, (b) no-rebuild-while-in-flight, (c) time bounds on every envelope, (d) unique intent ids.
5. **Local database manipulation:** CAS transitions + version tokens prevent a stale/racing process from driving an entry into a state it shouldn't reach; `remove()` is restricted to pre-submission states.
6. **Malicious queue modification:** an attacker who can write the store can delete/alter entries — out of scope to _prevent_ (it is the application's storage), but the library _detects_ payload tampering (hash) and _documents_ the boundary. Store file permissions / IndexedDB same-origin protections are the application's responsibility, documented in the security guide.
7. **Dependency hygiene:** `@stellar/stellar-sdk` is the only runtime dependency in the core (plus storage-adapter dependencies: `better-sqlite3` for Node). Strict TypeScript, no `any` leaks in public types, lockfile + provenance on releases.
8. **Logging:** config and payloads never logged; errors logged with redaction (no secrets, no full XDR in default log levels).

---

## 12. Testing Strategy

### 12.1 Unit (fast, no network)

| Area                   | Focus                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent model           | validation matrix per field, payloadHash stability, JSON round-trip, supported ops                                                                                                                                                      |
| State machine          | **exhaustive transition-table tests**: every valid transition executes; every invalid transition is rejected by the CAS layer; retryable-vs-terminal classification                                                                     |
| Reconciliation verdict | **the priority suite**: table-driven tests over every (submit-response × status-query × bounds × retention) combination → expected verdict, including all `NOT_FOUND` meanings (§8.1 Case 2) and the `tx_bad_seq` decision table (§7.3) |
| Backoff                | schedule math, jitter bounds, attempt budgeting                                                                                                                                                                                         |
| Store contract suite   | the _same_ test file run against every adapter: insert-uniqueness, CAS conflicts, atomic transition, restart durability, `listDue` semantics, claim lease grant/expiry/reclaim                                                          |
| Builder                | intent → draft mapping per operation, sequence assignment, time-bound application, fee handling                                                                                                                                         |

### 12.2 Integration (Stellar testnet)

- Happy path: enqueue → `process()` → `SUCCESS` (verified on-chain via the adapter).
- `DUPLICATE` handling: resubmit identical envelope after `SUCCESS`; assert no second on-chain application.
- `tx_bad_seq` recovery: two intents on one account, second submitted after first lands; assert both settle exactly once.
- Expiry → rebuild: intent with short `maxAgeSeconds` submitted during an artificial stall; assert rebuild with fresh sequence settles.
- On-chain failures: insufficient balance, invalid destination → `FAILED` with result XDR attached.
- These run against testnet (or a local `stellar-core` quickstart container for determinism) in a separate, gated CI job.

### 12.3 Reliability (fake recording network — the differentiator)

A `RecordingNetworkAdapter` test double that behaves like RPC/Horizon but **records every envelope hash it ever receives** and can be scripted to fail at any point. Invariants asserted across every scenario:

1. **At-most-once:** for any intent, at most one recorded hash ever reaches `SUCCESS` on the fake chain. (This is the project's core guarantee, tested directly.)
2. **Response lost after accept:** adapter receives the envelope, then throws before responding → restart → `reconcile()` → verdict `SUCCESS`, and **no rebuild was emitted**.
3. **Timeout after successful submission** → same as above.
4. **Crash at every state:** script a process kill at each persisted-state boundary; restart; assert recovery lands exactly one on-chain application (or an honest `INDETERMINATE`/`EXPIRED`).
5. **Double `process()` concurrency:** two concurrent sweeps; CAS ensures each entry is claimed once; assert single submission.
6. **`NOT_FOUND` matrix:** script each of the four meanings; assert the verdict is `PENDING`-continue / `EXPIRED` / `INDETERMINATE` as specified.
7. **Store corruption:** flip a byte in a stored payload → next `process()` → `FAILED (payload-mismatch)`, nothing submitted.
8. **Lease expiry mid-processing:** claim, let the lease lapse during `SIGNING`, run the janitor → entry reclaimed; assert the first owner's next transition fails (lost-ownership abort, nothing submitted) and the entry settles exactly once under the new owner.
9. **Crash at every phase:** extend the crash matrix (§6.7) — crash during `BUILDING`, `SIGNING`, between write-ahead and submit, after submit, during `CONFIRMING`; assert exactly one on-chain application (or honest `EXPIRED`/`INDETERMINATE`) per intent.

---

## 13. Repository Structure

Single package. No monorepo, no workspaces, no build matrix beyond `tsc` + one test runner.

```
stellar-offline-queue/
├── src/
│   ├── index.ts              # public exports (queue, types, factories, adapters)
│   ├── intent.ts             # Intent model, validation, payloadHash, createPaymentIntent factory
│   ├── state.ts              # IntentStatus, transition table, retryability classification (pure)
│   ├── queue.ts              # OfflineQueue: public API, sweep orchestration, event emitter
│   ├── engine.ts             # claim → build → sign → submit → confirm pipeline (one entry)
│   ├── builder.ts            # intent + account state → SDK TransactionBuilder draft
│   ├── reconciliation.ts     # verdict() pure function, error classification, recovery sweep
│   ├── backoff.ts            # exponential-with-jitter schedule
│   ├── signer.ts             # Signer interface + types
│   ├── errors.ts             # typed error hierarchy (ValidationError, StoreError, AdapterError…)
│   ├── events.ts             # typed event emitter
│   ├── store/
│   │   ├── types.ts          # QueueStore interface, CAS result types
│   │   ├── memory.ts         # MemoryStore
│   │   └── sqlite.ts         # SqliteStore (Node; better-sqlite3)
│   └── adapters/
│       ├── types.ts          # StellarAdapter interface, normalized result types
│       ├── rpc.ts            # RpcAdapter (@stellar/stellar-sdk rpc.Server)
│       └── horizon.ts        # HorizonAdapter (secondary)
├── tests/
│   ├── unit/                 # state-machine, reconciliation, intent, backoff, builder
│   ├── store/                # contract suite (runs against memory + sqlite)
│   ├── reliability/          # fake-network scenarios (at-most-once invariants)
│   └── helpers/              # RecordingNetworkAdapter, scriptable failures, factories
├── examples/
│   ├── node-sqlite.ts        # backend example with retry/start loop
│   └── browser-indexeddb.md  # browser integration sketch (adapter post-V1)
├── docs/
│   ├── architecture.md       # this document
│   ├── decisions/            # ADRs 0001–0006
│   └── security.md           # threat model + operator guidance
└── .github/
    └── workflows/ci.yml      # typecheck + lint + unit + store contract; gated testnet job
```

Folder rationale: `store/` and `adapters/` are separated so browser bundlers can tree-shake (`indexeddb`/`horizon` never imported in Node builds and vice versa); `state.ts` and `reconciliation.ts` are kept pure (no I/O) so their tests are trivial and exhaustive; `engine.ts` is the only module that touches all layers, keeping dependency direction (§3) checkable.

---

## 14. V1 Scope Checklist and Roadmap Hooks

See `docs/v1-scope.md` for the authoritative V1 inclusion/exclusion list.

**In V1:** intent model + factory, full state machine with CAS store, RPC + Horizon adapters, reconciliation with all four verdicts, per-account serialization, rebuild-on-expiry, backoff, events, memory + SQLite stores, examples, CI.

**Explicitly out of V1 (design hooks left for them):**

| Feature                         | Hook in V1 design                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel accounts                | sequence resolution isolated in `builder.ts` + per-account serialization in the scheduler — a channel pool slots in behind the same seam (aligns with SDF #1599) |
| Fee-bump recovery               | `NEEDS_RETRY` + `attempts` journal can carry "bump" attempts; adapter interface can expose `getFeeStats` (aligns with SDF #1602)                                 |
| Definitive `confirmTransaction` | `reconciliation.ts` implements the verdict now; swap internals for the SDK primitive when it ships (SDF #1615)                                                   |
| Soroban                         | operation union extension + `prepareTransaction` step in `builder.ts`; SDK already peers cleanly                                                                 |
| IndexedDB / React Native stores | `QueueStore` interface is complete; adapters are additive                                                                                                        |
| `bumpSequence` cancellation     | `remove()` semantics documented; a `cancel(id)` API becomes a thin addition                                                                                      |

---

## 15. Assumptions and Open Questions

**Assumptions (documented, not deferred):**

1. Source accounts exist and are funded before enqueue (account funding is the application's job; `tx_no_account` → `FAILED`).
2. Classic (non-Soroban) operations only in V1.
3. The application calls `process()` (or `start()`) — the library never spawns hidden background work.
4. Device clock is used only for `nextAttemptAt` scheduling; **all** Stellar-validity decisions use ledger time from adapter responses.
5. Store adapters provide real durability (SQLite WAL/transaction semantics); `MemoryStore` is explicitly non-durable.

**Resolved in architecture review (ADRs 0007–0009):**

1. **Processor ownership** — CAS claim + lease + janitor + lost-ownership abort (ADR-0007, §6.7).
2. **Retry semantics** — `retry(id)` is manual, never automatic, limited by `maxAttempts` (throws `AttemptsExhaustedError`), and creates a new attempt record; allowed only from `FAILED` and attempts-exhausted `EXPIRED` (ADR-0008).
3. **Network adapters** — `StellarAdapter` interface; `RpcAdapter` primary/required; `HorizonAdapter` optional secondary with documented verdict caveats (ADR-0009).
4. **`createPaymentIntent` factory** — kept: improves API safety and developer experience (see §10).

**Open questions (remaining):**

1. Defaults: `maxAgeSeconds` = 300, `maxAttempts` = 5, `leaseMs` = 60000 — confirm as testnet-first defaults.
2. `remove()` (pre-submission delete) stays as V1's only cancellation mechanism; confirm no `cancel()` is needed in V1 (a `cancel(id)` with `bumpSequence` invalidation remains a V2 roadmap item).

---

## 16. References

- Research findings: `docs/research.md`
- ADRs: `docs/decisions/0001-0009`
- V1 scope: `docs/v1-scope.md`
- SDF SDK issues #1599, #1602, #1615 (roadmap hooks, §14)
- Stellar docs: time bounds, sequence numbers, error handling, RPC `sendTransaction`/`getTransaction` (links in research appendix)
