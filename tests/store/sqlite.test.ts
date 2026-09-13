/**
 * SqliteStore tests (Phase 5 / Issue #6).
 *
 * - Full contract suite via `runStoreContractTests` incl. restart durability.
 * - SQLite-specific: WAL mode, schema version, multi-connection CAS,
 *   busy_timeout, crash-simulation durability.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../../src/store/sqlite.js';
import { runStoreContractTests } from './contract.js';
import { claimEntry, reclaimExpired, refreshLease } from '../../src/ownership.js';
import { OwnershipLostError } from '../../src/errors.js';
import type { QueueEntry } from '../../src/store/types.js';
import type { CreateIntentInput } from '../../src/intent.js';
import { createIntent } from '../../src/intent.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function intentInput(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
  return {
    sourceAccount: 'GAZ4BOIRV2JO5TAIKI2V4VOMYX45BW3VA3FOXGS6GGX4TY5YCFXTFPLR',
    operations: [
      {
        type: 'payment',
        destination: 'GA5BXUVTHLJXAP5M4ZZ7JIM6DYGVC4KQRXL7NQMOBRCOM5GJYKJWFQ63',
        asset: { code: 'XLM' },
        amount: '10.50',
      },
    ],
    ...overrides,
  };
}

function makeIntent(overrides: Partial<CreateIntentInput> = {}, now = 1_700_000_000_000) {
  return createIntent(intentInput(overrides), now);
}

function makeEntry(status: 'QUEUED' | 'READY' | 'SUBMITTING' = 'QUEUED'): QueueEntry {
  const intent = makeIntent();
  return {
    intent,
    status,
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: 0,
    backoffAttempts: 0,
    claimedBy: undefined,
    claimExpiresAt: 0,
    lastError: undefined,
    inFlightHashes: [],
    attempts: [],
    updatedAt: 1_700_000_000_000,
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function tempPath(): string {
  return join(tmpDir, `test-${randomUUID()}.db`);
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

describe('SqliteStore', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sq-store-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // `durable: true` + `reopen` activates the shared contract suite's
  // restart-durability variant: the reopen factory opens the SAME database
  // file, simulating a process restart against persisted storage.
  let currentPath = '';
  runStoreContractTests(
    'SqliteStore',
    () => {
      currentPath = tempPath();
      return Promise.resolve(new SqliteStore(currentPath));
    },
    {
      durable: true,
      reopen: () => Promise.resolve(new SqliteStore(currentPath)),
    },
  );

  // -----------------------------------------------------------------------
  // Restart durability
  // -----------------------------------------------------------------------

  describe('restart durability', () => {
    it('entries survive close + reopen', async () => {
      const path = tempPath();
      const store1 = new SqliteStore(path);
      const entry = makeEntry('QUEUED');
      await store1.insert(entry);
      await store1.close();

      // Reopen
      const store2 = new SqliteStore(path);
      const fetched = await store2.get(entry.intent.id);
      expect(fetched).toBeDefined();
      expect(fetched!.status).toBe('QUEUED');
      expect(fetched!.intent.id).toBe(entry.intent.id);
      await store2.close();
    });

    it('transitions survive close + reopen', async () => {
      const path = tempPath();
      const store1 = new SqliteStore(path);
      const entry = makeEntry('QUEUED');
      await store1.insert(entry);

      const claimed = await store1.claim(entry.intent.id, ['QUEUED'], 0, 1, 'w', 60_000);
      expect(claimed.ok).toBe(true);
      await store1.close();

      // Reopen
      const store2 = new SqliteStore(path);
      const fetched = await store2.get(entry.intent.id);
      expect(fetched).toBeDefined();
      expect(fetched!.status).toBe('READY');
      expect(fetched!.claimedBy).toBe('w');
      expect(fetched!.version).toBe(2);
      await store2.close();
    });
  });

  // -----------------------------------------------------------------------
  // WAL mode
  // -----------------------------------------------------------------------

  describe('WAL mode', () => {
    it('WAL mode is active by default', async () => {
      const store = new SqliteStore(tempPath());
      const mode = store.getDb().pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
      await store.close();
    });

    it('WAL mode can be disabled', async () => {
      const store = new SqliteStore(tempPath(), { wal: false });
      const mode = store.getDb().pragma('journal_mode', { simple: true });
      // Default is delete mode when WAL is disabled
      expect(mode).not.toBe('wal');
      await store.close();
    });
  });

  // -----------------------------------------------------------------------
  // Schema version
  // -----------------------------------------------------------------------

  describe('schema version', () => {
    it('fresh DB has schema version 1', async () => {
      const store = new SqliteStore(tempPath());
      expect(store.schemaVersion()).toBe(1);
      await store.close();
    });

    it('refuses to open a store with a newer schema version', () => {
      const path = tempPath();
      // Manually create a store with version 99
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO store_meta (key, value) VALUES ('schema_version', '99');
      `);
      raw.close();

      expect(() => new SqliteStore(path)).toThrow(/newer than supported version/);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-connection CAS
  // -----------------------------------------------------------------------

  describe('multi-connection CAS', () => {
    it('two connections race the same claim: exactly one wins per iteration (50 iterations)', async () => {
      const path = tempPath();
      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        const entry = makeEntry('QUEUED');
        const store = new SqliteStore(path);
        await store.insert(entry);

        // Open two connections to the same file
        const connA = new SqliteStore(path);
        const connB = new SqliteStore(path);

        const a = await connA.claim(entry.intent.id, ['QUEUED'], 0, 1, 'a', 60_000);
        const b = await connB.claim(entry.intent.id, ['QUEUED'], 0, 1, 'b', 60_000);

        const wins = [a, b].filter((r) => r.ok);
        const losses = [a, b].filter((r) => !r.ok);
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);

        await connA.close();
        await connB.close();
        await store.close();
      }
    }, 120_000);

    it('two connections race the same transition: exactly one wins', async () => {
      const path = tempPath();
      const store = new SqliteStore(path);
      const entry = makeEntry('QUEUED');
      await store.insert(entry);

      const claimed = await store.claim(entry.intent.id, ['QUEUED'], 0, 1, 'w', 60_000);
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) return;
      await store.close();

      const v = claimed.entry.version;
      const connA = new SqliteStore(path);
      const connB = new SqliteStore(path);

      const [a, b] = await Promise.all([
        connA.transition(claimed.entry.intent.id, ['READY'], 'BUILDING', {}, v, 1),
        connB.transition(claimed.entry.intent.id, ['READY'], 'BUILDING', {}, v, 1),
      ]);

      const wins = [a, b].filter((r) => r.ok);
      const losses = [a, b].filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);

      await connA.close();
      await connB.close();
    });
  });

  // -----------------------------------------------------------------------
  // busy_timeout
  // -----------------------------------------------------------------------

  describe('busy_timeout', () => {
    it('respects custom busy_timeout', async () => {
      const store = new SqliteStore(tempPath(), { busyTimeoutMs: 3000 });
      const timeout = store.getDb().pragma('busy_timeout', { simple: true });
      expect(timeout).toBe(3000);
      await store.close();
    });
  });

  // -----------------------------------------------------------------------
  // Ownership on multi-connection SQLite (Phase 6 / Issue #7)
  // -----------------------------------------------------------------------

  describe('ownership: multi-connection', () => {
    it('two workers claim the same id across connections: exactly one wins', async () => {
      const path = tempPath();
      const entry = makeEntry('QUEUED');
      const seed = new SqliteStore(path);
      await seed.insert(entry);

      const connA = new SqliteStore(path);
      const connB = new SqliteStore(path);

      const a = await claimEntry(connA, entry.intent.id, {
        workerId: 'worker-a',
        leaseMs: 60_000,
        now: 0,
      });
      const b = await claimEntry(connB, entry.intent.id, {
        workerId: 'worker-b',
        leaseMs: 60_000,
        now: 0,
      });

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.reason).toBe('state');

      // The winner's lease is visible from the other connection.
      const fromB = await connB.get(entry.intent.id);
      expect(fromB!.status).toBe('READY');
      expect(fromB!.claimedBy).toBe('worker-a');
      expect(fromB!.claimExpiresAt).toBe(60_000);

      await connA.close();
      await connB.close();
      await seed.close();
    });

    it('janitor race across connections: exactly one reclaim wins (20 iterations)', async () => {
      const path = tempPath();
      const seed = new SqliteStore(path);

      for (let i = 0; i < 20; i++) {
        const entry = makeEntry('QUEUED');
        await seed.insert(entry);

        const claimed = await claimEntry(seed, entry.intent.id, {
          workerId: 'worker-a',
          leaseMs: 60_000,
          now: 0,
        });
        expect(claimed.ok).toBe(true);

        const janitorA = new SqliteStore(path);
        const janitorB = new SqliteStore(path);
        const [idsA, idsB] = await Promise.all([
          reclaimExpired(janitorA, 60_001),
          reclaimExpired(janitorB, 60_001),
        ]);

        const winners = [...idsA, ...idsB].filter((id) => id === entry.intent.id);
        expect(winners).toHaveLength(1);

        const after = await seed.get(entry.intent.id);
        expect(after!.status).toBe('QUEUED');
        expect(after!.claimedBy).toBeUndefined();

        await janitorA.close();
        await janitorB.close();
      }

      await seed.close();
    }, 120_000);

    it('stale worker loses across connections: refreshLease throws OwnershipLostError after takeover', async () => {
      const path = tempPath();
      const entry = makeEntry('QUEUED');
      const connA = new SqliteStore(path);
      await connA.insert(entry);

      const claimed = await claimEntry(connA, entry.intent.id, {
        workerId: 'worker-a',
        leaseMs: 60_000,
        now: 0,
      });
      expect(claimed.ok).toBe(true);

      // Worker B takes over on another connection after the lease expires.
      await reclaimExpired(connA, 60_001);
      const connB = new SqliteStore(path);
      const taken = await claimEntry(connB, entry.intent.id, {
        workerId: 'worker-b',
        leaseMs: 60_000,
        now: 60_001,
      });
      expect(taken.ok).toBe(true);

      // The stale worker's refresh fails on its own connection.
      await expect(
        refreshLease(connA, entry.intent.id, 'worker-a', 60_000, 60_002),
      ).rejects.toThrow(OwnershipLostError);

      // And its raw CAS transition fails too — no mutation path is open.
      const stale = await connA.transition(
        entry.intent.id,
        ['READY'],
        'BUILDING',
        {},
        claimed.ok ? claimed.entry.version : 0,
        60_002,
      );
      expect(stale.ok).toBe(false);

      await connA.close();
      await connB.close();
    });
  });

  // -----------------------------------------------------------------------
  // close() lifecycle
  // -----------------------------------------------------------------------

  describe('close()', () => {
    it('close() flushes and closes; operations after close throw', async () => {
      const store = new SqliteStore(tempPath());
      await store.close();
      await expect(store.get('any')).rejects.toThrow();
    });
  });
});
