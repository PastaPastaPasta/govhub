// Token store (PLAN §8.4 rules 4 and 6): per-issuer dedup, nothing published.
//   tokens(epoch, proTxHash, collateral, blindedHash): PRIMARY KEY (epoch, proTxHash), UNIQUE (epoch, collateral)
//   epochs(epoch, issued, closed, served, reportId): the per-epoch count survives the deletion of the token rows (issuerReport);
//   every epoch up to the newest closed one is closed (a watermark), whether or not it has a row
// No timestamps, no IPs, no request strings, no signatures. Rows of an epoch are deleted (secure_delete) once its issuance
// window has closed; only the count remains.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ReserveOutcome =
  | { kind: 'signed'; blindSig: Uint8Array; retry: boolean }
  | { kind: 'conflict'; reason: 'mn' | 'collateral' }
  | { kind: 'closed' }
  /** the store was created (or reset) after this epoch's window opened: tokens issued before are unknown to it */
  | { kind: 'store-too-new' };

export interface TokenStore {
  /**
   * Atomically: refuse if the epoch is closed; a row for (epoch, proTxHash) with the same blindedHash is an idempotent retry
   * (signed again, not counted); with another blindedHash, or another proTxHash holding the collateral, a conflict; otherwise
   * sign, insert and count. `sign` runs inside the transaction: if it throws, nothing is stored.
   */
  reserve(o: { epoch: number; windowFrom: number; proTxHash: string; collateral: string; blindedHash: Uint8Array }, sign: () => Uint8Array): ReserveOutcome;
  /** Records the core height the store first ran at (kept across restarts; a lost database starts again). */
  markStarted(height: number): void;
  /** Marks the epoch as served by this server (it had the key), so a zero count is still reported. */
  openEpoch(epoch: number): void;
  /** Deletes the token rows of every epoch <= `epoch` and marks them closed. */
  closeThrough(epoch: number): number;
  issued(epoch: number): number;
  /** Closed epochs this server served that have not been reported yet. */
  unreported(): number[];
  markReported(epoch: number, docId: string): void;
  close(): void;
}

export function openTokenStore(path: string): TokenStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('secure_delete = ON');
  // A database from before the started_height guard ran from before its windows opened (it has the epochs table but no meta).
  const legacy = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'epochs'").get() && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      epoch INTEGER NOT NULL,
      pro_tx_hash TEXT NOT NULL,
      collateral TEXT NOT NULL,
      blinded_hash BLOB NOT NULL,
      PRIMARY KEY (epoch, pro_tx_hash),
      UNIQUE (epoch, collateral)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS epochs (
      epoch INTEGER PRIMARY KEY,
      issued INTEGER NOT NULL DEFAULT 0,
      closed INTEGER NOT NULL DEFAULT 0,
      served INTEGER NOT NULL DEFAULT 0,
      report_id TEXT
    );
  `);
  const q = {
    epoch: db.prepare<[number], { issued: number; closed: number; report_id: string | null }>('SELECT issued, closed, report_id FROM epochs WHERE epoch = ?'),
    open: db.prepare<[number]>('INSERT INTO epochs (epoch, served) VALUES (?, 1) ON CONFLICT (epoch) DO UPDATE SET served = 1'),
    mark: db.prepare<[number]>('INSERT OR IGNORE INTO epochs (epoch) VALUES (?)'),
    maxClosed: db.prepare<[], { m: number | null }>('SELECT MAX(epoch) AS m FROM epochs WHERE closed = 1'),
    byMn: db.prepare<[number, string], { blinded_hash: Buffer }>('SELECT blinded_hash FROM tokens WHERE epoch = ? AND pro_tx_hash = ?'),
    byCollateral: db.prepare<[number, string], { pro_tx_hash: string }>('SELECT pro_tx_hash FROM tokens WHERE epoch = ? AND collateral = ?'),
    insert: db.prepare<[number, string, string, Buffer]>('INSERT INTO tokens (epoch, pro_tx_hash, collateral, blinded_hash) VALUES (?, ?, ?, ?)'),
    count: db.prepare<[number]>('UPDATE epochs SET issued = issued + 1 WHERE epoch = ?'),
    del: db.prepare<[number]>('DELETE FROM tokens WHERE epoch <= ?'),
    closeAll: db.prepare<[number]>('UPDATE epochs SET closed = 1 WHERE epoch <= ?'),
    unreported: db.prepare<[], { epoch: number }>('SELECT epoch FROM epochs WHERE closed = 1 AND served = 1 AND report_id IS NULL ORDER BY epoch'),
    reported: db.prepare<[string, number]>('UPDATE epochs SET report_id = ? WHERE epoch = ?'),
    started: db.prepare<[number]>("INSERT OR IGNORE INTO meta (key, value) VALUES ('started_height', ?)"),
    startedAt: db.prepare<[], { value: number }>("SELECT value FROM meta WHERE key = 'started_height'"),
  };
  if (legacy) q.started.run(0);
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

  const reserve = db.transaction((o: { epoch: number; windowFrom: number; proTxHash: string; collateral: string; blindedHash: Uint8Array }, sign: () => Uint8Array): ReserveOutcome => {
    // A store that did not exist for the whole window cannot dedup it (a lost or reset database): refuse until the next epoch.
    const started = q.startedAt.get()?.value;
    if (started === undefined || started > o.windowFrom) return { kind: 'store-too-new' };
    const closed = q.maxClosed.get()?.m;
    if (closed !== null && closed !== undefined && o.epoch <= closed) return { kind: 'closed' };
    q.open.run(o.epoch);
    const mine = q.byMn.get(o.epoch, o.proTxHash);
    if (mine) return same(mine.blinded_hash, o.blindedHash) ? { kind: 'signed', blindSig: sign(), retry: true } : { kind: 'conflict', reason: 'mn' };
    if (q.byCollateral.get(o.epoch, o.collateral)) return { kind: 'conflict', reason: 'collateral' };
    const blindSig = sign();
    q.insert.run(o.epoch, o.proTxHash, o.collateral, Buffer.from(o.blindedHash));
    q.count.run(o.epoch);
    return { kind: 'signed', blindSig, retry: false };
  });

  return {
    reserve: (o, sign) => reserve.immediate(o, sign),
    openEpoch: (epoch) => void q.open.run(epoch),
    markStarted: (height) => void q.started.run(height),
    closeThrough: (epoch) => {
      const n = db.transaction(() => {
        const deleted = q.del.run(epoch).changes;
        q.mark.run(epoch);
        q.closeAll.run(epoch);
        return deleted;
      })();
      // secure_delete overwrites the pages in the database file; the WAL still holds the old frames until a checkpoint
      if (n) db.pragma('wal_checkpoint(TRUNCATE)');
      return n;
    },
    issued: (epoch) => q.epoch.get(epoch)?.issued ?? 0,
    unreported: () => q.unreported.all().map((r) => r.epoch),
    markReported: (epoch, docId) => void q.reported.run(docId, epoch),
    close: () => db.close(),
  };
}
