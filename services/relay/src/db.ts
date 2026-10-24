// SQLite store (better-sqlite3, WAL). Privacy by construction: no IP column, no request log table, and the receive time is kept
// only as the hour it fell in. Release/signed times are client-chosen and needed to broadcast.
import Database from 'better-sqlite3';

export type VoteStatus = 'held' | 'sending' | 'broadcast' | 'confirmed' | 'failed' | 'cancelled' | 'superseded';
export const FINAL_STATUSES = ['confirmed', 'failed', 'cancelled', 'superseded'] as const;

export interface VoteRow {
  id: string;
  vote_hash: string;
  collateral_txid: string;
  collateral_n: number;
  gov_hash: string;
  signal: number;
  outcome: number;
  time: number;
  sig_b64: string;
  release_at: number;
  status: VoteStatus;
  attempts: number;
  next_attempt_at: number;
  broadcast_at: number | null;
  confirmed_at: number | null;
  last_error: string | null;
  /** unix time rounded DOWN to the hour: coarse on purpose */
  received_hour: number;
  finished_at: number | null;
  /** consecutive voteraw errors since the last success (drives the backoff) */
  fail_n: number;
  /** how many times the confirmer sent a not-yet-visible vote back to the broadcaster */
  rebroadcasts: number;
  /**
   * 1: when it was submitted, Core's current funding vote of this masternode had the same outcome (a re-send that only moves the
   * timestamp); 0: a different or no current vote; null: Core could not be asked.
   */
  same_as_current: number | null;
}

export type NewVote = Omit<VoteRow, 'status' | 'attempts' | 'broadcast_at' | 'confirmed_at' | 'last_error' | 'finished_at' | 'fail_n' | 'rebroadcasts' | 'next_attempt_at' | 'same_as_current'> & {
  same_as_current?: number | null;
};

export interface VoteKey {
  txid: string;
  n: number;
  govHash: string;
  signal: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  vote_hash TEXT NOT NULL UNIQUE,
  collateral_txid TEXT NOT NULL,
  collateral_n INTEGER NOT NULL,
  gov_hash TEXT NOT NULL,
  signal INTEGER NOT NULL,
  outcome INTEGER NOT NULL,
  time INTEGER NOT NULL,
  sig_b64 TEXT NOT NULL,
  release_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  broadcast_at INTEGER,
  confirmed_at INTEGER,
  last_error TEXT,
  received_hour INTEGER NOT NULL,
  finished_at INTEGER,
  fail_n INTEGER NOT NULL DEFAULT 0,
  rebroadcasts INTEGER NOT NULL DEFAULT 0,
  same_as_current INTEGER
);
CREATE INDEX IF NOT EXISTS votes_due ON votes (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS votes_key ON votes (collateral_txid, collateral_n, gov_hash, signal);
CREATE TABLE IF NOT EXISTS last_broadcast (
  collateral_txid TEXT NOT NULL,
  collateral_n INTEGER NOT NULL,
  gov_hash TEXT NOT NULL,
  signal INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (collateral_txid, collateral_n, gov_hash, signal)
);
`;

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // columns added after the first release: databases created before them get them here
  const cols = new Set((db.prepare('PRAGMA table_info(votes)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('same_as_current')) db.exec('ALTER TABLE votes ADD COLUMN same_as_current INTEGER');
  return db;
}

export class Store {
  readonly db: Database.Database;
  private readonly q;

  constructor(db: Database.Database) {
    this.db = db;
    this.q = {
      insert: db.prepare(
        `INSERT INTO votes (id, vote_hash, collateral_txid, collateral_n, gov_hash, signal, outcome, time, sig_b64, release_at, status, next_attempt_at, received_hour, same_as_current)
         VALUES (@id, @vote_hash, @collateral_txid, @collateral_n, @gov_hash, @signal, @outcome, @time, @sig_b64, @release_at, 'held', @release_at, @received_hour, @same_as_current)`,
      ),
      byId: db.prepare('SELECT * FROM votes WHERE id = ?'),
      byHash: db.prepare('SELECT * FROM votes WHERE vote_hash = ?'),
      // held and in-flight votes of one (masternode, proposal, signal), newest signed time first
      activeForKey: db.prepare(`SELECT * FROM votes WHERE collateral_txid = ? AND collateral_n = ? AND gov_hash = ? AND signal = ? AND status IN ('held', 'sending') ORDER BY time DESC, id`),
      // held + sending: a vote in flight still occupies a slot
      heldForMn: db.prepare(`SELECT COUNT(*) n FROM votes WHERE collateral_txid = ? AND collateral_n = ? AND status IN ('held', 'sending')`),
      heldAll: db.prepare(`SELECT COUNT(*) n FROM votes WHERE status IN ('held', 'sending')`),
      // next_attempt_at first: a vote that keeps failing moves into the future and cannot starve the others
      due: db.prepare(`SELECT * FROM votes WHERE status = 'held' AND release_at <= ? AND next_attempt_at <= ? ORDER BY next_attempt_at, release_at, id LIMIT ?`),
      newerLive: db.prepare(
        `SELECT 1 FROM votes WHERE collateral_txid = ? AND collateral_n = ? AND gov_hash = ? AND signal = ? AND time > ? AND status IN ('held', 'sending', 'broadcast', 'confirmed') LIMIT 1`,
      ),
      broadcast: db.prepare(`SELECT * FROM votes WHERE status = 'broadcast' ORDER BY broadcast_at, id`),
      // never overwrites a final state (a cancel that won the race stays cancelled)
      finish: db.prepare(`UPDATE votes SET status = ?, finished_at = ?, last_error = ? WHERE id = ? AND status IN ('held', 'sending', 'broadcast')`),
      markSending: db.prepare(`UPDATE votes SET status = 'sending' WHERE id = ? AND status = 'held'`),
      recoverSending: db.prepare(`UPDATE votes SET status = 'held', next_attempt_at = ? WHERE status = 'sending'`),
      cancelHeld: db.prepare(`UPDATE votes SET status = 'cancelled', finished_at = ?, last_error = NULL WHERE id = ? AND status = 'held'`),
      supersedeHeld: db.prepare(`UPDATE votes SET status = 'superseded', finished_at = ?, last_error = NULL WHERE id = ? AND status = 'held'`),
      // sending -> held again (voteraw answered "wait" or failed transiently); also used on rows that are still held
      reschedule: db.prepare(`UPDATE votes SET status = 'held', next_attempt_at = ?, last_error = ? WHERE id = ? AND status IN ('held', 'sending')`),
      retry: db.prepare(
        `UPDATE votes SET status = 'held', next_attempt_at = ?, last_error = ?, attempts = attempts + 1, fail_n = fail_n + 1 WHERE id = ? AND status IN ('held', 'sending')`,
      ),
      sent: db.prepare(`UPDATE votes SET status = 'broadcast', broadcast_at = ?, attempts = attempts + 1, fail_n = 0, last_error = NULL WHERE id = ? AND status = 'sending'`),
      confirm: db.prepare(`UPDATE votes SET status = 'confirmed', confirmed_at = ?, finished_at = ?, last_error = NULL WHERE id = ? AND status = 'broadcast'`),
      rebroadcast: db.prepare(`UPDATE votes SET status = 'held', next_attempt_at = ?, rebroadcasts = rebroadcasts + 1, last_error = 'not-visible' WHERE id = ? AND status = 'broadcast'`),
      lastBroadcast: db.prepare('SELECT at FROM last_broadcast WHERE collateral_txid = ? AND collateral_n = ? AND gov_hash = ? AND signal = ?'),
      upsertLast: db.prepare(
        `INSERT INTO last_broadcast (collateral_txid, collateral_n, gov_hash, signal, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (collateral_txid, collateral_n, gov_hash, signal) DO UPDATE SET at = excluded.at`,
      ),
      purgeVotes: db.prepare(`DELETE FROM votes WHERE status IN ('confirmed', 'failed', 'cancelled', 'superseded') AND finished_at < ?`),
      purgeLast: db.prepare('DELETE FROM last_broadcast WHERE at < ?'),
    };
  }

  close(): void {
    this.db.close();
  }

  insert(v: NewVote): void {
    this.q.insert.run({ same_as_current: null, ...v });
  }
  get(id: string): VoteRow | undefined {
    return this.q.byId.get(id) as VoteRow | undefined;
  }
  getByVoteHash(hash: string): VoteRow | undefined {
    return this.q.byHash.get(hash) as VoteRow | undefined;
  }
  activeForKey(k: VoteKey): VoteRow[] {
    return this.q.activeForKey.all(k.txid, k.n, k.govHash, k.signal) as VoteRow[];
  }
  /** Is there a vote of the same key with a later signed time that is queued, in flight, broadcast or confirmed? Then this one is obsolete. */
  hasNewerLive(k: VoteKey, time: number): boolean {
    return this.q.newerLive.get(k.txid, k.n, k.govHash, k.signal, time) !== undefined;
  }
  countHeldForMn(txid: string, n: number): number {
    return (this.q.heldForMn.get(txid, n) as { n: number }).n;
  }
  countHeld(): number {
    return (this.q.heldAll.get() as { n: number }).n;
  }
  dueHeld(now: number, limit: number): VoteRow[] {
    return this.q.due.all(now, now, limit) as VoteRow[];
  }
  listBroadcast(): VoteRow[] {
    return this.q.broadcast.all() as VoteRow[];
  }

  /** held -> cancelled. False if the vote was not held. */
  cancelHeld(id: string, now: number): boolean {
    return this.q.cancelHeld.run(now, id).changes > 0;
  }
  supersedeHeld(id: string, now: number): boolean {
    return this.q.supersedeHeld.run(now, id).changes > 0;
  }
  /** Terminal failure (or any other terminal state) with a short error code. */
  finish(id: string, status: Exclude<VoteStatus, 'held' | 'sending' | 'broadcast'>, now: number, code: string | null): void {
    this.q.finish.run(status, now, code, id);
  }
  /** Not a failure: (sending ->) held, try again at `at` (one-hour rule, future time, ...). */
  reschedule(id: string, at: number, code: string | null): void {
    this.q.reschedule.run(at, code, id);
  }
  /** A voteraw error that counts towards the retry budget. Returns the new consecutive-error count. */
  retryLater(id: string, at: number, code: string): number {
    this.q.retry.run(at, code, id);
    return (this.get(id) as VoteRow).fail_n;
  }
  /** held -> sending, atomically. False if the vote was not held any more (cancelled, superseded). Call right before voteraw. */
  markSending(id: string): boolean {
    return this.q.markSending.run(id).changes > 0;
  }
  /** Startup: rows left in `sending` by a crash go back to held, due now. Returns how many. */
  recoverSending(now: number): number {
    return this.q.recoverSending.run(now).changes;
  }
  /** voteraw said "Voted successfully" (or that Core already has the vote): sending -> broadcast. */
  markSent(row: VoteRow, now: number): void {
    this.db.transaction(() => {
      if (this.q.sent.run(now, row.id).changes > 0) this.q.upsertLast.run(row.collateral_txid, row.collateral_n, row.gov_hash, row.signal, now);
    })();
  }
  markConfirmed(id: string, now: number): void {
    this.q.confirm.run(now, now, id);
  }
  /** broadcast -> held again, due immediately. */
  markRebroadcast(id: string, now: number): void {
    this.q.rebroadcast.run(now, id);
  }
  lastBroadcastAt(k: VoteKey): number | null {
    const r = this.q.lastBroadcast.get(k.txid, k.n, k.govHash, k.signal) as { at: number } | undefined;
    return r ? r.at : null;
  }

  purge(now: number, retentionDays: number): { votes: number; lastBroadcast: number } {
    const votes = this.q.purgeVotes.run(now - retentionDays * 86400).changes;
    const lastBroadcast = this.q.purgeLast.run(now - 2 * 3600).changes;
    return { votes, lastBroadcast };
  }
}
