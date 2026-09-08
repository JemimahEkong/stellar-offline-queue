/**
 * Typed error hierarchy for stellar-offline-queue.
 *
 * Contract rules (architecture §4.1, implementation plan T1.6):
 * - Every error carries a stable, machine-readable `code`.
 * - Codes are part of the public contract: their meaning never changes within
 *   a major version. New codes may be added; existing codes are never reused.
 * - Messages are structural (field names and expectations only) and never
 *   interpolate secret material, raw XDR, or user payload values.
 *
 * Additional error categories (storage, ownership, signing, submission,
 * reconciliation, attempts exhausted, …) are added by their own phases.
 */

/**
 * The stable set of validation error codes for V1.
 *
 * | Code                     | Meaning                                                                 |
 * |--------------------------|-------------------------------------------------------------------------|
 * | `invalid-id`             | `id` empty, longer than 128 chars, or not ASCII-printable               |
 * | `invalid-address`        | a strkey field is not a valid Ed25519 public key (`G…`)                 |
 * | `invalid-asset`          | malformed asset config (code charset/length, issuer, unknown fields)    |
 * | `invalid-asset-shorthand`| `createPaymentIntent` asset string could not be parsed                  |
 * | `invalid-amount`         | malformed amount/price string (format, precision, range, zero)          |
 * | `invalid-memo`           | memo type unknown, value malformed, or protocol limits exceeded         |
 * | `invalid-time-bounds`    | `maxAgeSeconds` below floor (60) / above cap (86400) / non-integer      |
 * | `invalid-metadata`       | metadata is not a JSON-safe plain object                                |
 * | `invalid-operation`      | operation variant failed per-field validation (incl. unknown fields)    |
 * | `unsupported-operation`  | operation `type` outside the V1 supported union                         |
 * | `invalid-serialized-intent` | `deserializeIntent` input is not valid JSON or lacks required shape  |
 */
export const VALIDATION_ERROR_CODES = [
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
] as const;

export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

/** Base class for every error thrown by this library. */
export class StellarOfflineQueueError extends Error {
  /** Stable, machine-readable error code (see class docs for the contract). */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StellarOfflineQueueError';
    this.code = code;
  }
}

/**
 * Thrown when intent input fails validation or normalization. Invalid input
 * never reaches storage: enqueue paths must treat this as terminal for the
 * rejected value (architecture §4.1).
 */
export class ValidationError extends StellarOfflineQueueError {
  /** Dotted path of the offending field, e.g. `operations[0].amount`. */
  readonly field?: string;

  constructor(code: ValidationErrorCode, message: string, field?: string) {
    super(code, message);
    this.name = 'ValidationError';
    this.field = field;
  }
}
