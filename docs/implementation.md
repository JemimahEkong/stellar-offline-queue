# stellar-offline-queue — V1 Implementation Plan

**Status:** Draft plan for review (no implementation started)
**Date:** September 5, 2026
**Authority:** This document converts `docs/architecture.md`, `docs/v1-scope.md`, and ADRs 0001–0011 into the sequential execution roadmap. Where this plan is silent, the architecture governs; if a genuine contradiction is found, stop and document it — never silently deviate.
**Companion documents:** `docs/github-issues.md` (issue/milestone breakdown), `docs/roadmap.md` (phase/milestone map), `docs/decisions/0010-*.md` (numeric defaults), `docs/decisions/0011-*.md` (remove vs cancel).

---

## 0. How to read this plan

- **Build order is inside-out:** core domain → state machine → storage → concurrency → engine → retry/idempotency → Stellar build → signer → network → reconciliation → testnet → hardening → release. No phase touches the network before Phase 10.
- **Every phase is independently testable and mergeable.** Each phase ends with its acceptance criteria met, CI green, and a merged PR (issues: see `docs/github-issues.md`).
- **Phases 10–12 depend on the installed official SDK**, `@stellar/stellar-sdk@^17` (v17.0.1 current at planning time). Every SDK API used must be verified against the installed version's typings — no invented APIs.
- **Subtasks are concrete on purpose.** "Define the `QueueEntry` type", not "implement the queue". An implementer should never have to guess what a task means.
- **Test files are named.** The store contract suite is a single file run against every adapter; the reconciliation suite is table-driven; the reliability suite asserts the at-most-once invariant directly (§13 of architecture.md).
- **Phases map to milestones** (M0–M6) and to GitHub issues 1:1 per phase (multiple issues for large phases) — see `docs/github-issues.md`.

## 0.1 Resolved planning questions (binding for implementation)

1. **Numeric defaults** — resolved in **ADR-0010**: `leaseMs=60_000`, `maxAttempts=5`, `maxAgeSeconds=300` (floor 60), `backoff.baseMs=1_000`, `backoff.capMs=60_000`, `concurrency=1`, `start()` interval 5 s; internal constants `RECONCILE_BATCH_LIMIT=200`, `DUE_SCAN_PAGE_SIZE=100`; `baseFee` = SDK `BASE_FEE`. All frozen for 1.x.
2. **`remove()` vs `cancel()`** — resolved in **ADR-0011**: V1 ships **both**. `cancel(id)` = soft pre-submission abandonment (`QUEUED/NEEDS_RETRY → FAILED`, `lastError.code='cancelled'`, auditable, reversible via `retry()`). `remove(id)` = guarded CAS delete, pre-submission only. Neither may ever touch an entry with in-flight hashes.

## 0.2 Conventions for every phase

- **Files** lists files created/modified by the phase (paths from architecture §13).
- **Tests** names test files and the exact cases they must contain.
- **AC (Acceptance Criteria)** are measurable; **DoD** is what must be true to merge.
- **Universal DoD (applies to every phase in addition to its own):** typecheck passes (`tsc --noEmit`), lint passes, unit tests pass, CI green on the PR, no new dependency without a written justification in the PR description, no secret material in code/tests/logs, docs updated where public behaviour changes.

---

# Phase 0 — Repository Foundation

## Objective

A clean, reproducible TypeScript library skeleton: package metadata, strict toolchain, test runner, lint/format, scripts, CI, and the exact source/test directory layout from architecture §13 — with no domain logic yet.

## Why it exists

Every later phase assumes working typecheck/test/lint/build/CI. Establishing it first means later phases never fight tooling, and CI is enforcing quality from commit one.

## Prerequisites

Approved architecture docs; Node.js LTS available locally; npm registry access.

## Tasks & Subtasks

**T0.1 Package metadata**

- Create `package.json` with: name `stellar-offline-queue`, version `0.0.0` (pre-release; 1.0.0 comes at Phase 23), `license: "MIT"`, `type: "module"`, `engines: { "node": ">=22" }` (Node 24 Active LTS + 22 Maintenance LTS supported; Node 20 EOL April 2026 — CI matrix tests both 22 and 24), `files: ["dist", "README.md", "LICENSE"]`, exports map (`.` → types + ESM import; `./package.json`), `main`/`types` mirrors for legacy resolvers.
- Dependency policy written into the PR: runtime deps = `@stellar/stellar-sdk@^17.0.1` (peer-or-direct decision below), `better-sqlite3` (Phase 5, added then — not now). Dev deps: `typescript`, `vitest`, `eslint`, `prettier`, `@types/node`, `tsup` (or plain `tsc` — choose and document; default choice: `tsc` for declarations simplicity, `tsup` only if dual-format friction demands it).
- Add `dependencies` vs `devDependencies` split; no dependencies beyond the above without an ADR-level justification.

**T0.2 TypeScript strictness**

- Create `tsconfig.json` with `strict: true` and the hardening flags: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `moduleResolution: "bundler"` (or `"nodenext"` — must match the exports map), `declaration: true`, `declarationMap: true`, `sourceMap: true`, `outDir: "dist"`.
- Create `tsconfig.build.json` (emits) and ensure `npm run typecheck` runs `tsc --noEmit` over src+tests.

**T0.3 Test framework**

- Install Vitest; create `vitest.config.ts` (node environment, `include: ["tests/**/*.test.ts"]`, coverage provider v8 with thresholds placeholder — enforced from Phase 19).
- Create the four test trees from architecture §13: `tests/unit/`, `tests/store/`, `tests/reliability/`, `tests/helpers/` each with a `.gitkeep` and a trivial smoke test that runs.

**T0.4 Lint + format**

- ESLint flat config with `typescript-eslint` recommended + `no-floating-promises`/`no-misused-promises` (type-checked), `no-console` (src only), import sorting.
- Prettier config (printWidth 100, singleQuote); `.prettierrc`, `.prettierignore` (dist, coverage).
- Lint must cover `src/`, `tests/`, `examples/`.

**T0.5 Scripts**

- `package.json` scripts: `typecheck`, `lint`, `format`, `test` (unit+store, no network), `test:reliability`, `test:integration` (gated, testnet), `build`, `prepublishOnly` (build+test+lint), `clean`.
- `test:integration` must be skipped unless `STELLAR_TESTNET=1` is set (implemented in Phase 18; wire the env gate now).

**T0.6 Source structure**

- Create `src/` with the module files from architecture §13 as **empty stubs with one-line doc comments** (no logic): `index.ts`, `intent.ts`, `state.ts`, `queue.ts`, `engine.ts`, `builder.ts`, `reconciliation.ts`, `backoff.ts`, `signer.ts`, `errors.ts`, `events.ts`, `store/types.ts`, `store/memory.ts`, `store/sqlite.ts` (stub only — `better-sqlite3` arrives Phase 5), `adapters/types.ts`, `adapters/rpc.ts`, `adapters/horizon.ts`.
- Stub files must compile with `export {};` and be re-exported from `index.ts` progressively in later phases.

**T0.7 CI**

- `.github/workflows/ci.yml`: two jobs — `verify` (node 22 + 24 matrix: install, typecheck, lint, test, build) and (placeholder) `integration` gated on `STELLAR_TESTNET=1` secret, always allowed to be skipped in early phases.
- Add `.github/workflows/docs-links.yml` optional? — **No** (keep CI minimal per architecture "fewest moving parts").

**T0.8 Repo hygiene**

- `.gitignore` review (already present), `LICENSE` (MIT, copyright holder = project maintainers), `README.md` placeholder with badges (CI status only — no claims yet), `CONTRIBUTING.md` stub (completed Phase 20).

## Files

`package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.github/workflows/ci.yml`, `LICENSE`, `README.md` (stub), all `src/**` stubs, `tests/**` trees.

## Dependencies

None (first phase). Uses decisions: none directly; verifies SDK `@stellar/stellar-sdk@^17.0.1` installs cleanly on Node 22/24.

## Tests

- `tests/unit/tooling.test.ts` (temporary, deleted in Phase 1): asserts the package's own export resolves (`await import('../src/index')`) and one stub compiles. Existence of this test proves the runner works end-to-end.

## Acceptance Criteria

- `npm install` completes with no errors on Node 22 and Node 24.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all succeed locally.
- CI runs the same commands on both Node versions and is green.
- `dist/` contains `.js`, `.d.ts`, `.d.ts.map` for every stub module.
- Dependency tree contains exactly: `@stellar/stellar-sdk` (runtime), `better-sqlite3` **not yet present**, plus declared dev tools. No other runtime deps.

## Definition of Done

All ACs; PR merged to `main` with CI green; package.json dependency policy documented in the PR; README badge renders.

---

# Phase 1 — Core Domain Model

## Objective

The immutable `Intent` model: validation, normalization, canonical payload hashing, serialization rules, and the `createPaymentIntent` factory — fully offline, no Stellar network calls.

## Why it exists

Everything downstream (queue entries, storage, building) consumes a validated, hash-protected intent. Getting this layer right makes invalid intents structurally impossible to persist (architecture §4.1).

## Prerequisites

Phase 0. ADR-0001 (intent model). Architecture §5.1–5.2, §9.4.

## Tasks & Subtasks

**T1.1 Types (`src/intent.ts`)**

- Define `Intent` exactly per ADR-0001/architecture §5.1 (`id`, `sourceAccount`, `operations`, `memo?`, `timeBounds: { maxAgeSeconds }`, `metadata?`, `createdAt`, `payloadHash`).
- Define `CreateIntentInput` (same minus `createdAt`/`payloadHash`; `timeBounds.maxAgeSeconds` optional with default 300).
- Define `OperationConfig` discriminated union per architecture §5.2: `payment`, `createAccount`, `pathPaymentStrictSend`, `pathPaymentStrictReceive`, `changeTrust`, `manageSellOffer`, `manageBuyOffer`, `setOptions` (subset: `inflationDest?`, `homeDomain?`, `signer?`, thresholds). Discriminate on `type`; each variant's fields must mirror the SDK operation descriptor names (verify against installed SDK typings).
- Define `MemoConfig` union: `{ type: 'text'|'id'|'hash'|'return', value: string }` (no `none` — absence is the none case).

**T1.2 Identifiers**

- `id`: accept app-supplied non-empty string (≤ 128 chars, printable) or generate UUIDv4 via `crypto.randomUUID()`; document that ids are store-unique keys.
- No other identity fields; do not add kind/tenant/version fields (out of scope).

**T1.3 Validation (`validateCreateIntentInput`)**

- Address validation: `StrKey.isValidEd25519PublicKey` (SDK) for `sourceAccount`, payment destinations, `createAccount` destination, `inflationDest`, signer keys. Consider muxed/strkey variants only if SDK typings make it free — otherwise G-addresses only, documented.
- Asset validation: native `XLM` and issued `CODE:ISSUER` parsing (used by `createPaymentIntent` and `changeTrust`/path payment configs); issuer must be valid G-address; code 1–12 chars for issued assets (4–12 for non-native per protocol rules — verify against SDK `Asset` and encode precisely what the SDK enforces).
- Amount validation: string decimal, `> 0`, ≤ 7 decimal places, parses to finite number without precision loss (use SDK's amount utilities if exported; else implement `isValidAmount` semantics matching SDK — verify against installed SDK source).
- Memo validation: text ≤ 28 bytes (UTF-8), id = unsigned 64-bit integer string, hash/return = 32-byte hex. Enforce SDK memo limits.
- `timeBounds.maxAgeSeconds`: positive integer, ≥ 60 (floor per ADR-0010), ≤ 86,400 (documented sanity cap).
- `metadata`: plain JSON object check (no functions/circulars) — it must serialize losslessly.
- Operations: non-empty array, ≤ 100 ops (protocol limit), per-variant field validation (destinations, assets, amounts, offer ids, price decimals, signer weight/signType subset), unsupported `type` → `ValidationError('unsupported-operation')`.
- Every failure returns/throws typed `ValidationError` with machine-readable `code` + `field` (see `errors.ts` T1.6) — entry is never persisted on failure (architecture §4.1).

**T1.4 Normalization**

- Trim/normalize: asset code uppercase for issued assets, memo values as strings, amount strings preserved exactly (never float-round), `timeBounds` defaulted to `{ maxAgeSeconds: 300 }` when omitted.
- Normalization must be deterministic (same input → same normalized output) and must be applied **before** hashing.

**T1.5 Payload hash + serialization**

- Implement `computePayloadHash(intent-core)` = SHA-256 hex over **canonical JSON** of `{ sourceAccount, operations, memo, timeBounds }` — stable key order (sort object keys recursively), no whitespace, UTF-8. `metadata`, `createdAt`, `id` excluded (architecture §5.1).
- Implement canonical-JSON stringify as a small pure utility (no dependency).
- JSON round-trip: `serializeIntent`/`deserializeIntent` (or document plain-JSON guarantee) — round-trip must preserve payloadHash byte-for-byte.
- `createPaymentIntent(input)` factory per architecture §10: expands to a single `payment` operation, parses asset shorthand (`'XLM'` native; `'CODE:ISSUER'` issued), validates eagerly as pure factory, returns `CreateIntentInput`.

**T1.6 Error types groundwork (`src/errors.ts`)**

- Base `StellarOfflineQueueError` (name, code, retryable flag). Subclasses now: `ValidationError` (with `field`). (Storage/ownership/submission etc. added in their phases.)
- All errors carry no payload echo of secrets; message texts must not interpolate raw XDR or keys.

**T1.7 Export surface**

- Re-export from `src/index.ts`: types (`Intent`, `OperationConfig`, `MemoConfig`, `CreateIntentInput`), `createPaymentIntent`, `ValidationError`. Nothing else yet.

## Files

`src/intent.ts`, `src/errors.ts`, `src/index.ts`, `tests/unit/intent.test.ts`, `tests/unit/errors.test.ts` (small), `tests/helpers/factories.ts` (intent factories for later phases).

## Dependencies

Phase 0; SDK strkey/asset/memo primitives (validated against installed typings); ADR-0001; ADR-0010 (`maxAgeSeconds` default/floor).

## Tests (`tests/unit/intent.test.ts`)

- Validation matrix per field: valid/invalid addresses; asset forms (native, issued, malformed issuer, bad code length); amounts (`'0'`, `'-1'`, `'0.0000001'`, `'1.00000005'`, non-string, `NaN`, overflow); memo limits per type; `maxAgeSeconds` below floor/above cap/non-integer; unsupported op type; >100 ops; metadata non-JSON.
- Normalization: defaults applied; asset shorthand parsing; id auto-generation is UUIDv4-shaped.
- payloadHash stability: same input → same hash; change in each of `sourceAccount`/`operations`(any member)/`memo`/`timeBounds` → different hash; change in `metadata`/`createdAt`/`id` → **same** hash.
- Canonical JSON: key-order independence (same object with different insertion order → same hash).
- Round-trip: serialize → deserialize → payloadHash equal.
- `createPaymentIntent`: produces input that passes validation; flat fields map to one `payment` op.
- Factory + validation run with **zero network** (no adapter in scope).

## Acceptance Criteria

- Every AC test above passes; `payloadHash` is stable across key order; invalid inputs never construct an `Intent`.
- Public exports compile against strict TS with no `any`.
- No network imports in `intent.ts` (only SDK value/type utilities).

## Definition of Done

ACs; contract between validation codes and `errors.ts` documented (JSDoc); intent factories in `tests/helpers` available to later phases; PR merged green.

---

# Phase 2 — State Machine

## Objective

The eleven-state lifecycle (`CREATED` transient; durable `QUEUED`, `READY`, `NEEDS_RETRY`, `SUBMITTING`, `CONFIRMING`, `SUCCESS`, `FAILED`, `EXPIRED`, `INDETERMINATE`) as a **pure** module with the exhaustive transition table from architecture §6.3–6.4.

## Why it exists

The transition table is the contract enforced by store CAS in Phase 3 and consumed by the engine in Phase 7. It must be pure, exhaustive, and tested to the last row before anything depends on it.

## Prerequisites

Phase 0; architecture §6 (all subsections); ADR-0006.

## Tasks & Subtasks

**T2.1 States (`src/state.ts`)**

- `IntentStatus` union with all eleven states; const arrays: `TERMINAL_STATES`, `PERSISTED_STATES`, `TRANSIENT_STATES`, `PRE_SUBMISSION_STATES` (no in-flight hash yet), `IN_FLIGHT_STATES = ['SUBMITTING','CONFIRMING']`, `RETRYABLE_STATES` per ADR-0008 (`QUEUED`, `NEEDS_RETRY` scheduled; `EXPIRED` rebuildable; `FAILED` manual-only).
- JSDoc each state with its semantics from §6.2 (one line each — the "why it exists" column).

**T2.2 Transition table**

- Encode §6.3 as data: `TRANSITIONS: Record<IntentStatus, Partial<Record<IntentStatus, TransitionRule>>>` where `TransitionRule` includes allowed `trigger` labels (e.g. `'claim' | 'janitor-reclaim' | 'write-ahead' | 'submit-ack' | 'transient-failure' | 'verdict' | 'rebuild' | 'manual-retry' | 'deterministic-failure' | 'remove') and flags (`requiresReason`, `attemptsIncrement`).
- Encode every valid row, including: `QUEUED→READY` (claim), `READY→QUEUED` (reclaim), `READY→BUILDING`, `BUILDING→SIGNING`, `SIGNING→SUBMITTING` (write-ahead), `SUBMITTING→CONFIRMING`, `SUBMITTING→NEEDS_RETRY`, `NEEDS_RETRY→SUBMITTING`, `SUBMITTING→FAILED` (structural errors only), `CONFIRMING→SUCCESS|FAILED|EXPIRED|INDETERMINATE`, `EXPIRED→QUEUED` (rebuild, attempts remaining), `FAILED→QUEUED` (manual retry), `QUEUED/NEEDS_RETRY→FAILED` (deterministic failure / cancel per ADR-0011), removal rows (pre-submission only).

**T2.3 Pure transition function**

- `canTransition(from, to, trigger?): { ok: true } | { ok: false; reason: string }` — validates current state, target state, trigger match where required; no I/O, no store.
- `validateTransition(...)` convenience that throws typed `InvalidTransitionError` (add to `errors.ts`).
- Version/timestamp/reason recording are **store/engine responsibilities** (CAS in Phase 3, engine in Phase 7) — the pure module only defines the table; document this split explicitly to avoid accidental re-coupling.

**T2.4 Recovery classification helpers**

- `isReclaimable(entry, now)` (READY + lease expired — input shape defined against `QueueEntry` fields, typed minimally here or in `store/types.ts` to avoid circular imports; choose the latter if cleaner).
- `isInFlight(status)`, `isTerminal(status)`, `isPreSubmission(status)` — pure predicates used by janitor/sweep (Phases 6–7).

**T2.5 Export**

- Re-export status type + table accessors from `index.ts`.

## Files

`src/state.ts`, `src/errors.ts` (add `InvalidTransitionError`), `src/index.ts`, `tests/unit/state.test.ts`.

## Dependencies

Phase 0; architecture §6.3–6.4; ADR-0006; ADR-0008 (retryable classification); ADR-0011 (cancel row).

## Tests (`tests/unit/state.test.ts`) — exhaustive

- **Every valid transition**: iterate `TRANSITIONS`, assert `canTransition` ok for each row with its trigger, and (where required) `requiresReason` flag correctness.
- **Every invalid transition**: iterate the full 11×11 cross product; assert every pair not in the table is rejected — this automatically covers §6.4's named prohibitions (`SUCCESS→anything`, `CONFIRMING→SUBMITTING`, `BUILDING→CONFIRMING`, etc.). Snapshot the accepted pair count and assert it equals the table row count (guards accidental additions).
- Trigger mismatch: a valid pair with wrong trigger is rejected.
- Recovery transitions present: `READY→QUEUED`, `EXPIRED→QUEUED`, `FAILED→QUEUED` (manual).
- Terminal classification: `SUCCESS`, `FAILED`, `INDETERMINATE` are terminal; `EXPIRED` is _not_ unconditionally terminal (attempts-remaining nuance documented and reflected in helpers).
- Predicates: `isInFlight`, `isPreSubmission`, `isReclaimable` truth tables.

## Acceptance Criteria

- Full cross-product test green; table matches §6.3 row-for-row (each row cross-referenced in review).
- `state.ts` imports nothing from store/engine/adapters (purity enforced by lint import rules or a test).

## Definition of Done

ACs; transition table cross-checked against architecture §6.3 line-by-line in PR description; PR merged green.

---

# Phase 3 — Storage Abstraction

## Objective

The `QueueStore` interface and CAS result types exactly per architecture §9.2 / ADR-0003 — plus the shared **contract test suite** that every adapter (memory, sqlite) must pass.

## Why it exists

CAS is the mechanism that makes "no double submission" structural. The interface must be frozen before adapters are written, and the contract suite must exist so adapter phases (4–5) prove parity mechanically rather than by inspection.

## Prerequisites

Phase 2 (statuses/transitions used in signatures); ADR-0003; architecture §5.3, §9.2.

## Tasks & Subtasks

**T3.1 Types (`src/store/types.ts`)**

- `QueueEntry` per architecture §5.3 (intent embedded; `status`, `attemptCount`, `maxAttempts`, `nextAttemptAt`, `backoffAttempts`, `claimedBy?`, `claimExpiresAt`, `lastError?`, `inFlightHashes`, `attempts`, `updatedAt`, `version`).
- `AttemptRecord` per §5.3 (`envelopeHash`, `sequenceNumber`, `submittedAt`, `outcome` union incl. `'UNKNOWN'`, `resultXdr?`).
- `QueueStore` interface per §9.2 verbatim: `insert`, `get`, `claim`, `transition`, `listDue`, `listByState`, `list`, `remove` — with the exact result unions (`{ ok: true; entry } | { ok: false; reason: 'state'|'not-due'|'version'|'missing' }` for claim; `'state'|'version'|'missing'` for transition).
- `remove(id, fromStates, expectedVersion): Promise<boolean>` — store enforces fromStates (CAS delete, pre-submission only per ADR-0011).
- Document in JSDoc: version is a monotonic optimistic-concurrency token incremented on **every** successful mutation; `insert` duplicate id returns existing entry; `transition` must atomically apply `update` with the state change; WAL/atomicity expectations for adapters.

**T3.2 Store error types (`src/errors.ts`)**

- `StoreError` + typed subclasses/wrappers: `DuplicateInsertError` (internal only — adapters resolve duplicates by returning existing), `PayloadMismatchError` (code `payload-mismatch`, engine-raised in Phase 7), `EntryNotFoundError` where non-CAS methods need it.
- Storage failure category code (`storage-error`) with `cause` preservation.

**T3.3 Contract test suite (`tests/store/contract.ts`)**

- Export `runStoreContractTests(name, makeStore: () => Promise<QueueStore> & { close(): Promise<void> })` covering (parameterized; each adapter's test file calls it):
  - insert/get round-trip; duplicate id insert returns existing (and does not mutate version);
  - `get` missing → `undefined`;
  - claim: success from `QUEUED` (sets `READY`, `claimedBy`, `claimExpiresAt = now + leaseMs`, version +1); fail reasons `state` (wrong status incl. `READY` double-claim), `not-due` (`nextAttemptAt > now`), `version` (stale token), `missing`;
  - claim from `NEEDS_RETRY`;
  - transition: success applies update atomically (hash append + status in one write), bumps version, updates `updatedAt`; fail reasons `state`, `version`, `missing`;
  - write-ahead shape: `transition(id, ['SIGNING'], 'SUBMITTING', { inFlightHashes: [...] }, version)` legal; re-running with stale version fails;
  - `listDue` filtering (states + `nextAttemptAt ≤ dueBefore`), ordering by `createdAt` then `id` (deterministic);
  - `listByState` for `{SUBMITTING, CONFIRMING}`;
  - `list` opts (`status`, `account`, `limit`);
  - `remove`: success pre-submission; rejects (returns false / typed reason) when `inFlightHashes` non-empty state (e.g. from `SUBMITTING`), stale version, missing;
  - lease fields: janitor-reclaim transition `READY→QUEUED` clears `claimedBy`/`claimExpiresAt` (via transition update);
  - **restart durability** (adapter-parameterized): for adapters with real persistence (sqlite), close + reopen store and verify entries/state survive; for memory adapter, the test is a no-op variant (documented non-durability per architecture §15.5).

**T3.4 Export**

- Re-export store types from `index.ts`.

## Files

`src/store/types.ts`, `src/errors.ts`, `src/index.ts`, `tests/store/contract.ts` (suite, not a test file itself), `tests/store/types.test.ts` (compile-time shape tests if useful).

## Dependencies

Phase 2; ADR-0003; ADR-0007 (claim/lease semantics baked into signatures); ADR-0011 (remove restrictions).

## Tests

The contract suite itself (T3.3) — it must compile and run with a trivial in-file throwaway fake adapter (never shipped) to prove the suite exercises every method; final validation happens in Phases 4–5.

## Acceptance Criteria

- `QueueStore` signatures match architecture §9.2 exactly (line-by-line cross-check in PR).
- Contract suite compiles and covers every method and every failure reason; a temporary fake adapter passes it.
- Interface has exactly 8 methods; no CRUD-update escape hatch exists (design review checklist).

## Definition of Done

ACs; JSDoc complete on every method; PR merged green.

---

# Phase 4 — Memory Storage

## Objective

`MemoryStore`: a deterministic, correct-by-CAS in-memory reference adapter for tests/dev — explicitly non-durable.

## Why it exists

Fast, deterministic unit substrate for every later phase (engine, ownership, retry, reliability fakes). Its CAS semantics are the executable reference for what SQLite must reproduce.

## Prerequisites

Phase 3 (interface + contract suite).

## Tasks & Subtasks

**T4.1 Implementation (`src/store/memory.ts`)**

- `Map<string, QueueEntry>` storage; per-store async mutex (promise-chain) to serialize mutations within the process (prevents interleaved async read-modify-write even single-process — mirrors ADR-0003 rationale).
- `insert`: clone-on-write (deep-clone entries on read and write so callers can't mutate store state through references — critical for tests); duplicate id → return existing entry.
- `claim`: under mutex, validate status ∈ fromStates, `nextAttemptAt ≤ now`, version match → set `READY` + `claimedBy` + `claimExpiresAt`, version+1. Return typed failure reasons exactly per interface.
- `transition`: under mutex, validate fromStates + version → apply `update` (shallow merge; arrays replaced wholesale), set `updatedAt`, version+1. Note: `inFlightHashes` updates are whole-array replaces carried by the caller (the engine) — document this.
- `listDue`, `listByState`, `list` with deterministic ordering (`createdAt`, then `id`).
- `remove`: CAS on fromStates + version; also reject when status is in-flight (defense-in-depth beyond fromStates).
- Optional constructor clock injection (`now: () => number`) for lease/backoff tests without real sleeps; default `Date.now`.

**T4.2 Export + wiring**

- Export `MemoryStore` from `index.ts` (dev/tests adapter; JSDoc marks non-durable per architecture §15.5).

## Files

`src/store/memory.ts`, `src/index.ts`, `tests/store/memory.test.ts`, `tests/helpers/factories.ts` (entry factories extended).

## Dependencies

Phase 3; contract suite from T3.3.

## Tests (`tests/store/memory.test.ts` = contract suite + memory-specific)

- Run full `runStoreContractTests('MemoryStore', …)`.
- Memory-specific: clone isolation (mutating a returned entry does not affect the store); mutex serialization (fire 50 concurrent transitions on one entry → exactly one wins per version, versions strictly sequential); clock injection drives `claim` not-due/lease-expiry without sleeps.

## Acceptance Criteria

- Contract suite green; concurrency test demonstrates CAS rejects stale versions under interleaving (no lost updates).
- No timers, no network, fully deterministic (same seed → same outcomes).

## Definition of Done

ACs; PR merged green; `MemoryStore` documented as non-durable in JSDoc and README table (README table stub acceptable, finalized Phase 20).

---

# Phase 5 — SQLite Storage

## Objective

`SqliteStore` on `better-sqlite3` (WAL): schema, indexes, constraints, transactional CAS, migrations/versioning — passing the **same** contract suite plus real restart-durability and multi-connection concurrency checks.

## Why it exists

SQLite is the recommended production default (ADR-0003). It must demonstrate the CAS contract survives real persistence, process restarts, and multi-connection interleaving — not just in-memory simulations.

## Prerequisites

Phases 3–4 (interface + reference semantics); ADR-0003 (WAL, durability expectations).

## Tasks & Subtasks

**T5.1 Dependency + file layout**

- Add `better-sqlite3` (runtime dep) + `@types/better-sqlite3`; justification recorded (ADR-0003 names it; native module pinned, lockfile committed).
- `src/store/sqlite.ts` implemented synchronously over better-sqlite3's sync API wrapped in the async interface (sync core removes in-process interleaving risk by construction; document this).

**T5.2 Schema (v1)**

- Table `queue_entries`: `id TEXT PRIMARY KEY`, `version INTEGER NOT NULL`, `status TEXT NOT NULL`, `source_account TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`, `next_attempt_at INTEGER NOT NULL`, `claim_expires_at INTEGER NOT NULL`, `claimed_by TEXT`, `attempt_count INTEGER`, `max_attempts INTEGER`, `backoff_attempts INTEGER`, `last_error_code TEXT`, `last_error_message TEXT`, `last_error_ts INTEGER`, `payload TEXT NOT NULL` (intent JSON), `payload_hash TEXT NOT NULL`, `in_flight_hashes TEXT NOT NULL` (JSON array), `attempts TEXT NOT NULL` (JSON array).
- Indexes: `(status, next_attempt_at)` (due scan), `(status)` (recovery sweep), `(source_account, created_at)` (per-account FIFO + `list(account)`).
- Uniqueness: PK on id (duplicate insert → return existing, matching contract); CHECK constraints where cheap (e.g. `version >= 1`).
- Meta table `store_meta(key, value)`: `schema_version`.

**T5.3 Transactions + CAS**

- All mutations run inside `db.transaction(...)`: read row, verify fromStates + version, write updated row, bump version, commit. WAL mode enabled (`PRAGMA journal_mode=WAL`); `busy_timeout` set (e.g. 5000 ms) — document values.
- Claim/transition/remove mirror MemoryStore semantics exactly (same typed failure reasons).
- `payloadHash` stored denormalized (indexed column) to support future store-level integrity scans without JSON parsing (V1 engine still verifies per §9.4).

**T5.4 Migrations/versioning**

- Embedded migration runner: `store_meta.schema_version` compared against `SCHEMA_VERSION` constant; on open, apply missing migrations in order; refuse (typed error) to open a store written by a **newer** schema version.
- M001 = initial schema. Future migrations appended, never edited.

**T5.5 Lifecycle + options**

- Constructor: `new SqliteStore(path: string | ':memory:', opts?: { busyTimeoutMs?: number; wal?: boolean })`; `close()` flushes and closes; `:memory:` allowed for tests (documented non-durable in that mode).
- Export from `index.ts`.

## Files

`src/store/sqlite.ts`, `src/index.ts`, `package.json` (dep added), `tests/store/sqlite.test.ts`.

## Dependencies

Phases 3–4; `better-sqlite3`; ADR-0003.

## Tests (`tests/store/sqlite.test.ts`)

- Full `runStoreContractTests('SqliteStore', …)` including the **restart-durability variant** (close, reopen same file, assert state).
- SQLite-specific:
  - WAL mode active (`PRAGMA journal_mode` returns `wal`);
  - schema version: fresh DB → M001 applied; opening newer-version DB → typed error;
  - multi-connection interleaving: two `SqliteStore` instances on the same file performing competing claims/transitions → exactly one winner per CAS, no lost updates (loop N iterations);
  - `busy_timeout` behavior under a write lock held by a second connection (claim fails gracefully, no unhandled throw);
  - crash-simulation durability: write entries, `close()` without graceful shutdown of a second connection (kill via `process.exit` in a child process test or `db.close()` omission pattern — document chosen mechanism), reopen → last committed transition visible.

## Acceptance Criteria

- Contract suite green including restart durability.
- Multi-connection CAS test demonstrates exactly-once claim wins across 2 connections (repeated ≥ 50 times).
- Migration runner refuses newer schemas with a typed error.
- Native dep builds on Node 22/24 in CI (CI matrix proves it).

## Definition of Done

ACs; PR documents schema DDL + index rationale; PR merged green.

---

# Phase 6 — Processing Ownership

## Objective

Claims, leases, worker identity, lease refresh, janitor reclamation, and the lost-ownership abort rule (ADR-0007) — implemented as a small module the engine consumes, with the concurrency test matrix proving the invariants.

## Why it exists

Duplicate processing is the double-payment root cause. This phase makes ownership exclusive, time-limited, recoverable, and abort-safe **before** the engine exists, so the engine can only compose correct primitives.

## Prerequisites

Phases 2–5 (states, store, working adapters); ADR-0007; architecture §6.5, §6.7.

## Tasks & Subtasks

**T6.1 Worker identity (`src/engine.ts` groundwork or `src/queue.ts` — decide in phase; files below)**

- `workerId` generation: config-supplied or `worker-<uuidv4>`; carried through claim calls. JSDoc: stable across a process lifetime; not a security identity.

**T6.2 Claim + lease module (`src/ownership.ts`)**

- `claimEntry(store, id, { workerId, leaseMs, now })` → wraps store `claim` from `{QUEUED, NEEDS_RETRY}`; returns typed result; on success the caller holds ownership until lease expiry.
- `refreshLease(store, id, workerId, leaseMs)`: CAS `transition` from `READY` with `claimedBy` match — used by long owner phases (extended in Phase 7); fails on lost ownership (typed `OwnershipLostError`).
- `reclaimExpired(store, now, leaseMs)` (janitor core): `listByState(['READY'])` → for each with `claimExpiresAt < now`, CAS `transition READY→QUEUED` clearing `claimedBy`/`claimExpiresAt`; concurrent reclaims: only version winner succeeds (loser re-reads/skips). Returns reclaimed ids.
- **Never** reclaim `SUBMITTING`/`CONFIRMING` — enforced by only passing `['READY']` to scans + a unit-level guard test (architecture §6.5.3).

**T6.3 Ownership errors (`src/errors.ts`)**

- `OwnershipLostError` (code `ownership-lost`, retryable=false at the owner level — the engine aborts silently per invariant §6.5.5).

**T6.4 Abort discipline helper**

- `withOwnership<T>(claimResult, fn)` convenience: runs `fn` only when ownership is live; any internal `OwnershipLostError`/CAS failure aborts without side effects. (Engine enforces the no-submit-after-loss rule structurally in Phase 7 by checking claim state immediately before the write-ahead transition.)

## Files

`src/ownership.ts`, `src/errors.ts`, `src/index.ts`, `tests/unit/ownership.test.ts`, `tests/store/contract.ts` (extend with ownership-focused cases if not already covered), `tests/helpers/factories.ts`.

## Dependencies

Phases 2–5; ADR-0007; ADR-0010 (`leaseMs` default 60 s, injectable clocks in tests).

## Tests (`tests/unit/ownership.test.ts` + contract additions)

Use `MemoryStore` with injected clock (fast, deterministic) and repeat key scenarios on `SqliteStore` multi-connection:

- two workers claim the same id → exactly one `ok:true`, other gets `reason:'state'` (or `version` if raced between read and claim);
- expired lease: janitor reclaims to `QUEUED`, clearing owner fields; entry re-claimable;
- active lease: janitor leaves it untouched (live claims never stolen);
- worker loses ownership: simulate reclaim by janitor, then stale worker's `transition`/`refreshLease` fails with `version`/`ownership-lost`; assert **no submit-side effects possible** (this is API-level here: assert transition result is not ok — the full no-submit proof lands in Phase 13/19);
- process crash simulation: claim entry, "crash" (abandon in-memory worker), advance clock past `leaseMs`, janitor reclaims, second worker processes — covered as state assertions;
- version conflict: two concurrent janitors race the same reclaim → exactly one success;
- never-reclaim guard: entries in `SUBMITTING`/`CONFIRMING` are never touched by `reclaimExpired` even when `claimExpiresAt` is stale (explicit regression test).

## Acceptance Criteria

- All ownership tests pass on both adapters (memory + sqlite multi-connection for the two-worker and janitor-race cases at minimum).
- Invariant test exists: a worker that lost ownership cannot perform any successful store mutation on that entry.

## Definition of Done

ACs; ADR-0007 rules each mapped to a named test (mapping list in PR description); PR merged green.

---

# Phase 7 — Queue Processor

## Objective

The engine pipeline (`src/engine.ts`) executing **one claimed entry** through build → sign → write-ahead → submit → confirm, and the `OfflineQueue.process()` sweep (`src/queue.ts`) that discovers due entries, enforces per-account single-writer ordering, and orchestrates recovery — with network access abstracted behind interfaces whose **fakes** drive this phase (real adapters come in Phases 10–12).

## Why it exists

This is the state-machine executor: it turns stored intents into submitted transactions or honest failures while structurally forbidding double processing and out-of-order side effects.

## Prerequisites

Phases 1–6; architecture §4.2, §6.5–6.7, §7.1, §8.2; ADR-0005 (flush-time building), ADR-0007 (ownership), ADR-0010 (defaults).

## Tasks & Subtasks

**T7.1 Abstractions for this phase (`src/adapters/types.ts`, `src/signer.ts`, `src/builder.ts` minimal seams)**

- Define `StellarAdapter` interface **shape** needed by the engine now (per ADR-0009): `loadAccount(accountId): Promise<AccountState>`; `submitTransaction(tx): Promise<SubmitResult>`; `getTransactionStatus(hash): Promise<TxStatus>` — with normalized `SubmitResult` (`status: 'PENDING'|'DUPLICATE'|'TRY_AGAIN_LATER'|'ERROR'|'TIMEOUT'|'UNKNOWN'`, `hash?`, `latestLedger`, `latestLedgerCloseTime`, error detail incl. normalized op-result codes) and `TxStatus` (`status: 'SUCCESS'|'FAILED'|'NOT_FOUND'`, `resultXdr?`, `ledger?`, `latestLedgerCloseTime`, `oldestLedger`). _(Concrete SDK adapters implemented Phase 10–12; fakes now.)_
- Define `Signer` interface per ADR-0002 (`sign(transaction, context)`).
- Define `AccountState` (`sequence: string`, `lastModifiedTime?`), `Transaction`-ish minimal type for the builder seam — use SDK `Transaction` type for real typing (SDK is a direct dependency; no invented types).
- `builder.ts`: minimal `buildTransaction(intent, accountState, config) → Transaction` wrapper around SDK `TransactionBuilder` (sequence = account.sequence + 1 semantics via SDK `Account`, fee, `timeBounds` from `flushTime + maxAgeSeconds`, memo, operations). Full builder hardening is Phase 10 — enough here to drive the pipeline, using the SDK directly.

**T7.2 Engine pipeline (`src/engine.ts`)**

- `processEntry(deps, entry, workerCtx)` steps:
  1. **Claim** via `claimEntry` (ownership from Phase 6).
  2. **Payload integrity**: recompute `payloadHash`; mismatch → transition `READY→FAILED` code `payload-mismatch` (never rebuild a tampered intent — architecture §9.4).
  3. **BUILDING (transient)**: `adapter.loadAccount(sourceAccount)`; `buildTransaction`; on account-not-found → `FAILED` (`tx_no_account` path per architecture §15.1). On build validation error → `FAILED` (deterministic). Refresh lease before/after long steps.
  4. **SIGNING (transient)**: invoke `signer.sign(tx, { intentId, networkPassphrase })`; signer throw/reject → `READY→FAILED` code `signer-rejected` (no side effects — deterministic per ADR-0002). Verify the signed transaction's hash is computable (`tx.hash()`); malformed signing result (not a Transaction / wrong network) → `FAILED` `signer-malformed`.
  5. **Write-ahead (atomic)**: `transition(id, ['READY'], 'SUBMITTING', { inFlightHashes: append(hash), attempts: append(AttemptRecord{envelopeHash, sequenceNumber, submittedAt, outcome:'UNKNOWN'}) }, version)` — **single store call before any network submission** (invariant §6.5.1). If CAS fails (lost ownership) → **abort without submitting**.
  6. **Submit**: `adapter.submitTransaction(signedTx)`. Classification per architecture §8.2:
     - `PENDING`/`DUPLICATE`/`UNKNOWN`(ambiguous ack) → `SUBMITTING→CONFIRMING`;
     - `TRY_AGAIN_LATER`/transport errors with attempts+bounds remaining → `SUBMITTING→NEEDS_RETRY` (backoff set; identical envelope on resume — resume path re-submits the journaled hash's envelope reconstruction rule in Phase 13; V1 rule: NEEDS_RETRY holds the signed envelope only in memory for this worker; after restart the entry is reconciled, never rebuilt — §8.1 Case 3);
     - structural `ERROR` (`tx_bad_auth`, malformed) → `SUBMITTING→FAILED` (provably never included);
     - `ERROR` `tx_too_late` → `CONFIRMING→EXPIRED` path (via verdict) — classify now as expired;
     - `ERROR` other (`tx_insufficient_balance`, `tx_no_account`, etc.) → `SUBMITTING→CONFIRMING` (poll the hash — §8.2 rule of thumb);
     - `tx_bad_seq` → §7.3 decision table (implemented with adapter `loadAccount` + compare; outcomes map to CONFIRMING/NEEDS_RETRY/EXPIRED per table).
  7. **Confirm**: `CONFIRMING` polling inside the same sweep: `adapter.getTransactionStatus(hash)` → verdict transitions (`SUCCESS`/`FAILED`(attach resultXdr)/`EXPIRED`/`INDETERMINATE` per §8.3); `NOT_FOUND` stays `CONFIRMING` while in bounds/retention (bounded polls per sweep — `RECONCILE_BATCH_LIMIT` awareness; full verdict logic refined in Phase 14 — this phase implements the naive-but-correct subset with fakes).
  8. Emit transitions via the events module (Phase 17 seam — minimal emitter now).
- Lost-ownership check immediately before write-ahead and before submit: any CAS failure aborts everything without network calls (invariant §6.5.5).

**T7.3 Sweep orchestration (`src/queue.ts`)**

- `OfflineQueue` class implementing the public API per architecture §10 (with `cancel` per ADR-0011):
  - `addIntent` (validate → `insert` with initial `QUEUED` state, defaults from ADR-0010; duplicate id → return existing);
  - `getIntent`, `list`;
  - `process()`: janitor run → recovery sweep (see below) → claim up to `concurrency` due entries, **per-account single-writer** (never two in-flight for one `sourceAccount`; FIFO by `createdAt`), process entries (parallel across accounts, sequential within account), return `ProcessSummary` (claimed/succeeded/failed/retried/reclaimed counts);
  - `retry(id)` per ADR-0008 (state check FAILED/attempts-exhausted EXPIRED → QUEUED, `nextAttemptAt=now`, `backoffAttempts=0`; `AttemptsExhaustedError` past budget) — full semantics refined Phase 8;
  - `cancel(id)` per ADR-0011; `remove(id)` per §9.2;
  - `reconcile(id?)` minimal now (recovery sweep), completed Phase 14;
  - `start(intervalMs)/stop()` polling loop (ADR-0010: 5 s default) — timer owns no hidden work beyond calling `process()`;
  - constructor config validation (typed errors; defaults per ADR-0010).
- **Recovery sweep on `process()`/`reconcile()` start** (§8.1 Case 3): `SUBMITTING`/`CONFIRMING` entries → reconcile journaled hashes (verdict logic subset); `EXPIRED` with attempts remaining → `QUEUED` (rebuild); `NEEDS_RETRY` → resume on schedule; `READY` with expired lease already handled by janitor.
- Concurrency inside one process: `concurrency` workers with per-account serialization; safe concurrent `process()` calls (CAS protects).

**T7.4 ProcessSummary + config types**

- `ProcessSummary` shape; `OfflineQueueConfig` per architecture §10 with defaults wired from ADR-0010.

## Files

`src/engine.ts`, `src/queue.ts`, `src/builder.ts`, `src/signer.ts`, `src/adapters/types.ts`, `src/backoff.ts`, `src/events.ts` (minimal), `src/errors.ts`, `src/index.ts`, `tests/unit/engine.test.ts`, `tests/unit/queue-sweep.test.ts`, `tests/unit/backoff.test.ts`, `tests/helpers/fake-adapter.ts`, `tests/helpers/fake-signer.ts`.

## Dependencies

Phases 1–6; SDK `TransactionBuilder`/`Account`/`Transaction` (typed, verified against installed SDK); ADR-0002/0005/0007/0010/0011.

## Tests

- `tests/unit/backoff.test.ts`: schedule math — base/cap/jitter bounds (`delay ≤ cap`, monotone growth in expectation), `nextAttemptAt` set, budget decrement points. Deterministic via seeded random injection (make jitter seed injectable).
- `tests/unit/engine.test.ts` (fake adapter + fake signer): happy path end-to-end (QUEUED→…→SUCCESS with persisted AttemptRecord + journaled hash before submit — assert store state _at_ submit time via fake adapter hook); signer rejection → FAILED `signer-rejected` with **no** write-ahead/submit; malformed signer result → FAILED `signer-malformed`; payload-mismatch → FAILED `payload-mismatch` (tamper stored intent); structural submit error (`tx_bad_auth`) → FAILED; ambiguous error → CONFIRMING; `TRY_AGAIN_LATER` → NEEDS_RETRY with backoff then identical-envelope resubmit; lost ownership before write-ahead → no submit (fake adapter records zero submissions).
- `tests/unit/queue-sweep.test.ts`: two entries same account → processed strictly sequentially (no interleaving; assert adapter call order); different accounts → may interleave; concurrent `process()` ×2 → each entry processed once (CAS), summary counts consistent; janitor reclaims expired-lease READY before claiming; recovery sweep reconciles a pre-seeded SUBMITTING entry (with journaled hash) instead of rebuilding — assert fake adapter got `getTransactionStatus(hash)`, **not** a new submission; `retry(id)` from FAILED works / from SUCCESS, INDETERMINATE, QUEUED, READY throws typed errors; `cancel()`/`remove()` per ADR-0011 matrix.
- Fakes: `tests/helpers/fake-adapter.ts` (scriptable responses, submission log with hashes, failure injection points at: before-submit, after-send-before-response, timeout) and `tests/helpers/fake-signer.ts` (success/reject/malformed).

## Acceptance Criteria

- All engine/sweep tests pass with fakes; no test sleeps in real time (injected clocks/timers).
- The write-ahead call is observably atomic and precedes `submitTransaction` in every recorded trace (fake adapter records call order).
- Per-account serialization holds under concurrent sweeps in tests.
- `process()` performs recovery-before-claim every time.

## Definition of Done

ACs; every architecture §6.3 trigger row exercised by at least one test; PR merged green. _(True at-most-once proof is Phase 19; here correctness is per-scenario.)_

---

# Phase 8 — Retry and Attempt Model

## Objective

The complete retry policy (ADR-0008): automatic identical-envelope resubmission and rebuild-on-expiry inside the pipeline, budget accounting (`attemptCount` = build cycles), and manual `retry(id)` with `AttemptsExhaustedError` — replacing Phase 7's minimal versions.

## Why it exists

Retry is where double payments are born. ADR-0008's distinctions (identical resubmit vs rebuild; automatic vs manual; budget) must be exact and exhaustively tested.

## Prerequisites

Phase 7 engine/sweep; ADR-0008; ADR-0010 (backoff defaults, `maxAttempts=5`).

## Tasks & Subtasks

**T8.1 Attempt accounting**

- Define **build cycle** = one write-ahead transition (one `AttemptRecord` appended). `attemptCount` increments only there (identical-envelope resubmissions within `NEEDS_RETRY⇄SUBMITTING` do **not** create new AttemptRecords — same envelope/hash; verify against ADR-0008 and document in code).
- Budget checks: automatic rebuild (`CONFIRMING→EXPIRED→QUEUED`) only if `attemptCount < maxAttempts`, else `EXPIRED` becomes terminal; budget-exhausted `EXPIRED` remains manual-retryable per ADR-0008.
- `backoffAttempts` (consecutive transient failures) resets on any non-transient progress; drives §6.6 schedule.

**T8.2 Manual retry (`queue.retry(id)`)**

- Allowed from: `FAILED`, and `EXPIRED` (both attempts-remaining and attempts-exhausted — manual retry always allowed from EXPIRED while a _new_ budget consideration applies; **resolve precisely per ADR-0008**: manual retry permitted only while `attemptCount < maxAttempts`, else `AttemptsExhaustedError`).
- Effect: CAS `FAILED/EXPIRED → QUEUED`, `nextAttemptAt = now`, `backoffAttempts = 0`; creates **no** AttemptRecord (the next build cycle does); emits transition event.
- Forbidden states → typed `InvalidRetryStateError` (SUCCESS, INDETERMINATE, SUBMITTING, CONFIRMING, QUEUED, NEEDS_RETRY, READY).
- Idempotency note: `retry()` on an already-QUEUED entry (raced) → typed error or no-op-with-entry? **Decide: typed error** (explicit > silent).

**T8.3 Automatic paths verification (align engine)**

- In-bounds resubmit loop bounded by both `maxAttempts` cycle budget and `maxAgeSeconds` — whichever first sends entry to `CONFIRMING` (poll) or `EXPIRED` (rebuild) (§6.6).
- `NEEDS_RETRY` resume after restart: entry remains resubmit-eligible only if its journaled envelope can still be identically resubmitted; after restart the engine cannot hold the signed envelope — so the resume rule is: reconcile the journaled hash first (Phase 14 full logic); if `NOT_FOUND` + in bounds → **rebuild-identical** is impossible without the original signatures... **Resolution (design note, must be implemented as specified):** identical-envelope resubmission across a worker boundary is achieved by **rebuilding the exact same envelope deterministically** — the build is a pure function of `(intent, accountSequence, fee, maxTime)`. On resume within bounds, the engine reloads the account; if `account.seq + 1 == journaledSequence`, it rebuilds with the **same sequence and same maxTime** (recomputed deterministically from the AttemptRecord's recorded flush parameters — record `maxTime` and `fee` on the AttemptRecord in this phase to make rebuilds byte-identical), re-signs via the signer, and the envelope hash must match the journaled hash (assert; mismatch → `FAILED` `payload-mismatch`-style `envelope-drift` + do not submit). This preserves "identical envelope" across restarts without persisting signatures.
- Update `AttemptRecord` type: add `maxTime: number`, `fee: string` (needed for deterministic identical rebuild). Contract-suite impact documented.

**T8.4 Errors**

- `AttemptsExhaustedError`, `InvalidRetryStateError` in `errors.ts` with machine-readable current state.

## Files

`src/engine.ts`, `src/queue.ts`, `src/store/types.ts` (AttemptRecord extension), `src/errors.ts`, `src/index.ts`, store contract suite (AttemptRecord field additions), `tests/unit/retry.test.ts`.

## Dependencies

Phase 7; ADR-0008; ADR-0010; contract suite update (Phase 3 file).

## Tests (`tests/unit/retry.test.ts`)

- successful manual retry: FAILED→QUEUED with `nextAttemptAt=now`, `backoffAttempts=0`, then processes to SUCCESS (fake adapter);
- exhausted: `maxAttempts=2` → after 2 failed build cycles `retry()` throws `AttemptsExhaustedError`;
- retry from allowed states (FAILED, EXPIRED-exhausted) and forbidden states (each other state asserted);
- automatic identical-envelope resubmission: TRY_AGAIN_LATER → NEEDS_RETRY → resubmit **same hash** (fake adapter asserts submission hash equality; no new AttemptRecord);
- rebuild on expiry increments `attemptCount` and journals a **new** AttemptRecord (new hash, fresh sequence);
- budget interplay: `maxAgeSeconds` short → loop ends via expiry rebuild before `maxAttempts`; the other ordering too;
- deterministic identical rebuild across "restart": pre-seed SUBMITTING entry with journaled AttemptRecord (sequence/maxTime/fee), run new queue instance → rebuilt envelope hash equals journaled hash (fake signer signs deterministically); assert adapter received identical envelope; assert no submission if rebuild hash ≠ journaled hash (`envelope-drift` FAILED path);
- `retry()` does not create AttemptRecord directly (attempt appended only at write-ahead).

## Acceptance Criteria

- All retry tests pass; ADR-0008 tables each covered by named tests (mapping in PR).
- AttemptRecord extension is backward-compatible within the working tree (contract suite updated everywhere at once).

## Definition of Done

ACs; "attempt" definition documented in code + docs/api.md stub; PR merged green.

---

# Phase 9 — Idempotency

## Objective

End-to-end idempotency guarantees: duplicate `addIntent` returns the existing entry; the at-most-once invariant (§6.5.2 — no new envelope while any journaled hash is unresolved) is enforced structurally; repeated `process()` and concurrent workers cannot double-apply.

## Why it exists

Idempotency is the product's core promise ("exactly one on-chain application per intent that reaches SUCCESS"). This phase assembles and _proves_ the pieces from Phases 3–8 into the invariant.

## Prerequisites

Phases 3–8; architecture §5.3 (idempotency fields), §6.5, §8.1; ADR-0004.

## Tasks & Subtasks

**T9.1 Structural enforcement (engine)**

- Central guard `assertNoUnresolvedInFlight(entry)` invoked at every build site: a new envelope may be built only when every hash in `inFlightHashes` has a resolved outcome in `attempts` (`SUCCESS`/`FAILED`/`EXPIRED`) — `UNKNOWN`/`INDETERMINATE` block building. Violation → typed `InFlightUnresolvedError` (fail-safe: refuse, never submit).
- `addIntent` duplicate-id semantics confirmed (insert returns existing; assert returned entry matches stored version).

**T9.2 Restart + repeated-processing scenarios (engine/queue hardening)**

- Repeated `process()` with no due entries → no-op summary, no state churn (version stable).
- `reconcile()` + `process()` ordering: recovery-before-claim maintained.
- Multi-worker: entry claimed by A; B's claim fails; B proceeds to other entries (no busy-loop on conflicts — backoff or skip logic; implement skip + summary count).

**T9.3 Response-loss handling seam**

- Fake adapter "accept then throw" mode: submission reaches network, response lost → entry SUBMITTING with journaled hash → sweep reconciles hash (Phase 7 subset verdict) → **no rebuild** while unresolved (assert `InFlightUnresolvedError` cannot be hit because verdict resolves first; the full retention-window case completes in Phase 14).

**T9.4 Documentation of invariants in code**

- Each invariant (write-ahead, no-rebuild-while-in-flight, CAS-only mutation, per-account single-writer) asserted in one named unit test referenced from a checklist comment in `src/engine.ts`.

## Files

`src/engine.ts`, `src/queue.ts`, `src/errors.ts`, `src/index.ts`, `tests/unit/idempotency.test.ts`, updates to `tests/helpers/fake-adapter.ts` (accept-then-throw mode).

## Dependencies

Phases 3–8; ADR-0003/0004/0007/0008.

## Tests (`tests/unit/idempotency.test.ts`)

- duplicate enqueue: same id twice → same entry object/state, version unchanged, only one store record;
- duplicate processing: run `process()` to completion twice → second is a no-op; adapter submission log shows exactly one envelope;
- concurrent `process()` ×N (N=5) on one due entry → exactly one submission total (fake adapter log), others reported as skipped/conflicted;
- application restart: serialize store (memory adapter via snapshot or sqlite file), create new queue instance, `process()` → resolution continues from journaled hash, no second envelope;
- repeated `process()` while entry in NEEDS_RETRY → resubmission only after `nextAttemptAt` passes (injected clock), still same envelope hash;
- response loss: accept-then-throw → journaled hash exists, sweep polls hash, no rebuild emitted, verdict lands when fake adapter returns SUCCESS for that hash;
- same intent, multiple attempts: simulate EXPIRED → rebuild → SUCCESS; assert exactly one hash reached SUCCESS in adapter log and `attempts[]` shows the audit trail.

## Acceptance Criteria

- All idempotency tests pass; the four invariant-checklist tests exist and are named in `src/engine.ts`.
- No scenario in the suite produced two distinct submitted envelopes with unresolved first hash.

## Definition of Done

ACs; invariant checklist comment in engine merged; PR merged green. _(Full adversarial proof suite = Phase 19.)_

---

# Phase 10 — Stellar Transaction Builder

## Objective

Production-grade `builder.ts`: intent + fresh account state → unsigned SDK `Transaction`, with sequence acquisition, fee configuration, relative-time-bound resolution, operation mapping for all supported ops, and pre-submission verification (payload-hash check + built-transaction introspection). Real SDK, still no network submission (adapter `loadAccount` is the only network touch).

## Why it exists

Envelope construction is where Stellar correctness lives (sequence at apply time, bounds at flush time). It must be isolated, pure-ish, and exhaustively tested before signing/submission phases rely on it.

## Prerequisites

Phases 1, 7; SDK `@stellar/stellar-sdk@^17` installed; ADR-0005; architecture §4.4, §7.1–7.2.

## Tasks & Subtasks

**T10.1 Operation mapping (complete)**

- Map every `OperationConfig` variant (§5.2 list) to the SDK `Operation.<op>()` call with exact field names — **verify each against the installed SDK typings** (`Operation.payment`, `createAccount`, `pathPaymentStrictSend/Receive`, `changeTrust`, `manageSellOffer`, `manageBuyOffer`, `setOptions` subset incl. thresholds/inflationDest/homeDomain/signer).
- Unsupported fields silently dropped? **No** — unknown/extra fields must be rejected at validation (Phase 1) and asserted here (build-time invariant check).
- Asset handling: convert `AssetLike` (`'XLM'` | `'CODE:ISSUER'` | structured) → SDK `Asset.native()`/`new Asset(code, issuer)`; memo config → SDK `Memo.text/id/hash/return`.

**T10.2 Sequence + account handling**

- `AccountState.sequence` (string, 64-bit) → SDK `Account(sourceAccount, sequence)`; `TransactionBuilder` with `fee` (stroops string; default SDK `BASE_FEE` per ADR-0010), `networkPassphrase` from config.
- Time bounds: `timeBounds: { minTime: 0, maxTime: flushTime + maxAgeSeconds }` — flushTime supplied by the engine (Date.now at build); ledger-time correctness of _verdicts_ unaffected (uses adapter ledger times).
- Sequence-number unit edge cases: '0' sequence, max-int64 sequences (string math sanity), malformed sequence → typed error (never silently build).

**T10.3 Verification hooks**

- `verifyBuiltTransaction(tx, intent, params)`: asserts tx source, fee, memo, timeBounds.maxTime, op count/types match the intent and build params; `tx.hash()` computable. Used by engine before write-ahead.
- Deterministic-build helper (for Phase 8's identical-rebuild): `buildDeterministic(intent, { sequence, fee, maxTime })` — pure, no clock reads; hash-stable.

**T10.4 Fee + config validation**

- `baseFee` from config; reject fee below network minimum only at submission (network rule) — but validate ≥ 100 stroops and integer-string at build; document.
- `concurrency`/lease interplay not builder's concern (documented boundary).

## Files

`src/builder.ts`, `src/intent.ts` (AssetLike type if not yet), `src/index.ts`, `tests/unit/builder.test.ts`.

## Dependencies

Phases 1, 7; SDK TransactionBuilder/Operations/Memo/Asset; ADR-0005; ADR-0010.

## Tests (`tests/unit/builder.test.ts`) — no network; SDK only

- per-operation mapping: each supported op builds a tx whose XDR contains the expected operation (decode via SDK `Transaction` from XDR to assert fields);
- sequence: built tx sequence = provided account sequence + 1 (string-safe for large values);
- time bounds: `maxTime = flushTime + maxAgeSeconds` exactly; `minTime = 0`;
- memo mapping per type;
- fee: applied exactly; invalid fee strings rejected;
- determinism: `buildDeterministic` same inputs → byte-identical XDR (hence same hash) — assert twice;
- verification hook catches: wrong source, wrong bounds, op drift;
- unsupported op type rejected (defense-in-depth behind Phase 1).

## Acceptance Criteria

- All builder tests pass; every supported operation exercised; no invented SDK APIs (each SDK call cross-checked in PR description against installed typings).

## Definition of Done

ACs; SDK-version note recorded (v17.0.1 at implementation) in the module header; PR merged green.

---

# Phase 11 — Signer Abstraction

## Objective

The `Signer` interface consumption boundary hardened: signing occurs at exactly one lifecycle point, failures are deterministic, and no secret material can reach storage/logs (ADR-0002).

## Why it exists

The security guarantee "keys are structurally absent" must be tested, not asserted.

## Prerequisites

Phases 7, 10 (pipeline + real transactions); ADR-0002.

## Tasks & Subtasks

**T11.1 Interface finalization (`src/signer.ts`)**

- `Signer.sign(transaction: Transaction, context: { intentId: string; networkPassphrase: string }): Promise<Transaction>` exactly per ADR-0002.
- Provide `keypairSigner(secret)` **as an application-facing example only** — placed in `examples/` (not exported from `index.ts`), documented "app owns the secret".

**T11.2 Engine boundary enforcement**

- Signing invoked only in the SIGNING phase (assert by code structure: no other call sites; grep-able single call).
- Signed-result validation: returned object is an SDK `Transaction`; `tx.hash()` equals the unsigned hash (signing must not alter the transaction body — if it does, the signed tx's own hash is used and the unsigned hash journal is corrected **before** write-ahead; document the rule: journal the hash of what will be submitted); wrong-network signing is _not_ detected here (no network) — surfaces as `tx_bad_auth`/`tx_bad_auth_extra_signers` at submission → FAILED (documented, per ADR-0002).

**T11.3 Secret-leak prevention tests**

- Storage scan test: serialize every store record type (`QueueEntry`, `AttemptRecord`, events payloads, error messages) after a full lifecycle with a signer that embeds a sentinel secret string — assert the sentinel appears nowhere in store JSON, error messages, or event payloads.
- Log redaction: run with the default logging path (if any logging exists; else assert no console output from library code via a console spy during a full lifecycle).

## Files

`src/signer.ts`, `src/engine.ts` (boundary), `examples/keypair-signer.ts` (example module), `src/index.ts`, `tests/unit/signer.test.ts`, `tests/unit/secret-leak.test.ts`.

## Dependencies

Phases 7, 10; ADR-0002.

## Tests (`tests/unit/signer.test.ts`, `tests/unit/secret-leak.test.ts`)

- successful signing → pipeline proceeds to write-ahead with the signed hash;
- signer throws/rejects → `READY→FAILED` code `signer-rejected`, **zero** adapter submissions (fake adapter log empty), entry remains retryable via manual retry;
- signer returns malformed (non-Transaction) → FAILED `signer-malformed`, no submission;
- signer returns a _different_ transaction (tampered) → hash-correction rule asserted (journal matches submitted hash) and submission proceeds against the returned tx;
- single-call-site: structural test (exported helper list) or code-lint rule asserting `signer.sign` referenced exactly once in `src/`;
- secret-leak scans (T11.3) green.

## Acceptance Criteria

- All signer/leak tests pass; `sign` has exactly one call site; no secret sentinel in any persisted/logged surface.

## Definition of Done

ACs; example signer documented as app-owned; PR merged green.

---

# Phase 12 — Stellar RPC Adapter

## Objective

`RpcAdapter` (primary, per ADR-0009) over the SDK's `rpc.Server`: normalized `SubmitResult`/`TxStatus`/`AccountState`, typed transient-vs-terminal errors, and the ledger-time/retention context the verdict engine requires. `HorizonAdapter` secondary with documented verdict-quality caveats.

## Why it exists

The engine and reconciliation must never parse transport-specific responses (ADR-0009). This adapter is the only module allowed to import an SDK network client.

## Prerequisites

Phases 7 (interface shape), 10 (SDK verified); ADR-0009.

## Tasks & Subtasks

**T12.1 RpcAdapter (`src/adapters/rpc.ts`)**

- Constructor takes an RPC server URL (and optional client injection for tests); wraps `rpc.Server`.
- `loadAccount(accountId)` → `getAccount` → `AccountState { sequence, lastModifiedTime? }`; account missing → typed `AccountMissingError` (engine maps to deterministic `FAILED` per architecture §15.1).
- `submitTransaction(tx)` → `sendTransaction`: map `PENDING | DUPLICATE | TRY_AGAIN_LATER | ERROR` to normalized statuses; `ERROR` includes the decoded result XDR codes (`tx_bad_auth`, `tx_bad_seq`, `tx_too_late`, `tx_insufficient_balance`, `tx_insufficient_fee`, `tx_no_account`, malformed); carry `latestLedger`, `latestLedgerCloseTime`.
- `getTransactionStatus(hash)` → `getTransaction`: map `SUCCESS | FAILED | NOT_FOUND`; carry `resultXdr?`, `ledger?`, `latestLedger`, `latestLedgerCloseTime`, `oldestLedger` (retention context — required by verdicts).
- Transport failures: HTTP 5xx/network/429 → typed `AdapterTransientError` (retryable); timeout → `AdapterTimeoutError` (ambiguous — engine classifies `UNKNOWN`); never throw raw SDK errors across the boundary.

**T12.2 HorizonAdapter (`src/adapters/horizon.ts`)**

- Same interface over Horizon: submit 504 → `TIMEOUT` (ambiguous); `getTransaction` 404 → `NOT_FOUND` with **no** retention context (`oldestLedger` unavailable → retention-based `INDETERMINATE` cannot be produced; documented ADR-0009 caveat).
- JSDoc marks it secondary; primary recommended.

**T12.3 Adapter error taxonomy (`src/errors.ts`, `src/adapters/types.ts`)**

- `AdapterError` base; `AdapterTransientError`, `AdapterTimeoutError`, `AdapterPermanentError` (structural); machine-readable `code`, preserved `cause`; no raw XDR in messages.

**T12.4 Capability declaration**

- `adapters/types.ts` documents per-adapter capabilities (retention context present or not) so the verdict engine behaves honestly per transport.

## Files

`src/adapters/rpc.ts`, `src/adapters/horizon.ts`, `src/adapters/types.ts`, `src/errors.ts`, `src/index.ts`, `tests/unit/adapter-rpc.test.ts`, `tests/unit/adapter-horizon.test.ts`.

## Dependencies

Phases 7, 10; SDK `rpc.Server`/`Horizon.Server` typings verified against installed version; ADR-0009.

## Tests

- Unit with a scriptable fake client (injected): every normalized submit status; every error-code mapping (`tx_bad_auth`, `tx_bad_seq`, `tx_too_late`, `tx_insufficient_balance`, …); timeout → `AdapterTimeoutError`; 429/5xx → `AdapterTransientError`; `getTransaction` SUCCESS/FAILED/NOT_FOUND with ledger context fields populated;
- malformed/missing response fields → typed errors (no raw throw);
- Horizon: 404 → `NOT_FOUND` without retention fields; 504 → `TIMEOUT`;
- import-boundary test/lint rule: nothing outside `src/adapters/` imports SDK network clients.

## Acceptance Criteria

- All adapter tests pass; every normalized status/error code consumed by §8.2 classification is produced by tests; boundary rule enforced.

## Definition of Done

ACs; capability table documented; PR merged green.

---

# Phase 13 — Submission Safety

## Objective

The write-ahead submission protocol proven at the storage boundary: `SUBMITTING` + envelope hash journaled in one atomic store operation **before** any network call, with the crash-point matrix tested end-to-end (architecture §6.5.1, §8.1).

## Why it exists

"Envelope possibly sent, no record of it" must be structurally impossible. This phase converts the engine's write-ahead call into a verified durability contract.

## Prerequisites

Phases 5, 7, 8 (deterministic identical rebuild), 12; architecture §6.5, §8.1–8.2.

## Tasks & Subtasks

**T13.1 Durability semantics (`src/store/sqlite.ts`)**

- Verify WAL defaults; document `synchronous=NORMAL` (crash-safe against process death) vs the power-loss guarantee of `synchronous=FULL`; expose a constructor opt-in for FULL with the trade-off documented (additive config).
- Integration-level test: simulated abort (child-process `process.exit`) immediately after the write-ahead transition → reopen → journaled hash readable.

**T13.2 Crash-point matrix (`tests/reliability/crash-matrix.test.ts`)**
Script every crash instant (fake adapter + injected clocks; SQLite child-process for the persistence-critical points):

1. crash before write-ahead → entry `READY` (lease) → janitor reclaims → reprocessed from scratch; adapter log shows zero submissions;
2. crash after write-ahead, before submit → `SUBMITTING` + journaled hash → restart → reconcile (`NOT_FOUND` + in bounds → identical-envelope resubmit; hash equality asserted) → settles once;
3. crash during submit (accepted, no response) → same recovery path; fake chain shows inclusion;
4. crash after submit success, before verdict → reconcile → `SUCCESS`; no rebuild;
5. response lost after successful submission (timeout classification) → same as (4).
   Per scenario assert: at most one successful on-chain application in the fake chain; no new envelope built while any journaled hash is unresolved.

**T13.3 Ordering assertions**

- Recorded-call-order test (store spy + adapter log): write-ahead strictly precedes `submitTransaction` in every trace.

## Files

`src/store/sqlite.ts` (sync-mode opt-in + docs), `tests/reliability/crash-matrix.test.ts`, `tests/helpers/fake-adapter.ts` (crash injection points).

## Dependencies

Phases 5, 7, 8, 9, 12.

## Tests

The crash matrix (T13.2) + durability test (T13.1) — they are the deliverable.

## Acceptance Criteria

- All five crash scenarios pass (memory store; the two persistence-critical ones also on SQLite via child-process abort); ordering proof universal.

## Definition of Done

ACs; sync-mode trade-off documented; PR merged green.

---

# Phase 14 — Reconciliation Engine

## Objective

Complete `src/reconciliation.ts`: the pure `verdict()` function (§8.3), `NOT_FOUND` disambiguation, retention-window math, the `tx_bad_seq` decision table (§7.3), multi-hash final-verdict rule, and the full recovery sweep — with the exhaustive table-driven suite (ADR-0004).

## Why it exists

This is the project's differentiator: honest verdicts (`SUCCESS | FAILED | EXPIRED | INDETERMINATE`), never guessed (architecture §2.3.3). It must be a pure, exhaustively tested decision procedure.

## Prerequisites

Phases 7, 12 (adapter context fields); architecture §7.3, §8; ADR-0004, ADR-0009.

## Tasks & Subtasks

**T14.1 Pure verdict function**

- `verdict(input)` over `{ txStatus: 'SUCCESS'|'FAILED'|'NOT_FOUND', latestLedgerCloseTime, oldestLedger?, maxTime, inclusionWindow }` → `SUCCESS | FAILED | EXPIRED | INDETERMINATE | PENDING(continue)` with machine-readable `reason`.
- Check order per §8.3: SUCCESS → SUCCESS; FAILED → FAILED; ledger time > maxTime → EXPIRED; retention closure → INDETERMINATE; still in bounds → PENDING (poll / resubmit identical). No adapter calls, no device clock.

**T14.2 NOT_FOUND disambiguation (§8.1 Case 2)**

- The four meanings encoded as table rows: never-accepted (bounds passed → EXPIRED), still-pending (in bounds + retention → PENDING), retention-closed (→ INDETERMINATE), expired (→ EXPIRED).

**T14.3 Retention-window math**

- Given `oldestLedger` context and the attempt's inclusion window: if oldest available ledger is past the window's end → evidence gone → `INDETERMINATE` (`retention-window-closed`). Pure boundary function, inclusivity documented and tested.

**T14.4 `tx_bad_seq` decision table (§7.3)**

- `classifyBadSeq(accountSeq, txSeq)` → one of: included (`account.seq == tx.seq`) / expected-next (`== tx.seq − 1`) / too-early (`< tx.seq − 1`) / can-never-include (`> tx.seq`), each with its documented action; string-safe 64-bit comparison.

**T14.5 Recovery sweep completion (`reconcile()`)**

- `SUBMITTING`/`CONFIRMING` entries: verdict per journaled hash; multiple hashes → final verdict = last in-flight hash's verdict; prior outcomes retained in `attempts[]` (§8.3).
- `NOT_FOUND` + in bounds + retention OK on `SUBMITTING` → identical-envelope resubmit path (T8.3 deterministic rebuild; hash match asserted before submit).
- Horizon caveat honored: no `oldestLedger` → entry stays `CONFIRMING` (poll) until bounds expire → `EXPIRED` (documented ADR-0009 behaviour).

**T14.6 Engine integration**

- Replace the Phase 7 subset verdicts everywhere — the pure function becomes the single source of truth (single call site).

## Files

`src/reconciliation.ts`, `src/engine.ts`, `src/queue.ts`, `src/index.ts`, `tests/unit/reconciliation.test.ts`, `tests/unit/recovery-sweep.test.ts`.

## Dependencies

Phases 7, 12; ADR-0004, ADR-0009; architecture §8.

## Tests — table-driven, exhaustive

- Verdict matrix over (txStatus × bounds-state × retention-state) → expected verdict, including boundary rows (ledger time == maxTime; oldestLedger exactly at window edge — both inclusivity conventions asserted per documentation);
- NOT_FOUND four-meaning table → verdict + reason each;
- `classifyBadSeq` all four rows + boundary equalities;
- multi-hash: `[EXPIRED, UNKNOWN]` → verdict from last; `[SUCCESS(old), FAILED(last)]` → FAILED with last hash;
- `PENDING` never surfaces as a terminal verdict to the application (pseudo-outcome only);
- recovery sweep (fake adapter): journaled-hash SUCCESS transitions the entry; NOT_FOUND in-bounds → identical resubmit with hash equality; NOT_FOUND past bounds → EXPIRED → rebuild if budget remains; retention closed → INDETERMINATE terminal; CONFIRMING polls only (never submits).

## Acceptance Criteria

- Matrix test asserts exhaustiveness over the enumerated input dimensions (no uncovered combination); all engine verdict decisions route through the pure function.

## Definition of Done

ACs; verdict-reason strings catalogued in `errors.ts`/docs; PR merged green.

---

# Phase 15 — Sequence Recovery

## Objective

Prove the approved sequence strategy (ADR-0005) end-to-end: per-account serialization, fresh-sequence rebuilds, and the full `tx_bad_seq` recovery surface — the exact scenario list from the planning brief.

## Why it exists

Sequence mishandling is the classic Stellar double-payment vector; these scenarios are the regression fence.

## Prerequisites

Phases 7–8, 10, 14; ADR-0005; architecture §7.

## Tasks & Subtasks

**T15.1 Scenario suite (`tests/reliability/sequence.test.ts`)** — scriptable fake chain:

- one queued payment: QUEUED → SUCCESS, sequence consumed once;
- several queued payments from one account: FIFO, each built with fresh account state, all land exactly once;
- sequential `process()` loops: no sequence drift across many entries;
- concurrent `process()` calls: per-account single-writer holds; every entry lands once;
- `tx_bad_seq` row 1 (`account.seq == tx.seq`): envelope was included → poll hash → SUCCESS, no rebuild;
- row 2 (`== tx.seq − 1`): still the expected next → identical resubmit → lands;
- row 3 (`< tx.seq − 1`): too early → stay CONFIRMING, poll;
- row 4 (`> tx.seq`): can never include → poll confirms absence → EXPIRED → rebuild fresh;
- account sequence advanced externally between attempts: next build uses fresh state (assert built sequence = loaded + 1);
- transaction already landed (DUPLICATE on resubmit): CONFIRMING → SUCCESS via hash; no second application;
- transaction cannot land (persistent `TRY_AGAIN_LATER`): bounded `NEEDS_RETRY` loop → ends in CONFIRMING/EXPIRED per bounds/budget;
- stale transaction (expired while NEEDS_RETRY): verdict → EXPIRED → rebuild with fresh sequence/bounds;
- retry after expiration: manual retry on attempts-exhausted EXPIRED (budget permitting per ADR-0008) → new build cycle → lands.

**T15.2 Invariant assertions**

- In every scenario: built sequence always equals loaded account sequence + 1; no envelope ever submitted under two different hashes for the same unresolved attempt; single-writer ordering from Phase 7 still holds.

## Files

`tests/reliability/sequence.test.ts`; engine fixes as scenarios reveal them.

## Dependencies

Phases 7, 8, 10, 14; ADR-0005.

## Tests

The scenario list itself; each named test maps to a bullet above (mapping in PR).

## Acceptance Criteria

- All scenarios pass; any engine bug they exposed is fixed with a regression test (no weakening).

## Definition of Done

ACs; scenario→test mapping recorded; PR merged green.

---

# Phase 16 — Failure Handling

## Objective

The complete, frozen typed error hierarchy (`src/errors.ts`): every failure category, machine-readable codes, consistent serialization, no secret leakage.

## Why it exists

Applications integrate against error codes, not prose. The error surface is part of the stable public API frozen at Phase 23.

## Prerequisites

Phases 1–15 (errors exist incrementally); this phase unifies and freezes them.

## Tasks & Subtasks

**T16.1 Error catalog**

- Categories and codes (minimum): validation (`validation` + `field`), storage (`storage-error`), ownership (`ownership-lost`), signing (`signer-rejected`, `signer-malformed`), submission (`submission-failed` + normalized codes), sequence (`bad-sequence`, `envelope-drift`), expiration (`expired`), reconciliation (`inflight-unresolved`), attempts (`attempts-exhausted`, `invalid-retry-state`), transition (`invalid-transition`), payload integrity (`payload-mismatch`), account (`account-missing`); cancellation via `lastError.code = 'cancelled'` (ADR-0011).
- Every error: `name`, `code`, `retryable`, optional `cause`; `toJSON()` for structured logging.

**T16.2 Consistency pass**

- All thrown errors extend the base; no raw `Error` crosses the public API; adapter/engine/store classifications unified; codes match docs.

**T16.3 Hygiene**

- No error message interpolates XDR dumps or key material at default level; `resultXdr` only as a structured field on FAILED outcomes (architecture §11.8).
- Secret-leak sentinel scan extended to the full error catalog.

## Files

`src/errors.ts`, all modules (consistency), `tests/unit/errors.test.ts`.

## Dependencies

Phases 1–15.

## Tests

- Every catalog code constructible and serializing to the expected shape; per-category test that the corresponding public API failure produces the typed error (not a raw throw); sentinel-leak scan across all error messages.

## Acceptance Criteria

- Catalog documented and test-enforced; zero raw `Error` leaks on public API failure paths.

## Definition of Done

ACs; catalog table merged into `docs/api.md` stub; PR merged green.

---

# Phase 17 — Events

## Objective

The V1 event API (`src/events.ts`): `intent:transition` and `intent:settled`, typed payloads, defined ordering guarantees, handler-error isolation.

## Why it exists

Apps/UIs observe the lifecycle without polling; the architecture keeps the emitter intentionally tiny (§10 — two events, no plugin hooks).

## Prerequisites

Phases 7, 14 (all transition sites exist); architecture §10.

## Tasks & Subtasks

**T17.1 Emitter implementation**

- `on(event, handler): () => void`; payloads: transition → `(entry, { from, to, trigger })`; settled → `(entry, result: ReconciliationResult)` on terminal states.
- Ordering guarantee: events fire after the store transition commits, in per-entry transition order; **no cross-entry ordering guarantee** across concurrent workers (documented).
- Handler errors are caught and contained — a throwing handler never breaks queue operation.

**T17.2 Emission sites**

- Exactly one event per store transition in engine/queue; no events for transient-only phases; settled fires exactly once per terminal state.

**T17.3 Docs**

- JSDoc + events section for `docs/api.md` (payload shapes, guarantees, limitations).

## Files

`src/events.ts`, `src/engine.ts`, `src/queue.ts`, `tests/unit/events.test.ts`.

## Dependencies

Phases 7, 14.

## Tests

- transition events correspond 1:1 to store transitions (store spy + listener);
- settled fires exactly once per entry per terminal state;
- a throwing handler does not affect queue operation (entry still settles);
- unsubscribe works; no events during transient-only phases; payload type/shape tests.

## Acceptance Criteria

- Correspondence test proves events = state changes (no missed or duplicate emissions).

## Definition of Done

ACs; event API documented; PR merged green.

---

# Phase 18 — Testnet Integration

## Objective

The technical reference example (`examples/node-sqlite.ts`) and the gated testnet integration suite demonstrating the full lifecycle: create intent → store → process → build → sign → submit → reconcile → final result.

## Why it exists

Proves the library against the real network end-to-end and gives users a runnable reference. **This is a technical reference implementation, not the merchant application.**

## Prerequisites

Phases 12, 14, 16; testnet access; friendbot-funded test accounts.

## Tasks & Subtasks

**T18.1 Reference example (`examples/node-sqlite.ts`)**

- Script: create two testnet accounts (friendbot); open `SqliteStore` on a temp file; `RpcAdapter` against testnet; queue with an inline app-owned signer (example only — secrets stay in the example, never in the library); `createPaymentIntent` → `addIntent` → `process()`; print lifecycle events, envelope-hash journal, final on-chain hash + verdict.
- Second run demonstrates offline-first: adapter pointed at an unreachable URL → intent creation + queueing still work → reconnect → `process()` settles.

**T18.2 Integration suite (`tests/integration/`, gated on `STELLAR_TESTNET=1`)**

- happy path: enqueue → `process()` → SUCCESS verified via an independent `getTransaction` lookup;
- DUPLICATE: resubmit identical envelope after SUCCESS → no second on-chain effect;
- `tx_bad_seq` recovery: two intents, one account → both settle exactly once;
- expiry rebuild: short `maxAgeSeconds` under an artificial adapter stall → EXPIRED → rebuild → SUCCESS;
- on-chain failures: insufficient balance, invalid destination → FAILED with `resultXdr` attached;
- restart reconciliation: fresh process against the same SQLite file with an entry left CONFIRMING → resolves to SUCCESS.

**T18.3 CI gating**

- Integration job: manual trigger + nightly schedule + `STELLAR_TESTNET=1`; does not block unit CI; required green for release (Phases 22–23 checklist).

## Files

`examples/node-sqlite.ts`, `tests/integration/*.test.ts`, `.github/workflows/ci.yml` (job), `README.md` (example link).

## Dependencies

Phases 12, 14, 16; SDK RPC testnet endpoint.

## Tests

The integration suite itself; example smoke-run in the gated job.

## Acceptance Criteria

- All gated integration tests pass on testnet; the example runs end-to-end and prints a settled payment with the correct journal audit trail.

## Definition of Done

ACs; example documented in README; PR merged green (unit CI unaffected).

---

# Phase 19 — Reliability Test Suite

## Objective

The comprehensive reliability suite (`tests/reliability/`) against the `RecordingNetworkAdapter` fake network: every scenario from the planning brief, the **at-most-once invariant asserted directly as a property**, and coverage thresholds enforced.

## Why it exists

The core promise — at most one successful on-chain application per intent — must be tested as a property across every adversarial scenario, not inferred from unit tests.

## Prerequisites

Phases 13–15, 18; fake-network infrastructure.

## Tasks & Subtasks

**T19.1 `RecordingNetworkAdapter` hardening (`tests/helpers/`)**

- Records every envelope hash received; scriptable failures at every boundary (before-send, after-send-before-response, timeout, 5xx, 429, malformed response); simulated chain state (hash → included/failed/pending; retention window; ledger clock); deterministic seeded randomness.

**T19.2 Scenario matrix (`tests/reliability/scenarios.test.ts`)** — each item from the brief:

- network unavailable (transient throws) → `NEEDS_RETRY`/backoff, no corruption;
- network restored → queued/retrying entries settle;
- RPC timeout → ambiguous → CONFIRMING / identical resubmit per bounds;
- lost submission response → reconcile → settled once;
- duplicate `process()` → single submission;
- simultaneous workers (two queues, one store) → no double claim/submit;
- application restart (SQLite file) at every persisted state → correct recovery (ties to Phase 13 matrix);
- expired lease mid-processing → lost-owner aborts without submitting; new owner settles once;
- expired transaction → EXPIRED → rebuild → settle;
- bad sequence (all four §7.3 rows);
- insufficient balance → FAILED with `resultXdr`;
- invalid destination → on-chain FAILED;
- failed operation → FAILED, no automatic retry;
- signer rejection → FAILED pre-submission, manually retryable;
- storage failure (store throws mid-sweep) → typed error, no partial state, safe retry;
- SQLite restart mid-write → last committed state visible;
- transaction already submitted (DUPLICATE path);
- transaction not found (NOT_FOUND matrix — all four meanings);
- retention-window uncertainty → INDETERMINATE terminal, surfaced honestly.

**T19.3 The core property test**

- Property: across every scenario and crash point, for every intent, **at most one recorded hash ever reaches SUCCESS in the fake chain** — asserted globally per run.
- **Documented proof limits** (test header + docs): the fake chain models RPC/Horizon semantics as understood at implementation time (dedupe-by-hash, retention, per-ledger sequencing); it cannot prove real-network behaviour beyond that model, nor disk-level corruption beyond simulated aborts.

**T19.4 Coverage + CI**

- Enable vitest coverage thresholds (≥ 90% statements/branches on `src`, adjusted to measured reality — final numbers recorded in PR); reliability suite runs in CI (no network required).
- **Mutation check:** deliberately break one invariant (allow rebuild with unresolved hash) → property test must fail → revert. Proves the suite has teeth.

## Files

`tests/helpers/recording-adapter.ts`, `tests/reliability/scenarios.test.ts`, `tests/reliability/property.test.ts`, `vitest.config.ts`.

## Dependencies

Phases 13, 14, 15, 17; fake network.

## Tests

The scenario matrix + property test — they _are_ the deliverable.

## Acceptance Criteria

- All scenarios green; the property test catches an intentionally injected double-submission bug (mutation check) and passes on the fixed code.

## Definition of Done

ACs; proof limits documented; coverage recorded; PR merged green.

---

# Phase 20 — Documentation

## Objective

Complete, honest documentation: README, API reference, lifecycle/security guides, finalized docs set — no overclaiming offline settlement.

## Why it exists

V1 completeness requires documentation that lets an engineer integrate without reading source and that states limitations plainly (the honesty standard from research.md).

## Prerequisites

Phases 1–19 complete; public API surface frozen.

## Tasks & Subtasks

**T20.1 README.md** — what it is / is-not; install; quick start (`addIntent` → `process` → events); storage adapters table (Memory non-durable, SQLite production default); signer wiring; state-machine diagram; retry + reconciliation summary; limitations (no offline _settlement_ — settlement is online; signer latency bounded by the lease; Horizon verdict caveats); links.
**T20.2 docs/api.md** — every public export with signatures; defaults table (ADR-0010); error catalog (Phase 16); events (Phase 17); `cancel`/`remove` semantics (ADR-0011); config reference.
**T20.3 Architecture annotation** — architecture.md §10 gains a short note documenting `cancel()` per ADR-0011 (marked as planning-phase resolution, not a silent change); implementation.md phase statuses updated; research.md untouched.
**T20.4 Remaining guides** — `docs/security.md` (threat model per architecture §11), `CONTRIBUTING.md` (issue → feature branch → PR → review → CI workflow; the AI coding rules), `SECURITY.md` (reporting policy), `docs/roadmap.md` finalized.
**T20.5 Consistency pass** — every code default matches ADR-0010; every error code matches Phase 16; snippets compile; no doc claims a V1-excluded feature; no overclaim of offline settlement.

## Files

`README.md`, `docs/api.md`, `docs/security.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/architecture.md` (annotation only), `docs/implementation.md` (statuses), `docs/roadmap.md`.

## Dependencies

Phases 1–19.

## Tests

Docs verified by checklist review; code snippets extractable into a compile-checked example where feasible.

## Acceptance Criteria

- A new engineer can integrate from README + api.md alone; no doc/code contradictions (defaults, errors, events cross-checked); limitations stated plainly.

## Definition of Done

ACs; docs PR merged green.

---

# Phase 21 — Package Quality

## Objective

npm package readiness: verified exports, type declarations, build output, file set, dependency declarations, and a local pack/install smoke test — no publish yet.

## Why it exists

The package must be consumable exactly as it will be published before the release review signs off.

## Prerequisites

Phases 0 (exports map), 20 (docs).

## Tasks & Subtasks

**T21.1 Package metadata verification** — `files` whitelist (dist, README, LICENSE); exports map resolves under node16/nodenext/bundler resolvers (verified with a real strict consumer project); `types` points at dist declarations; source maps shipped as appropriate.
**T21.2 Dependency audit** — runtime deps exactly `@stellar/stellar-sdk` + `better-sqlite3`; direct-dependency (vs peer) decision documented; lockfile committed; `npm audit` clean or exceptions documented; transitive licenses MIT-compatible.
**T21.3 Pack + install smoke test** — `npm pack` → install tarball into a scratch project → run the quick-start flow (MemoryStore + testnet RpcAdapter); declarations typecheck in a strict consumer; browser-consumer import boundaries (adapters tree-shakeable) verified.
**T21.4 Publishing hygiene** — `prepublishOnly` (build+test+lint, from Phase 0) refuses on failure; `--provenance` publishing documented for Phase 23; version stays 0.x until Phase 23.

## Files

`package.json`, files whitelist, scratch smoke-test consumer (temporary; repeatable via `scripts/` if useful).

## Dependencies

Phases 0, 20.

## Tests

The pack/install smoke test itself.

## Acceptance Criteria

- Tarball installs and works in a clean consumer on Node 22/24; declarations compile under strict TS in the consumer; package contains only the intended files.

## Definition of Done

ACs; audit results recorded; PR merged green.

---

# Phase 22 — Security and Release Review

## Objective

The pre-release security and quality review — dependency tree, secret handling, storage security, transaction construction, signer boundary, state transitions, concurrency, retry logic, reconciliation, error handling — plus full green runs of every suite.

## Why it exists

V1.0 stamps a stability-and-safety promise; this review is the last line before that stamp.

## Prerequisites

Phases 1–21 complete.

## Tasks & Subtasks

**T22.1 Checklist review (each item with named evidence)**

- secrets: Phase 11 sentinel tests + pattern grep over `src/`/`dist/`;
- storage security: CAS enforcement tests; file-permission guidance in security.md;
- transaction construction: builder verification hooks + determinism tests;
- signer boundary: single-call-site proof; keys structurally absent from types/storage/logs;
- state transitions: 11×11 cross-product test; table-vs-architecture §6.3 audit;
- concurrency: ownership/janitor/races suites incl. SQLite multi-connection;
- retry: ADR-0008 table→test mapping;
- reconciliation: exhaustive verdict matrix;
- error handling: catalog completeness + leak scans.

**T22.2 Dependency tree review** — `npm ls` audit; no unexpected transitive runtime deps; `better-sqlite3` pinned known-good; licenses compatible.

**T22.3 Full verification run** — typecheck, lint, unit, store contracts (both adapters), reliability suite, gated testnet integration, build, package smoke test — all green in one recorded run (`docs/release-checklist.md`).

**T22.4 Issue triage** — blockers resolved; everything else labelled post-V1.

## Files

`docs/release-checklist.md` + fixes wherever the review finds them.

## Dependencies

All prior phases.

## Tests

Everything, once more, recorded.

## Acceptance Criteria

- Checklist complete with evidence links; zero unresolved blockers; all suites green in a single CI run.

## Definition of Done

Review signed off by both maintainers (two-engineer rule); merge green.

---

# Phase 23 — V1.0 Release

## Objective

Ship 1.0.0: version bump, changelog, reproducible build, git tag, npm publication, GitHub release, verified example.

## Why it exists

The public API is frozen here; backward compatibility becomes a promise.

## Prerequisites

Phase 22 sign-off.

## Tasks & Subtasks

**T23.1 Version + changelog** — `1.0.0`; `CHANGELOG.md` (features, ADR-0010 defaults table, limitations, known issues); release notes derived from it.
**T23.2 Reproducible build** — lockfile-pinned CI build; `npm pack` from the CI artifact; tag `v1.0.0` on the release commit.
**T23.3 Publish** — `npm publish --provenance` (2FA, maintainer-executed); public tarball checksum verified against the tagged build.
**T23.4 GitHub release** — tag + notes; example verified against the _published_ package (fresh install, testnet run).
**T23.5 Post-release** — issue labels post-V1 activated; roadmap.md updated with V2 hooks (Soroban, channel pools, fee-bump recovery, IndexedDB, bumpSequence cancellation).

## Files

`CHANGELOG.md`, `package.json`, git tag, GitHub release, `docs/roadmap.md`.

## Dependencies

Phase 22.

## Tests

Fresh-consumer smoke test against the published artifact; example run.

## Acceptance Criteria

- Published package installs and runs the reference example on testnet; tag/checksum/provenance verified; docs live.

## Definition of Done

V1-complete definition (below) satisfied and recorded.

---

## Phase Dependency Summary

- **Strictly sequential spine:** P0 → P1 → P2 → P3 → P6 → P7 → P8 → P9 → P13 → P14 → P15 → P19 → P20 → P21 → P22 → P23.
- **Parallelizable:** P4 ∥ P5 (both after P3, contract suite as the shared gate); P10 after P1+P7 (overlaps P4/P5 tail); P12 after P7 (overlaps P10 tail); P16 ∥ P17 (after P14 / P7 respectively); P21 overlaps P19→P22.
- **Critical path:** P0 → P1 → P2 → P3 → P6 → P7 → P8 → P9 → P13 → P14 → P15 → P19 → P22 → P23 (P20/P21 folded into the P19→P22 window).

---

## Planning-Phase Summary (required deliverable)

1. **V1 implementation phases:** 24 phases (0–23), inside-out per the approved strategy; each independently testable and mergeable.
2. **Dependencies between phases:** every phase lists prerequisites; the store contract suite (P3) is the shared gate for both adapters (P4/P5); the pure reconciliation function (P14) is the single verdict authority for the engine.
3. **Parallelizable work:** two-engineer allocation detailed in `docs/github-issues.md` — Engineer A on the storage/ownership/engine spine, Engineer B on domain/state, adapters, and reconciliation, converging at P7 and again at P19.
4. **Critical path:** the spine above; nothing on it starts before its predecessor merges.
5. **Biggest implementation risks:** (a) deterministic identical-envelope rebuild across restarts (T8.3 — mitigated by journaled flush parameters + hash-match assertion); (b) SQLite multi-connection CAS subtleties (WAL/busy_timeout — dedicated P5 tests); (c) SDK API drift vs the installed v17 typings (verify-at-implementation rule, no invented APIs); (d) retention-window boundary math (exhaustive P14 tables); (e) testnet CI flakiness (gated job, never blocks unit CI); (f) test-suite overconfidence (P19 mutation check + documented proof limits).
6. **Proposed GitHub milestones:** M0 Foundation · M1 Core (domain, state, storage) · M2 Engine (ownership, processor, retry, idempotency) · M3 Stellar (builder, signer, adapters, submission safety) · M4 Reconciliation (verdicts, sequence, failures, events) · M5 Validation (testnet, reliability) · M6 Release (docs, package, review, v1.0).
7. **Proposed GitHub issues:** full breakdown — titles, descriptions, dependencies, testing requirements, acceptance criteria, engineer allocation, labels — in `docs/github-issues.md`.
8. **Definition of V1 completion:** all V1 scope items implemented; every phase's AC + DoD met; unit/store/reliability suites green in CI; gated testnet integration green; documentation complete and consistent; security review signed off; the npm package installs and the reference example settles a testnet payment; and the architecture invariants — write-ahead before submission, no-rebuild-while-in-flight, at-most-once settlement, signer boundary, no secrets — each hold with a named test proving it.

**Status: PLANNING COMPLETE — awaiting explicit implementation approval. No production code has been written.**
