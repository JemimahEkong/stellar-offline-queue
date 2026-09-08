# stellar-offline-queue — GitHub Issues Plan (V1)

**Date:** September 5, 2026
**Purpose:** Ready-to-create issue breakdown for the V1 implementation phases in `docs/implementation.md`. Every issue corresponds to actual implementation work; nothing here is invented scope. The repository owner can create these issues verbatim and begin assigning work.
**Rule:** one phase → one issue (exceptions noted). Issues reference the phase as the authoritative task list; this document adds issue metadata (description, why, dependencies, testing, acceptance, labels, allocation).

---

## 1. Milestones

| Milestone | Title          | Contains issues    | Exit criterion                                                                    |
| --------- | -------------- | ------------------ | --------------------------------------------------------------------------------- |
| **M0**    | Foundation     | #1, #2, #3         | Toolchain + CI green; intent model and state machine merged                       |
| **M1**    | Core storage   | #4, #5, #6         | `QueueStore` frozen; Memory + SQLite adapters pass the contract suite             |
| **M2**    | Engine         | #7, #8, #9, #10    | Ownership, processor, retry, idempotency — full pipeline on fakes                 |
| **M3**    | Stellar        | #11, #12, #13, #14 | Real builder, signer boundary, RPC/Horizon adapters, write-ahead crash matrix     |
| **M4**    | Reconciliation | #15, #16, #17, #18 | Pure verdict engine exhaustive; sequence scenarios; errors + events frozen        |
| **M5**    | Validation     | #19, #20           | Testnet integration green (gated); reliability suite + at-most-once property test |
| **M6**    | Release        | #21, #22, #23, #24 | Docs, package, security review, v1.0.0 published                                  |

Labels: `area/*` (`foundation`, `domain`, `state-machine`, `storage`, `ownership`, `engine`, `retry`, `builder`, `signer`, `adapters`, `reconciliation`, `events`, `docs`, `release`), `type/*` (`feature`, `test`, `chore`, `docs`), `critical-path`, `parallel-b`, `review-required`.

---

## 2. Issues

### M0 — Foundation

#### Issue #1 — Repository foundation: toolchain, scripts, CI, source structure

- **Milestone:** M0 · **Labels:** `type/chore`, `area/foundation`, `critical-path` · **Phase:** 0 · **Engineer:** A
- **Description:** Set up the reproducible library skeleton per Phase 0: package.json (ESM, engines `>=22`), strict tsconfig, Vitest, ESLint flat config + Prettier, npm scripts, GitHub Actions CI (Node 22 + 24 matrix), the `src/` + `tests/` layout from architecture §13, LICENSE/README stub.
- **Why:** Every later phase assumes green typecheck/lint/test/build/CI from commit one.
- **Dependencies:** None.
- **Implementation tasks:** Phase 0 T0.1–T0.8.
- **Testing requirements:** Tooling smoke test (`tests/unit/tooling.test.ts`, temporary).
- **Acceptance criteria:** Phase 0 AC list (clean install, typecheck/lint/test/build green locally + CI on both Node versions, exact dependency set).
- **Definition of done:** PR merged to `main`, CI green, dependency policy documented in the PR.

#### Issue #2 — Core domain model: Intent, validation, payload hash, factory

- **Milestone:** M0 · **Labels:** `type/feature`, `area/domain`, `parallel-b` · **Phase:** 1 · **Engineer:** B
- **Description:** Implement `src/intent.ts` per Phase 1: `Intent`/`CreateIntentInput`/`OperationConfig`/`MemoConfig` types, deterministic validation with typed `ValidationError`, normalization, canonical-JSON `payloadHash`, JSON round-trip, `createPaymentIntent` factory. Offline only — no network.
- **Why:** The validated, hash-protected intent is the durable "what" every downstream layer consumes; invalid intents must be structurally impossible to persist.
- **Dependencies:** #1.
- **Implementation tasks:** Phase 1 T1.1–T1.7 (verify every SDK strkey/asset/memo API against installed v17 typings).
- **Testing requirements:** `tests/unit/intent.test.ts` — full validation matrix, hash stability/canonicalization, round-trip, factory; plus `tests/helpers/factories.ts`.
- **Acceptance criteria:** Phase 1 AC list.
- **Definition of done:** ACs met, validation codes documented, PR merged green.

#### Issue #3 — State machine: 11 states + exhaustive transition table

- **Milestone:** M0 · **Labels:** `type/feature`, `area/state-machine`, `critical-path`, `parallel-b` · **Phase:** 2 · **Engineer:** B
- **Description:** Implement pure `src/state.ts` per Phase 2: `IntentStatus`, state-classification constants, `TRANSITIONS` table encoding architecture §6.3 exactly, `canTransition`/`validateTransition`, recovery predicates. No I/O.
- **Why:** The transition table is the contract the store CAS enforces and the engine obeys; it must be exhaustive and pure before anything depends on it.
- **Dependencies:** #1.
- **Implementation tasks:** Phase 2 T2.1–T2.5.
- **Testing requirements:** `tests/unit/state.test.ts` — every valid row, full 11×11 invalid cross-product, trigger mismatch, recovery rows, predicate truth tables, purity guard.
- **Acceptance criteria:** Phase 2 AC list (table cross-checked row-for-row against §6.3).
- **Definition of done:** ACs met, cross-check recorded in PR, merged green.

### M1 — Core storage

#### Issue #4 — Storage abstraction: QueueStore CAS interface + contract test suite

- **Milestone:** M1 · **Labels:** `type/feature`, `area/storage`, `critical-path` · **Phase:** 3 · **Engineer:** A
- **Description:** Implement `src/store/types.ts` per Phase 3 (architecture §9.2 verbatim) and the parameterized contract suite `tests/store/contract.ts` every adapter must pass (insert uniqueness, claim/transition/remove CAS reasons, listDue/listByState/list, write-ahead shape, lease/reclaim, restart durability variant).
- **Why:** CAS is what makes "no double submission" structural; the contract suite makes adapter parity mechanical, not by inspection.
- **Dependencies:** #3 (statuses), ADR-0003/0007/0011.
- **Implementation tasks:** Phase 3 T3.1–T3.4.
- **Testing requirements:** Suite must pass against a temporary throwaway fake adapter proving full method/reason coverage.
- **Acceptance criteria:** Phase 3 AC list (interface = §9.2 exactly; exactly 8 methods; no CRUD-update escape hatch).
- **Definition of done:** ACs met, JSDoc complete, merged green.

#### Issue #5 — MemoryStore (reference adapter)

- **Milestone:** M1 · **Labels:** `type/feature`, `area/storage`, `parallel-b` · **Phase:** 4 · **Engineer:** B
- **Description:** Implement `src/store/memory.ts` per Phase 4: async-mutex-serialized mutations, clone-on-write, exact CAS failure reasons, injected clock, deterministic ordering. Non-durable by design (documented).
- **Why:** The fast deterministic substrate for all later testing, and the executable reference for SQLite's CAS semantics.
- **Dependencies:** #4.
- **Implementation tasks:** Phase 4 T4.1–T4.2.
- **Testing requirements:** Full contract suite + clone-isolation, 50-way concurrent-transition serialization, clock-injection tests.
- **Acceptance criteria:** Phase 4 AC list.
- **Definition of done:** ACs met, non-durability documented, merged green.

#### Issue #6 — SqliteStore (WAL, migrations, multi-connection CAS)

- **Milestone:** M1 · **Labels:** `type/feature`, `area/storage`, `critical-path` · **Phase:** 5 · **Engineer:** A
- **Description:** Implement `src/store/sqlite.ts` per Phase 5 on `better-sqlite3`: schema v1 + indexes, transactional CAS, WAL + busy_timeout, embedded migration runner with schema-version refusal, `:memory:` and file modes.
- **Why:** SQLite is the recommended production default; the CAS contract must survive real persistence, restarts, and multi-connection interleaving.
- **Dependencies:** #4, #5 (reference semantics); adds `better-sqlite3` runtime dep (documented justification).
- **Implementation tasks:** Phase 5 T5.1–T5.5.
- **Testing requirements:** Full contract suite incl. restart-durability variant; WAL pragma, migration refusal, 2-connection competing claims (≥50 iterations), busy_timeout grace, crash-simulation durability.
- **Acceptance criteria:** Phase 5 AC list (native build proven in CI on Node 22/24).
- **Definition of done:** ACs met, schema DDL + index rationale documented, merged green.

### M2 — Engine

#### Issue #7 — Processing ownership: claims, leases, janitor, abort rule

- **Milestone:** M2 · **Labels:** `type/feature`, `area/ownership`, `critical-path` · **Phase:** 6 · **Engineer:** A
- **Description:** Implement `src/ownership.ts` per Phase 6: `claimEntry`, `refreshLease`, `reclaimExpired` (janitor core), `OwnershipLostError`, abort-discipline helper. Never touches `SUBMITTING`/`CONFIRMING`.
- **Why:** Exclusive, time-limited, recoverable ownership is the structural answer to duplicate processing (the double-payment root cause).
- **Dependencies:** #4–#6; ADR-0007; ADR-0010 (`leaseMs`).
- **Implementation tasks:** Phase 6 T6.1–T6.4.
- **Testing requirements:** Two-worker claim race, expired vs active lease, lost-ownership abort, crash simulation, janitor race (one winner), never-reclaim regression — on MemoryStore with injected clock and on SQLite multi-connection for key cases.
- **Acceptance criteria:** Phase 6 AC list (ADR-0007 rule → named-test mapping in PR).
- **Definition of done:** ACs met, merged green.

#### Issue #8 — Queue processor: engine pipeline + process() sweep

- **Milestone:** M2 · **Labels:** `type/feature`, `area/engine`, `critical-path`, `review-required` · **Phase:** 7 · **Engineer:** A
- **Description:** Implement the one-entry pipeline (`src/engine.ts`: claim → payload check → BUILDING → SIGNING → atomic write-ahead → submit → classify → confirm) and the `OfflineQueue` sweep (`src/queue.ts`: janitor, recovery sweep, per-account single-writer claiming, ProcessSummary, `start()/stop()`, config defaults). Adapter/signer/builder minimal seams; fakes drive tests. **Both engineers review this PR.**
- **Why:** This is the state-machine executor — the module that turns intents into settled outcomes while structurally forbidding double processing.
- **Dependencies:** #2, #3, #4–#7; ADR-0002/0005/0007/0010/0011.
- **Implementation tasks:** Phase 7 T7.1–T7.4.
- **Testing requirements:** `tests/unit/engine.test.ts`, `queue-sweep.test.ts`, `backoff.test.ts` with scriptable fakes (`tests/helpers/fake-adapter.ts`, `fake-signer.ts`); every §6.3 trigger row exercised; write-ahead-before-submit order proof; no real-time sleeps.
- **Acceptance criteria:** Phase 7 AC list.
- **Definition of done:** ACs met, both-engineer review recorded, merged green.

#### Issue #9 — Retry and attempt model

- **Milestone:** M2 · **Labels:** `type/feature`, `area/retry`, `critical-path` · **Phase:** 8 · **Engineer:** A
- **Description:** Complete ADR-0008 semantics: build-cycle budget accounting, manual `retry(id)` with `AttemptsExhaustedError`/`InvalidRetryStateError`, deterministic identical-envelope rebuild across restarts (AttemptRecord gains `maxTime`/`fee`; hash-match assertion → `envelope-drift` failure path).
- **Why:** Retry is where double payments are born; the automatic/manual and identical/rebuild distinctions must be exact.
- **Dependencies:** #8; ADR-0008, ADR-0010.
- **Implementation tasks:** Phase 8 T8.1–T8.4.
- **Testing requirements:** `tests/unit/retry.test.ts` — allowed/forbidden retry states, exhaustion, identical-hash resubmission, rebuild-on-expiry budget interplay, cross-restart deterministic rebuild (incl. drift rejection), no AttemptRecord from `retry()` itself.
- **Acceptance criteria:** Phase 8 AC list (ADR-0008 tables → named tests).
- **Definition of done:** ACs met, "attempt" documented, merged green.

#### Issue #10 — Idempotency enforcement + invariant checklist

- **Milestone:** M2 · **Labels:** `type/feature`, `area/engine`, `critical-path` · **Phase:** 9 · **Engineer:** A
- **Description:** Central `assertNoUnresolvedInFlight` guard at every build site; duplicate `addIntent` semantics; repeated/concurrent `process()` hardening; response-loss seam via fake adapter; invariant checklist in `src/engine.ts` linked to named tests.
- **Why:** Assembles Phases 3–8 into the product's core promise — at-most-once per intent.
- **Dependencies:** #8, #9.
- **Implementation tasks:** Phase 9 T9.1–T9.4.
- **Testing requirements:** `tests/unit/idempotency.test.ts` — duplicate enqueue, duplicate processing, 5-way concurrent sweeps, restart-from-journal, NEEDS_RETRY timing, response loss, multi-attempt audit trail.
- **Acceptance criteria:** Phase 9 AC list.
- **Definition of done:** ACs met, invariant checklist merged, green.

### M3 — Stellar

#### Issue #11 — Stellar transaction builder (full)

- **Milestone:** M3 · **Labels:** `type/feature`, `area/builder`, `parallel-b` · **Phase:** 10 · **Engineer:** B
- **Description:** Production `src/builder.ts` per Phase 10: complete operation mapping for all §5.2 ops (SDK-verified), sequence +1 from fresh account state, fee, flush-time `maxTime`, memo/asset conversion, `verifyBuiltTransaction` hook, `buildDeterministic` helper.
- **Why:** Envelope construction is where Stellar correctness lives; it must be isolated and exhaustively tested before submission relies on it.
- **Dependencies:** #2, #8 (seams).
- **Implementation tasks:** Phase 10 T10.1–T10.4.
- **Testing requirements:** `tests/unit/builder.test.ts` — per-op XDR decode assertions, sequence math (incl. large values), bounds exactness, memo/fee mapping, determinism (byte-identical), verification-hook catches. No network.
- **Acceptance criteria:** Phase 10 AC list (every SDK call cross-checked against installed typings in PR).
- **Definition of done:** ACs met, SDK-version note in module header, merged green.

#### Issue #12 — Signer abstraction hardening

- **Milestone:** M3 · **Labels:** `type/feature`, `area/signer`, `parallel-b` · **Phase:** 11 · **Engineer:** B
- **Description:** Finalize `src/signer.ts` per Phase 11 (ADR-0002 interface), single-call-site enforcement in the engine, signed-result validation + journal-the-submitted-hash rule, app-facing `examples/keypair-signer.ts`, secret-leak sentinel tests over store/errors/events.
- **Why:** "Keys are structurally absent" is a security guarantee that must be tested, not asserted.
- **Dependencies:** #8, #11.
- **Implementation tasks:** Phase 11 T11.1–T11.3.
- **Testing requirements:** `tests/unit/signer.test.ts` (success/rejection/malformed/tampered paths; zero submissions on signer failure), single-call-site structural check, `tests/unit/secret-leak.test.ts`.
- **Acceptance criteria:** Phase 11 AC list.
- **Definition of done:** ACs met, example documented as app-owned, merged green.

#### Issue #13 — Stellar RPC + Horizon adapters

- **Milestone:** M3 · **Labels:** `type/feature`, `area/adapters`, `parallel-b` · **Phase:** 12 · **Engineer:** B
- **Description:** `src/adapters/rpc.ts` (primary) and `src/adapters/horizon.ts` (secondary) per Phase 12 + ADR-0009: normalized `SubmitResult`/`TxStatus`/`AccountState`, typed transient/timeout/permanent errors, retention-context capability declaration, import-boundary rule (only adapters import SDK network clients).
- **Why:** The engine must never parse transport-specific responses; verdict quality depends on RPC's ledger/retention context.
- **Dependencies:** #8 (interface shape), #11 (SDK verification).
- **Implementation tasks:** Phase 12 T12.1–T12.4.
- **Testing requirements:** Scriptable fake clients — every normalized status and error-code mapping, timeout/429/5xx classification, Horizon 404/504 caveat behaviour, boundary lint rule.
- **Acceptance criteria:** Phase 12 AC list.
- **Definition of done:** ACs met, capability table documented, merged green.

#### Issue #14 — Submission safety: write-ahead durability + crash matrix

- **Milestone:** M3 · **Labels:** `type/feature`, `area/engine`, `critical-path` · **Phase:** 13 · **Engineer:** A
- **Description:** Prove the write-ahead protocol at the storage boundary: SQLite durability semantics (`synchronous` trade-off opt-in), child-process abort durability test, and the five-scenario crash-point matrix with per-scenario at-most-once assertions and recorded call-order proof.
- **Why:** "Envelope possibly sent, no record of it" must be structurally impossible.
- **Dependencies:** #6, #8, #9, #10, #13.
- **Implementation tasks:** Phase 13 T13.1–T13.3.
- **Testing requirements:** `tests/reliability/crash-matrix.test.ts` (all five crash instants; persistence-critical ones also on SQLite) + durability test.
- **Acceptance criteria:** Phase 13 AC list.
- **Definition of done:** ACs met, sync-mode trade-off documented, merged green.

### M4 — Reconciliation

#### Issue #15 — Reconciliation engine (pure verdict + recovery sweep)

- **Milestone:** M4 · **Labels:** `type/feature`, `area/reconciliation`, `critical-path`, `parallel-b`, `review-required` · **Phase:** 14 · **Engineer:** B
- **Description:** Complete `src/reconciliation.ts` per Phase 14 + ADR-0004: pure `verdict()`, `NOT_FOUND` four-meaning table, retention-window math, `classifyBadSeq` (§7.3), multi-hash final-verdict rule, full `reconcile()` recovery sweep; engine routed through the pure function. **Both engineers review.**
- **Why:** The project's differentiator — honest verdicts, never guessed.
- **Dependencies:** #8, #13; architecture §7.3/§8.
- **Implementation tasks:** Phase 14 T14.1–T14.6.
- **Testing requirements:** Exhaustive table-driven matrix (status × bounds × retention, boundary rows), NOT_FOUND table, bad-seq table, multi-hash rules, recovery-sweep scenarios incl. identical-envelope resubmit and Horizon caveat.
- **Acceptance criteria:** Phase 14 AC list (matrix asserted exhaustive; single verdict authority).
- **Definition of done:** ACs met, both-engineer review recorded, merged green.

#### Issue #16 — Sequence recovery scenario suite

- **Milestone:** M4 · **Labels:** `type/test`, `area/reconciliation`, `parallel-b` · **Phase:** 15 · **Engineer:** B
- **Description:** `tests/reliability/sequence.test.ts` — the full planning-brief scenario list over a scriptable fake chain (one payment; many payments one account; sequential/concurrent sweeps; all four `tx_bad_seq` rows; external sequence advance; already-landed; cannot-land; stale; retry-after-expiry) with sequence invariants asserted per scenario.
- **Why:** Sequence mishandling is the classic Stellar double-payment vector; this is the regression fence.
- **Dependencies:** #9, #11, #15.
- **Implementation tasks:** Phase 15 T15.1–T15.2 (fix any engine bugs with regression tests).
- **Testing requirements:** The scenario list itself, each bullet a named test.
- **Acceptance criteria:** Phase 15 AC list.
- **Definition of done:** ACs met, scenario→test mapping recorded, merged green.

#### Issue #17 — Typed error catalog (freeze)

- **Milestone:** M4 · **Labels:** `type/feature`, `area/engine`, `parallel-b` · **Phase:** 16 · **Engineer:** B
- **Description:** Unify and freeze `src/errors.ts`: full category/code catalog, `name/code/retryable/cause/toJSON`, consistency pass across all modules (no raw `Error` crosses the public API), no-secret-leak hygiene, catalog table for docs.
- **Why:** Applications integrate against error codes; the surface must be complete and stable before release review.
- **Dependencies:** #8–#15 (errors exist incrementally; this freezes them).
- **Implementation tasks:** Phase 16 T16.1–T16.3.
- **Testing requirements:** Every code constructible + serializes; per-category public-API failure → typed error; sentinel scan across messages.
- **Acceptance criteria:** Phase 16 AC list.
- **Definition of done:** ACs met, catalog merged into `docs/api.md` stub, merged green.

#### Issue #18 — Events

- **Milestone:** M4 · **Labels:** `type/feature`, `area/events`, `parallel-b` · **Phase:** 17 · **Engineer:** A
- **Description:** `src/events.ts` per Phase 17: `intent:transition` + `intent:settled` with typed payloads, post-commit emission ordering, exactly-once settled, handler-error isolation, one emission site per store transition.
- **Why:** Minimal observability for apps/UIs, as designed in architecture §10.
- **Dependencies:** #8, #15.
- **Implementation tasks:** Phase 17 T17.1–T17.3.
- **Testing requirements:** `tests/unit/events.test.ts` — 1:1 correspondence with store transitions, exactly-once settled, throwing-handler isolation, unsubscribe, payload shapes.
- **Acceptance criteria:** Phase 17 AC list.
- **Definition of done:** ACs met, event API documented, merged green.

### M5 — Validation

#### Issue #19 — Testnet reference example + gated integration suite

- **Milestone:** M5 · **Labels:** `type/feature`, `type/test`, `area/adapters`, `parallel-b` · **Phase:** 18 · **Engineer:** B
- **Description:** `examples/node-sqlite.ts` (full lifecycle incl. offline-then-reconnect demonstration; technical reference, not a merchant app) and `tests/integration/*` gated on `STELLAR_TESTNET=1`: happy path, DUPLICATE, `tx_bad_seq` recovery, expiry rebuild, on-chain failures, restart reconciliation. CI: manual + nightly, never blocking unit CI.
- **Why:** Proves the library against the real network and gives users a runnable reference.
- **Dependencies:** #13, #15, #17.
- **Implementation tasks:** Phase 18 T18.1–T18.3.
- **Testing requirements:** The integration suite + example smoke run in the gated job.
- **Acceptance criteria:** Phase 18 AC list.
- **Definition of done:** ACs met, example linked in README, merged green (unit CI unaffected).

#### Issue #20 — Reliability suite + at-most-once property test

- **Milestone:** M5 · **Labels:** `type/test`, `area/engine`, `critical-path`, `review-required` · **Phase:** 19 · **Engineer:** A
- **Description:** `RecordingNetworkAdapter` hardening; the full 19-scenario matrix; the core property test ("at most one recorded hash reaches SUCCESS per intent, across every scenario"); documented proof limits; coverage thresholds; **mutation check** (deliberately break no-rebuild-while-in-flight → property test must fail → revert). **Both engineers review.**
- **Why:** The core promise must be tested as a property across adversarial scenarios, not inferred.
- **Dependencies:** #14, #15, #16, #18.
- **Implementation tasks:** Phase 19 T19.1–T19.4.
- **Testing requirements:** The suite itself + the mutation check.
- **Acceptance criteria:** Phase 19 AC list (mutation check catches the injected bug; coverage recorded).
- **Definition of done:** ACs met, proof limits documented, both-engineer review, merged green.

### M6 — Release

#### Issue #21 — Documentation complete

- **Milestone:** M6 · **Labels:** `type/docs`, `parallel-b` · **Phase:** 20 · **Engineer:** B
- **Description:** README, `docs/api.md` (exports, ADR-0010 defaults, error catalog, events, cancel/remove semantics), `docs/security.md`, `CONTRIBUTING.md`, `SECURITY.md`, architecture §10 annotation for ADR-0011, consistency pass (defaults/codes/events vs code), no overclaiming offline settlement.
- **Why:** An engineer must be able to integrate from docs alone, with limitations stated plainly.
- **Dependencies:** #1–#20 (API surface frozen).
- **Implementation tasks:** Phase 20 T20.1–T20.5.
- **Testing requirements:** Checklist review; snippets compile-checked where feasible.
- **Acceptance criteria:** Phase 20 AC list.
- **Definition of done:** Docs PR merged green.

#### Issue #22 — Package quality (npm readiness)

- **Milestone:** M6 · **Labels:** `type/chore`, `area/foundation` · **Phase:** 21 · **Engineer:** A
- **Description:** Verify files/exports/types/build output; dependency audit (runtime deps exactly stellar-sdk + better-sqlite3; `npm audit`; licenses); `npm pack` → clean-consumer install + strict typecheck smoke test; publishing hygiene (`prepublishOnly`, provenance notes). No publish in this issue.
- **Why:** The package must be consumable exactly as it will be published before release sign-off.
- **Dependencies:** #1, #21 (docs for the tarball README).
- **Implementation tasks:** Phase 21 T21.1–T21.4.
- **Testing requirements:** The pack/install smoke test itself.
- **Acceptance criteria:** Phase 21 AC list.
- **Definition of done:** ACs met, audit recorded, merged green.

#### Issue #23 — Security and release review

- **Milestone:** M6 · **Labels:** `review-required`, `release-blocker` · **Phase:** 22 · **Engineer:** A + B (sign-off by both)
- **Description:** Checklist review with named evidence (secrets, storage, builder, signer boundary, transitions, concurrency, retry, reconciliation, errors); dependency tree review; full verification run recorded in `docs/release-checklist.md`; issue triage (blockers resolved, rest labelled post-V1).
- **Why:** V1.0 stamps a safety promise; this is the last line before it.
- **Dependencies:** #1–#22.
- **Implementation tasks:** Phase 22 T22.1–T22.4.
- **Testing requirements:** Every suite, once more, in one recorded CI run.
- **Acceptance criteria:** Phase 22 AC list (checklist complete, zero blockers, all green).
- **Definition of done:** Both maintainers signed off; merged green.

#### Issue #24 — V1.0.0 release

- **Milestone:** M6 · **Labels:** `release-blocker` · **Phase:** 23 · **Engineer:** A + B
- **Description:** Version 1.0.0, `CHANGELOG.md` + release notes, reproducible tagged build, `npm publish --provenance`, GitHub release, published-package smoke test (fresh install + testnet example), roadmap updated with V2 hooks.
- **Why:** The public API freezes here; backward compatibility becomes a promise.
- **Dependencies:** #23.
- **Implementation tasks:** Phase 23 T23.1–T23.5.
- **Testing requirements:** Fresh-consumer smoke test against the published artifact.
- **Acceptance criteria:** Phase 23 AC list; the V1-complete definition in implementation.md satisfied and recorded.
- **Definition of done:** Published, tagged, released, verified.

---

## 3. Contributor work allocation

**Engineer A — the durability spine (store, ownership, engine, submission safety, events, release mechanics):**
#1 → #4 → #6 → #7 → #8 → #9 → #10 → #14 → #18 → #20 → #22 → #23 → #24

**Engineer B — the domain and network surface (domain model, state, adapters, reconciliation, docs):**
#2 → #3 → #5 → #11 → #12 → #13 → #15 → #16 → #17 → #19 → #21 → #23 → #24

**Parallel waves (A and B never editing the same files):**

- Wave 1: A #1 → then A #4 while B does #2 + #3.
- Wave 2: A #6 while B does #5 (different files; shared gate = contract suite #4, which B extends for #5 without changing its cases unilaterally — additions require cross-review).
- Wave 3: A #7 → #8 while B starts #11 (builder) — #8's minimal builder seam is agreed at #8's review (both engineers), so B's #11 lands into a stable seam.
- Wave 4: A #9 + #10 + #14 while B does #12 + #13.
- Wave 5: A #18 + #22 while B does #15 → #16 → #17 → #19 → #21.
- Wave 6 (convergence): #20 (A leads, B reviews), then #23/#24 (both).

**Must be sequential (critical path):**
#1 → #3 → #4 → #7 → #8 → #9 → #10 → #14 → #15 → #20 → #23 → #24.
Nothing on the spine starts before its predecessor merges; #8 and #15 and #20 are two-reviewer PRs.

**Code review policy:**

- Every PR: the other engineer reviews (no self-merge); `critical-path` + `review-required` PRs (#8, #15, #20, #23) require **both** engineers' approval.
- Interface-freezing PRs (#3 transition table, #4 store interface, #13 adapter interface) require cross-review before dependents start.
- Test-weakening (skips, relaxed assertions) requires justification in the PR and reviewer sign-off per the AI coding rules.

---

## 4. Git workflow

- Branches: `main` (protected: PR + CI required) and `feature/<issue#>-<slug>`.
- Each issue: create branch → implement (tests with code) → PR → review → CI green → merge (squash, message references the issue, e.g. `feat(storage): SqliteStore with WAL + migrations (#6)`).
- Never commit experimental or unfinished work to `main`; experiments live on branches or the author's fork.
- The issue closes only when its acceptance criteria and definition of done are met — not when the code "looks done".
