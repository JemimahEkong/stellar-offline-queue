# stellar-offline-queue — V1 Scope

**Date:** September 5, 2026
**Status:** Approved as part of the architecture review
**Authority:** This document is the single source of truth for what ships in V1. Anything not listed as included is excluded unless explicitly marked otherwise.

---

## 1. Included in V1

| Area                  | What ships                                                                                                                                                                                                                                                                                                          | Why                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Payment intents**   | `Intent` model (id, sourceAccount, operations, memo?, relative timeBounds policy, metadata, payloadHash), enqueue-time validation, `createPaymentIntent` factory, supported classic operation set (payment, createAccount, pathPaymentStrictSend/Receive, changeTrust, manageSellOffer/BuyOffer, setOptions subset) | The durable, offline-creatable "what"; the unit of idempotency and audit                      |
| **Durable queue**     | `QueueEntry` lifecycle record, CAS-backed state transitions, write-ahead hash journal, lease fields (`claimedBy`, `claimExpiresAt`)                                                                                                                                                                                 | Crash-safe, multi-process-safe persistence of workflow state                                  |
| **Storage**           | `QueueStore` interface (§9.2 of architecture.md) + `MemoryStore` (tests/dev) + `SqliteStore` (Node, WAL)                                                                                                                                                                                                            | Node-first; browser/IndexedDB and React Native adapters are post-V1 (interface is their spec) |
| **Processing engine** | Claim/lease ownership, per-account single-writer serialization, FIFO scheduling, exponential backoff, identical-envelope resubmission, rebuild-on-expiry, `process()`/`start()` sweep                                                                                                                               | Turns stored intents into settled (or honestly uncertain) outcomes                            |
| **Reconciliation**    | `SUCCESS                                                                                                                                                                                                                                                                                                            | FAILED                                                                                        | EXPIRED | INDETERMINATE`verdicts,`NOT_FOUND`disambiguation (pending / never-accepted / expired / retention-closed),`tx_bad_seq` decision table, crash recovery sweep | The project's differentiator: honest answers to "did the payment happen?" |
| **Stellar adapter**   | `StellarAdapter` interface; `RpcAdapter` (primary, required); `HorizonAdapter` (optional secondary, documented verdict caveats)                                                                                                                                                                                     | Network-agnostic core; RPC provides the ledger-time/retention context verdicts need           |
| **Signer boundary**   | `Signer` interface; signing happens only at the `SIGNING` phase; keys never stored, serialized, or logged                                                                                                                                                                                                           | The library is not a wallet by construction                                                   |
| **Events**            | `intent:transition`, `intent:settled` typed events                                                                                                                                                                                                                                                                  | Minimal observability for apps/UI                                                             |
| **Examples & docs**   | `examples/node-sqlite.ts` (testnet), README, architecture.md, ADRs 0001–0009, security.md, v1-scope.md                                                                                                                                                                                                              | Another engineer implements without guessing                                                  |
| **CI**                | typecheck + lint + unit + store contract suite; gated testnet integration job; reliability suite against the recording fake network                                                                                                                                                                                 | The at-most-once guarantee is tested, not asserted                                            |

## 2. Excluded from V1

| Area                                              | Why excluded                                                                                           | When reconsidered                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Wallet / custody / key management**             | Contradicts the signer boundary (ADR-0002); keys belong to the application                             | never — out of scope permanently                              |
| **POS / merchant / inventory / CRM features**     | Application domain, not infrastructure                                                                 | never (library-level); apps (e.g. HaloPay-style) build on top |
| **Mobile app / UI**                               | Not a product; a library                                                                               | never (library-level)                                         |
| **Soroban / smart-contract transactions**         | Requires simulation, footprint management, `prepareTransaction`                                        | V2 (operation union + builder step; ADR seam documented)      |
| **Multi-chain / Stellar forks (e.g. Pi Network)** | Passphrase-agnostic core makes it possible, but V1 ships Stellar testnet only                          | V2 (adapter additions; follows @coixa/stellar precedent)      |
| **Channel accounts / parallel throughput**        | Per-account serialization is the V1 correctness baseline                                               | V2 (aligns with SDF #1599)                                    |
| **Automatic fee-bump recovery**                   | Adds fee-source semantics and sponsorship decisions                                                    | V2 (aligns with SDF #1602)                                    |
| **`bumpSequence`-based cancellation**             | V1 `remove()` covers pre-submission deletion; on-chain invalidation adds a new operation and semantics | V2 (`cancel(id)` API)                                         |
| **Background daemon / CLI / hosted service**      | V1 is a library; apps drive `process()`/`start()`                                                      | V2 if ecosystem demand appears                                |
| **IndexedDB / React Native storage adapters**     | Node-first V1; interface is complete and contract-tested                                               | first post-V1 milestone                                       |
| **Off-chain payment channels**                    | That is `@stellar/mpp`'s problem, not ours                                                             | never — out of scope permanently                              |

## 3. Explicit non-goals (repeat of architecture §2.2)

- Not a replacement for `@stellar/stellar-sdk` (it is a peer dependency).
- Not a wallet, key storage, or key management.
- Not a new payment network, consensus layer, or Horizon/RPC server.
- Not an offline _settlement_ mechanism — blockchain settlement stays fully online; the library manages offline-first **workflow** with eventual settlement.
- Not a reimplementation of XDR, signing, network clients, fee math, simulation, or fee-bump mechanics.

## 4. Open questions resolved during implementation planning

Both open questions left by architecture review (§15 of architecture.md) were resolved in the planning phase. These resolutions are **in scope for V1** and bind the implementation plan (`docs/implementation.md`):

1. **Numeric defaults → ADR-0010.** `leaseMs` 60 000 ms · `maxAttempts` 5 · `maxAgeSeconds` 300 (floor 60) · `backoff.baseMs` 1 000 / `capMs` 60 000 · `concurrency` 1 · `start()` interval 5 000 ms · `baseFee` = SDK `BASE_FEE`; internal constants `RECONCILE_BATCH_LIMIT` 200 and `DUE_SCAN_PAGE_SIZE` 100. All defaults frozen for the 1.x line; changing a default is a major-version (breaking) change.
2. **`remove()` vs `cancel()` → ADR-0011.** V1 ships **both**, each strictly pre-submission: `cancel(id)` is the primary, auditable abandonment verb (`QUEUED`/`NEEDS_RETRY` → `FAILED` with `lastError.code = 'cancelled'`, reversible via manual `retry(id)`), and `remove(id)` is the guarded CAS delete of the record. Neither may touch an entry with an in-flight hash; post-submission intents always run to `SUCCESS | FAILED | EXPIRED | INDETERMINATE`. Post-submission cancellation via `bumpSequence` remains V2.

Planning-phase additions this authorizes in the V1 deliverable set: `docs/implementation.md`, `docs/roadmap.md`, `docs/github-issues.md`, and ADR-0010/0011 in `docs/decisions/`.
