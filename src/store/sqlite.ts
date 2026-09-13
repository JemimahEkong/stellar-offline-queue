/**
 * SqliteStore: production default adapter on better-sqlite3 (Phase 5 / Issue #6).
 *
 * Schema v1 with WAL mode, transactional CAS, embedded migration runner,
 * and busy_timeout. Synchronous core over better-sqlite3's sync API wrapped
 * in the async QueueStore interface — the sync core removes in-process
 * interleaving risk by construction.
 *
 * Model contract: ADR-0003, architecture §9.2, §9.3.
 */

import Database from 'better-sqlite3';
import type { QueueStore, QueueEntry, AttemptRecord } from './types.js';
import type { IntentStatus } from '../state.js';
import type { Intent } from '../intent.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

const M001_DDL = `
  CREATE TABLE IF NOT EXISTS queue_entries (
    id                TEXT PRIMARY KEY,
    version           INTEGER NOT NULL CHECK (version >= 1),
    status            TEXT NOT NULL,
    source_account    TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    next_attempt_at   INTEGER NOT NULL,
    claim_expires_at  INTEGER NOT NULL,
    claimed_by        TEXT,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL DEFAULT 5,
    backoff_attempts  INTEGER NOT NULL DEFAULT 0,
    last_error_code   TEXT,
    last_error_message TEXT,
    last_error_ts     INTEGER,
    payload           TEXT NOT NULL,
    payload_hash      TEXT NOT NULL,
    in_flight_hashes  TEXT NOT NULL DEFAULT '[]',
    attempts          TEXT NOT NULL DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS idx_queue_entries_status_next
    ON queue_entries (status, next_attempt_at);

  CREATE INDEX IF NOT EXISTS idx_queue_entries_status
    ON queue_entries (status);

  CREATE INDEX IF NOT EXISTS idx_queue_entries_account_created
    ON queue_entries (source_account, created_at);

  CREATE TABLE IF NOT EXISTS store_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO store_meta (key, value) VALUES ('schema_version', '1');
`;

const MIGRATIONS: string[] = [M001_DDL];

// ---------------------------------------------------------------------------
// Row ↔ QueueEntry mapping
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  version: number;
  status: string;
  source_account: string;
  created_at: number;
  updated_at: number;
  next_attempt_at: number;
  claim_expires_at: number;
  claimed_by: string | null;
  attempt_count: number;
  max_attempts: number;
  backoff_attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_ts: number | null;
  payload: string;
  payload_hash: string;
  in_flight_hashes: string;
  attempts: string;
};

function rowToEntry(row: Row): QueueEntry {
  const intent = JSON.parse(row.payload) as Intent;
  return {
    intent,
    status: row.status as IntentStatus,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    backoffAttempts: row.backoff_attempts,
    claimedBy: row.claimed_by ?? undefined,
    claimExpiresAt: row.claim_expires_at,
    lastError:
      row.last_error_code !== null && row.last_error_message !== null && row.last_error_ts !== null
        ? { code: row.last_error_code, message: row.last_error_message, ts: row.last_error_ts }
        : undefined,
    inFlightHashes: JSON.parse(row.in_flight_hashes) as string[],
    attempts: JSON.parse(row.attempts) as AttemptRecord[],
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function entryToRow(entry: QueueEntry): Row {
  return {
    id: entry.intent.id,
    version: entry.version,
    status: entry.status,
    source_account: entry.intent.sourceAccount,
    created_at: entry.intent.createdAt,
    updated_at: entry.updatedAt,
    next_attempt_at: entry.nextAttemptAt,
    claim_expires_at: entry.claimExpiresAt,
    claimed_by: entry.claimedBy ?? null,
    attempt_count: entry.attemptCount,
    max_attempts: entry.maxAttempts,
    backoff_attempts: entry.backoffAttempts,
    last_error_code: entry.lastError?.code ?? null,
    last_error_message: entry.lastError?.message ?? null,
    last_error_ts: entry.lastError?.ts ?? null,
    payload: JSON.stringify(entry.intent),
    payload_hash: entry.intent.payloadHash,
    in_flight_hashes: JSON.stringify(entry.inFlightHashes),
    attempts: JSON.stringify(entry.attempts),
  };
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

export type SqliteStoreOptions = {
  /** WAL mode enabled by default. Set to false to disable. */
  wal?: boolean;
  /** Busy timeout in ms (default 5000). */
  busyTimeoutMs?: number;
};

/**
 * SQLite-backed QueueStore adapter using better-sqlite3.
 *
 * Synchronous core wrapped in the async QueueStore interface. WAL mode and
 * busy_timeout are configured on open. Schema migrations run automatically;
 * the store refuses to open a database written by a newer schema version.
 *
 * Use `:memory:` for tests (non-durable in that mode). File paths produce
 * real durable storage.
 */
export class SqliteStore implements QueueStore {
  private db: Database.Database;
  private open = true;

  constructor(path: string, opts?: SqliteStoreOptions) {
    const wal = opts?.wal ?? true;
    const busyTimeoutMs = opts?.busyTimeoutMs ?? 5_000;

    this.db = new Database(path);
    if (wal) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    this.db.pragma('synchronous = NORMAL');

    this.runMigrations();
  }

  // -----------------------------------------------------------------------
  // Migrations
  // -----------------------------------------------------------------------

  private runMigrations(): void {
    let currentVersion = 0;
    try {
      const versionRow = this.db
        .prepare("SELECT value FROM store_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      if (versionRow !== undefined) {
        currentVersion = parseInt(versionRow.value, 10);
      }
    } catch {
      // Table doesn't yet exist — currentVersion stays 0.
    }

    if (currentVersion > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `Store schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}. ` +
          'Open with a newer version of the library, or delete the store file.',
      );
    }

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i];
      if (migration !== undefined) {
        this.db.exec(migration);
      }
    }
  }

  // -----------------------------------------------------------------------
  // QueueStore implementation
  // -----------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/require-await
  async insert(entry: QueueEntry): Promise<QueueEntry> {
    const row = entryToRow(entry);
    const stmt = this.db.prepare(`
      INSERT INTO queue_entries (id, version, status, source_account, created_at, updated_at,
        next_attempt_at, claim_expires_at, claimed_by, attempt_count, max_attempts,
        backoff_attempts, last_error_code, last_error_message, last_error_ts,
        payload, payload_hash, in_flight_hashes, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    stmt.run(
      row.id,
      row.version,
      row.status,
      row.source_account,
      row.created_at,
      row.updated_at,
      row.next_attempt_at,
      row.claim_expires_at,
      row.claimed_by,
      row.attempt_count,
      row.max_attempts,
      row.backoff_attempts,
      row.last_error_code,
      row.last_error_message,
      row.last_error_ts,
      row.payload,
      row.payload_hash,
      row.in_flight_hashes,
      row.attempts,
    );
    // Return existing on duplicate (idempotent insert).
    const existing = this.db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(row.id) as
      Row | undefined;
    return rowToEntry(existing!);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(id: string): Promise<QueueEntry | undefined> {
    const row = this.db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(id) as
      Row | undefined;
    return row !== undefined ? rowToEntry(row) : undefined;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
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
    const txResult = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(id) as
        Row | undefined;
      if (row === undefined) return { ok: false, reason: 'missing' as const };
      if (!fromStates.includes(row.status as IntentStatus))
        return { ok: false, reason: 'state' as const };
      if (row.next_attempt_at > now) return { ok: false, reason: 'not-due' as const };
      if (row.version !== expectedVersion) return { ok: false, reason: 'version' as const };

      this.db
        .prepare(
          `UPDATE queue_entries SET
            status = 'READY',
            claimed_by = ?,
            claim_expires_at = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ?`,
        )
        .run(workerId, now + leaseMs, now, id);

      const updated = this.db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(id) as Row;
      return { ok: true as const, entry: rowToEntry(updated) };
    })();
    return txResult as
      | { ok: true; entry: QueueEntry }
      | { ok: false; reason: 'state' | 'not-due' | 'version' | 'missing' };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
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
    const txResult = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(id) as
        Row | undefined;
      if (row === undefined) return { ok: false, reason: 'missing' as const };
      if (!fromStates.includes(row.status as IntentStatus))
        return { ok: false, reason: 'state' as const };
      if (row.version !== expectedVersion) return { ok: false, reason: 'version' as const };

      // Build SET clause from update fields.
      const sets: string[] = ['status = ?', 'version = version + 1', 'updated_at = ?'];
      const params: unknown[] = [to, now];

      const fieldMap: [keyof QueueEntry, string][] = [
        ['attemptCount', 'attempt_count = ?'],
        ['maxAttempts', 'max_attempts = ?'],
        ['nextAttemptAt', 'next_attempt_at = ?'],
        ['backoffAttempts', 'backoff_attempts = ?'],
        ['claimedBy', 'claimed_by = ?'],
        ['claimExpiresAt', 'claim_expires_at = ?'],
        ['inFlightHashes', 'in_flight_hashes = ?'],
        ['attempts', 'attempts = ?'],
      ];

      for (const [field, column] of fieldMap) {
        if (field in update) {
          sets.push(column);
          const value = update[field];
          if (field === 'inFlightHashes' || field === 'attempts') {
            params.push(JSON.stringify(value));
          } else if (field === 'claimedBy') {
            params.push(value ?? null);
          } else {
            params.push(value);
          }
        }
      }

      if ('lastError' in update) {
        sets.push('last_error_code = ?', 'last_error_message = ?', 'last_error_ts = ?');
        params.push(
          update.lastError?.code ?? null,
          update.lastError?.message ?? null,
          update.lastError?.ts ?? null,
        );
      }

      params.push(id);
      this.db.prepare(`UPDATE queue_entries SET ${sets.join(', ')} WHERE id = ?`).run(...params);

      const updated = this.db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(id) as Row;
      return { ok: true as const, entry: rowToEntry(updated) };
    })();
    return txResult as
      { ok: true; entry: QueueEntry } | { ok: false; reason: 'state' | 'version' | 'missing' };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listDue(fromStates: IntentStatus[], dueBefore: number): Promise<QueueEntry[]> {
    const placeholders = fromStates.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM queue_entries
         WHERE status IN (${placeholders}) AND next_attempt_at <= ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...fromStates, dueBefore) as Row[];
    return rows.map(rowToEntry);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listByState(states: IntentStatus[]): Promise<QueueEntry[]> {
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM queue_entries WHERE status IN (${placeholders})`)
      .all(...states) as Row[];
    return rows.map(rowToEntry);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(opts?: {
    status?: IntentStatus;
    account?: string;
    limit?: number;
  }): Promise<QueueEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.status !== undefined) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    if (opts?.account !== undefined) {
      conditions.push('source_account = ?');
      params.push(opts.account);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : '';

    const rows = this.db
      .prepare(`SELECT * FROM queue_entries ${where} ${limit}`)
      .all(...params) as Row[];
    return rows.map(rowToEntry);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async remove(id: string, fromStates: IntentStatus[], expectedVersion: number): Promise<boolean> {
    const result = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(id) as
        Row | undefined;
      if (row === undefined) return false;
      if (!fromStates.includes(row.status as IntentStatus)) return false;
      if (row.version !== expectedVersion) return false;
      // Defense-in-depth beyond fromStates (parity with MemoryStore): never
      // delete an entry whose hash may already be in flight (ADR-0011).
      const hashes = JSON.parse(row.in_flight_hashes) as string[];
      if (hashes.length > 0) return false;

      this.db.prepare('DELETE FROM queue_entries WHERE id = ?').run(id);
      return true;
    })();
    return result;
  }

  /**
   * Flush and close the database connection. After this, the store is unusable.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    // Idempotent: safe to call twice (e.g. from a test body and from afterAll).
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }

  /**
   * Return the current schema version from the store metadata.
   */
  schemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row !== undefined ? parseInt(row.value, 10) : 0;
  }

  /**
   * Return the raw database handle for advanced operations (PRAGMA checks, etc.)
   * in tests. Not part of the public API.
   */
  getDb(): Database.Database {
    return this.db;
  }
}
