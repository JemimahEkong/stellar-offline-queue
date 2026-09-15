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
 * Build the unsigned transaction for one attempt (architecture §4.4):
 *
 * - source = `intent.sourceAccount`, sequence = `accountState.sequence + 1`
 *   (via SDK `Account`, which consumes the sequence on build);
 * - fee = `config.baseFee` per operation;
 * - `maxTime = flushTime + maxAgeSeconds` (relative bounds resolved at
 *   flush time, ADR-0005); `minTime = 0`;
 * - memo and operations mapped 1:1 from the intent.
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
  if (!Number.isInteger(intent.timeBounds.maxAgeSeconds) || intent.timeBounds.maxAgeSeconds <= 0) {
    throw new ValidationError('invalid-time-bounds', 'intent.timeBounds.maxAgeSeconds must be a positive integer', 'timeBounds.maxAgeSeconds');
  }
  if (!/^[0-9]+$/.test(accountState.sequence)) {
    throw new ValidationError('invalid-amount', 'accountState.sequence must be a decimal string', 'sequence');
  }

  const sdkAccount = new Account(intent.sourceAccount, accountState.sequence);
  const builder = new TransactionBuilder(sdkAccount, {
    fee: config.baseFee,
    networkPassphrase: config.networkPassphrase,
    timebounds: {
      minTime: 0,
      // SDK timebounds are unix SECONDS; flushTime is ms epoch.
      maxTime: Math.floor(params.flushTime / 1000) + intent.timeBounds.maxAgeSeconds,
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
