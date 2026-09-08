/**
 * Phase 1 / Issue #2 unit tests: the core domain model.
 *
 * Coverage per implementation plan §Phase 1 Tests:
 * - Validation matrix per field (addresses, assets, amounts, memos, time
 *   bounds, operations, metadata, id).
 * - Normalization (defaults applied, asset shorthand parsing, UUIDv4 id).
 * - payloadHash stability (same input → same hash; payload changes → different
 *   hash; id/metadata/createdAt changes → same hash) + canonical key order.
 * - JSON round-trip preserving payloadHash byte-for-byte.
 * - `createPaymentIntent` factory mapping flat fields to one `payment` op.
 * - Zero network: no adapter is involved anywhere in this module.
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  computePayloadHash,
  createIntent,
  createPaymentIntent,
  deserializeIntent,
  isValidAmount,
  parseAssetLike,
  serializeIntent,
  validateCreateIntentInput,
  DEFAULT_MAX_AGE_SECONDS,
  MIN_MAX_AGE_SECONDS,
  MAX_MAX_AGE_SECONDS,
  MAX_OPERATIONS,
  MAX_ID_LENGTH,
  MEMO_TEXT_MAX_BYTES,
} from '../../src/intent.js';
import type { OperationConfig, MemoConfig } from '../../src/intent.js';
import { ValidationError } from '../../src/errors.js';
import {
  validAccountId,
  otherAccountId,
  validIntentInput,
  validIntent,
  issuedAsset,
  expectValidationError,
} from '../helpers/factories.js';

// ---------------------------------------------------------------------------
// Validation matrix
// ---------------------------------------------------------------------------

describe('validateCreateIntentInput — id', () => {
  it('accepts an app-supplied id', () => {
    const out = validateCreateIntentInput(validIntentInput({ id: 'invoice-42' }));
    expect(out.id).toBe('invoice-42');
  });

  it('accepts no id (generated later)', () => {
    const out = validateCreateIntentInput(validIntentInput());
    expect(out.id).toBeUndefined();
  });

  it('rejects an empty id', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ id: '' })),
      'invalid-id',
      'id',
    );
  });

  it('rejects an id longer than 128 chars', () => {
    const long = 'a'.repeat(MAX_ID_LENGTH + 1);
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ id: long })),
      'invalid-id',
      'id',
    );
  });

  it('rejects non-printable / non-ASCII ids', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ id: 'has\nnewline' })),
      'invalid-id',
      'id',
    );
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ id: 'héllo' })),
      'invalid-id',
      'id',
    );
  });
});

describe('validateCreateIntentInput — sourceAccount', () => {
  it('accepts a valid G… address', () => {
    const out = validateCreateIntentInput(validIntentInput());
    expect(out.sourceAccount).toBe(validAccountId);
  });

  it('rejects a non-address', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ sourceAccount: 'not-an-address' })),
      'invalid-address',
      'sourceAccount',
    );
  });

  it('rejects a secret seed instead of a public key', () => {
    // The all-zero seed (publicly derivable, worthless by construction) — proves
    // a *valid* seed strkey is rejected for not being a public key.
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            sourceAccount: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSU2',
          }),
        ),
      'invalid-address',
      'sourceAccount',
    );
  });
});

describe('validateCreateIntentInput — operations', () => {
  it('accepts a single payment op', () => {
    const out = validateCreateIntentInput(validIntentInput());
    expect(out.operations).toHaveLength(1);
    expect(out.operations[0]).toMatchObject({ type: 'payment' });
  });

  it('rejects an empty operations array', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ operations: [] })),
      'invalid-operation',
      'operations',
    );
  });

  it('rejects more than 100 operations', () => {
    const ops = Array.from({ length: MAX_OPERATIONS + 1 }, () => ({
      type: 'payment',
      destination: otherAccountId,
      asset: { code: 'XLM' },
      amount: '1',
    }));
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ operations: ops as unknown as OperationConfig[] }),
        ),
      'invalid-operation',
      'operations',
    );
  });

  it('accepts exactly 100 operations', () => {
    const ops = Array.from({ length: MAX_OPERATIONS }, () => ({
      type: 'payment',
      destination: otherAccountId,
      asset: { code: 'XLM' },
      amount: '1',
    }));
    const out = validateCreateIntentInput(
      validIntentInput({ operations: ops as unknown as OperationConfig[] }),
    );
    expect(out.operations).toHaveLength(MAX_OPERATIONS);
  });

  it('rejects an unsupported operation type', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ operations: [{ type: 'bogus' }] as unknown as OperationConfig[] }),
        ),
      'unsupported-operation',
      'operations[0].type',
    );
  });

  it('rejects a missing operation type', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [{ destination: otherAccountId }] as unknown as OperationConfig[],
          }),
        ),
      'invalid-operation',
      'operations[0].type',
    );
  });

  it('rejects an operation with an invalid destination', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [
              { type: 'payment', destination: 'bad', asset: { code: 'XLM' }, amount: '1' },
            ],
          }),
        ),
      'invalid-address',
      'operations[0].destination',
    );
  });
});

describe('validateCreateIntentInput — assets', () => {
  it('accepts native XLM', () => {
    const out = validateCreateIntentInput(validIntentInput());
    expect(out.operations[0]).toMatchObject({ asset: { code: 'XLM' } });
  });

  it('normalizes XLM casing to uppercase', () => {
    const out = validateCreateIntentInput(
      validIntentInput({
        operations: [
          { type: 'payment', destination: otherAccountId, asset: { code: 'xlm' }, amount: '1' },
        ],
      }),
    );
    expect(out.operations[0]).toMatchObject({ asset: { code: 'XLM' } });
  });

  it('accepts an issued asset with a valid issuer', () => {
    const out = validateCreateIntentInput(
      validIntentInput({
        operations: [
          { type: 'payment', destination: otherAccountId, asset: issuedAsset(), amount: '1' },
        ],
      }),
    );
    expect(out.operations[0]).toMatchObject({ asset: { code: 'USDC', issuer: otherAccountId } });
  });

  it('rejects an asset code with invalid characters', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [
              {
                type: 'payment',
                destination: otherAccountId,
                asset: { code: 'US$C', issuer: otherAccountId },
                amount: '1',
              },
            ],
          }),
        ),
      'invalid-asset',
      'operations[0].asset.code',
    );
  });

  it('rejects an asset code longer than 12 chars', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [
              {
                type: 'payment',
                destination: otherAccountId,
                asset: { code: 'ABCDEFGHIJKLM', issuer: otherAccountId },
                amount: '1',
              },
            ],
          }),
        ),
      'invalid-asset',
      'operations[0].asset.code',
    );
  });

  it('rejects an issued asset with an invalid issuer', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [
              {
                type: 'payment',
                destination: otherAccountId,
                asset: { code: 'USDC', issuer: 'nope' },
                amount: '1',
              },
            ],
          }),
        ),
      'invalid-asset',
      'operations[0].asset.issuer',
    );
  });

  it('rejects XLM with an issuer', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [
              {
                type: 'payment',
                destination: otherAccountId,
                asset: { code: 'XLM', issuer: otherAccountId },
                amount: '1',
              },
            ],
          }),
        ),
      'invalid-asset',
      'operations[0].asset.issuer',
    );
  });

  it('rejects a non-object asset', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [
              {
                type: 'payment',
                destination: otherAccountId,
                asset: 'XLM',
                amount: '1',
              } as unknown as OperationConfig,
            ],
          }),
        ),
      'invalid-asset',
      'operations[0].asset',
    );
  });
});

describe('validateCreateIntentInput — amounts', () => {
  const paymentWith = (amount: unknown) =>
    validIntentInput({
      operations: [
        {
          type: 'payment',
          destination: otherAccountId,
          asset: { code: 'XLM' },
          amount: amount as string,
        },
      ],
    });

  it('accepts a plain integer string', () => {
    expect(validateCreateIntentInput(paymentWith('10')).operations[0]).toMatchObject({
      amount: '10',
    });
  });

  it('accepts a decimal string with ≤ 7 places', () => {
    expect(validateCreateIntentInput(paymentWith('0.0000001')).operations[0]).toMatchObject({
      amount: '0.0000001',
    });
  });

  it('rejects zero', () => {
    expectValidationError(
      () => validateCreateIntentInput(paymentWith('0')),
      'invalid-amount',
      'operations[0].amount',
    );
  });

  it('rejects negative', () => {
    expectValidationError(
      () => validateCreateIntentInput(paymentWith('-1')),
      'invalid-amount',
      'operations[0].amount',
    );
  });

  it('rejects more than 7 decimal places', () => {
    expectValidationError(
      () => validateCreateIntentInput(paymentWith('1.00000005')),
      'invalid-amount',
      'operations[0].amount',
    );
  });

  it('rejects a non-string amount', () => {
    expectValidationError(
      () => validateCreateIntentInput(paymentWith(10)),
      'invalid-amount',
      'operations[0].amount',
    );
    expectValidationError(
      () => validateCreateIntentInput(paymentWith(NaN)),
      'invalid-amount',
      'operations[0].amount',
    );
  });

  it('rejects overflow beyond MAX_INT64', () => {
    expectValidationError(
      () => validateCreateIntentInput(paymentWith('9223372036854775808')),
      'invalid-amount',
      'operations[0].amount',
    );
  });

  it('accepts allowZero fields (createAccount.startingBalance, changeTrust.limit, offer amount)', () => {
    const input = validIntentInput({
      operations: [
        { type: 'createAccount', destination: otherAccountId, startingBalance: '0' },
        { type: 'changeTrust', asset: issuedAsset(), limit: '0' },
        {
          type: 'manageSellOffer',
          selling: { code: 'XLM' },
          buying: issuedAsset(),
          amount: '0',
          price: { n: 1, d: 1 },
        },
      ],
    });
    const out = validateCreateIntentInput(input);
    expect(out.operations).toHaveLength(3);
  });
});

describe('validateCreateIntentInput — memo', () => {
  it('accepts no memo', () => {
    const out = validateCreateIntentInput(validIntentInput());
    expect(out.memo).toBeUndefined();
  });

  it('accepts a text memo within 28 bytes', () => {
    const out = validateCreateIntentInput(
      validIntentInput({ memo: { type: 'text', value: 'invoice-42' } }),
    );
    expect(out.memo).toEqual({ type: 'text', value: 'invoice-42' });
  });

  it('rejects a text memo longer than 28 bytes (UTF-8 sensitive)', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ memo: { type: 'text', value: 'é'.repeat(MEMO_TEXT_MAX_BYTES) } }),
        ),
      'invalid-memo',
      'memo.value',
    );
  });

  it('accepts an id memo at uint64 max', () => {
    const out = validateCreateIntentInput(
      validIntentInput({ memo: { type: 'id', value: '18446744073709551615' } }),
    );
    expect(out.memo).toEqual({ type: 'id', value: '18446744073709551615' });
  });

  it('rejects an id memo beyond uint64 max', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ memo: { type: 'id', value: '18446744073709551616' } }),
        ),
      'invalid-memo',
      'memo.value',
    );
  });

  it('rejects a negative id memo', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ memo: { type: 'id', value: '-1' } })),
      'invalid-memo',
      'memo.value',
    );
  });

  it('rejects a non-integer id memo', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ memo: { type: 'id', value: '1.5' } })),
      'invalid-memo',
      'memo.value',
    );
  });

  it('accepts a hash memo (32 bytes hex)', () => {
    const hex = 'ab'.repeat(32);
    const out = validateCreateIntentInput(validIntentInput({ memo: { type: 'hash', value: hex } }));
    expect(out.memo).toEqual({ type: 'hash', value: hex });
  });

  it('rejects a hash memo that is not 32 bytes', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ memo: { type: 'hash', value: 'abcd' } })),
      'invalid-memo',
      'memo.value',
    );
  });

  it('rejects an unknown memo type', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ memo: { type: 'none', value: '' } as unknown as MemoConfig }),
        ),
      'invalid-memo',
      'memo.type',
    );
  });
});

describe('validateCreateIntentInput — timeBounds', () => {
  it('defaults maxAgeSeconds to 300 when omitted', () => {
    const out = validateCreateIntentInput(validIntentInput());
    expect(out.timeBounds).toEqual({ maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS });
  });

  it('defaults maxAgeSeconds to 300 when timeBounds omitted entirely', () => {
    const base = validIntentInput();
    const rest: Omit<typeof base, 'timeBounds'> = {
      sourceAccount: base.sourceAccount,
      operations: base.operations,
    };
    if (base.id !== undefined) rest.id = base.id;
    if (base.memo !== undefined) rest.memo = base.memo;
    if (base.metadata !== undefined) rest.metadata = base.metadata;
    const out = validateCreateIntentInput(rest);
    expect(out.timeBounds).toEqual({ maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS });
  });

  it('accepts an explicit value within bounds', () => {
    const out = validateCreateIntentInput(validIntentInput({ timeBounds: { maxAgeSeconds: 120 } }));
    expect(out.timeBounds).toEqual({ maxAgeSeconds: 120 });
  });

  it('rejects below the floor', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ timeBounds: { maxAgeSeconds: MIN_MAX_AGE_SECONDS - 1 } }),
        ),
      'invalid-time-bounds',
      'timeBounds.maxAgeSeconds',
    );
  });

  it('rejects above the cap', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ timeBounds: { maxAgeSeconds: MAX_MAX_AGE_SECONDS + 1 } }),
        ),
      'invalid-time-bounds',
      'timeBounds.maxAgeSeconds',
    );
  });

  it('rejects a non-integer', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ timeBounds: { maxAgeSeconds: 60.5 } })),
      'invalid-time-bounds',
      'timeBounds.maxAgeSeconds',
    );
  });
});

describe('validateCreateIntentInput — metadata', () => {
  it('accepts a plain JSON-safe object', () => {
    const out = validateCreateIntentInput(
      validIntentInput({ metadata: { orderId: '123', tags: ['a', 'b'], nested: { x: 1 } } }),
    );
    expect(out.metadata).toEqual({ orderId: '123', tags: ['a', 'b'], nested: { x: 1 } });
  });

  it('accepts no metadata', () => {
    const out = validateCreateIntentInput(validIntentInput());
    expect(out.metadata).toBeUndefined();
  });

  it('rejects non-object metadata', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ metadata: 'nope' as unknown as Record<string, unknown> }),
        ),
      'invalid-metadata',
      'metadata',
    );
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({ metadata: [1, 2] as unknown as Record<string, unknown> }),
        ),
      'invalid-metadata',
      'metadata',
    );
  });

  it('rejects NaN/Infinity in metadata', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ metadata: { x: NaN } })),
      'invalid-metadata',
      'metadata.x',
    );
  });

  it('rejects functions in metadata', () => {
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ metadata: { x: () => 1 } })),
      'invalid-metadata',
      'metadata.x',
    );
  });

  it('rejects circular metadata', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectValidationError(
      () => validateCreateIntentInput(validIntentInput({ metadata: circular })),
      'invalid-metadata',
      'metadata',
    );
  });
});

describe('validateCreateIntentInput — setOptions subset', () => {
  it('accepts the full V1 subset', () => {
    const out = validateCreateIntentInput(
      validIntentInput({
        operations: [
          {
            type: 'setOptions',
            inflationDest: otherAccountId,
            homeDomain: 'example.com',
            signer: { ed25519PublicKey: otherAccountId, weight: 1 },
            thresholds: { masterWeight: 1, lowThreshold: 1, medThreshold: 2, highThreshold: 2 },
          },
        ],
      }),
    );
    expect(out.operations[0]).toMatchObject({ type: 'setOptions' });
  });

  it('rejects an invalid signer key', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [{ type: 'setOptions', signer: { ed25519PublicKey: 'bad', weight: 1 } }],
          }),
        ),
      'invalid-address',
      'operations[0].signer.ed25519PublicKey',
    );
  });

  it('rejects a signer weight outside 0–255', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [
              { type: 'setOptions', signer: { ed25519PublicKey: otherAccountId, weight: 256 } },
            ],
          }),
        ),
      'invalid-operation',
      'operations[0].signer.weight',
    );
  });

  it('rejects a threshold outside 0–255', () => {
    expectValidationError(
      () =>
        validateCreateIntentInput(
          validIntentInput({
            operations: [{ type: 'setOptions', thresholds: { medThreshold: -1 } }],
          }),
        ),
      'invalid-operation',
      'operations[0].thresholds.medThreshold',
    );
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('normalization', () => {
  it('applies defaults deterministically (same input → same normalized output)', () => {
    const a = validateCreateIntentInput(validIntentInput());
    const b = validateCreateIntentInput(validIntentInput());
    expect(a).toEqual(b);
  });

  it('preserves amount strings exactly (no float rounding)', () => {
    const amount = '0.1234567';
    const out = validateCreateIntentInput(
      validIntentInput({
        operations: [
          { type: 'payment', destination: otherAccountId, asset: { code: 'XLM' }, amount },
        ],
      }),
    );
    expect(out.operations[0]).toMatchObject({ amount });
  });

  it('uppercases asset codes', () => {
    const out = validateCreateIntentInput(
      validIntentInput({
        operations: [
          {
            type: 'payment',
            destination: otherAccountId,
            asset: { code: 'usdc', issuer: otherAccountId },
            amount: '1',
          },
        ],
      }),
    );
    expect(out.operations[0]).toMatchObject({ asset: { code: 'USDC', issuer: otherAccountId } });
  });
});

// ---------------------------------------------------------------------------
// createIntent
// ---------------------------------------------------------------------------

describe('createIntent', () => {
  it('generates a UUIDv4-shaped id when none is supplied', () => {
    const intent = createIntent(validIntentInput());
    expect(intent.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps an app-supplied id', () => {
    const intent = createIntent(validIntentInput({ id: 'my-id' }));
    expect(intent.id).toBe('my-id');
  });

  it('records createdAt from the injected clock', () => {
    const intent = createIntent(validIntentInput(), 1_700_000_000_000);
    expect(intent.createdAt).toBe(1_700_000_000_000);
  });

  it('computes a 64-char hex payloadHash', () => {
    const intent = validIntent();
    expect(intent.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws ValidationError (not raw Error) for invalid input', () => {
    try {
      createIntent(validIntentInput({ sourceAccount: 'bad' }));
      throw new Error('expected ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('invalid-address');
    }
  });
});

// ---------------------------------------------------------------------------
// payloadHash stability & canonical JSON
// ---------------------------------------------------------------------------

describe('payloadHash stability', () => {
  it('same input → same hash', () => {
    expect(validIntent().payloadHash).toBe(validIntent().payloadHash);
  });

  it('different sourceAccount → different hash', () => {
    const a = validIntent();
    const b = validIntent({ sourceAccount: otherAccountId });
    expect(b.payloadHash).not.toBe(a.payloadHash);
  });

  it('different operation → different hash', () => {
    const a = validIntent();
    const b = validIntent({
      operations: [
        { type: 'payment', destination: otherAccountId, asset: { code: 'XLM' }, amount: '10.51' },
      ],
    });
    expect(b.payloadHash).not.toBe(a.payloadHash);
  });

  it('different memo → different hash', () => {
    const a = validIntent();
    const b = validIntent({ memo: { type: 'text', value: 'other' } });
    expect(b.payloadHash).not.toBe(a.payloadHash);
  });

  it('different timeBounds → different hash', () => {
    const a = validIntent();
    const b = validIntent({ timeBounds: { maxAgeSeconds: 120 } });
    expect(b.payloadHash).not.toBe(a.payloadHash);
  });

  it('different id → same hash', () => {
    const a = validIntent({ id: 'a' });
    const b = validIntent({ id: 'b' });
    expect(b.payloadHash).toBe(a.payloadHash);
  });

  it('different createdAt → same hash', () => {
    const a = validIntent({}, 1);
    const b = validIntent({}, 2);
    expect(b.payloadHash).toBe(a.payloadHash);
  });

  it('different metadata → same hash', () => {
    const a = validIntent({ metadata: { x: 1 } });
    const b = validIntent({ metadata: { x: 2 } });
    expect(b.payloadHash).toBe(a.payloadHash);
  });

  it('is stable across object key insertion order', () => {
    const base = validIntentInput();
    const ops = base.operations[0] as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const key of ['amount', 'asset', 'destination', 'type']) reordered[key] = ops[key];
    const a = computePayloadHash({
      sourceAccount: base.sourceAccount,
      operations: base.operations,
      memo: base.memo,
      timeBounds: { maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS },
    });
    const b = computePayloadHash({
      sourceAccount: base.sourceAccount,
      operations: [reordered] as unknown as OperationConfig[],
      memo: base.memo,
      timeBounds: { maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS },
    });
    expect(b).toBe(a);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('is independent of insertion order', () => {
    const a: Record<string, unknown> = {};
    a.x = 1;
    a.y = 2;
    const b: Record<string, unknown> = {};
    b.y = 2;
    b.x = 1;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('stringifies arrays in order', () => {
    expect(canonicalJson({ list: ['b', 'a'] })).toBe('{"list":["b","a"]}');
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe('serializeIntent / deserializeIntent', () => {
  it('round-trips preserving payloadHash byte-for-byte', () => {
    const intent = validIntent({ memo: { type: 'text', value: 'rt' }, metadata: { k: 'v' } });
    const restored = deserializeIntent(serializeIntent(intent));
    expect(restored).toEqual(intent);
    expect(restored.payloadHash).toBe(intent.payloadHash);
  });

  it('rejects invalid JSON', () => {
    expectValidationError(() => deserializeIntent('not json'), 'invalid-serialized-intent');
  });

  it('rejects a missing required field', () => {
    const intent = validIntent();
    const rest: Record<string, unknown> = {
      id: intent.id,
      sourceAccount: intent.sourceAccount,
      operations: intent.operations,
      timeBounds: intent.timeBounds,
      createdAt: intent.createdAt,
    };
    expectValidationError(
      () => deserializeIntent(JSON.stringify(rest)),
      'invalid-serialized-intent',
    );
  });

  it('rejects a tampered payload (hash mismatch)', () => {
    const intent = validIntent();
    const tampered = { ...intent, operations: [{ ...intent.operations[0], amount: '999' }] };
    expectValidationError(
      () => deserializeIntent(JSON.stringify(tampered)),
      'invalid-serialized-intent',
    );
  });

  it('rejects a tampered hash field itself', () => {
    const intent = validIntent();
    const tampered = { ...intent, payloadHash: '0'.repeat(64) };
    expectValidationError(
      () => deserializeIntent(JSON.stringify(tampered)),
      'invalid-serialized-intent',
    );
  });
});

// ---------------------------------------------------------------------------
// createPaymentIntent factory
// ---------------------------------------------------------------------------

describe('createPaymentIntent', () => {
  it('maps flat fields to a single payment op', () => {
    const input = createPaymentIntent({
      source: validAccountId,
      destination: otherAccountId,
      asset: 'XLM',
      amount: '42.5',
      memo: { type: 'text', value: 'invoice' },
      metadata: { order: 1 },
    });
    expect(input.sourceAccount).toBe(validAccountId);
    expect(input.operations).toEqual([
      { type: 'payment', destination: otherAccountId, asset: { code: 'XLM' }, amount: '42.5' },
    ]);
    expect(input.memo).toEqual({ type: 'text', value: 'invoice' });
    expect(input.metadata).toEqual({ order: 1 });
    expect(input.timeBounds).toBeUndefined();
  });

  it('parses issued asset shorthand CODE:ISSUER', () => {
    const input = createPaymentIntent({
      source: validAccountId,
      destination: otherAccountId,
      asset: `USDC:${otherAccountId}`,
      amount: '1',
    });
    expect(input.operations[0]).toMatchObject({ asset: { code: 'USDC', issuer: otherAccountId } });
  });

  it('accepts a structured asset object', () => {
    const input = createPaymentIntent({
      source: validAccountId,
      destination: otherAccountId,
      asset: issuedAsset(),
      amount: '1',
    });
    expect(input.operations[0]).toMatchObject({ asset: { code: 'USDC', issuer: otherAccountId } });
  });

  it('rejects malformed asset shorthand', () => {
    expectValidationError(
      () =>
        createPaymentIntent({
          source: validAccountId,
          destination: otherAccountId,
          asset: 'USDC',
          amount: '1',
        }),
      'invalid-asset-shorthand',
      'asset',
    );
    expectValidationError(
      () =>
        createPaymentIntent({
          source: validAccountId,
          destination: otherAccountId,
          asset: `USDC:bad-issuer`,
          amount: '1',
        }),
      'invalid-asset-shorthand',
      'asset',
    );
  });

  it('produces input that passes full validation', () => {
    const input = createPaymentIntent({
      id: 'custom-id',
      source: validAccountId,
      destination: otherAccountId,
      asset: 'XLM',
      amount: '0.0000001',
    });
    const validated = validateCreateIntentInput(input);
    expect(validated.id).toBe('custom-id');
    expect(validated.operations).toHaveLength(1);
    expect(validated.operations[0]).toMatchObject({ type: 'payment' });
  });

  it('is pure: validation still runs once at addIntent (no hashing here)', () => {
    const input = createPaymentIntent({
      source: validAccountId,
      destination: otherAccountId,
      asset: 'XLM',
      amount: '1',
    });
    // The factory output has no payloadHash/createdAt — those are derived later.
    expect(input).not.toHaveProperty('payloadHash');
    expect(input).not.toHaveProperty('createdAt');
  });
});

// ---------------------------------------------------------------------------
// isValidAmount (SDK parity)
// ---------------------------------------------------------------------------

describe('isValidAmount', () => {
  it('matches SDK semantics', () => {
    expect(isValidAmount('10')).toBe(true);
    expect(isValidAmount('0.0000001')).toBe(true);
    expect(isValidAmount('0')).toBe(false);
    expect(isValidAmount('0', true)).toBe(true);
    expect(isValidAmount('-1')).toBe(false);
    expect(isValidAmount('1.00000005')).toBe(false);
    expect(isValidAmount('9223372036854775807')).toBe(true);
    expect(isValidAmount('9223372036854775808')).toBe(false);
    expect(isValidAmount('abc')).toBe(false);
    expect(isValidAmount('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAssetLike
// ---------------------------------------------------------------------------

describe('parseAssetLike', () => {
  it('parses native and issued shorthand', () => {
    expect(parseAssetLike('XLM')).toEqual({ code: 'XLM' });
    expect(parseAssetLike('xlm')).toEqual({ code: 'XLM' });
    expect(parseAssetLike(`USDC:${otherAccountId}`)).toEqual({
      code: 'USDC',
      issuer: otherAccountId,
    });
  });

  it('validates structured assets', () => {
    expect(parseAssetLike(issuedAsset())).toEqual({ code: 'USDC', issuer: otherAccountId });
  });

  it('rejects malformed shorthand', () => {
    expectValidationError(() => parseAssetLike('USDC'), 'invalid-asset-shorthand', 'asset');
    expectValidationError(() => parseAssetLike(':issuer'), 'invalid-asset-shorthand', 'asset');
    expectValidationError(() => parseAssetLike('USDC:'), 'invalid-asset-shorthand', 'asset');
  });
});
