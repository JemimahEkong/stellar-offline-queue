# ADR-0003: Storage Design

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

The queue's safety promises — no double submission, crash recovery, write-ahead journaling — all terminate in the storage layer. The storage abstraction must therefore express _atomicity and concurrency control_, not just CRUD. V1 targets Node.js (in-memory for tests, SQLite for production), with browser (IndexedDB) and mobile (React Native) as design targets.

The naive interface (`add / get / list / update / remove`) cannot express:

1. **Atomic compare-and-set transitions.** "Transition entry X from {QUEUED, NEEDS_RETRY} to SUBMITTING, appending this envelope hash, atomically" must fail if X is already being processed by another worker. Without CAS, concurrent `process()` calls or a recovery sweep racing a worker can both submit — the exact double-payment class of bug this project exists to prevent.
2. **Conditional scans.** The scheduler needs "due entries" (`status ∈ {QUEUED, NEEDS_RETRY} ∧ nextAttemptAt ≤ now`); the recovery sweep needs "in-flight entries" (`status ∈ {SUBMITTING, CONFIRMING}`). A flat `list()` pushes filtering into the engine, which races across processes.

## Options considered

### Option A — CRUD-only interface (the prompt's `QueueStorage<T>`)

- **Pros:** simplest possible surface.
- **Cons:** correctness is delegated to engine-level locking that cannot survive restarts or multiple processes; the write-ahead invariant ("persist SUBMITTING + hash before the network call") has no atomic primitive; duplicate-id handling is ad hoc. The core guarantee becomes untestable at the storage boundary.

### Option B — CAS-based store interface (recommended)

`insert`, `get`, `claim`, `transition`, `listDue`, `listByState`, `list`, `remove` — where `claim`, `transition`, and `remove` are compare-and-set on `(status ∈ fromStates, version)`. See §9.2 of `docs/architecture.md` for the exact signatures.

- **Pros:** the engine's safety logic becomes _calls to atomic primitives_; a second worker or a racing sweep gets a typed conflict instead of corrupting state; the write-ahead transition is a single atomic `transition()` whose `update` carries the new hash; multi-process backends (Postgres/Redis) later need no interface change, only an adapter.
- **Cons:** a slightly larger interface (8 methods); adapters must implement real transactions (SQLite transactions, in-memory mutex). Both are small.

### Option C — Engine-level mutex only

- **Pros:** tiny store.
- **Cons:** in-process locks die with the process; the crash-recovery story collapses precisely where it matters. Rejected.

## Decision

Adopt Option B. The `QueueStore` interface (§9.2 of `docs/architecture.md`) is the storage contract, with:

- **`version` optimistic-concurrency tokens** on every entry, incremented on each transition.
- **Atomic write-ahead:** `transition(id, [SIGNING], SUBMITTING, { inFlightHashes: [...] }, version)` is a single store operation.
- **Idempotent insert:** duplicate `id` returns the existing entry (never corrupts, never silently double-enqueues).
- **`remove` restricted by CAS** to pre-submission states (no hash ever in flight).
- **V1 adapters:** `MemoryStore` (tests/dev) and `SqliteStore` (Node, `better-sqlite3`, WAL mode). `IndexedDbStore` and React Native adapters are additive; the interface is their spec.
- **Serialization:** plain JSON (operation configs, memos, metadata are JSON-safe); `payloadHash` verification happens in the engine before every build, not in the store.

## Consequences

- Concurrency safety and crash recovery are _structural_ (testable against any adapter via one contract suite) rather than incidental.
- A modest interface surface is the price; it is fully specified, so implementers don't guess.
- Applications that only ever run one process still benefit (CAS protects interleaved async operations within the process).
- SQLite is the recommended production default for V1; Postgres/Redis adapters are drop-in later.
