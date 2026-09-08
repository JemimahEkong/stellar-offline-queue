# ADR-0001: Payment Intent Model

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

The queue must durably represent "what the application wants to happen on Stellar" in a way that is created fully offline, survives restarts, supports idempotency, recovery, and auditing, and never invites misuse. The shape of this model determines everything downstream: what can be validated at enqueue time, what the payload-hash protects, how rebuilds stay safe, and what the audit trail can answer.

Key Stellar facts constraining the model:

- Sequence numbers must equal `account.seq + 1` at **apply** time — they cannot be known offline and must not be baked into durable intent data.
- Time bounds must be resolved relative to the **flush** moment, not intent creation (an absolute `maxTime` stored at creation would expire while the app is offline).
- The memo is a transaction-level field (not per-operation).
- The SDK consumes plain operation-config objects; they are JSON-serializable.

## Options considered

### Option A — Flat payment fields

```typescript
{
  (id, sourceAccount, destination, asset, amount, memo, status, createdAt, metadata);
}
```

- **Pros:** simplest, matches the 90% "send X to Y" case, trivial validation.
- **Cons:** not general (cannot represent path payments, trustlines, offers, multi-op bundles); duplicates the operation payload with a lossy projection (asset/amount/destination would drift from the real operation); a future operation type forces a model migration; "what actually happens on-chain" is not the durable truth.

### Option B — Operation list (recommended)

`operations: OperationConfig[]` — the exact SDK operation descriptors, plus transaction-level `memo` and a `timeBounds` **policy** (relative), not absolute bounds.

- **Pros:** the intent is the durable truth of the on-chain effect; validation and building reuse the SDK shapes with zero translation; extensible by adding union members; JSON-safe.
- **Cons:** validation must cover every supported operation type (one switch, contained); a flat convenience API is lost — mitigated by a `createPaymentIntent()` factory that expands to a single `payment` operation.

### Option C — Stored transaction envelope (hash or XDR)

- **Rejected for the model** (see ADR-0005): envelopes bind sequence numbers and absolute time bounds, both of which are wrong to persist offline; storing full signed XDR invites misuse and is unnecessary. Only envelope **hashes** are journaled, in the mutable lifecycle record, never in the intent.

### Status placement — inside vs. outside the intent

A single mutable record vs. an immutable intent + mutable lifecycle record.

- **Immutable intent payload + mutable lifecycle fields on one stored entry** (recommended): the payload section is never mutated (enforced by API and verified by `payloadHash`); lifecycle fields (`status`, `attempts`, `inFlightHashes`, …) live beside it. One record keeps V1 simple; the hash check makes immutability structural rather than conventional.
- Full separation (two tables/objects) rejected for V1: adds an indirection and a join with no correctness benefit once `payloadHash` exists.

## Decision

The intent model is:

```typescript
interface Intent {
  id: string; // app-supplied or UUIDv4; uniqueness enforced by store
  sourceAccount: string; // G... address
  operations: OperationConfig[]; // discriminated union of SDK operation configs
  memo?: MemoConfig; // transaction-level
  timeBounds: { maxAgeSeconds: number }; // relative policy, resolved at build
  metadata?: Record<string, unknown>; // app-owned, excluded from payloadHash
  createdAt: number;
  payloadHash: string; // SHA-256 of canonical {sourceAccount, operations, memo, timeBounds}
}
```

- **Required fields:** `id` (idempotency, recovery), `sourceAccount` (authorization, sequence ownership), `operations` (the effect), `timeBounds` (safe retry window), `createdAt` (audit, FIFO), `payloadHash` (integrity).
- **Optional fields:** `memo`, `metadata`.
- **Never stored:** keys/secrets, credentials, absolute sequence numbers as intent data, full signed envelopes.
- **Recovery fields** (on the lifecycle record, not the intent): `status`, `inFlightHashes`, `nextAttemptAt`, `attemptCount`, `attempts[]` (each with `envelopeHash`, `sequenceNumber`, `submittedAt`, `outcome`).
- **Idempotency fields:** stable `id` (store-enforced uniqueness; duplicate `addIntent` returns the existing entry) + `payloadHash` + `inFlightHashes`.
- **Auditing fields:** `createdAt`, `updatedAt`, `attempts[]` journal, `lastError`.

## Consequences

- Enqueue-time validation is deterministic and comprehensive (addresses, assets, amounts, memo limits, supported operations) — invalid intents never persist.
- Rebuilds are safe because the payload is immutable and hashed; any drift is detected as `payload-mismatch` → `FAILED`, never silently submitted.
- The model is general enough for V2 (Soroban) by extending the operation union.
- Cost: validation must enumerate supported operations, and the "payment" ergonomics require the `createPaymentIntent` factory.
