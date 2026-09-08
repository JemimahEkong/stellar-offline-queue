# ADR-0009: Network Adapter

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

The library must talk to Stellar — load accounts, submit transactions, query status — without coupling its correctness logic to any particular endpoint or SDK client shape. Two realities drive the design:

1. **Reconciliation needs context, not just status.** The verdict engine (§8.3 of `docs/architecture.md`) requires `latestLedgerCloseTime` (to prove expiry) and `oldestLedger` (to detect retention-window closure). The Stellar **RPC** (`getTransaction`) provides both; **Horizon** (`GET /transactions/:hash`) does not — a Horizon `404` gives no retention information at all. The two transports therefore have _different verdict quality_, and the library must be honest about that.
2. **The SDK client is a means, not a contract.** `@stellar/stellar-sdk` provides `rpc.Server` and `Horizon.Server` clients, but the queue's semantics (normalized submission statuses, ambiguity classification, ledger-time queries) are ours to define. Coupling the engine directly to SDK client types would leak transport quirks (Horizon 504s, RPC `TRY_AGAIN_LATER`) into the state machine and make future transports (fee-bump-aware submit, channel endpoints, other Stellar-compatible networks such as Pi) invasive changes.

The research phase also established that the project is network-agnostic by intent: it is a workflow layer above Stellar infrastructure, not a fork or a new network.

## Options considered

### Option A — RPC-only

- **Pros:** one path; the best reconciliation context; aligns with SDF's recommendation.
- **Cons:** excludes existing Horizon-based applications (many classic Stellar apps submit via Horizon and would have to migrate to run the queue).

### Option B — Horizon-only

- **Pros:** covers the legacy surface.
- **Cons:** cannot produce `EXPIRED` vs `INDETERMINATE` distinctions precisely (no `oldestLedger`); the differentiator of the project would be crippled by default. Rejected as the primary.

### Option C — Adapter interface with RPC primary + Horizon optional secondary (recommended)

A `StellarAdapter` interface normalizes exactly what the engine needs (`loadAccount`, `submitTransaction`, `getTransactionStatus` — with normalized statuses and ledger-time/retention context where the transport can provide it). Two implementations: `RpcAdapter` (primary, full verdict quality) and `HorizonAdapter` (optional secondary, documented verdict-quality caveats). The core library never imports an SDK client directly — only adapters do; `builder.ts` uses the SDK's network-agnostic `TransactionBuilder` for construction.

## Decision

Adopt Option C.

- **Core is network-agnostic:** the engine, state machine, reconciliation, and storage depend only on the `StellarAdapter` interface (§4.6 of `docs/architecture.md`). No SDK client type leaks into core logic.
- **RpcAdapter is the required, primary adapter** — it provides `latestLedgerCloseTime` and `oldestLedger`, which the reconciliation verdict requires for precise `EXPIRED`/`INDETERMINATE` classification.
- **HorizonAdapter is optional and secondary** — supported for legacy applications, with documented behavior:
  - submission: normalized `PENDING`-like (async), `DUPLICATE`, `TRY_AGAIN_LATER`-like, and 504 → ambiguous;
  - status: `SUCCESS`/`FAILED` when found; `NOT_FOUND` (404) → the engine classifies using only time-bounds context: within bounds → keep polling; past `maxTime` → `EXPIRED`. Retention-window `INDETERMINATE` cannot be detected via Horizon and is documented as such (the app can supply an external indexer/explorer check).
- Both adapters normalize errors into typed, classifiable failures (transient vs terminal) so the state machine never parses transport-specific messages.

## Consequences

- The queue's correctness logic is testable against a fake adapter without any network, and usable against any Stellar-compatible endpoint or fork without core changes.
- Horizon users get the full state machine with slightly weaker expiry/indeterminate precision — an accepted, documented trade-off, not a silent one.
- Adding future transports (fee-bump-aware submission per SDF #1602, channel endpoints, Pi Network RPC) is additive: new adapter implementations behind the same interface.
