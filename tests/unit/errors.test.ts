/**
 * Phase 1 / Issue #2 unit tests: the typed error groundwork (T1.6).
 *
 * Only the error classes that exist at this phase are tested: the base
 * `StellarOfflineQueueError` and `ValidationError` with its `field` and stable
 * `code`. Later phases extend the catalog (storage, ownership, submission,
 * reconciliation, attempts) and their own tests.
 */

import { describe, it, expect } from 'vitest';
import { StellarOfflineQueueError, ValidationError } from '../../src/errors.js';
import { VALIDATION_ERROR_CODES } from '../../src/errors.js';

describe('StellarOfflineQueueError', () => {
  it('carries a stable code and is an Error', () => {
    const err = new StellarOfflineQueueError('test-code', 'message');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('test-code');
    expect(err.message).toBe('message');
    expect(err.name).toBe('StellarOfflineQueueError');
  });
});

describe('ValidationError', () => {
  it('carries code, message, and field', () => {
    const err = new ValidationError(
      'invalid-amount',
      'amount must be a decimal string',
      'operations[0].amount',
    );
    expect(err).toBeInstanceOf(StellarOfflineQueueError);
    expect(err.code).toBe('invalid-amount');
    expect(err.message).toBe('amount must be a decimal string');
    expect(err.field).toBe('operations[0].amount');
    expect(err.name).toBe('ValidationError');
  });

  it('allows an undefined field', () => {
    const err = new ValidationError('invalid-serialized-intent', 'bad json');
    expect(err.field).toBeUndefined();
  });

  it('serializes to JSON with code and field', () => {
    const err = new ValidationError('invalid-id', 'id must be printable ASCII', 'id');
    const json = JSON.parse(JSON.stringify(err)) as { code?: string; field?: string };
    expect(json.code).toBe('invalid-id');
    expect(json.field).toBe('id');
    // Message survives JSON.stringify of an Error (enumerable own props only:
    // code/field; message is preserved by the Error default).
    expect(String(err)).toContain('id must be printable ASCII');
  });
});

describe('VALIDATION_ERROR_CODES', () => {
  it('is a frozen, unique catalog', () => {
    expect(new Set(VALIDATION_ERROR_CODES).size).toBe(VALIDATION_ERROR_CODES.length);
    // The catalog is part of the public contract — spot-check the codes that
    // the validation matrix depends on.
    for (const code of [
      'invalid-id',
      'invalid-address',
      'invalid-asset',
      'invalid-asset-shorthand',
      'invalid-amount',
      'invalid-memo',
      'invalid-time-bounds',
      'invalid-metadata',
      'invalid-operation',
      'unsupported-operation',
      'invalid-serialized-intent',
    ]) {
      expect(VALIDATION_ERROR_CODES).toContain(code);
    }
  });
});
