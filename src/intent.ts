/**
 * Core domain model (Phase 1 / Issue #2).
 *
 * The immutable `Intent` is the durable "what" every downstream layer consumes:
 * validated at enqueue time, integrity-protected by a canonical-JSON payload
 * hash, and never mutated after creation. This module is fully offline — it
 * only imports value/type utilities from `@stellar/stellar-sdk` (StrKey, Asset,
 * Memo), never network clients.
 *
 * Model contract: ADR-0001, architecture §5.1–5.2, §9.4. Numeric defaults:
 * ADR-0010 (`timeBounds.maxAgeSeconds` default 300, floor 60, cap 86400).
 * Every SDK primitive below is verified against the installed v17 typings.
 */

import { createHash, randomUUID } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { StrKey } from '@stellar/stellar-sdk';
import { ValidationError } from './errors.js';
import type { ValidationErrorCode } from './errors.js';

// ---------------------------------------------------------------------------
// Constants (ADR-0010 + protocol limits)
// ---------------------------------------------------------------------------

/** Default relative validity window when `timeBounds` is omitted (ADR-0010 #3). */
export const DEFAULT_MAX_AGE_SECONDS = 300;
/** Floor for `maxAgeSeconds` — prevents envelopes born expired (ADR-0010 #3). */
export const MIN_MAX_AGE_SECONDS = 60;
/** Documented sanity cap for `maxAgeSeconds`. */
export const MAX_MAX_AGE_SECONDS = 86_400;
/** Protocol limit on operations per transaction. */
export const MAX_OPERATIONS = 100;
/** `id` limits: non-empty, printable ASCII, ≤ 128 chars. */
export const MAX_ID_LENGTH = 128;
/** Memo text limit: 28 bytes UTF-8 (SDK `Memo._validateTextValue`). */
export const MEMO_TEXT_MAX_BYTES = 28;
/** Memo hash/return: 32 bytes (64 hex chars), SDK `Memo._validateHashValue`. */
export const MEMO_HASH_BYTES = 32;
/** Memo id is an unsigned 64-bit integer (SDK `Memo._validateIdValue`). */
export const MEMO_ID_MAX = '18446744073709551615';
/** Amount precision: at most 7 decimal places (SDK `isValidAmount` semantics). */
export const AMOUNT_MAX_DECIMAL_PLACES = 7;
/** Max value of an int64 (SDK `isValidAmount` caps amounts at MAX_INT64). */
export const AMOUNT_MAX_INT64 = '9223372036854775807';

// ---------------------------------------------------------------------------
// Types (ADR-0001 / architecture §5.1–5.2)
// ---------------------------------------------------------------------------

/** Transaction-level memo. `none` is expressed by absence. */
export type MemoConfig =
  | { type: 'text'; value: string }
  | { type: 'id'; value: string }
  | { type: 'hash'; value: string }
  | { type: 'return'; value: string };

/** Asset reference as stored on operation configs. */
export type AssetConfig = { code: string; issuer?: string };

/** `setOptions` signer entry (V1 subset: Ed25519 signer keys only). */
export type SetOptionsSignerConfig = {
  ed25519PublicKey: string;
  weight: number;
};

/** Thresholds are unsigned bytes (0–255), matching SDK `weightCheckFunction`. */
export type ThresholdConfig = {
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
};

/**
 * Discriminated union of supported V1 operation configs (architecture §5.2).
 * Field names mirror the SDK operation descriptor names (verified against the
 * installed v17 typings): `payment`, `createAccount`, `pathPaymentStrictSend`,
 * `pathPaymentStrictReceive`, `changeTrust`, `manageSellOffer`,
 * `manageBuyOffer`, `setOptions` (V1 subset).
 */
export type OperationConfig =
  | {
      type: 'payment';
      destination: string;
      asset: AssetConfig;
      amount: string;
    }
  | {
      type: 'createAccount';
      destination: string;
      startingBalance: string;
    }
  | {
      type: 'pathPaymentStrictSend';
      destination: string;
      sendAsset: AssetConfig;
      sendAmount: string;
      destAsset: AssetConfig;
      destMin: string;
      path?: AssetConfig[];
    }
  | {
      type: 'pathPaymentStrictReceive';
      destination: string;
      sendAsset: AssetConfig;
      sendMax: string;
      destAsset: AssetConfig;
      destAmount: string;
      path?: AssetConfig[];
    }
  | {
      type: 'changeTrust';
      asset: AssetConfig;
      limit?: string;
    }
  | {
      type: 'manageSellOffer';
      selling: AssetConfig;
      buying: AssetConfig;
      amount: string;
      price: { n: number; d: number };
      offerId?: string;
    }
  | {
      type: 'manageBuyOffer';
      selling: AssetConfig;
      buying: AssetConfig;
      buyAmount: string;
      price: { n: number; d: number };
      offerId?: string;
    }
  | {
      type: 'setOptions';
      inflationDest?: string;
      homeDomain?: string;
      signer?: SetOptionsSignerConfig;
      thresholds?: ThresholdConfig;
    };

/** Input for `createIntent` — the immutable intent minus derived fields. */
export type CreateIntentInput = {
  id?: string;
  sourceAccount: string;
  operations: OperationConfig[];
  memo?: MemoConfig;
  timeBounds?: { maxAgeSeconds?: number };
  metadata?: Record<string, unknown>;
};

/**
 * The normalized form of a `CreateIntentInput`: `timeBounds` is materialized
 * with its default and every field is validated. This is what
 * `validateCreateIntentInput` returns and `createIntent` consumes.
 */
export type NormalizedCreateIntentInput = {
  id?: string;
  sourceAccount: string;
  operations: OperationConfig[];
  memo?: MemoConfig;
  timeBounds: { maxAgeSeconds: number };
  metadata?: Record<string, unknown>;
};

/** The immutable, validated, hash-protected intent (ADR-0001). */
export type Intent = {
  id: string;
  sourceAccount: string;
  operations: OperationConfig[];
  memo?: MemoConfig;
  timeBounds: { maxAgeSeconds: number };
  metadata?: Record<string, unknown>;
  createdAt: number;
  payloadHash: string;
};

/** Flat convenience input for `createPaymentIntent` (architecture §10). */
export type CreatePaymentIntentInput = {
  id?: string;
  source: string;
  destination: string;
  asset: AssetLike;
  amount: string;
  memo?: MemoConfig;
  metadata?: Record<string, unknown>;
};

/** Asset shorthand: native `XLM` or issued `CODE:ISSUER`. */
export type AssetLike = string | { code: string; issuer?: string };

// ---------------------------------------------------------------------------
// Canonical JSON (T1.5)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON stringify: object keys sorted recursively, no whitespace.
 * Insertion order of the *input* object is irrelevant — the output is a pure
 * function of the key/value structure. Used for payload hashing only.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      {
        const entries: Array<[string, unknown]> = [];
        for (const [key, val] of Object.entries(value)) {
          // JSON.stringify semantics: undefined-valued object keys are dropped.
          if (val === undefined) continue;
          entries.push([key, val]);
        }
        entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const body = entries
          .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
          .join(',');
        return `{${body}}`;
      }
    default:
      // Functions/symbols are not JSON-safe; the payload core is validated
      // before hashing, so this is unreachable for valid input.
      throw new ValidationError('invalid-metadata', 'value is not JSON-safe', undefined);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ID_RE = /^[\x20-\x7E]+$/;
const ASSET_CODE_RE = /^[a-zA-Z0-9]{1,12}$/;
const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;

/**
 * Matches the SDK's `isValidAmount` (not exported; semantics verified against
 * the installed v17 source): string, > 0 (or ≥ 0 with `allowZero`), ≤ 7
 * decimal places, finite, and ≤ MAX_INT64.
 */
export function isValidAmount(value: string, allowZero = false): boolean {
  if (typeof value !== 'string' || value.length === 0 || !DECIMAL_RE.test(value)) {
    return false;
  }
  const dot = value.indexOf('.');
  if (dot !== -1 && value.length - dot - 1 > AMOUNT_MAX_DECIMAL_PLACES) {
    return false;
  }
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return false;
  if (asNumber === 0) return allowZero;
  if (asNumber < 0) return false;
  // Cap at MAX_INT64 like the SDK (BigNumber comparison against MAX_INT64).
  const [whole] = value.split('.');
  if (whole !== undefined && whole.length > AMOUNT_MAX_INT64.length) return false;
  if (whole !== undefined && whole.length === AMOUNT_MAX_INT64.length && whole > AMOUNT_MAX_INT64) {
    return false;
  }
  return true;
}

function invalid(code: ValidationErrorCode, message: string, field?: string): never {
  throw new ValidationError(code, message, field);
}

function assertRecord(
  value: unknown,
  field: string,
  code: ValidationErrorCode = 'invalid-metadata',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(code, `${field} must be a plain object`, field);
  }
  return value as Record<string, unknown>;
}

function validateAssetConfig(asset: unknown, field: string): AssetConfig {
  const rec = assertRecord(asset, field, 'invalid-asset');
  if (typeof rec.code !== 'string' || !ASSET_CODE_RE.test(rec.code)) {
    invalid('invalid-asset', `${field}.code must be 1–12 alphanumeric chars`, `${field}.code`);
  }
  const code = rec.code.toUpperCase();
  if (code === 'XLM') {
    if (rec.issuer !== undefined) {
      invalid('invalid-asset', `${field}.issuer must be absent for native XLM`, `${field}.issuer`);
    }
    return { code: 'XLM' };
  }
  if (rec.issuer !== undefined && typeof rec.issuer !== 'string') {
    invalid('invalid-asset', `${field}.issuer must be a string`, `${field}.issuer`);
  }
  if (rec.issuer !== undefined && !StrKey.isValidEd25519PublicKey(rec.issuer)) {
    invalid('invalid-asset', `${field}.issuer must be a valid G… address`, `${field}.issuer`);
  }
  return { code, issuer: rec.issuer };
}

function validateAmount(value: unknown, field: string, allowZero = false): string {
  if (typeof value !== 'string' || !isValidAmount(value, allowZero)) {
    invalid('invalid-amount', `${field} must be a decimal string (> 0, ≤ 7 places)`, field);
  }
  return value;
}

function validatePrice(price: unknown, field: string): { n: number; d: number } {
  const rec = assertRecord(price, field, 'invalid-operation');
  const n = rec.n;
  const d = rec.d;
  if (
    typeof n !== 'number' ||
    typeof d !== 'number' ||
    !Number.isFinite(n) ||
    !Number.isFinite(d)
  ) {
    invalid('invalid-operation', `${field}.n and ${field}.d must be finite numbers`, field);
  }
  if (n < 0 || d <= 0) {
    invalid('invalid-operation', `${field} must be positive (n ≥ 0, d > 0)`, field);
  }
  return { n, d };
}

function validateOfferId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !/^-?[0-9]+$/.test(s)) {
    invalid('invalid-operation', `${field} must be an integer string`, field);
  }
  return s;
}

function validateDestination(value: unknown, field: string): string {
  if (typeof value !== 'string' || !StrKey.isValidEd25519PublicKey(value)) {
    invalid('invalid-address', `${field} must be a valid G… address`, field);
  }
  return value;
}

function validateSigner(signer: unknown, field: string): SetOptionsSignerConfig {
  const rec = assertRecord(signer, field, 'invalid-operation');
  const key = rec.ed25519PublicKey;
  const weight = rec.weight;
  if (typeof key !== 'string' || !StrKey.isValidEd25519PublicKey(key)) {
    invalid(
      'invalid-address',
      `${field}.ed25519PublicKey must be a valid G… address`,
      `${field}.ed25519PublicKey`,
    );
  }
  if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0 || weight > 255) {
    invalid('invalid-operation', `${field}.weight must be an integer 0–255`, `${field}.weight`);
  }
  return { ed25519PublicKey: key, weight };
}

function validateThresholds(t: unknown, field: string): ThresholdConfig {
  const rec = assertRecord(t, field, 'invalid-operation');
  const out: ThresholdConfig = {};
  for (const key of ['masterWeight', 'lowThreshold', 'medThreshold', 'highThreshold'] as const) {
    const v = rec[key];
    if (v !== undefined) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
        invalid('invalid-operation', `${field}.${key} must be an integer 0–255`, `${field}.${key}`);
      }
      out[key] = v;
    }
  }
  return out;
}

function validateMemo(memo: unknown): MemoConfig | undefined {
  if (memo === undefined) return undefined;
  const rec = assertRecord(memo, 'memo', 'invalid-memo');
  const type = rec.type;
  const value = rec.value;
  if (typeof type !== 'string' || !['text', 'id', 'hash', 'return'].includes(type)) {
    invalid('invalid-memo', 'memo.type must be one of text, id, hash, return', 'memo.type');
  }
  if (typeof value !== 'string') {
    invalid('invalid-memo', 'memo.value must be a string', 'memo.value');
  }
  switch (type) {
    case 'text': {
      if (new TextEncoder().encode(value).length > MEMO_TEXT_MAX_BYTES) {
        invalid(
          'invalid-memo',
          `memo.text must be ≤ ${MEMO_TEXT_MAX_BYTES} bytes UTF-8`,
          'memo.value',
        );
      }
      break;
    }
    case 'id': {
      if (!/^[0-9]+$/.test(value)) {
        invalid('invalid-memo', 'memo.id must be an unsigned 64-bit integer string', 'memo.value');
      }
      const num = BigInt(value);
      const max = BigInt(MEMO_ID_MAX);
      if (num < 0n || num > max) {
        invalid('invalid-memo', 'memo.id must be an unsigned 64-bit integer string', 'memo.value');
      }
      break;
    }
    case 'hash':
    case 'return': {
      if (!/^[0-9A-Fa-f]{64}$/.test(value)) {
        invalid('invalid-memo', `memo.${type} must be 32 bytes as hex (64 chars)`, 'memo.value');
      }
      break;
    }
    default:
      invalid('invalid-memo', 'memo.type must be one of text, id, hash, return', 'memo.type');
  }
  return { type: type, value };
}

function validateTimeBounds(tb: unknown): { maxAgeSeconds: number } {
  if (tb === undefined) return { maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS };
  const rec = assertRecord(tb, 'timeBounds', 'invalid-time-bounds');
  const raw = rec.maxAgeSeconds === undefined ? DEFAULT_MAX_AGE_SECONDS : rec.maxAgeSeconds;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    invalid(
      'invalid-time-bounds',
      'timeBounds.maxAgeSeconds must be an integer',
      'timeBounds.maxAgeSeconds',
    );
  }
  if (raw < MIN_MAX_AGE_SECONDS || raw > MAX_MAX_AGE_SECONDS) {
    invalid(
      'invalid-time-bounds',
      `timeBounds.maxAgeSeconds must be between ${MIN_MAX_AGE_SECONDS} and ${MAX_MAX_AGE_SECONDS}`,
      'timeBounds.maxAgeSeconds',
    );
  }
  return { maxAgeSeconds: raw };
}

function validateMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const rec = assertRecord(metadata, 'metadata');
  const seen = new Set<object>();
  const check = (v: unknown, path: string): void => {
    if (v === null) return;
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(v)) {
          invalid('invalid-metadata', `metadata${path} must be JSON-safe`, `metadata${path}`);
        }
        return;
      case 'object': {
        if (seen.has(v)) {
          invalid('invalid-metadata', 'metadata must not contain cycles', 'metadata');
        }
        seen.add(v);
        if (Array.isArray(v)) {
          v.forEach((item, i) => check(item, `${path}[${i}]`));
        } else {
          for (const [k, val] of Object.entries(v)) {
            check(val, `${path}.${k}`);
          }
        }
        seen.delete(v);
        return;
      }
      default:
        invalid('invalid-metadata', `metadata${path} must be JSON-safe`, `metadata${path}`);
    }
  };
  check(rec, '');
  return rec;
}

function validateOperations(operations: unknown): OperationConfig[] {
  if (!Array.isArray(operations)) {
    invalid('invalid-operation', 'operations must be an array', 'operations');
  }
  if (operations.length === 0) {
    invalid('invalid-operation', 'operations must not be empty', 'operations');
  }
  if (operations.length > MAX_OPERATIONS) {
    invalid('invalid-operation', `operations must have ≤ ${MAX_OPERATIONS} entries`, 'operations');
  }
  return operations.map((op, i) => validateOperation(op, `operations[${i}]`));
}

function validatePath(path: unknown, field: string): AssetConfig[] | undefined {
  if (path === undefined) return undefined;
  if (!Array.isArray(path)) {
    invalid('invalid-asset', `${field} must be an array of assets`, field);
  }
  return path.map((a, i) => validateAssetConfig(a, `${field}[${i}]`));
}

function validateSetOptions(rec: Record<string, unknown>, field: string): OperationConfig {
  const out: OperationConfig = { type: 'setOptions' };
  if (rec.inflationDest !== undefined) {
    out.inflationDest = validateDestination(rec.inflationDest, `${field}.inflationDest`);
  }
  if (rec.homeDomain !== undefined) {
    if (typeof rec.homeDomain !== 'string') {
      invalid('invalid-operation', `${field}.homeDomain must be a string`, `${field}.homeDomain`);
    }
    out.homeDomain = rec.homeDomain;
  }
  if (rec.signer !== undefined) {
    out.signer = validateSigner(rec.signer, `${field}.signer`);
  }
  if (rec.thresholds !== undefined) {
    out.thresholds = validateThresholds(rec.thresholds, `${field}.thresholds`);
  }
  return out;
}

function validateOperation(op: unknown, field: string): OperationConfig {
  const rec = assertRecord(op, field, 'invalid-operation');
  const type = rec.type;
  if (typeof type !== 'string') {
    invalid('invalid-operation', `${field}.type must be a string`, `${field}.type`);
  }
  switch (type) {
    case 'payment':
      return {
        type: 'payment',
        destination: validateDestination(rec.destination, `${field}.destination`),
        asset: validateAssetConfig(rec.asset, `${field}.asset`),
        amount: validateAmount(rec.amount, `${field}.amount`),
      };
    case 'createAccount':
      return {
        type: 'createAccount',
        destination: validateDestination(rec.destination, `${field}.destination`),
        startingBalance: validateAmount(rec.startingBalance, `${field}.startingBalance`, true),
      };
    case 'pathPaymentStrictSend':
      return {
        type: 'pathPaymentStrictSend',
        destination: validateDestination(rec.destination, `${field}.destination`),
        sendAsset: validateAssetConfig(rec.sendAsset, `${field}.sendAsset`),
        sendAmount: validateAmount(rec.sendAmount, `${field}.sendAmount`),
        destAsset: validateAssetConfig(rec.destAsset, `${field}.destAsset`),
        destMin: validateAmount(rec.destMin, `${field}.destMin`),
        path: validatePath(rec.path, `${field}.path`),
      };
    case 'pathPaymentStrictReceive':
      return {
        type: 'pathPaymentStrictReceive',
        destination: validateDestination(rec.destination, `${field}.destination`),
        sendAsset: validateAssetConfig(rec.sendAsset, `${field}.sendAsset`),
        sendMax: validateAmount(rec.sendMax, `${field}.sendMax`),
        destAsset: validateAssetConfig(rec.destAsset, `${field}.destAsset`),
        destAmount: validateAmount(rec.destAmount, `${field}.destAmount`),
        path: validatePath(rec.path, `${field}.path`),
      };
    case 'changeTrust':
      return {
        type: 'changeTrust',
        asset: validateAssetConfig(rec.asset, `${field}.asset`),
        limit:
          rec.limit === undefined ? undefined : validateAmount(rec.limit, `${field}.limit`, true),
      };
    case 'manageSellOffer':
      return {
        type: 'manageSellOffer',
        selling: validateAssetConfig(rec.selling, `${field}.selling`),
        buying: validateAssetConfig(rec.buying, `${field}.buying`),
        amount: validateAmount(rec.amount, `${field}.amount`, true),
        price: validatePrice(rec.price, `${field}.price`),
        offerId: validateOfferId(rec.offerId, `${field}.offerId`),
      };
    case 'manageBuyOffer':
      return {
        type: 'manageBuyOffer',
        selling: validateAssetConfig(rec.selling, `${field}.selling`),
        buying: validateAssetConfig(rec.buying, `${field}.buying`),
        buyAmount: validateAmount(rec.buyAmount, `${field}.buyAmount`, true),
        price: validatePrice(rec.price, `${field}.price`),
        offerId: validateOfferId(rec.offerId, `${field}.offerId`),
      };
    case 'setOptions':
      return validateSetOptions(rec, field);
    default:
      invalid(
        'unsupported-operation',
        `${field}.type is not a supported V1 operation`,
        `${field}.type`,
      );
  }
}

// ---------------------------------------------------------------------------
// Public API (T1.3–T1.5)
// ---------------------------------------------------------------------------

function validateId(id: unknown): string | undefined {
  if (id === undefined) return undefined;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH || !ID_RE.test(id)) {
    invalid('invalid-id', `id must be 1–${MAX_ID_LENGTH} printable ASCII chars`, 'id');
  }
  return id;
}

/** Validate and normalize a `CreateIntentInput` (throws `ValidationError`). */
export function validateCreateIntentInput(input: unknown): NormalizedCreateIntentInput {
  const rec = assertRecord(input, 'input');
  const id = validateId(rec.id);
  const sourceAccount = validateDestination(rec.sourceAccount, 'sourceAccount');
  const operations = validateOperations(rec.operations);
  const memo = validateMemo(rec.memo);
  const timeBounds = validateTimeBounds(rec.timeBounds);
  const metadata = validateMetadata(rec.metadata);
  return { id, sourceAccount, operations, memo, timeBounds, metadata };
}

/** SHA-256 hex of canonical JSON of the payload core (T1.5). */
export function computePayloadHash(payload: {
  sourceAccount: string;
  operations: OperationConfig[];
  memo?: MemoConfig;
  timeBounds: { maxAgeSeconds: number };
}): string {
  const canonical = canonicalJson(payload);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Create an immutable `Intent` from validated input.
 * `createdAt` defaults to `Date.now()`. Validation runs exactly once, here;
 * the returned intent is structurally valid.
 */
export function createIntent(input: CreateIntentInput, now: number = Date.now()): Intent {
  const normalized = validateCreateIntentInput(input);
  const id = normalized.id ?? randomUUID();
  const timeBounds = normalized.timeBounds;
  const payload = {
    sourceAccount: normalized.sourceAccount,
    operations: normalized.operations,
    memo: normalized.memo,
    timeBounds,
  };
  return {
    id,
    sourceAccount: normalized.sourceAccount,
    operations: normalized.operations,
    memo: normalized.memo,
    timeBounds,
    metadata: normalized.metadata,
    createdAt: now,
    payloadHash: computePayloadHash(payload),
  };
}

/** Serialize an intent to its plain-JSON form (round-trips losslessly). */
export function serializeIntent(intent: Intent): string {
  return JSON.stringify(intent);
}

/** Deserialize an intent created by `serializeIntent` (validates shape + hash). */
export function deserializeIntent(serialized: string): Intent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    invalid('invalid-serialized-intent', 'input is not valid JSON', undefined);
  }
  const rec = assertRecord(parsed, 'intent');
  for (const key of [
    'id',
    'sourceAccount',
    'operations',
    'timeBounds',
    'createdAt',
    'payloadHash',
  ] as const) {
    if (rec[key] === undefined) {
      invalid('invalid-serialized-intent', `intent is missing required field "${key}"`, key);
    }
  }
  if (typeof rec.id !== 'string' || typeof rec.sourceAccount !== 'string') {
    invalid(
      'invalid-serialized-intent',
      'intent.id and intent.sourceAccount must be strings',
      undefined,
    );
  }
  if (typeof rec.createdAt !== 'number' || !Number.isFinite(rec.createdAt)) {
    invalid('invalid-serialized-intent', 'intent.createdAt must be a finite number', 'createdAt');
  }
  if (typeof rec.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(rec.payloadHash)) {
    invalid(
      'invalid-serialized-intent',
      'intent.payloadHash must be a 64-char hex string',
      'payloadHash',
    );
  }
  const operations = validateOperations(rec.operations);
  const memo = validateMemo(rec.memo);
  const timeBounds = validateTimeBounds(rec.timeBounds);
  const metadata = validateMetadata(rec.metadata);
  const intent: Intent = {
    id: rec.id,
    sourceAccount: rec.sourceAccount,
    operations,
    memo,
    timeBounds,
    metadata,
    createdAt: rec.createdAt,
    payloadHash: rec.payloadHash,
  };
  // Integrity: the embedded hash must match the recomputed canonical hash.
  const expected = computePayloadHash({
    sourceAccount: intent.sourceAccount,
    operations: intent.operations,
    memo: intent.memo,
    timeBounds: intent.timeBounds,
  });
  if (expected !== intent.payloadHash) {
    invalid(
      'invalid-serialized-intent',
      'intent.payloadHash does not match the payload',
      'payloadHash',
    );
  }
  return intent;
}

/**
 * Parse asset shorthand: `'XLM'` native or `'CODE:ISSUER'` issued.
 * A structured `{ code, issuer }` object is validated as an asset config.
 */
export function parseAssetLike(asset: AssetLike): AssetConfig {
  if (typeof asset === 'string') {
    const trimmed = asset.trim();
    if (trimmed.toUpperCase() === 'XLM') return { code: 'XLM' };
    const idx = trimmed.lastIndexOf(':');
    if (idx === -1 || idx === 0 || idx === trimmed.length - 1) {
      invalid(
        'invalid-asset-shorthand',
        `asset "${asset}" must be 'XLM' or 'CODE:ISSUER'`,
        'asset',
      );
    }
    const code = trimmed.slice(0, idx);
    const issuer = trimmed.slice(idx + 1);
    if (!ASSET_CODE_RE.test(code)) {
      invalid(
        'invalid-asset-shorthand',
        `asset code "${code}" must be 1–12 alphanumeric chars`,
        'asset',
      );
    }
    if (!StrKey.isValidEd25519PublicKey(issuer)) {
      invalid(
        'invalid-asset-shorthand',
        `asset issuer "${issuer}" must be a valid G… address`,
        'asset',
      );
    }
    return { code: code.toUpperCase(), issuer };
  }
  return validateAssetConfig(asset, 'asset');
}

/**
 * Convenience factory (architecture §10): the 90% case, expands to a single
 * `payment` operation. Pure — validation still runs once, at `addIntent`.
 */
export function createPaymentIntent(input: CreatePaymentIntentInput): CreateIntentInput {
  const asset = parseAssetLike(input.asset);
  return {
    id: input.id,
    sourceAccount: input.source,
    operations: [
      {
        type: 'payment',
        destination: input.destination,
        asset,
        amount: input.amount,
      },
    ],
    memo: input.memo,
    metadata: input.metadata,
  };
}
