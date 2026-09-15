/**
 * Scriptable `Signer` fake (Phase 7 test substrate).
 *
 * Produces **genuinely signed envelopes** via the SDK — `Transaction.sign`
 * with a random in-test `Keypair`, so `tx.hash()` and the engine's network
 * check run against real signed output — while letting tests inject the
 * failure modes the pipeline must handle:
 *
 * - `reject` — the signer throws/rejects (deterministic `signer-rejected`
 *   failure; no side effects).
 * - `malformed-network` — the signer returns an envelope built for a
 *   different network (`signer-malformed` failure).
 * - `rejectOnce()` — reject exactly the next signing request, then succeed.
 *
 * The fake records how many envelopes it signed; tests assert zero signings
 * on aborted paths.
 */

import {
  Account,
  Keypair,
  Networks,
  Operation,
  Asset,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import type { Signer, SigningContext } from '../../src/signer.js';

/** Build a real, signed one-op payment transaction (independent of the queue builder). */
export function buildSignedTransaction(networkPassphrase: string = Networks.TESTNET): Transaction {
  const source = Keypair.random();
  const builder = new TransactionBuilder(new Account(source.publicKey(), '100'), {
    fee: '100',
    networkPassphrase,
    timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
  });
  builder.addOperation(
    Operation.payment({
      destination: Keypair.random().publicKey(),
      asset: Asset.native(),
      amount: '1.0000000',
    }),
  );
  const tx = builder.build();
  tx.sign(source);
  return tx;
}

export type FakeSignerMode = 'success' | 'reject' | 'malformed-network';

export class FakeSigner implements Signer {
  /** Current behaviour mode. */
  mode: FakeSignerMode = 'success';

  /** Number of envelopes actually signed (successful or malformed). */
  signedCount = 0;

  /** Number of rejected signing requests. */
  rejectedCount = 0;

  /** Envelope hashes of successfully signed transactions, in order. */
  readonly signedHashes: string[] = [];

  private rejectNext = false;

  /**
   * Sign the given draft with a random in-test keypair. The result is a real
   * signed envelope for `context.networkPassphrase` (or the wrong network in
   * `malformed-network` mode); the envelope hash is the hash the engine
   * journals and submits (Stellar hashes exclude signatures, so signing does
   * not change `tx.hash()`).
   */
  async sign(transaction: Transaction, context: SigningContext): Promise<Transaction> {
    await Promise.resolve(); // real signers are async; keep the shape
    if (this.rejectNext) {
      this.rejectNext = false;
      this.rejectedCount += 1;
      throw new Error('signer rejected this request once (scripted)');
    }
    switch (this.mode) {
      case 'reject':
        this.rejectedCount += 1;
        throw new Error('signer rejected the transaction (scripted)');

      case 'malformed-network': {
        this.signedCount += 1;
        // Build a fully-formed envelope for the WRONG network: same passphrase
        // family as requested, but never the requested one itself.
        const testnetPassphrase: string = Networks.TESTNET;
        const wrongPassphrase =
          context.networkPassphrase === testnetPassphrase ? Networks.PUBLIC : Networks.TESTNET;
        const builder = new TransactionBuilder(new Account(Keypair.random().publicKey(), '100'), {
          fee: '100',
          networkPassphrase: wrongPassphrase,
          timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
        });
        builder.addOperation(
          Operation.payment({
            destination: Keypair.random().publicKey(),
            asset: Asset.native(),
            amount: '1.0000000',
          }),
        );
        const wrong = builder.build();
        wrong.sign(Keypair.random());
        return wrong;
      }

      case 'success':
      default: {
        this.signedCount += 1;
        transaction.sign(Keypair.random());
        this.signedHashes.push(Buffer.from(transaction.hash()).toString('hex'));
        return transaction;
      }
    }
  }

  /** Reject exactly the next signing request, then behave as `success`. */
  rejectOnce(): this {
    this.rejectNext = true;
    return this;
  }

  /** Reset counters and logs (keep the mode). */
  reset(): void {
    this.signedCount = 0;
    this.rejectedCount = 0;
    this.signedHashes.length = 0;
    this.rejectNext = false;
  }
}
