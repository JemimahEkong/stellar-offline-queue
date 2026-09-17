/**
 * Transaction builder (Phase 7 / Issue #8 minimal seam; full hardening is
 * Phase 10 / Issue #11).
 *
 * Converts a validated, hash-protected intent plus fresh account state into
 * an **unsigned** SDK `Transaction` at flush time (ADR-0005): the sequence is
 * `account.sequence + 1`, `maxTime = flushTime + maxAgeSeconds` — resolved
 * when connectivity exists, never at intent creation.
 *
 * Build is deterministic for fixed inputs (needed later for the identical-
 * envelope rebuild rule, Phase 8): same `(intent, accountState, config)` →
 * byte-identical envelope.
 *
 * Every SDK primitive below is verified against the installed v17 typings
 * (`TransactionBuilder`, `Account`, `Operation.payment|createAccount|
 * pathPaymentStrictSend|pathPaymentStrictReceive|changeTrust|
 * manageSellOffer|manageBuyOffer|setOptions`, `Asset`, `Memo.*`).
 *
 * Model contract: ADR-0005, architecture §4.4, §5.2, ADR-0010 (#3, #9).
 */

import {
  Account,
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
  Networks,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { AssetConfig, Intent, MemoConfig, OperationConfig } from './intent.js';
import type { AccountState } from './adapters/types.js';
import { ValidationError } from './errors.js';

/** SDK network passphrases, re-exported so apps configure without raw strings. */
export { Networks, BASE_FEE };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Builder configuration resolved from queue config (ADR-0010 defaults). */
export type BuilderConfig = {
  /** Network passphrase, e.g. `Networks.TESTNET`. */
  networkPassphrase: string;
  /** Per-operation fee in stroops; default `BASE_FEE` (`"100"`, ADR-0010 #9). */
  baseFee: string;
};

/**
 * Flush-time parameters resolved by the engine for one build cycle.
 * Recorded on the `AttemptRecord` from Phase 8 so identical rebuilds are
 * byte-exact.
 */
export type FlushParams = {
  /** Flush time (ms epoch) — basis for `maxTime = flushTime + maxAgeSeconds`. */
  flushTime: number;
};

/**
 * The complete deterministic build parameters of one envelope (ADR-0008):
 * build is a pure function of `(intent, sequence, fee, maxTime)`, so these
 * three values — all journaled on the `AttemptRecord` — are everything the
 * post-restart resume path needs to rebuild the **byte-identical** envelope.
 */
export type BuildParams = {
  /** Sequence number to embed (decimal string; typically `account.seq + 1`). */
  sequence: string;
  /** Per-operation fee in stroops (decimal string). */
  fee: string;
  /** Upper time bound in unix **seconds** (resolved at the original flush). */
  maxTime: number;
};

// ---------------------------------------------------------------------------
// SDK conversion helpers (internal)
// ---------------------------------------------------------------------------

/** Map a validated `AssetConfig` onto an SDK `Asset`. */
function toSdkAsset(asset: AssetConfig): Asset {
  return asset.issuer === undefined ? Asset.native() : new Asset(asset.code, asset.issuer);
}

/** Map a validated `MemoConfig` onto an SDK `Memo` (SDK limits already enforced). */
function toSdkMemo(memo: MemoConfig): Memo {
  switch (memo.type) {
    case 'text':
      return Memo.text(memo.value);
    case 'id':
      return Memo.id(memo.value);
    case 'hash':
      return Memo.hash(memo.value);
    case 'return':
      return Memo.return(memo.value);
  }
}

/**
 * Map one validated `OperationConfig` onto the corresponding SDK operation
 * descriptor. This is the single validation→SDK mapping point (architecture
 * §5.2: "validation lives in one switch" — the builder is its mirror).
 */
function toSdkOperation(op: OperationConfig): ReturnType<(typeof Operation)['payment']> {
  switch (op.type) {
    case 'payment':
      return Operation.payment({
        destination: op.destination,
        asset: toSdkAsset(op.asset),
        amount: op.amount,
      });
    case 'createAccount':
      return Operation.createAccount({
        destination: op.destination,
        startingBalance: op.startingBalance,
      });
    case 'pathPaymentStrictSend':
      return Operation.pathPaymentStrictSend({
        destination: op.destination,
        sendAsset: toSdkAsset(op.sendAsset),
        sendAmount: op.sendAmount,
        destAsset: toSdkAsset(op.destAsset),
        destMin: op.destMin,
        ...(op.path !== undefined ? { path: op.path.map(toSdkAsset) } : {}),
      });
    case 'pathPaymentStrictReceive':
      return Operation.pathPaymentStrictReceive({
        destination: op.destination,
        sendAsset: toSdkAsset(op.sendAsset),
        sendMax: op.sendMax,
        destAsset: toSdkAsset(op.destAsset),
        destAmount: op.destAmount,
        ...(op.path !== undefined ? { path: op.path.map(toSdkAsset) } : {}),
      });
    case 'changeTrust':
      return Operation.changeTrust({
        asset: toSdkAsset(op.asset),
        ...(op.limit !== undefined ? { limit: op.limit } : {}),
      });
    case 'manageSellOffer':
      return Operation.manageSellOffer({
        selling: toSdkAsset(op.selling),
        buying: toSdkAsset(op.buying),
        amount: op.amount,
        price: op.price,
        ...(op.offerId !== undefined ? { offerId: op.offerId } : {}),
      });
    case 'manageBuyOffer':
      return Operation.manageBuyOffer({
        selling: toSdkAsset(op.selling),
        buying: toSdkAsset(op.buying),
        buyAmount: op.buyAmount,
        price: op.price,
        ...(op.offerId !== undefined ? { offerId: op.offerId } : {}),
      });
    case 'setOptions': {
      // V1 subset mapping: only the fields present on the intent config are
      // forwarded; thresholds/signer weights are validated integers. Built
      // inline so the SDK's `SetOptionsOpts<T>` signer generic infers from
      // the literal (verified against installed v17 typings).
      const t = op.thresholds;
      return Operation.setOptions({
        ...(op.inflationDest !== undefined ? { inflationDest: op.inflationDest } : {}),
        ...(op.homeDomain !== undefined ? { homeDomain: op.homeDomain } : {}),
        ...(op.signer !== undefined
          ? { signer: { ed25519PublicKey: op.signer.ed25519PublicKey, weight: op.signer.weight } }
          : {}),
        ...(t?.masterWeight !== undefined ? { masterWeight: t.masterWeight } : {}),
        ...(t?.lowThreshold !== undefined ? { lowThreshold: t.lowThreshold } : {}),
        ...(t?.medThreshold !== undefined ? { medThreshold: t.medThreshold } : {}),
        ...(t?.highThreshold !== undefined ? { highThreshold: t.highThreshold } : {}),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

/**
 * Build the unsigned transaction from **explicit deterministic parameters**
 * (ADR-0008 identical-envelope rule): `config.networkPassphrase` supplies the
 * network; `params.fee` overrides `config.baseFee`. Build is pure — no clock
 * reads, no I/O — so fixed inputs yield byte-identical XDR (hence the same
 * envelope hash).
 *
 * Throws `ValidationError` when an SDK build-time rule rejects the payload.
 */
export function buildDeterministic(
  intent: Intent,
  params: BuildParams,
  config: Pick<BuilderConfig, 'networkPassphrase'>,
): Transaction {
  if (!Number.isInteger(intent.timeBounds.maxAgeSeconds) || intent.timeBounds.maxAgeSeconds <= 0) {
    throw new ValidationError('invalid-time-bounds', 'intent.timeBounds.maxAgeSeconds must be a positive integer', 'timeBounds.maxAgeSeconds');
  }
  if (!/^[0-9]+$/.test(params.sequence)) {
    throw new ValidationError('invalid-amount', 'sequence must be a decimal string', 'sequence');
  }
  // The SDK `Account` consumes its sequence on build (tx sequence =
  // account.sequence + 1), so the account is constructed one BELOW the
  // requested transaction sequence. A transaction sequence of 0 can never
  // exist (accounts start at 0; the first transaction is 1).
  if (BigInt(params.sequence) <= 0n) {
    throw new ValidationError('invalid-amount', 'sequence must be a positive integer (transaction sequences start at 1)', 'sequence');
  }
  if (!/^[0-9]+$/.test(params.fee)) {
    throw new ValidationError('invalid-amount', 'fee must be a non-negative integer string (stroops)', 'fee');
  }
  if (!Number.isInteger(params.maxTime) || params.maxTime < 0) {
    throw new ValidationError('invalid-time-bounds', 'maxTime must be a non-negative integer (unix seconds)', 'maxTime');
  }

  const sdkAccount = new Account(intent.sourceAccount, (BigInt(params.sequence) - 1n).toString());
  const builder = new TransactionBuilder(sdkAccount, {
    fee: params.fee,
    networkPassphrase: config.networkPassphrase,
    timebounds: {
      minTime: 0,
      maxTime: params.maxTime,
    },
  });

  for (const op of intent.operations) {
    builder.addOperation(toSdkOperation(op));
  }
  if (intent.memo !== undefined) {
    builder.addMemo(toSdkMemo(intent.memo));
  }

  return builder.build();
}

/**
 * Build the unsigned transaction for one attempt (architecture §4.4):
 *
 * - source = `intent.sourceAccount`, sequence = `accountState.sequence + 1`
 *   (via SDK `Account`, which consumes the sequence on build);
 * - fee = `config.baseFee` per operation;
 * - `maxTime = flushTime + maxAgeSeconds` (relative bounds resolved at
 *   flush time, ADR-0005); `minTime = 0`;
 * - memo and operations mapped 1:1 from the intent.
 *
 * Deterministic core: delegates to `buildDeterministic` with the flush-time
 * parameters, so this path and the post-restart identical-rebuild path share
 * one code base and cannot drift.
 *
 * Throws `ValidationError` when an SDK build-time rule rejects the payload
 * (the intent itself was validated at enqueue; SDK rules are the second
 * net). The engine maps any build throw to a deterministic failure.
 */
export function buildTransaction(
  intent: Intent,
  accountState: AccountState,
  config: BuilderConfig,
  params: FlushParams,
): Transaction {
  if (!/^[0-9]+$/.test(accountState.sequence)) {
    throw new ValidationError('invalid-amount', 'accountState.sequence must be a decimal string', 'sequence');
  }
  // Sequence arithmetic must be string-safe: sequence numbers are int64 and
  // exceed Number.MAX_SAFE_INTEGER for mature accounts.
  const sequence = (BigInt(accountState.sequence) + 1n).toString();
  const maxTime = Math.floor(params.flushTime / 1000) + intent.timeBounds.maxAgeSeconds;
  return buildDeterministic(intent, { sequence, fee: config.baseFee, maxTime }, config);
}
