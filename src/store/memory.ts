/**
 * MemoryStore: in-memory reference adapter for tests and development (Phase 4 / Issue #5).
 *
 * Non-durable by design — entries are lost on process exit. This is the fast,
 * deterministic substrate for all later testing (engine, ownership, retry,
 * reliability fakes). Its CAS semantics are the executable reference for what
 * SQLite must reproduce.
 *
 * Concurrency: a per-store async mutex (promise chain) serializes all mutations,
 * preventing interleaved async read-modify-write even within a single process
 * (mirrors ADR-0003 rationale).
 *
 * Clone-on-write: all entries are deep-cloned on read and write so callers
 * cannot mutate store state through references (critical for tests).
 *
 * Model contract: ADR-0003, architecture §9.2.
 */

import type { QueueStore, QueueEntry } from './types.js';
import type { IntentStatus } from '../state.js';

// ---------------------------------------------------------------------------
// Async mutex (promise-chain)
// ---------------------------------------------------------------------------

type Mutex = {
  <T>(fn: () => Promise<T>): Promise<T>;
};

function createMutex(): Mutex {
  let head: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = head.then(fn, fn);
    // Always chain so subsequent calls wait for this one, but don't propagate
    // earlier errors to later calls.
    head = result.then(undefined, undefined);
    return result;
  };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export type MemoryStoreOptions = {
  /**
   * Injected clock for lease/backoff tests without real sleeps.
   * Defaults to `Date.now`.
   */
  now?: () => number;
};

/**
 * In-memory QueueStore adapter. Non-durable — entries are lost on process exit.
 * Suitable for tests and development only.
 *
 * Every entry is deep-cloned on read and write (clone-on-write) so callers
 * cannot mutate store state through references. All mutations are serialized
 * by an async mutex to prevent interleaved async read-modify-write.
 */
export class MemoryStore implements QueueStore {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly mutex: Mutex;
  private readonly clock: () => number;

  constructor(opts?: MemoryStoreOptions) {
    this.mutex = createMutex();
    this.clock = opts?.now ?? (() => Date.now());
  }

  async insert(entry: QueueEntry): Promise<QueueEntry> {
    // eslint-disable-next-line @typescript-eslint/require-await
    return this.mutex(async () => {
      const existing = this.entries.get(entry.intent.id);
      if (existing !== undefined) return structuredClone(existing);
      const clone = structuredClone(entry);
      this.entries.set(entry.intent.id, structuredClone(clone));
      return clone;
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(id: string): Promise<QueueEntry | undefined> {
    // Read-only — no mutex needed (Map.get is synchronous and atomic).
    const entry = this.entries.get(id);
    return entry !== undefined ? structuredClone(entry) : undefined;
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
    // eslint-disable-next-line @typescript-eslint/require-await
    return this.mutex(async () => {
      const entry = this.entries.get(id);
      if (entry === undefined) return { ok: false, reason: 'missing' };
      if (!fromStates.includes(entry.status)) return { ok: false, reason: 'state' };
      if (entry.nextAttemptAt > now) return { ok: false, reason: 'not-due' };
      if (entry.version !== expectedVersion) return { ok: false, reason: 'version' };

      entry.status = 'READY';
      entry.claimedBy = workerId;
      entry.claimExpiresAt = now + leaseMs;
      entry.version++;
      entry.updatedAt = now;
      return { ok: true, entry: structuredClone(entry) };
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
    | { ok: true; entry: QueueEntry }
    | { ok: false; reason: 'state' | 'version' | 'missing' }
  > {
    // eslint-disable-next-line @typescript-eslint/require-await
    return this.mutex(async () => {
      const entry = this.entries.get(id);
      if (entry === undefined) return { ok: false, reason: 'missing' };
      if (!fromStates.includes(entry.status)) return { ok: false, reason: 'state' };
      if (entry.version !== expectedVersion) return { ok: false, reason: 'version' };

      // Apply update: shallow merge; arrays replaced wholesale.
      for (const [key, value] of Object.entries(update)) {
        if (key === 'intent') continue; // never overwrite intent
        (entry as Record<string, unknown>)[key] = value;
      }
      entry.status = to;
      entry.version++;
      entry.updatedAt = now;
      return { ok: true, entry: structuredClone(entry) };
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listDue(fromStates: IntentStatus[], dueBefore: number): Promise<QueueEntry[]> {
    // Read-only — no mutex needed for snapshot consistency within one process.
    const result: QueueEntry[] = [];
    for (const entry of this.entries.values()) {
      if (fromStates.includes(entry.status) && entry.nextAttemptAt <= dueBefore) {
        result.push(structuredClone(entry));
      }
    }
    result.sort(
      (a, b) => a.intent.createdAt - b.intent.createdAt || a.intent.id.localeCompare(b.intent.id),
    );
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listByState(states: IntentStatus[]): Promise<QueueEntry[]> {
    const result: QueueEntry[] = [];
    for (const entry of this.entries.values()) {
      if (states.includes(entry.status)) {
        result.push(structuredClone(entry));
      }
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(opts?: { status?: IntentStatus; account?: string; limit?: number }): Promise<QueueEntry[]> {
    let result: QueueEntry[] = [...this.entries.values()].map((e) => structuredClone(e));
    if (opts?.status !== undefined) {
      result = result.filter((e) => e.status === opts.status);
    }
    if (opts?.account !== undefined) {
      result = result.filter((e) => e.intent.sourceAccount === opts.account);
    }
    if (opts?.limit !== undefined) {
      result = result.slice(0, opts.limit);
    }
    return result;
  }

  async remove(id: string, fromStates: IntentStatus[], expectedVersion: number): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/require-await
    return this.mutex(async () => {
      const entry = this.entries.get(id);
      if (entry === undefined) return false;
      if (!fromStates.includes(entry.status)) return false;
      if (entry.version !== expectedVersion) return false;
      this.entries.delete(id);
      return true;
    });
  }

  /**
   * Return the current time from the injected clock. Useful in tests to
   * advance time without real sleeps.
   */
  now(): number {
    return this.clock();
  }
}
