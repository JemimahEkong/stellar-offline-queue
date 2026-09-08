// Public entry point (Phase 1 / Issue #2 export surface — T1.7).
// Exports grow incrementally with later implementation issues.

export {
  createIntent,
  createPaymentIntent,
  deserializeIntent,
  serializeIntent,
  parseAssetLike,
  validateCreateIntentInput,
  computePayloadHash,
  canonicalJson,
  isValidAmount,
  DEFAULT_MAX_AGE_SECONDS,
  MIN_MAX_AGE_SECONDS,
  MAX_MAX_AGE_SECONDS,
  MAX_OPERATIONS,
  MAX_ID_LENGTH,
  MEMO_TEXT_MAX_BYTES,
  MEMO_HASH_BYTES,
  MEMO_ID_MAX,
  AMOUNT_MAX_DECIMAL_PLACES,
  AMOUNT_MAX_INT64,
} from './intent.js';
export { ValidationError, StellarOfflineQueueError, InvalidTransitionError } from './errors.js';
export type {
  Intent,
  CreateIntentInput,
  CreatePaymentIntentInput,
  OperationConfig,
  MemoConfig,
  AssetConfig,
  AssetLike,
  SetOptionsSignerConfig,
  ThresholdConfig,
} from './intent.js';
export type { ValidationErrorCode } from './errors.js';

// Phase 2: State machine
export {
  ALL_STATUSES,
  TERMINAL_STATES,
  PERSISTED_STATES,
  TRANSIENT_STATES,
  PRE_SUBMISSION_STATES,
  IN_FLIGHT_STATES,
  RETRYABLE_STATES,
  TRANSITIONS,
  canTransition,
  validateTransition,
  isInFlight,
  isTerminal,
  isPreSubmission,
  isReclaimable,
} from './state.js';
export type { IntentStatus, TransitionTrigger, TransitionRule, TransitionResult, MinimalEntry } from './state.js';

// Phase 3: Storage abstraction
export type {
  QueueStore,
  QueueEntry,
  AttemptRecord,
  CASResult,
  CASOkResult,
  CASFailResult,
} from './store/types.js';
export {
  PayloadMismatchError,
  EntryNotFoundError,
  StoreError,
} from './errors.js';
