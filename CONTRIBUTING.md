# Contributing to stellar-offline-queue

Thank you for your interest in contributing! This is an open-source TypeScript
library for Stellar applications, and it is built publicly: the architecture,
the implementation plan, and every decision record live in this repository, and
all work lands on `main` through reviewed, CI-green pull requests.
Contributions of any size are welcome — from a typo fix to a new storage
adapter.

## Before contributing

The codebase is deliberately design-driven. Before writing code, please:

1. Read the [README](README.md) for the project's purpose and current status.
2. Read [`docs/architecture.md`](docs/architecture.md) — the authoritative
   model (lifecycle states, write-ahead journaling, ownership, reconciliation).
3. Read [`docs/implementation.md`](docs/implementation.md) — the phase plan
   every issue maps to.
4. Understand the [V1 scope](docs/v1-scope.md): what is in, what is
   explicitly out, and what is deferred behind a decision record.

If your change touches architecture (state machine, store contract, retry
semantics, the signer boundary), open an issue to discuss it first.
Architecture changes require an ADR in [`docs/decisions/`](docs/decisions/)
before implementation.

## Development setup

Requirements: **Node.js 22 (Maintenance LTS) or 24 (Active LTS)** and npm 10+.

```bash
npm install        # install dependencies
npm run typecheck  # tsc --noEmit over src, tests, examples
npm test           # unit + store suites (no network)
npm run lint       # eslint (type-checked)
npm run build      # compile src/ to dist/ (declarations + source maps)
npm run format     # prettier --write
npm run format:check
```

There are no real-time sleeps and no network calls in the test suite: tests
drive scriptable fakes with an injected clock. The gated testnet integration
suite (`npm run test:integration`) is not part of normal validation.

## Contribution workflow

1. **Fork** the repository (or work from a clone if you have write access).
2. **Create a branch** from `main`, named `feature/<issue#>-<slug>` (or
   `fix/<issue#>-<slug>`). Issues map 1:1 to the implementation plan, and one
   branch addresses one issue.
3. **Make your changes**, keeping them scoped to the issue.
4. **Add tests** for every behavior change. New engine/storage behavior
   belongs in the existing suites (`tests/unit/`, `tests/store/`) with
   deterministic, fake-driven cases.
5. **Run validation**: `npm run typecheck && npm run lint && npm test && npm
run build`. All four must pass before you open the PR.
6. **Open a pull request** against `main`, referencing the issue. CI runs the
   same checks on Node 22 and Node 24. Changes on the critical path
   (engine, reconciliation, reliability) require two reviewers.

## Issue guidelines

- Work is tracked through the existing GitHub issues (see
  [`docs/github-issues.md`](docs/github-issues.md) for the breakdown). Please
  comment on the issue you are picking up so work is not duplicated.
- Keep changes scoped: one issue, one branch, one PR. Unrelated refactors and
  drive-by fixes belong in their own PRs.
- Architectural changes are discussed in an issue (and an ADR) before any
  implementation PR.

## Code standards

- **TypeScript strictness is not negotiable**: the compiler runs with
  `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`; code
  must typecheck with no `any` escapes.
- **Tests are required** for behavior changes. Determinism matters: inject the
  clock, script the fakes, never sleep.
- **Respect the architecture boundaries**: adapters are the only modules that
  talk to the network; the engine never reads the wall clock; the signer
  boundary (`ADR-0002`) means the library never touches private keys.
- **No new runtime dependency** without written justification in the PR
  description.
- **No secret material** in code, tests, or logs.
- Update documentation when public behavior changes.

## Project areas

Good places to contribute, aligned with the remaining plan:

- **Core library** — engine pipeline, reconciliation verdicts, idempotency
  hardening (the critical path; two-reviewer PRs).
- **Storage adapters** — the store contract suite
  (`tests/store/contract.ts`) is the parity bar for any new adapter.
- **Reliability testing** — the adversarial at-most-once suite and crash
  matrix that prove the invariants.
- **Documentation** — API reference, guides, and examples.
- **Developer experience** — toolchain, CI, examples, error-message quality.

If you are unsure where to start, look for the lowest-numbered open issue and
read its phase section in [`docs/implementation.md`](docs/implementation.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
