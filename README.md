# stellar-offline-queue

Offline-first transaction workflow and reliability layer for Stellar applications. The library is being built on top of the official `@stellar/stellar-sdk`: it manages **workflow** — durable payment intents, persistent queueing, a formal transaction lifecycle, bounded retries, and honest reconciliation of uncertain submission outcomes — not signing, custody, or consensus.

## Status

**Design complete; implementation underway (V1 phases 0–8 / issues #1–#9 merged).**

- Architecture, V1 scope, and decision records: see [`docs/architecture.md`](docs/architecture.md), [`docs/v1-scope.md`](docs/v1-scope.md), and [`docs/decisions/`](docs/decisions/).
- Execution plan: [`docs/implementation.md`](docs/implementation.md) (24 phases, 0–23) with the issue breakdown in [`docs/github-issues.md`](docs/github-issues.md).
- This repository currently contains the approved documentation set, the repository foundation (toolchain, CI, source/test structure), the core domain model (`src/intent.ts` — Issue #2), the lifecycle state machine (`src/state.ts` — Issue #3), the storage contract (`src/store/types.ts` + the shared adapter contract suite — Issue #4), the storage adapters `MemoryStore` (`src/store/memory.ts` — Issue #5) and `SqliteStore` (`src/store/sqlite.ts` — Issue #6), processing ownership (`src/ownership.ts` — Issue #7), the engine pipeline and sweep (`src/engine.ts` + `src/queue.ts` — Issue #8), and the retry/attempt model with deterministic identical-envelope rebuilds (`src/builder.ts`, Issue #9). `MemoryStore` is a deterministic, in-process adapter for tests and local development and is **non-durable by design**: all state is discarded on `close()`; use `SqliteStore` wherever entries must survive a restart. Remaining `src/` modules are stubs pending their implementation issues.

## Planned V1 capabilities (design approved; not yet implemented)

- Payment/transaction **intents** created fully offline, validated at enqueue time, integrity-protected by a payload hash.
- A **durable queue** with compare-and-set state transitions, processing leases, and crash recovery.
- **Storage adapters**: in-memory (tests/dev) and SQLite (Node).
- A **signer boundary**: applications sign through a single interface; the library never touches private keys.
- **Stellar RPC submission** with write-ahead envelope-hash journaling and reconciliation verdicts of `SUCCESS | FAILED | EXPIRED | INDETERMINATE` — uncertainty is surfaced, never guessed.

Feature work is tracked by issue; nothing in this list is promised until it ships.

## Development setup

Requirements: **Node.js 22 (Maintenance LTS) or 24 (Active LTS)** and npm 10+.

```bash
npm install        # install dev toolchain
npm run build      # compile src/ to dist/ (declarations + source maps)
npm test           # run unit tests (no network)
npm run lint       # eslint (type-checked)
npm run typecheck  # tsc --noEmit over src, tests, examples
npm run format     # prettier --write
```

CI runs install → typecheck → lint → test → build on Node 22 and Node 24 for every push and pull request. A separate, gated job runs the testnet integration suite only when the repository variable `STELLAR_TESTNET=1` is set (or on manual dispatch); it never blocks the unit checks.

## Contributing

Issues map 1:1 to the implementation plan: one issue → one `feature/<issue#>-<slug>` branch → PR → review → CI → merge. Work is not merged to `main` without passing CI and review; experimental work stays on branches. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide, and the engineering rules in [`docs/implementation.md`](docs/implementation.md).

## Security

Security-relevant reports are handled privately — never open a public issue for a suspected vulnerability. See [SECURITY.md](./SECURITY.md) for the disclosure policy and scope.

## License

[MIT](LICENSE)
