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
export type {
  IntentStatus,
  TransitionTrigger,
  TransitionRule,
  TransitionResult,
  MinimalEntry,
} from './state.js';

// Phase 3: Storage abstraction
export type { QueueStore, QueueEntry, AttemptRecord } from './store/types.js';
export { PayloadMismatchError, EntryNotFoundError, StoreError } from './errors.js';

// Phase 4: Memory adapter (reference store; non-durable per architecture §15.5)
export { MemoryStore } from './store/memory.js';
export type { MemoryStoreOptions } from './store/memory.js';

// Phase 6: Processing ownership (claims, leases, janitor; ADR-0007)
export {
  createWorkerId,
  claimEntry,
  refreshLease,
  reclaimExpired,
  withOwnership,
} from './ownership.js';
export type { ClaimParams, ClaimResult } from './ownership.js';
export { OwnershipLostError } from './errors.js';

// Phase 7: Queue processor (engine pipeline + sweep; architecture §10)
export { OfflineQueue } from './queue.js';
export type { OfflineQueueConfig, ProcessSummary } from './queue.js';
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_LEASE_MS,
  DEFAULT_INTERVAL_MS,
  RECONCILE_BATCH_LIMIT,
  DUE_SCAN_PAGE_SIZE,
} from './queue.js';
export {
  processEntry,
  confirmEntry,
  reconcileSubmitting,
  verifyPayloadIntegrity,
  transactionHash,
} from './engine.js';
export type {
  EngineDeps,
  ProcessOutcome,
  RetryJournalRecord,
  WorkerContext,
} from './engine.js';
export { buildTransaction, buildDeterministic, Networks, BASE_FEE } from './builder.js';
export type { BuilderConfig, FlushParams, BuildParams } from './builder.js';
export type { Signer, SigningContext } from './signer.js';
export type {
  AccountState,
  StellarAdapter,
  SubmitableTransaction,
  SubmitResult,
  SubmitStatus,
  TxStatus,
  TxStatusValue,
} from './adapters/types.js';
export { QueueEvents } from './events.js';
export type { QueueEventType, QueueEventHandler, QueueErrorHandler } from './events.js';
export {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  computeBackoffDelay,
  expBackoffCeiling,
  nextAttemptTime,
} from './backoff.js';
export type { BackoffOptions } from './backoff.js';
export type {
  ReconciliationOutcome,
  ReconciliationResult,
} from './reconciliation.js';
export { isRecordedOutcome } from './reconciliation.js';
export {
  QueueConfigError,
  AccountNotFoundError,
  AttemptsExhaustedError,
  InvalidRetryStateError,
  InvalidCancelStateError,
} from './errors.js';
