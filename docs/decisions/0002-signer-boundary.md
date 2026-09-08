# ADR-0002: Signer Boundary

**Status:** Accepted (proposed)
**Date:** September 5, 2026

## Context

The library orchestrates transaction workflows in applications that may handle money. Two failure modes must be impossible by construction: (1) the library persisting, logging, or leaking private keys, and (2) the library making signing decisions (e.g. "which key signs this") that belong to the application's wallet. The project explicitly is **not** a wallet.

Stellar signing is offline-capable: a transaction + network passphrase + secret key produces a signature with no network access. That makes it tempting to pull key handling into the library — exactly what must be resisted.

## Options considered

### Option A — Library accepts `Keypair`s directly

- **Pros:** fewer lines of app code.
- **Cons:** the library now stores keys in memory across async boundaries; serialization of entries or debug logging can leak seeds; key lifecycle (hardware wallets, wallet kits, HSMs) becomes the library's problem; the library becomes a wallet by accident. Security guarantee would be "we try not to leak keys" instead of "keys are structurally absent."

### Option B — Signer interface (recommended)

```typescript
interface Signer {
  /** Signs the given unsigned transaction. Returns the signed envelope (or rejects). */
  sign(
    transaction: Transaction,
    context: { intentId: string; networkPassphrase: string },
  ): Promise<Transaction>;
}
```

- **Pros:** the library's types contain no secret material — it cannot persist, serialize, or log what it never receives; the application composes its own wallet logic (Keypair in env, HSM, `@creit.tech/stellar-wallets-kit`, hardware) behind one method; test signers make unit tests trivial; audit boundary is a single interface.
- **Cons:** one async hop per attempt; the signer may produce an envelope the library must trust (mitigated: wrong/absent signatures surface deterministically as `tx_bad_auth` at submission → `FAILED`, never double-applied).

### Option C — Signing callbacks at multiple points

- **Pros:** maximal flexibility.
- **Cons:** multiple injection points fragment the guarantee and the test surface. One interface, called at exactly one point in the lifecycle (SIGNING), is simpler and sufficient.

## Decision

Adopt Option B: a single `Signer` interface invoked at exactly one lifecycle point (`SIGNING`), before the write-ahead `SUBMITTING` transition.

- The library defines `Signer` and consumes it; it never implements key storage, derivation, or selection.
- The signer receives the **unsigned** draft built by the library (sequence + bounds already resolved) and returns the signed envelope.
- Signer rejection (throw / reject) → deterministic `SIGNING → FAILED` with no side effects; the app may `retry(id)`.
- A `KeypairSigner` (plain SDK `Keypair`) is provided **as an application-facing example**, not a library default — the app owns the secret.

## Consequences

- Private keys are structurally absent from the library's types, storage, logs, and serialization. This is a guarantee, not a policy.
- Developers integrate their wallet in one place; hardware/wallet-kit support is their code, not ours.
- DX cost: one small adapter function for apps that hold a `Keypair`.
- Test signers make the full lifecycle testable without secrets.
