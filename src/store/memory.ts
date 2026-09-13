/**
 * MemoryStore: in-memory reference adapter (Phase 4 / Issue #5).
 *
 * A deterministic, correct-by-CAS `QueueStore` implementation for tests and
 * local development. Its CAS semantics are the executable reference for what
 * SqliteStore must reproduce (Phase 5); every mutation is serialized by an
 * in-process async mutex so interleaved async read-modify-write sequences
 * cannot lose updates (ADR-0003 rationale).
 *
 * **Non-durable by design** (architecture §15.5): all state lives in a single
 * process; `close()` discards it. Never use this adapter where entries must
 * survive a restart — use SqliteStore.
 */

import type { IntentStatus } from '../state.js';
import type { QueueEntry, QueueStore } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Constructor options for MemoryStore. */
export type MemoryStoreOptions = {
  /**
   * Clock used for internal bookkeeping and exposed to tests. Inject a fixed
   * or manually advanced clock to drive lease/backoff behaviour without real
   * sleeps. Defaults to `Date.now`. (Note: the `QueueStore` methods still take
   * explicit `now` arguments per architecture §9.2; this clock governs only
   * store-internal defaults.)
   */
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Async mutex (in-process mutation serialization)
// ---------------------------------------------------------------------------

/**
 * Minimal promise-chain mutex: every `run` body executes only after all
 * previously queued bodies finish, so async read-modify-write sequences
 * (read state → validate → mutate → bump version) cannot interleave within
 * the process. Mirrors ADR-0003's in-process safety requirement; SQLite adds
 * cross-process safety via transactions in Phase 5.
 */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Queue `fn` after every previously queued operation. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive even if `fn` rejects; the caller still sees the error.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// Clone-on-write helper
// ---------------------------------------------------------------------------

/**
 * Deep-clone an entry so store state can never be mutated through a returned
 * reference (or vice versa). `structuredClone` preserves field values exactly,
 * including `undefined`-valued optional properties' absence semantics for our
 * plain-JSON entry shape.
 */
function cloneEntry(entry: QueueEntry): QueueEntry {
  return structuredClone(entry);
}

/**
 * Shallow-merge an update onto an entry. Arrays are replaced wholesale —
 * `inFlightHashes`/`attempts` updates carry the complete new array; the
 * engine owns append logic (architecture §9.2). The embedded intent is
 * immutable (ADR-0001) and never overwritten.
 */
function applyUpdate(entry: QueueEntry, update: Partial<QueueEntry>): void {
  for (const [key, value] of Object.entries(update)) {
    if (key === 'intent') continue;
    (entry as Record<string, unknown>)[key] = value;
  }
}

/**
 * Deterministic list ordering: `intent.createdAt` ascending, ties broken by
 * `intent.id` (lexicographic). Every listing method uses this.
 */
function byCreatedAtThenId(a: QueueEntry, b: QueueEntry): number {
  return a.intent.createdAt - b.intent.createdAt || a.intent.id.localeCompare(b.intent.id);
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/**
 * In-memory reference implementation of the `QueueStore` CAS contract
 * (architecture §9.2). Fully deterministic: no timers, no network, no
 * wall-clock sampling — pass explicit `now` values or inject a clock.
 */
export class MemoryStore implements QueueStore {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly mutex = new AsyncMutex();
  private readonly nowFn: () => number;

  constructor(options: MemoryStoreOptions = {}) {
    this.nowFn = options.now ?? Date.now;
  }

  /**
   * Current store time from the injected clock. The `QueueStore` methods take
   * explicit `now` arguments per architecture §9.2; this accessor exposes the
   * clock itself so tests (and later modules that want the store's time base)
   * can read it instead of sampling the wall clock.
   */
  now(): number {
    return this.nowFn();
  }

  /**
   * Discards all state (non-durable by design, architecture §15.5). Idempotent;
   * safe to call from `afterAll` or repeatedly at shutdown.
   */
  async close(): Promise<void> {
    await this.mutex.run(() => {
      this.entries.clear();
    });
  }

  async insert(entry: QueueEntry): Promise<QueueEntry> {
    return this.mutex.run(() => {
      const existing = this.entries.get(entry.intent.id);
      if (existing !== undefined) {
        // Idempotent insert: duplicate id returns the existing entry without
        // mutating it (architecture §9.2 / ADR-0003).
        return cloneEntry(existing);
      }
      const stored = cloneEntry(entry);
      this.entries.set(entry.intent.id, stored);
      return cloneEntry(stored);
    });
  }

  async get(id: string): Promise<QueueEntry | undefined> {
    return this.mutex.run(() => {
      const entry = this.entries.get(id);
      return entry !== undefined ? cloneEntry(entry) : undefined;
    });
  }

  async claim(
    id: string,
    fromStates: IntentStatus[],
    now: number,
    expectedVersion: number,
    workerId: string,
    leaseMs: number,
  ): Promise<
    | { ok: true; entry: QueueEntry }
    | { ok: false; reason: 'state' | 'not-due' | 'version' | 'missing' }
  > {
    return this.mutex.run(() => {
      const entry = this.entries.get(id);
      if (entry === undefined) return { ok: false as const, reason: 'missing' as const };
      if (!fromStates.includes(entry.status))
        return { ok: false as const, reason: 'state' as const };
      if (entry.nextAttemptAt > now) return { ok: false as const, reason: 'not-due' as const };
      if (entry.version !== expectedVersion) {
        return { ok: false as const, reason: 'version' as const };
      }

      entry.status = 'READY';
      entry.claimedBy = workerId;
      entry.claimExpiresAt = now + leaseMs;
      entry.updatedAt = now;
      entry.version += 1;
      return { ok: true as const, entry: cloneEntry(entry) };
    });
  }

  async transition(
    id: string,
    fromStates: IntentStatus[],
    to: IntentStatus,
    update: Partial<QueueEntry>,
    expectedVersion: number,
    now: number,
  ): Promise<
    { ok: true; entry: QueueEntry } | { ok: false; reason: 'state' | 'version' | 'missing' }
  > {
    return this.mutex.run(() => {
      const entry = this.entries.get(id);
      if (entry === undefined) return { ok: false as const, reason: 'missing' as const };
      if (!fromStates.includes(entry.status))
        return { ok: false as const, reason: 'state' as const };
      if (entry.version !== expectedVersion) {
        return { ok: false as const, reason: 'version' as const };
      }

      applyUpdate(entry, update);
      entry.status = to;
      entry.updatedAt = now;
      entry.version += 1;
      return { ok: true as const, entry: cloneEntry(entry) };
    });
  }

  async listDue(fromStates: IntentStatus[], dueBefore: number): Promise<QueueEntry[]> {
    return this.mutex.run(() => {
      const result: QueueEntry[] = [];
      for (const entry of this.entries.values()) {
        if (fromStates.includes(entry.status) && entry.nextAttemptAt <= dueBefore) {
          result.push(cloneEntry(entry));
        }
      }
      result.sort(byCreatedAtThenId);
      return result;
    });
  }

  async listByState(states: IntentStatus[]): Promise<QueueEntry[]> {
    return this.mutex.run(() => {
      const result: QueueEntry[] = [];
      for (const entry of this.entries.values()) {
        if (states.includes(entry.status)) {
          result.push(cloneEntry(entry));
        }
      }
      result.sort(byCreatedAtThenId);
      return result;
    });
  }

  async list(opts?: {
    status?: IntentStatus;
    account?: string;
    limit?: number;
  }): Promise<QueueEntry[]> {
    return this.mutex.run(() => {
      let result = [...this.entries.values()];
      if (opts?.status !== undefined) {
        result = result.filter((e) => e.status === opts.status);
      }
      if (opts?.account !== undefined) {
        result = result.filter((e) => e.intent.sourceAccount === opts.account);
      }
      result.sort(byCreatedAtThenId);
      if (opts?.limit !== undefined) {
        result = result.slice(0, opts.limit);
      }
      return result.map(cloneEntry);
    });
  }

  async remove(id: string, fromStates: IntentStatus[], expectedVersion: number): Promise<boolean> {
    return this.mutex.run(() => {
      const entry = this.entries.get(id);
      if (entry === undefined) return false;
      if (!fromStates.includes(entry.status)) return false;
      if (entry.version !== expectedVersion) return false;
      // Defense-in-depth beyond fromStates: never delete an entry whose hash
      // may already be in flight (architecture §6.5.3 / ADR-0011).
      if (entry.inFlightHashes.length > 0) return false;
      this.entries.delete(id);
      return true;
    });
  }
}
