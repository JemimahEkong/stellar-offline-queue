# API reference (stub)

> **Status:** stub — finalized in Phase 20 (Documentation). This page currently
> documents only the concepts whose definitions are frozen by earlier phases
> and which later phases build on. The full API surface is documented at
> release time from `src/index.ts`.

## The attempt model (ADR-0008, Phase 8)

Everything the queue does to move an intent toward settlement is expressed in
terms of **attempts**. The distinction below is what makes safe retries
automatic and dangerous retries structurally impossible.

### Attempt (build cycle)

One **build cycle**: the creation and submission of one envelope. It is
journaled at the **write-ahead transition** (`SIGNING → SUBMITTING`) as one
`AttemptRecord` appended to `attempts[]`, and it increments `attemptCount`.
The record carries the envelope hash plus the deterministic build parameters
(`sequenceNumber`, `maxTime`, `fee`) needed to reproduce that envelope
byte-for-byte later.

### Identical-envelope resubmission (not a new attempt)

A transient failure (`TRY_AGAIN_LATER`, transport error, `TIMEOUT`) schedules
the **same envelope** for resubmission after backoff (`NEEDS_RETRY`). The
network dedupes by envelope hash, so resubmitting the identical bytes can
never double-apply. Resubmissions — whether the worker still holds the signed
envelope in memory, or a process restart occurred and the envelope was
rebuilt deterministically from the journaled build parameters (hash asserted
equal before any resubmission, else `envelope-drift` → FAILED) — create **no**
new `AttemptRecord` and do **not** increment `attemptCount`.

### Attempt budget

`maxAttempts` (default 5, ADR-0010) counts **build cycles only**. It is
consumed by the initial build and by automatic rebuilds after provable expiry
(`EXPIRED → QUEUED` with a fresh envelope: new hash, fresh sequence, fresh
time bounds) — never by identical-envelope resubmissions. Manual
`retry(id)` re-queues a terminal `FAILED`/`EXPIRED` entry and consumes budget
only when the next build cycle runs; `retry()` itself journals nothing.

### Naming map (code ↔ concept)

| Concept | Code |
| --- | --- |
| Attempt (build cycle) | `AttemptRecord` appended at write-ahead in `src/engine.ts` |
| Identical-envelope resubmission | in-worker: `resumeSubmit`; post-restart: `resumeViaRebuild` (both `src/engine.ts`) |
| Deterministic rebuild helper | `buildDeterministic` (`src/builder.ts`) |
| Budget check | `attemptCount` vs `maxAttempts` (`scheduleRetry`, `queue.retry`) |
| Manual retry | `OfflineQueue.retry(id)` (`src/queue.ts`) |
