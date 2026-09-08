# stellar-offline-queue — Research Report

**Status:** Research phase (no implementation code)
**Research date:** September 5, 2026
**Scope:** Determine whether an offline-first transaction queue for Stellar is a real gap, what already exists, what the correct MVP direction is, and what must not be rebuilt.

---

## 1. Executive Summary

Stellar provides excellent primitives for **building, signing, and submitting** transactions, but it deliberately provides **no durable workflow layer** on top of them. Every production backend that submits Stellar transactions hand-rolls the same machinery: sequence-number management, bounded retries, timeout ambiguity handling, and duplicate-payment prevention. SDF's own SDK team has filed three open backlog issues ([#1599](#), [#1602](#), [#1615](#)) explicitly naming these gaps — the SDK itself cannot currently tell a builder "is it safe to retry without paying twice."

**No existing open-source project** (as of September 2026) provides a durable, offline-first transaction queue for Stellar:

- `@coixa/stellar` is the closest library, but it is a _synchronous pipeline_ with **no persistence, no queue, no retry-on-reconnect, and no uncertain-outcome reconciliation**.
- The Stellar Disbursement Platform has a production-grade transaction submission service, but it is Go-only, server-side, and not offline-first.
- `@stellar/mpp` solves a different problem (payment channels / machine-to-machine payments).
- Merchant apps like HaloPay POS go offline by _deferring the payment to the customer_ (SEP-0007 QR codes), not by queueing transactions from the merchant side.

**Conclusion:** The gap is real. The correct form is a **TypeScript library layered on top of `@stellar/stellar-sdk`**, storage-agnostic (runs in Node and browsers), that provides: durable offline intent storage, sequence-aware scheduling, safe bounded retry, and explicit reconciliation of uncertain outcomes. Settlement itself stays fully online — the library manages _workflow_, not consensus.

---

## 2. Stellar Ecosystem Overview

### 2.1 How transactions work

- **Operations** are the atomic commands that modify the ledger (payment, create account, path payment, change trust, offers, smart contract invocation, etc.). A transaction bundles 1–100 operations (smart-contract transactions: exactly 1).
- **Transactions** are encoded in XDR, contain source account, sequence number, fee, memo, preconditions, and a list of operations. They are **atomic**: if one operation fails, the whole transaction fails.
- **Transaction envelopes** are a transaction plus its signatures. Signing binds the **network passphrase** into the hash — a testnet transaction cannot be replayed on mainnet, and _vice versa_.
- **Validity checks** happen in three stages: preconditions (time bounds, ledger bounds, min sequence number, min sequence age, extra signers), operation validity, and transaction validity (source account exists, fee ≥ network minimum, sequence number is exactly one greater than the account's, signatures meet thresholds).

### 2.2 Sequence numbers — the heart of the problem

- Every account has a monotonically increasing sequence number. A transaction is valid only if its sequence number equals `account sequence + 1`.
- When a transaction is included, the account's sequence number is set to the transaction's sequence number. **Sequence numbers are consumed exactly once and can never be replaced.**
- Since Protocol 20, an account can have **at most one transaction per ledger** (source account limit). Concurrent submission from one account races; the loser fails with `tx_bad_seq`.
- `tx_bad_seq` is the classic trap: if two payments are built from the same account state and both are submitted, only one lands. Naively "fixing" the loser by reloading the account and rebuilding produces a **different transaction hash** — and if the original actually did land (e.g. the timeout was spurious), the rebuilt copy is a **duplicate payment**.
- **Channel accounts** are the official scaling answer: separate source accounts that own sequence numbers, with the acting account as the _operation_ source. This is currently a fully manual pattern (SDF issue #1599 proposes making it a first-class SDK feature; it is still backlog).

### 2.3 Time bounds and expiry — the safety tool

- **Time bounds** (`minTime`/`maxTime`) bound when a transaction is valid, measured by **ledger time** (not device clock).
- If `maxTime = 0`, there is **no upper bound** — an un-included transaction sits in node memory trying to get into every subsequent transaction set, forever. The docs explicitly advise _against_ this when you plan to resubmit.
- Once the network's `latestLedgerCloseTime` exceeds `maxTime`, the transaction **can never be included** — it is provably expired, its sequence number was never consumed, and rebuilding/resubmitting is provably safe (not merely probable). This property is the foundation of any correct retry design.
- Because _"resubmitting a transaction is only safe when it is unchanged — same operations, signatures, sequence number, etc."_ (official docs), the retry contract is: **within time bounds → resubmit the identical envelope; past time bounds → rebuild from scratch.**

### 2.4 Submission paths and their uncertainty

**Horizon** (traditional API):

- `POST /transactions` — synchronous; returns 200 (included), 400 (invalid), or **504** on timeout.
- **A 504 does not mean failure.** Horizon waited 30s while core retried the transaction for up to 3 ledgers; the transaction may still land. The docs call 504 "a warning that your transaction hasn't been accepted yet."
- `POST /transactions_async` — returns immediately with `tx_status`: `PENDING`, `DUPLICATE`, `ERROR`, or `TRY_AGAIN_LATER`. The client must then poll.
- Public Horizon rate limit: 3,600 requests/hour.

**Stellar RPC** (Soroban RPC; recommended and required for smart contracts):

- `sendTransaction` — validates and **enqueues**; returns `PENDING | DUPLICATE | TRY_AGAIN_LATER | ERROR`, plus `hash`, `latestLedger`, `latestLedgerCloseTime`.
- `getTransaction(hash)` — returns `SUCCESS | NOT_FOUND | FAILED`, plus `latestLedger`, `latestLedgerCloseTime`, `oldestLedger`, and (on success/failure) the ledger number, result XDR, and meta.
- The RPC keeps a **bounded retention window** of processed transactions — stock default **120,960 ledgers (~7 days)**. Beyond that, `getTransaction` returns `NOT_FOUND` even for a transaction that did land.
- **`NOT_FOUND` is triply ambiguous:** still pending, never accepted, or aged out of the retention window.

**Fee bumps** — an independent fee source can wrap an already-signed inner transaction to raise its bid under surge pricing. Recovery today is hand-rolled (SDF issue #1602 proposes `bumpAndResubmit`; backlog).

### 2.5 The SDK's own gap list (backlog, Q3 2026)

These are open issues in `stellar/js-stellar-sdk`, not shipped features:

| Issue | Title                                                | What it says                                                                                                                                                                                                                                                                |
| ----- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1599 | Sequence-safe submission and channel account pooling | "The SDK offers nothing for concurrent submission… Every backend that submits concurrently rebuilds this, and the failure mode when they get it wrong is paying a user twice. This is the highest-severity gap in the SDK's surface."                                       |
| #1602 | Fee-bump recovery for stuck transactions             | Recovery on `TRY_AGAIN_LATER`/`tx_insufficient_fee` means hand-building a fee-bump; "enough friction that most apps simply fail the operation."                                                                                                                             |
| #1615 | Definitive transaction outcome                       | "After submitting, the SDK cannot tell a builder whether a transaction failed permanently or is still in flight… backends either retry blind and risk double submission, or stall a user on an outcome that is already decided." Proposes `confirmTransaction(tx) → SUCCESS | FAILED | EXPIRED | INDETERMINATE`, derived from `maxTime`vs`latestLedgerCloseTime`. |

This is the single strongest external validation that the problem stellar-offline-queue targets is real, and that SDF considers it unsolved as of the research date.

---

## 3. Existing Solutions (detailed profiles)

For each project: purpose, architecture, features, similarities, differences, integration potential, and whether it makes part of this idea unnecessary.

### 3.1 `@stellar/stellar-sdk` (official JS SDK)

- **Repo / package:** github.com/stellar/js-stellar-sdk · `@stellar/stellar-sdk` (v17.0.1 as of Aug 2026)
- **Purpose:** The official library for building, signing, submitting, and querying Stellar transactions (Horizon + RPC).
- **Architecture:** `TransactionBuilder` / `FeeBumpTransactionBuilder` → sign with `Keypair` → submit via `Horizon.Server.submitTransaction` or `rpc.Server.sendTransaction` → poll via `getTransaction`/`pollTransaction`. Includes Soroban simulation/`prepareTransaction`, `AssembledTransaction`, and contract bindings tooling.
- **Features:** XDR encode/decode, all operations, multisig, muxed accounts, fee bumps, time bounds/preconditions, keypair management, network passphrases, RPC client with `getFeeStats`, `getHealth`, etc.
- **Similarities:** Provides the raw submission/polling verbs a queue needs.
- **Differences:** Stateless. No durable storage, no queue, no state machine, no retry policy, no offline intent model. Its own docs show a "rudimentary looping mechanism" for submit-and-wait — the SDK deliberately leaves policy to the developer.
- **Integration:** stellar-offline-queue is a **peer dependency consumer** of this SDK. Everything in section 6 "what not to rebuild" comes from here.
- **Does it make the idea unnecessary?** No — the SDK's open issues (#1599, #1602, #1615) are the gap.

### 3.2 `@coixa/stellar` (coixa-labs/stellar)

- **Repo / package:** github.com/coixa-labs/stellar · `@coixa/stellar` v0.1.0 (published Aug 14, 2026; Apache-2.0; 3 stars)
- **Purpose:** "Typed transaction pipeline and Horizon/RPC provider routing for Stellar-compatible networks (Stellar, Pi Network)." Built and used in production by Coixa, a Pi Network wallet.
- **Architecture:** Composable pipeline stages — `accountResolutionStage → draftCreationStage → feeResolutionStage → buildStage → (simulationStage/preparationStage) → signingStage → submissionStage → confirmationStage → receiptNormalizationStage`. A `createStellarProviderRouter` selects transports (account lookup: RPC→Horizon; submission: RPC→Horizon, selected once; base fee: Horizon only; simulation: RPC only).
- **Features:** Typed lifecycle, transport routing without cross-transport duplicate submission, classic operation helpers (`paymentOperation`, `changeTrustOperation`, path payments, offers), network presets (Stellar + Pi mainnet/testnet), stroop conversion, BIP39 wallet utils.
- **Similarities:** Same "layer on top of the SDK" philosophy; TypeScript; classic + Soroban; the pipeline mirrors a queue's stages (resolve → build → sign → submit → confirm).
- **Differences:** **No durable storage and no offline model.** It is an in-process, one-shot pipeline: a `run()` that completes or throws. No queue, no retry-on-reconnect, no persistence across restarts, no idempotency keys, no uncertain-outcome reconciliation, no sequence-slot management across queued items. v0.1.0, single maintainer, Apache-2.0 (vs. this project's MIT), oriented toward Pi Network + wallet UX rather than backend/offline reliability.
- **Integration:** Excellent candidate for inspiration (stage names, provider routing) and possible collaboration; a queue's "flush/worker" stage could reuse its pipeline shape.
- **Does it make part of this idea unnecessary?** No. It proves demand for a higher-level Stellar layer but does not solve offline durability or retry safety.

### 3.3 `@stellar/mpp` (stellar-mpp-sdk)

- **Repo / package:** github.com/stellar/stellar-mpp-sdk · `@stellar/mpp`
- **Purpose:** Stellar payment method for the Machine Payments Protocol (MPP) — machine-to-machine payments using SEP-41 token transfers, with optional one-way payment channels.
- **Architecture:** Two modes: **charge** (each payment is an on-chain SEP-41 transfer; includes client→server credential flow with its own poll loop — `pollMaxAttempts`, `pollDelayMs`, `pollTimeoutMs`, replay-protection `Store`) and **channel** (funder deposits once on-chain, then signs cumulative off-chain commitments; no per-payment on-chain transactions; close when convenient).
- **Features:** 402-payment challenge flow, sponsored (fee-payer) and unsponsored modes, fee bumps, replay protection stores, channel contract support.
- **Similarities:** Both sit on the SDK; both care about safe submission (polling, replay protection, store abstraction).
- **Differences:** Different problem entirely — off-chain _payment channels_ for high-frequency M2M payments, plus a specific HTTP payment protocol. Not a general-purpose offline queue; no intent persistence for arbitrary operations; tied to SEP-41 transfers and the MPPx protocol.
- **Integration:** Its `Store` interface and poll-loop parameters are a good reference for the queue's storage and polling design. The channel mode is a legitimate _alternative_ to queuing for very high-frequency, low-value flows.
- **Does it make part of this idea unnecessary?** Partially overlaps for _micro-payment streaming_ use cases (channels), but not for general offline-first workflows (POS payments, disbursements, arbitrary operations).

### 3.4 Stellar Disbursement Platform (SDP) Backend

- **Repo:** github.com/stellar/stellar-disbursement-platform-backend (Go)
- **Purpose:** Bulk disbursement of payments to recipients on Stellar (aid, payroll, etc.).
- **Architecture:** Admin/Dashboard APIs + Message Service (SMS/email OTPs) + a **Transaction Submission Service (TSS)** — a production-grade submission engine with queueing, retries, and status tracking, backed by a database. SEP-10 auth and SEP-24 deposit flows natively implemented. The project notes TSS "will be moved to its own repository to be used as an independent service."
- **Features:** Payment batches, channel accounts for throughput, retry and status management, multi-tenant, approval flows.
- **Similarities:** The TSS is conceptually the server-side sibling of this project's queue (durable intents → sequence-aware submission → status tracking).
- **Differences:** Go, heavyweight service (Postgres, Redis, message providers), server-only, disbursement-specific domain, not offline-first (it assumes connectivity), not a reusable library.
- **Integration:** When TSS is extracted, it could become a reference implementation or a server-side alternative. The queue's store adapter could mirror its schema.
- **Does it make part of this idea unnecessary?** No — it is not a library and not offline-first; but it does show the "correct" shape of a production submission engine and raises the bar for what a credible MVP must handle.

### 3.5 HaloPay Merchant POS (halopay-pos)

- **Repo:** github.com/HaloPaye/halopay-pos (PWA, Next.js/Tailwind, MIT)
- **Purpose:** Offline-first POS terminal for merchants in low-connectivity regions accepting USDC over Stellar.
- **Architecture:** Service-worker-cached PWA; generates **SEP-0007** `web+stellar:pay` QR codes fully offline; caches fiat→USDC rates with staleness warnings; listens via WebSocket to a settlement backend for on-chain confirmations.
- **Features:** Offline QR generation, cached rate engine, large-touch keypad, PWA shell, real-time payment confirmation toasts.
- **Similarities:** Same offline-first motivation and target user (merchants in low-connectivity environments).
- **Differences:** The merchant **never submits a transaction** — the _customer's wallet_ relays the payment. Offline capability is achieved by deferring settlement, not by queueing. It is an application, not a library.
- **Integration:** stellar-offline-queue could power the _backend_ side of this flow (confirming inbound payments, reconciling), or a future variant where the merchant itself submits queued transactions when connectivity returns.
- **Does it make part of this idea unnecessary?** Only for the specific "customer relays the payment" design; it validates the demand but does not solve queueing, retries, or reconciliation.

### 3.6 Other observations

- **PayStell/paystell-backend** — merchant payment backend on Stellar (early-stage, GitHub org). Application-level, not a reusable queue library.
- **PayPulse (ombaviskar18)** — student/hackathon mobile app demoing offline XLM/token transfers; not production infrastructure.
- **SEP-0007 (`web+stellar:pay` URIs)** — the de-facto offline _payment request_ standard (amount, asset, memo, destination as a URI). A queue library should interoperate with it (accepting intents in this format is a natural integration).
- **Generic queues (p-queue, bull, yocto-queue, offline-queue-engine, react-offline-queue)** — transport-agnostic or app-level; none understand sequence numbers, time bounds, or Stellar submission semantics.
- **`@creit.tech/stellar-wallets-kit`** — wallet connection kit (Albedo, xBull, Freighter, Ledger…); a _signing source_, not submission infrastructure. Relevant as an integration point for client-side signing.
- **stellar-protocol / stellar-core** — protocol spec and node software; context, not competition. CAP-21-style preconditions (min sequence number) and CAP-0015 (fee bumps) are the protocol features a queue relies on.

---

## 4. Possible Competitors (as of research date)

1. **SDF itself** (highest-risk competitor). If #1599/#1602/#1615 ship as SDK features, part of the queue's value (sequence-safe submission, definitive outcomes, fee-bump recovery) becomes SDK-native. **Mitigation:** the SDK is browser+Node and deliberately stays stateless; a durable, offline-first _workflow_ layer with persistence and policy is out of its scope. The queue should be designed to _consume_ those SDK primitives when they land, not compete with them.
2. **`@coixa/stellar`** — young but production-used on Pi Network; may grow persistence/retry features. Apache-2.0 vs. MIT; different network focus (Pi) but directly adjacent.
3. **Extracted SDP TSS** — if SDF extracts the transaction submission service as a standalone Go service, it becomes the server-side alternative for backend-heavy users.
4. **Anchor/merchant platforms** (Anchor Platform, SDP-like products, PayStell) — application-level, may bundle queueing internally.

None of these currently ship an offline-first, storage-agnostic TypeScript queue.

---

## 5. Technical Investigation Findings

### 5.1 Transaction lifecycle and where failures happen

`create intents offline → resolve account/sequence → build → sign → submit → confirm → reconcile`

| Stage                     | Failure modes                                                                     | Notes for a queue                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Intent creation (offline) | None on-chain                                                                     | Fully supported offline: building + signing needs only keys and the network passphrase.              |
| Sequence resolution       | Requires network                                                                  | Must know the account's current sequence. **Resolve at flush time, not at intent time** (see 5.2).   |
| Build                     | Precondition mistakes                                                             | Keep the _intent_ (operations, memo, bounds policy) durable; materialize the envelope at flush time. |
| Sign                      | Key availability                                                                  | Keys may live in a wallet kit / HSM / device; queue should accept a signer interface, not copy keys. |
| Submit                    | `tx_bad_seq`, `tx_insufficient_fee`, 504, `TRY_AGAIN_LATER`, `DUPLICATE`, `ERROR` | Map each to a queue transition (retry-within-bounds / expired / terminal / indeterminate).           |
| Confirm                   | `SUCCESS`, `FAILED`, `NOT_FOUND`                                                  | `NOT_FOUND` is **never** terminal by itself (see 5.4).                                               |
| Reconcile                 | Retention window                                                                  | After ~7 days the RPC may no longer answer; the queue must decide how to report "indeterminate."     |

### 5.2 Sequence numbers and multiple queued transactions

- Sequence numbers are **strictly consecutive and consumed once**. If intents are queued for one account and each is materialized with `account.seq + 1`, they must be submitted **serially and in order** — a failure or timeout on item N blocks items N+1….
- Risks of preparing transactions fully offline _ahead of time_:
  - The first submission burns a sequence; every pre-built sibling now carries a stale sequence → cascade of `tx_bad_seq`.
  - If item N expires or is cancelled, subsequent pre-built transactions must all be rebuilt anyway (or `bumpSequence` must be used to invalidate them).
  - Rebinding sequences requires re-signing, which requires key access at flush time.
- Safe patterns (to expose, not to force):
  1. **Single-writer serialization** — one account processed by one queue worker at a time, sequence resolved at flush time (the MVP-appropriate default).
  2. **Channel accounts** — parallel throughput; the queue can manage a channel pool (this is exactly SDF #1599).
  3. **`minSeqNum` precondition** (CAP-21) — a queued transaction can carry a floor so it stays valid even if earlier intents are cancelled/reordered; useful but subtle, keep out of MVP.
  4. **`bumpSequence`** — explicit invalidation of stale queued envelopes when an intent is cancelled.

### 5.3 Transaction validity, expiration, retries

- **Time bounds are mandatory for a queue.** Recommended default: `maxTime = now + window` (e.g. 5–30 min) at _flush_ time, giving a bounded submission window per attempt.
- **Retry contract (from official docs):**
  - Within bounds, connection-level failures (`TRY_AGAIN_LATER`, 504, network errors): **resubmit the identical envelope** with backoff — the network dedupes by hash (`DUPLICATE`), so identical resubmission cannot double-apply.
  - Past `maxTime` (ledger time, via `latestLedgerCloseTime`): the envelope **can never be included** → mark `expired`, rebuild with a fresh sequence and bounds, and resubmit. Sequence was not consumed, so this is provably safe.
  - **Never** rebuild "to fix" a `tx_bad_seq` failure before confirming the original did not land.
- Stale/intentionally-cancelled intents: rely on expiry (time bounds) or `bumpSequence`.

### 5.4 Duplicate prevention and uncertain outcomes

- The network is idempotent **per envelope hash**: the same signed envelope can be submitted repeatedly and will be applied at most once.
- The danger is a _different hash for the same intent_: rebuilt with a new sequence, a new memo, or a new fee. That is a _new transaction_ and can double-pay.
- Ambiguous outcomes that must be treated as "unknown, do not rebuild":
  - Horizon **504** (may still land).
  - RPC `sendTransaction` → `TRY_AGAIN_LATER` (transient; may have been accepted).
  - `getTransaction` → `NOT_FOUND` (pending / never accepted / **aged out of retention**).
- Definitive outcomes: `SUCCESS`, `FAILED` (included in a ledger and failed), `DUPLICATE` (already known), and **expiry** once `latestLedgerCloseTime > maxTime` (can never be included → safe to rebuild).
- **Design implication:** the queue's core judgment is exactly SDF #1615's proposed verdict — `SUCCESS | FAILED | EXPIRED | INDETERMINATE` — with `INDETERMINATE` when the retention window makes the answer unknowable. The queue should implement this _today_ using raw `getTransaction` + `maxTime` + `oldestLedger`, and adopt the SDK's `confirmTransaction` when it ships.
- Idempotency: each queued **intent** gets a stable client-generated ID; the queue records every envelope hash it created per intent; before any rebuild it checks (a) hashes seen in `SUCCESS`/`DUPLICATE` responses and (b) whether any recorded hash is still within bounds. A durable intent journal is what makes "safe retry" a guarantee instead of a hope.

---

## 6. Research Questions — Direct Answers

1. **Does a Stellar offline payment queue already exist?** No. Nothing on npm or GitHub provides a durable, offline-first transaction queue for Stellar (search checks: npm "stellar transaction queue", GitHub "stellar offline payment", "stellar transaction queue", "stellar payment sdk", "stellar merchant").
2. **Are there similar transaction queue systems?** Yes, in adjacent shapes: SDP's TSS (server-side Go submission engine), `@stellar/mpp`'s replay-protection stores + poll loops, `@coixa/stellar`'s pipeline. None is an offline-first reusable queue.
3. **Are we solving a real ecosystem gap?** Yes. Independently confirmed by (a) SDF SDK backlog issues #1599/#1602/#1615 explicitly naming retry-safety, sequence-safe submission, and definitive outcomes as missing, (b) official docs forcing developers to hand-roll error handling with warnings about double payments, and (c) production offline-first apps (HaloPay POS, disbursement platforms) that need exactly this layer.
4. **What is already handled by the Stellar SDK?** Building/signing/keypairs/envelopes, all operations, network passphrases, time bounds and preconditions, Horizon + RPC transport, submission verbs, polling, fee bumps, Soroban simulation/prepare, account loading, rate/fee stats.
5. **What layer is missing?** The durable workflow layer: intent persistence, a state machine (queued → resolving → submitting → confirming → settled/expired/failed/indeterminate), sequence-aware scheduling, bounded backoff retry, duplicate prevention via envelope-hash journaling, and explicit uncertain-outcome reconciliation.
6. **What form should the project take?** A **library** (TypeScript, MIT), layered on `@stellar/stellar-sdk`, storage-agnostic (in-memory for tests, SQLite/Postgres/Redis for Node servers, IndexedDB/localStorage for browsers/PWAs), with an optional worker/flush loop. Not an SDK fork, not an application, not a service — though the store/worker design should leave room for a future standalone daemon or an SDP-TSS-style service.
7. **What should we avoid rebuilding?** XDR encode/decode, signing, keypairs, network communication, fee math, Soroban simulation, fee-bump mechanics (all in the SDK); payment-channel cryptography and off-chain commitment logic (in `@stellar/mpp`); a Horizon/RPC replacement; consensus/validation. Also avoid re-implementing SEP-0007 generation (use the standard).

---

## 7. Technical Gaps (what the library must fill)

1. **Offline intent model** — create, sign-ready intents (payments, create account, path payments, trustlines, offers…) with zero network access; store them durably with a stable intent ID.
2. **Deferred sequence resolution** — resolve account state at flush time; serialize per source account; support channel pools for throughput (matching SDF #1599's design bar).
3. **Bounded retry with the correct retry contract** — identical-envelope resubmission inside time bounds; rebuild only after provable expiry; backoff + jitter; respect RPC/Horizon rate limits.
4. **Uncertain-outcome reconciliation** — implement the `SUCCESS | FAILED | EXPIRED | INDETERMINATE` verdict (per SDF #1615) on top of `getTransaction` + time bounds + `oldestLedger`, including retention-window awareness.
5. **Duplicate prevention / idempotency** — durable envelope-hash journal per intent; no rebuild without checking the journal and bounds; guidance for app-level idempotency (e.g. memo/on-chain records) where needed.
6. **Recovery after crash/restart** — durable states make the queue resumable; store adapters must be transactional per state transition.
7. **Observability** — typed state transitions, emitted events (intent-queued, submitting, confirmed, expired, indeterminate…), and hooks so applications can surface "payment settled" or "needs attention" (compare HaloPay's WebSocket confirmations and SDP's status tracking).

---

## 8. Risks

| Risk                         | Detail                                                                   | Mitigation                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Double payment** (highest) | Rebuilding a possibly-landed transaction (new hash) pays twice.          | Strict retry contract; envelope-hash journal; never rebuild before provable expiry; document the guarantee precisely.           |
| Sequence cascades            | One stuck/expired intent invalidates every later intent for the account. | Serialize per account; resolve sequence at flush; `bumpSequence`/expiry for cancellation; channel pools later.                  |
| Retention-window blindness   | After ~7 days RPC stops answering; a landed tx looks `NOT_FOUND`.        | Use `oldestLedger`; report `INDETERMINATE` rather than failure; allow external confirmation sources (Horizon, indexer, Hubble). |
| Clock skew                   | Time bounds use _ledger_ time, not device time.                          | Derive expiry from `latestLedgerCloseTime`, never local clock; tolerate NTP skew on intent creation.                            |
| Unbounded `maxTime`          | No upper bound → cannot ever prove expiry → unsafe retry.                | Enforce a maxTime default and refuse unbounded transactions (docs do the same).                                                 |
| Key handling                 | Offline signing means keys live on the device/backend.                   | Signer abstraction (Keypair, HSM, wallet kits); keys never persisted by the queue itself.                                       |
| Fee/surge changes            | Low bids get priced out; transactions stall.                             | Optional fee-bump recovery (adopt SDF #1602 when available); configurable max fee; `getFeeStats` awareness.                     |
| Scope creep                  | Rebuilding SDK internals, consensus, or payment channels.                | Hard boundary list (section 6, "avoid rebuilding").                                                                             |
| SDF roadmap overlap          | #1599/#1602/#1615 ship and shrink the differentiator.                    | Consume those primitives; differentiate on durability, offline intents, and reconciliation policy, which the SDK will not ship. |

---

## 9. Opportunities

1. **Timing:** SDF's backlog (#1599, #1602, #1615) proves the need while the SDK team explicitly de-prioritizes building the durable layer — a window for a community library that the SDK can later interoperate with.
2. **Offline-first markets:** POS merchants, field agents, aid disbursements, and low-connectivity regions (HaloPay POS, Pi Network's ecosystem, SDP use cases) are actively building on Stellar today with hand-rolled workarounds.
3. **Cross-network leverage:** Stellar-compatible forks (Pi Network, as `@coixa/stellar` demonstrates) share the same SDK; a passphrase/transport-agnostic design inherits that reach.
4. **Browsers + Node:** No existing project covers both; storage adapters (IndexedDB vs SQLite) make PWAs and servers first-class.
5. **SEP-0007 interop:** Accepting `web+stellar:pay` URIs as queueable intents directly serves the HaloPay-style merchant flow and makes the library useful to wallet teams.
6. **Alignment with SDF roadmap:** Implement #1615's verdict today, then adopt `confirmTransaction` and channel pooling when released — documented as a roadmap item builds credibility.
7. **Reference material:** SDP's TSS and `@stellar/mpp`'s store/poll design provide proven patterns to borrow for the MVP.

---

## 10. Recommended Project Direction

### 10.1 Form

A **TypeScript library** (`stellar-offline-queue`), MIT-licensed, with `@stellar/stellar-sdk` as the only peer dependency. Storage and transport are pluggable interfaces, so it runs in:

- Node.js backends (SQLite adapter for MVP; Postgres/Redis later),
- browsers/PWAs (IndexedDB adapter),
- test environments (in-memory adapter).

### 10.2 Architecture (conceptual, no code)

- **Intent layer:** durable, storage-agnostic representation of a transaction _intent_ (operations, source, memo, bounds policy, stable intent ID). Serializable; created fully offline.
- **State machine:** `queued → resolving → built → submitting → confirming → settled | failed | expired | indeterminate | cancelled`, with every transition persisted atomically.
- **Scheduler:** per-account serialization (channel pools later); resolves account/sequence at flush time; respects time-bound windows.
- **Submission & reconciliation engine:** wraps SDK `sendTransaction`/`getTransaction` (and Horizon equivalents); implements the #1615-style verdict (`SUCCESS | FAILED | EXPIRED | INDETERMINATE`) using `maxTime` + `latestLedgerCloseTime` + `oldestLedger`; identical-envelope retry inside bounds; journaled envelope hashes for idempotency.
- **Signer interface:** `Keypair`, HSM, wallet kits; keys never persisted by the queue.
- **Events/hooks:** typed lifecycle events for UI and backend integration.

### 10.3 MVP scope (recommended)

- Classic operations: `payment`, `createAccount`, `pathPaymentStrictSend/Receive`, `changeTrust`, `manageSellOffer/BuyOffer`, `setOptions` basics.
- Single source account, serialized submission; time-bounded transactions with enforced `maxTime`.
- In-memory + SQLite store adapters; RPC (and Horizon) transports; testnet-first.
- The full reconciliation verdict including `INDETERMINATE`; crash-recoverable states.
- Explicitly **out of MVP:** Soroban/simulation flows, channel pools, fee-bump automation, SEP-0007 URI parsing (nice follow-up), multi-tenant/daemon mode.

### 10.4 Explicit non-goals

- Not a replacement for `@stellar/stellar-sdk` (peer dependency).
- Not a consensus/validation layer, not a Horizon/RPC server, not a wallet, not a payment-channel implementation (see `@stellar/mpp`).
- Not an offline settlement mechanism — blockchain settlement remains fully online; the queue manages _workflow_ around it.

### 10.5 Suggested next steps (post-research)

1. Draft the state-machine and storage-interface design (document, not code).
2. Write the retry-safety and idempotency guarantee as a design doc — SDF's bar for #1599/#1615 applies here: a written guarantee, not a ticket.
3. Validate on testnet with a crash/restart simulation before any mainnet claims.

---

## Appendix: Primary Sources

- Stellar docs — operations & transactions: https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions
- Stellar RPC `sendTransaction`: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction
- Stellar RPC `getTransaction`: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction
- Stellar docs — error handling (Horizon): https://developers.stellar.org/docs/data/apis/horizon/api-reference/errors/error-handling
- Stellar docs — submit-and-wait guide (JS SDK): https://developers.stellar.org/docs/build/guides/transactions/submit-transaction-wait-js
- SDF blog — transaction submission, timeouts, dynamic fees FAQ: https://stellar.org/blog/developers/transaction-submission-timeouts-and-dynamic-fees-faq
- SDF blog — proposed changes to transaction submission (1 tx/account/ledger, channels): https://stellar.org/blog/developers/proposed-changes-to-transaction-submission
- js-stellar-sdk issues #1599 (sequence-safe submission), #1602 (fee-bump recovery), #1615 (definitive transaction outcome): https://github.com/stellar/js-stellar-sdk/issues
- `@coixa/stellar` (coixa-labs/stellar): https://github.com/coixa-labs/stellar · https://www.npmjs.com/package/@coixa/stellar
- `@stellar/mpp` (stellar-mpp-sdk): https://github.com/stellar/stellar-mpp-sdk
- Stellar Disbursement Platform backend: https://github.com/stellar/stellar-disbursement-platform-backend
- HaloPay POS: https://github.com/HaloPaye/halopay-pos
- SEP-0007 (`web+stellar:pay`): https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
