# ADR-0011: `remove()` vs `cancel()` in V1

**Status:** Accepted (proposed)
**Date:** September 5, 2026
**Resolves:** Open question 2 in `docs/architecture.md` §15 ("`remove()` (pre-submission delete) stays as V1's only cancellation mechanism; confirm no `cancel()` is needed in V1") and the planning-phase requirement to decide whether V1 exposes `remove()`, `cancel()`, or both.

## Context

The planning phase requires an explicit decision on whether V1 exposes `remove()`, `cancel()`, or both, weighed against auditability, state-machine integrity, accidental data loss, and developer experience. The architecture (§7.2) already sketches `remove(id)` as a pre-submission-only deletion; on-chain invalidation via `bumpSequence` is named as the V2 `cancel(id)` mechanism; the public API section (§10) says "No `cancel()` … V1 scope. `remove()` covers the only legal cancellation (pre-submission)." This ADR makes that decision formal, with the rejected alternatives recorded.

Stellar facts that constrain the choice:

- Once an envelope **may have been submitted**, only the ledger can decide its outcome. There is no client-side way to retract it: the sequence number is either consumed (included) or still free — and a new envelope with a fresh sequence would be a _new_ transaction, i.e. a possible double payment if the old one later lands.
- A transaction that has provably expired (`latestLedgerCloseTime > maxTime`) was never included and can safely be superseded by a rebuild — but that is the state machine's automatic `EXPIRED → QUEUED` rebuild path (ADR-0005/0008), not a user-initiated cancellation.
- A `bumpSequence`-based cancellation works by _deliberately consuming the account's sequence_, making the pending envelope's sequence stale so it can never be included. It is safe, but it mutates the account's global state and permanently invalidates exactly one slot — semantics well beyond "remove a row."

The four criteria from the planning brief:

| Criterion               | What it demands                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Auditability            | Financially relevant records (especially anything that was ever submitted, and `INDETERMINATE` outcomes) must never silently disappear. |
| State-machine integrity | Removal must not create states the transition table cannot reason about, or orphan journaled hashes.                                    |
| Accidental data loss    | A delete API that works in the wrong state is a foot-gun; the safe action should be the easy action.                                    |
| Developer experience    | Apps need a way to abandon an intent that will never be submitted — without deleting audit history.                                     |

## Options considered

### Option A — `remove()` only (hard delete, pre-submission) — as sketched in the architecture

- **Pros:** smallest API; no dead states.
- **Cons:** hard-deleting the row destroys even pre-submission audit history (an operator cannot later answer "what happened to intent `inv-42`?"); the "only before any in-flight hash" guard must live in caller discipline and the store's CAS, and a bug that bypasses it would let a submitted intent vanish with its hash journaled nowhere else — directly attacking the at-most-once invariant's evidence trail.

### Option B — `cancel()` only (soft-cancel to a terminal state)

- **Pros:** no data loss; full audit trail.
- **Cons:** without on-chain invalidation (bumpSequence), a "cancelled" entry with no in-flight hash is just an intent that will never be processed — that is precisely what `remove()` already covers more honestly. Meanwhile a _real_ cancellation that must defeat a possibly-pending envelope requires sequence invalidation, which is V2 scope (and excluded from V1 by both the architecture and the V1 scope's exclusion list). A `cancel()` that cannot actually stop anything is a misleading API.

### Option C — Both `remove()` (pre-submission) and `cancel()` (on-chain invalidation)

- **Pros:** complete semantics.
- **Cons:** `cancel()` requires the `bumpSequence` mechanism explicitly excluded from V1; shipping it early would violate the scope boundary and ADR-0005.

### Option D — `cancel(id)` as a soft-state transition to `FAILED`/terminal `CANCELLED`, plus `remove()` — rejected for V1 for the Option B reasons, plus a new state

- Adding a `CANCELLED` state in V1 would expand the eleven-state machine (ADR-0006), require a new ADR-level architecture change, and duplicate what `FAILED` + `lastError.code = 'cancelled'` can already express for pre-submission abandonment — without enabling any capability V1 can actually honour.

### Option E — `cancel(id)` as a soft cancel for pre-submission entries mapping to `FAILED` (`lastError.code = 'cancelled'`), `remove()` retained as documented deletion of the record (recommended)

- **Pros:** preserves audit history (nothing is silently deleted by the primary API); keeps the state machine intact (`FAILED` is terminal; `retry()` from it is already defined by ADR-0008, which is exactly the right escape hatch if an operator cancels by mistake); zero new states; the dangerous delete remains possible but is no longer the _only_ tool; gives apps an honest "abandon this intent" verb today.
- **Cons:** one extra public method beyond the architecture's §10 sketch — but §10's rationale ("`remove()` covers the only legal cancellation (pre-submission)") is preserved: `cancel()` is also strictly pre-submission, so no on-chain semantics are claimed. This is an additive clarification, not a contradiction of the architecture.

## Decision

Adopt **Option E**: V1 exposes **both**, with strictly pre-submission reach:

- **`cancel(id): Promise<QueueEntry>`** — the _primary_ abandonment verb. CAS transition of a `QUEUED`/`NEEDS_RETRY` entry to `FAILED` with `lastError = { code: 'cancelled', ... }` and `nextAttemptAt` cleared. It is rejected (typed error, no mutation) for any other state, in particular anything with an in-flight hash (`SUBMITTING`, `CONFIRMING`) or terminal. Effectively a durable "do not process this," fully auditable, reversible only via the existing manual `retry(id)` (ADR-0008 semantics unchanged — `retry()` from `FAILED` is already legal and budget-limited).
- **`remove(id): Promise<boolean>`** — retained exactly as specified in architecture §9.2/§10: a CAS delete legal only from `QUEUED` (and `NEEDS_RETRY`) with no in-flight hashes; rejects otherwise. It is documented as the "erase the record" tool for pre-submission intents (e.g. GDPR-style data cleanup of `metadata`), not as the primary cancellation verb.

Invariants preserved:

- Neither operation may ever touch an entry with a non-empty, unresolved `inFlightHashes` — the store's `fromStates` CAS makes it structural (ADR-0003).
- Neither operation may bypass `payloadHash` verification or mutate intent payload fields.
- Post-submission intents run to `SUCCESS | FAILED | EXPIRED | INDETERMINATE` — no client-side cancellation exists in V1 (matching Stellar's own semantics, §7.2).
- The V2 `cancel(id)` with `bumpSequence` invalidation remains on the roadmap as the _post-submission_ cancellation mechanism; when it arrives it can either replace or sit beside the V1 soft-cancel under the same name, decided by a future ADR.

## Consequences

- The public API gains one method (`cancel`) relative to architecture §10; `docs/api.md` (Phase 20) and `docs/architecture.md` §10 will be annotated accordingly during implementation, with a pointer back to this ADR.
- Accidental data loss is reduced: the easy verb (`cancel`) preserves history; the destructive verb (`remove`) is deliberate, guarded, and documented.
- State-machine integrity is untouched: no new states; `cancel()` reuses the existing `QUEUED/NEEDS_RETRY → FAILED` transition row from the §6.3 table (trigger: deterministic pre-submission failure), now with a dedicated error code.
- The engine must emit `intent:transition` for `cancel()` like any other transition, and the store contract suite gains cancellation cases (Phase 3/4/5 tests).
