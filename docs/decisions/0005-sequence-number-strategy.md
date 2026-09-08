# ADR-0005: Sequence Number Strategy

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

Stellar sequence numbers are strictly consecutive, consumed exactly once, and cannot be replaced: a transaction is valid only if its sequence number equals `account.seq + 1` at apply time. Since Protocol 20 an account can submit at most one transaction per ledger. Multiple queued intents for the same account therefore interact through sequence numbers, and any queue design must decide **what gets stored**: signed envelopes, unsigned intents, or something in between.

Offline-first makes this sharper: at intent-creation time the app has no network access, so it cannot know the account's current sequence, and if it guesses, every envelope it pre-signs will be stale by the time connectivity returns.

## Options considered

### Option A — Queue signed transaction envelopes

- **Pros:** envelopes are ready to submit the moment connectivity returns; the transaction hash is stable, which simplifies dedupe.
- **Cons (decisive):**
  1. **Sequence staleness is guaranteed.** The first envelope to land consumes the sequence; every other pre-signed envelope fails `tx_bad_seq`. "Fixing" them requires re-signing anyway — so the pre-signing bought nothing.
  2. **Time bounds are wrong by construction.** `maxTime` must be chosen at signing time: too short and intents expire while queued offline; too long and the retry window becomes unsafe (an envelope that may land hours later must not be rebuilt). The correct window is relative to _flush_, which Option A cannot express.
  3. Storing signed envelopes invites misuse and complicates the security story (secrets-adjacent artifacts persisted in the store).
- This option optimizes the _last_ step of the pipeline (submit) at the expense of every step before it — and submit is the one step that happens exactly when connectivity exists.

### Option B — Queue unsigned intents (recommended)

- **Pros:** the intent is durable and immutable; sequence numbers and time bounds are resolved at **flush time**, when account state is actually reachable (`loadAccount`); rebuilding is cheap and safe because nothing sequence-bound was persisted; the signer boundary stays clean (signing happens at flush too); cancellation-by-removal works for unsubmitted entries.
- **Cons:** requires a network round-trip (`loadAccount`) per build; envelope hashes vary per attempt — mitigated by journaling every hash in `inFlightHashes` and by the no-rebuild-while-in-flight invariant.

### Option C — Hybrid (store intents, cache last-used sequences)

- **Pros:** could skip `loadAccount` when a cached sequence is fresh.
- **Cons:** cached sequences go stale across restarts and concurrent writers; a stale cache _is_ Option A's bug reintroduced. The saved RPC call is not worth the correctness risk in V1. Revisit if a channel pool (V2) makes sequence caching meaningful.

## Decision

Adopt **Option B**: queue unsigned intents; materialize envelopes per attempt at flush time.

Concretely (V1):

- One entry per source account is processed at a time (single-writer serialization; FIFO by `createdAt` as a predictability choice). Different accounts may process concurrently.
- Each build resolves the account's sequence from the network, assigns `tx.seq = account.seq + 1`, and applies `maxTime = flushTime + maxAgeSeconds`.
- The write-ahead transition (`SIGNING → SUBMITTING` + hash journal) precedes every submission.
- On `EXPIRED` (ledger time > `maxTime`), the envelope is provably dead and the intent rebuilds with a fresh sequence and fresh bounds — safe by construction.
- `tx_bad_seq` is disambiguated deterministically by comparing `account.seq` vs `tx.seq` (§7.3 of the architecture doc): included / still-current / too-early / can-never-include.
- `remove(id)` is only legal before any submission (no in-flight hashes). On-chain invalidation (`bumpSequence`) and channel accounts are V2.

## Consequences

- Correctness: every envelope is built from fresh network state, so queued intents cannot poison each other's sequence numbers.
- Safety: rebuild is only permitted from `EXPIRED`, and the hash journal prevents building while a possibly-landed envelope is unresolved.
- Cost: one `loadAccount` per build attempt (negligible vs. the operations being coordinated) and per-attempt signing, which the signer boundary already assumes.
- The design leaves a clean seam for V2 channel-account pooling (behind the sequence-resolution and serialization points), matching SDF issue #1599.
