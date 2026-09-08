# ADR-0007: Queue Processor Ownership and Concurrency

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

Any entry can be processed by a worker running `process()` (or the `start()` loop). If two workers — two `process()` calls in one process, two application processes sharing a store, or a recovery sweep racing a live worker — both believe they own the same entry, both can build, sign, and submit envelopes for it. That is the double-payment root cause the project exists to prevent. Ownership must therefore be explicit, exclusive, time-limited, and recoverable.

The naive answer — "an entry is either being processed or it isn't" — fails on one question: **what happens when the worker dies mid-processing?** Without a lease, a dead worker's claim blocks the entry forever; without exclusivity, a live worker's work is duplicated. The design needs a claim that expires and a rule for what a _new_ owner may and may not do.

A second constraint comes from Stellar: submitting is not the only side effect. Building and signing are side-effect-free, but the write-ahead transition (`SIGNING → SUBMITTING` + hash journal) precedes the network call, and once a hash is journaled, the entry carries a possibly-sent envelope. So the ownership model must distinguish **"safe to reprocess from scratch"** (no side effects yet) from **"only reconcile, never rebuild"** (side effects possible).

## Options considered

### Option A — No ownership discipline (engine mutex only)

- **Pros:** nothing to design.
- **Cons:** an in-process mutex dies with the process; two processes sharing SQLite have no mutual exclusion; the recovery sweep cannot know whether a READY entry's worker is alive. Duplicate submission is possible by construction. Rejected.

### Option B — CAS claim without lease

`claim()` transitions `QUEUED/NEEDS_RETRY → READY` atomically; only the claimant may transition the entry onward.

- **Pros:** exclusive ownership across processes via the store; simple.
- **Cons:** a worker that dies (or is killed) while holding `READY` leaves the entry stranded — no other worker can claim it, and the recovery sweep cannot distinguish "legitimately processing" from "dead". Requires a restart to even attempt recovery, and even then a multi-process deployment can't safely take over. Rejected.

### Option C — CAS claim + lease (recommended)

`claim()` transitions `QUEUED/NEEDS_RETRY → READY` **and** writes `claimedBy` (worker id) + `claimExpiresAt = now + leaseMs` in the same atomic operation. Ownership is exclusive while the lease is live. A **janitor** (run inside `process()`/`reconcile()`) reclaims `READY` entries whose lease has expired via a CAS transition back to `QUEUED`; the claimant's own transitions refresh the lease and any CAS version conflict means the owner has lost ownership and **must abort without submitting**.

- **Pros:** exclusive while live, recoverable when dead, multi-process safe, and the version-conflict-abort rule closes the race where a reclaimed worker and a new owner both proceed.
- **Cons:** a lease parameter and a janitor; signer latency is bounded by the lease (documented constraint, configurable `leaseMs`).

## Decision

Adopt Option C. The ownership model (§6.7 of `docs/architecture.md`):

1. **Who can process:** only the queue engine, and only via `claim()` — ownership of an entry is granted exclusively by the store's CAS, never assumed.
2. **Duplicate processing prevention:** CAS `claim` (status + `nextAttemptAt` + version), CAS `transition` on every persisted state change, per-account single-writer scheduling, and the no-rebuild-while-in-flight rule. A worker that loses a CAS conflict **aborts the entry without submitting** — it never races the new owner.
3. **Lease:** `claim()` sets `claimedBy` + `claimExpiresAt`; every persisted transition refreshes the lease; `leaseMs` default 60 s (configurable). Build/sign must complete within the lease (the signer contract documents this; interactive signing is out of V1 scope).
4. **Reclamation:** a janitor inside `process()`/`reconcile()` reclaims `READY` entries with expired leases → `QUEUED` (no side effects had occurred). `SUBMITTING`/`CONFIRMING` entries are **never reclaimed or rebuilt** — they are only ever reconciled (their journaled hashes decide), so a possibly-sent envelope is never double-built.
5. **Crash recovery:** a crash at any instant leaves the entry as `READY` (lease expires → reclaimed → reprocessed), or as `SUBMITTING`/`CONFIRMING` (reconciled), or as a durable waiting/terminal state (nothing to do). No side-effect can be lost and none can be doubled.

## Consequences

- The at-most-once guarantee holds across concurrent `process()` calls, multiple processes, and crash/restart — it is enforced by store CAS + lease, not by convention.
- Cost: `leaseMs` config, `claimedBy`/`claimExpiresAt` fields on `QueueEntry`, a janitor, and a documented signer-latency bound.
- The model is compatible with V2 channel pools: each channel account becomes another "account slot" subject to the same claim discipline.
