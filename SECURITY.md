# Security Policy

## Supported versions

The project is in active development on `main`, working toward the first V1
release (version `0.0.0` today; nothing is published to npm yet). Security
fixes are made on the current `main` and included in the next release. Older
or forked snapshots should not be relied on for production use until a stable
release exists.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected security problem, and
please do not publicly disclose it before a fix is available — responsible
disclosure gives us the chance to ship a fix first.

Report security issues **privately through GitHub Security Advisories**
(_Security_ tab → _Report a vulnerability_). If that is unavailable to you,
contact the maintainers directly and we will arrange a private channel.

Please include as much of the following as you can: a description of the
issue, the steps or script to reproduce it, the affected commit or version,
and your assessment of impact. You will get an acknowledgment, and we will
work with you on timing for any public disclosure after a fix lands.

## Scope

Areas of this library that are security-relevant:

- **Transaction handling** — envelope building, sequence handling, submission
  classification, and the identical-envelope resubmission rule (a rebuilt
  envelope must never diverge from its journaled hash).
- **Persistence** — store CAS semantics, crash durability, and journal
  integrity (the write-ahead record must exist before any submission).
- **Concurrency** — claim/lease ownership, lost-ownership aborts, and the
  per-account single-writer invariant that prevents double submission.
- **Data integrity** — payload-hash verification of stored intents.
- **Cryptographic boundaries** — signing and signature validation.

Out of scope for this library by design (please verify claims against the
application using the library): compromise of the host machine or file system,
the Stellar network protocol itself, and vulnerabilities in application code
or third-party dependencies outside what we pin.

## Keys and secrets

This library **never stores, transmits, or derives private keys**. All
signing happens through the application-provided signer interface
(`ADR-0002` in [`docs/decisions/`](docs/decisions/)); the library only ever
holds fully signed envelopes in memory, briefly, on the path to submission.
Signatures are never persisted.

If you use this library, keep your secrets outside it: do not paste key
material into intents, metadata, logs, or issue reports.

## Safe harbor

We consider good-faith security research following this policy to be
authorized and will not pursue action against researchers who avoid privacy
violations, data destruction, and service degradation while investigating.
