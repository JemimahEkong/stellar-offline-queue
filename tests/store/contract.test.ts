/**
 * Throwaway fake adapter to prove the contract suite compiles and covers
 * every method. This file is never shipped — it exists only to validate the
 * suite during Phase 3 (Issue #4). Final adapter tests arrive in Phases 4–5.
 *
 * The `FakeStore` implements the minimum QueueStore surface: enough to pass
 * the contract suite and no more.
 */

import { runStoreContractTests } from './contract.js';
import type { QueueStore, QueueEntry } from '../../src/store/types.js';
import type { IntentStatus } from '../../src/state.js';

// ---------------------------------------------------------------------------
// FakeStore: a minimal in-memory adapter for contract-suite validation only.
// This is NOT the real MemoryStore (Phase 4); it exists to prove the suite
// compiles and exercises every method/reason path.
// ---------------------------------------------------------------------------

class FakeStore implements QueueStore {
  private readonly entries = new Map<string, QueueEntry>();

  insert(entry: QueueEntry): Promise<QueueEntry> {
    const existing = this.entries.get(entry.intent.id);
    if (existing !== undefined) return Promise.resolve(existing);
    const clone = structuredClone(entry);
    this.entries.set(entry.intent.id, clone);
    return Promise.resolve(clone);
  }

  get(id: string): Promise<QueueEntry | undefined> {
    const entry = this.entries.get(id);
    return Promise.resolve(entry !== undefined ? structuredClone(entry) : undefined);
  }

  claim(
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
    const entry = this.entries.get(id);
    if (entry === undefined) return Promise.resolve({ ok: false, reason: 'missing' });
    if (!fromStates.includes(entry.status)) return Promise.resolve({ ok: false, reason: 'state' });
    if (entry.nextAttemptAt > now) return Promise.resolve({ ok: false, reason: 'not-due' });
    if (entry.version !== expectedVersion) return Promise.resolve({ ok: false, reason: 'version' });

    entry.status = 'READY';
    entry.claimedBy = workerId;
    entry.claimExpiresAt = now + leaseMs;
    entry.version++;
    entry.updatedAt = now;
    return Promise.resolve({ ok: true, entry: structuredClone(entry) });
  }

  transition(
    id: string,
    fromStates: IntentStatus[],
    to: IntentStatus,
    update: Partial<QueueEntry>,
    expectedVersion: number,
    now: number,
  ): Promise<
    { ok: true; entry: QueueEntry } | { ok: false; reason: 'state' | 'version' | 'missing' }
  > {
    const entry = this.entries.get(id);
    if (entry === undefined) return Promise.resolve({ ok: false, reason: 'missing' });
    if (!fromStates.includes(entry.status)) return Promise.resolve({ ok: false, reason: 'state' });
    if (entry.version !== expectedVersion) return Promise.resolve({ ok: false, reason: 'version' });

    // Apply update
    for (const [key, value] of Object.entries(update)) {
      if (key === 'intent') continue; // never overwrite intent
      (entry as Record<string, unknown>)[key] = value;
    }
    entry.status = to;
    entry.version++;
    entry.updatedAt = now;
    return Promise.resolve({ ok: true, entry: structuredClone(entry) });
  }

  listDue(fromStates: IntentStatus[], dueBefore: number): Promise<QueueEntry[]> {
    const result: QueueEntry[] = [];
    for (const entry of this.entries.values()) {
      if (fromStates.includes(entry.status) && entry.nextAttemptAt <= dueBefore) {
        result.push(structuredClone(entry));
      }
    }
    result.sort(
      (a, b) => a.intent.createdAt - b.intent.createdAt || a.intent.id.localeCompare(b.intent.id),
    );
    return Promise.resolve(result);
  }

  listByState(states: IntentStatus[]): Promise<QueueEntry[]> {
    const result: QueueEntry[] = [];
    for (const entry of this.entries.values()) {
      if (states.includes(entry.status)) {
        result.push(structuredClone(entry));
      }
    }
    return Promise.resolve(result);
  }

  list(opts?: { status?: IntentStatus; account?: string; limit?: number }): Promise<QueueEntry[]> {
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
    return Promise.resolve(result);
  }

  remove(id: string, fromStates: IntentStatus[], expectedVersion: number): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry === undefined) return Promise.resolve(false);
    if (!fromStates.includes(entry.status)) return Promise.resolve(false);
    if (entry.version !== expectedVersion) return Promise.resolve(false);
    this.entries.delete(id);
    return Promise.resolve(true);
  }
}

// ---------------------------------------------------------------------------
// Run the contract suite against the throwaway adapter
// ---------------------------------------------------------------------------

runStoreContractTests('FakeStore (throwaway)', () => Promise.resolve(new FakeStore()));
