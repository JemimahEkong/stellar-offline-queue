# stellar-offline-queue — Roadmap

**Date:** September 5, 2026
**Status:** V1 planning complete; execution pending approval
**Sources:** `docs/implementation.md` (authoritative phase plan), `docs/github-issues.md` (issue/milestone breakdown), `docs/v1-scope.md` (scope authority).

---

## V1 execution map

| Phase | Deliverable                                         | Milestone | Issue(s) | Critical path?                   |
| ----- | --------------------------------------------------- | --------- | -------- | -------------------------------- |
| 0     | Toolchain, CI, source structure                     | M0        | #1       | ✅                               |
| 1     | Intent model, validation, payload hash, factory     | M0        | #2       | —                                |
| 2     | State machine + exhaustive transition table         | M0        | #3       | ✅                               |
| 3     | QueueStore CAS interface + contract suite           | M1        | #4       | ✅                               |
| 4     | MemoryStore                                         | M1        | #5       | —                                |
| 5     | SqliteStore (WAL, migrations, multi-connection CAS) | M1        | #6       | — (gated by #4; precedes engine) |
| 6     | Processing ownership (claims, leases, janitor)      | M2        | #7       | ✅                               |
| 7     | Engine pipeline + process() sweep                   | M2        | #8       | ✅ (two-reviewer PR)             |
| 8     | Retry + attempt model (ADR-0008)                    | M2        | #9       | ✅                               |
| 9     | Idempotency enforcement                             | M2        | #10      | ✅                               |
| 10    | Stellar transaction builder (full)                  | M3        | #11      | —                                |
| 11    | Signer boundary hardening                           | M3        | #12      | —                                |
| 12    | RPC + Horizon adapters                              | M3        | #13      | —                                |
| 13    | Submission safety + crash matrix                    | M3        | #14      | ✅                               |
| 14    | Reconciliation engine (pure verdicts)               | M4        | #15      | ✅ (two-reviewer PR)             |
| 15    | Sequence recovery scenarios                         | M4        | #16      | ✅                               |
| 16    | Typed error catalog (freeze)                        | M4        | #17      | —                                |
| 17    | Events                                              | M4        | #18      | —                                |
| 18    | Testnet example + gated integration                 | M5        | #19      | —                                |
| 19    | Reliability suite + at-most-once property           | M5        | #20      | ✅ (two-reviewer PR)             |
| 20    | Documentation                                       | M6        | #21      | ✅ (pre-release)                 |
| 21    | Package quality                                     | M6        | #22      | ✅ (pre-release)                 |
| 22    | Security/release review                             | M6        | #23      | ✅                               |
| 23    | V1.0.0 release                                      | M6        | #24      | ✅                               |

Milestones: **M0** Foundation · **M1** Core storage · **M2** Engine · **M3** Stellar · **M4** Reconciliation · **M5** Validation · **M6** Release.

---

## Critical path

P0 → P2 → P3 → P6 → P7 → P8 → P9 → P13 → P14 → P15 → P19 → P20 → P21 → P22 → P23
(The two-engineer plan interleaves non-critical work — #2, #5, #11, #12, #13, #16, #17, #18, #19, #21 — alongside this spine.)

## Two-engineer allocation (summary)

- **Engineer A (durability spine):** #1 → #4 → #6 → #7 → #8 → #9 → #10 → #14 → #18 → #20 → #22 → #23/#24.
- **Engineer B (domain + network surface):** #2 → #3 → #5 → #11 → #12 → #13 → #15 → #16 → #17 → #19 → #21 → #23/#24.
- Wave structure, review policy, and interface-freeze gates: `docs/github-issues.md` §3.

## V1 completion definition

All V1 scope items implemented; every phase's AC + DoD met; unit/store/reliability suites green in CI; gated testnet integration green; documentation complete and consistent; security review signed off; the npm package installs and the reference example settles a testnet payment; architecture invariants (write-ahead before submission, no-rebuild-while-in-flight, at-most-once settlement, signer boundary, no secrets) each hold with a named test proving it.

---

## Post-V1 (design hooks already in place — architecture §14)

Ordered by anticipated demand; each requires an ADR before implementation:

1. **IndexedDB adapter** (first post-V1 milestone; interface is complete and contract-tested) and React Native storage.
2. **Soroban support** — operation-union extension + `prepareTransaction` builder step.
3. **Channel-account pooling** for parallel throughput (aligns with SDF #1599; slots in behind `builder.ts` + scheduler seam).
4. **Automatic fee-bump recovery** (aligns with SDF #1602; `NEEDS_RETRY` journal can carry bump attempts).
5. **Post-submission `cancel(id)`** via `bumpSequence` invalidation (ADR-0011 names the seam; V1's soft-cancel is pre-submission only).
6. **`confirmTransaction` SDK primitive swap** when SDF #1615 ships (verdict internals only; result model unchanged).
7. Multi-chain / Stellar-compatible networks (Pi etc.), background daemon/CLI — evaluated on demand.
