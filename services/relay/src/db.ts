// SQLite store (better-sqlite3). Privacy by construction: no IP column, no request log table, and the receive time is kept only as
// the hour it fell in. Release/signed times are client-chosen and needed to broadcast.
// Neither the file nor its journal keeps the order votes arrived in, or rows that were deleted (review SR-36), as in the issuer's
// token store: tables are WITHOUT ROWID, so rows sit in the order of their random id (a rowid table numbers them in arrival
// order); a rollback journal instead of a WAL (a WAL keeps every committed page in order until a checkpoint, and is removed
// after each transaction here); and secure_delete zeroes the content of purged rows.
import Database from 'better-sqlite3';

/**
 * `maybe-broadcast`: waiting to be sent again, but an earlier attempt may already have reached Core (voteraw timed out or the
 * process died mid-call, or a broadcast vote never showed up and is re-sent). It is due like `held` but can never be cancelled:
 * a cancel could not take it back from the network.
 */
export type VoteStatus = 'held' | 'maybe-broadcast' | 'sending' | 'broadcast' | 'confirmed' | 'failed' | 'cancelled' | 'superseded';
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
  /** 1 once any attempt may have reached Core: from then on the vote waits as `maybe-broadcast`, never as `held` */
  maybe_sent: number;
}

export type NewVote = Omit<VoteRow, 'status' | 'attempts' | 'broadcast_at' | 'confirmed_at' | 'last_error' | 'finished_at' | 'fail_n' | 'rebroadcasts' | 'next_attempt_at' | 'same_as_current' | 'maybe_sent'> & {
  same_as_current?: number | null;
};

export interface VoteKey {
  txid: string;
  n: number;
  govHash: string;
  signal: number;
}

/**
 * Held proposal submissions (POST /v1/proposals). `waiting`: the collateral is not deep enough yet (or a retry is pending);
 * `submitting`: `gobject submit` is in flight; `submitted` and `failed` are final.
 */
export type ProposalStatus = 'waiting' | 'submitting' | 'submitted' | 'failed';

export interface ProposalRow {
  /** 16 random bytes, hex: the handle for GET /v1/proposals/:id (never the gov hash) */
  id: string;
  gov_hash: string;
  collateral_txid: string;
  time: number;
  data_hex: string;
  status: ProposalStatus;
  /** the collateral's confirmations when last looked at (Core's `getrawtransaction <txid> true`) */
  confirmations: number;
  /** `gobject submit` calls */
  attempts: number;
  /** consecutive Core errors (drives the backoff) */
  fail_n: number;
  next_attempt_at: number;
  last_error: string | null;
  /** Core's refusal, trimmed; only with last_error `core-rejected` */
  core_message: string | null;
  /** when Core was first seen not to know the collateral (null while it does) */
  missing_since: number | null;
  /** unix time rounded DOWN to the hour: the only receive time kept */
  received_hour: number;
  submitted_at: number | null;
  finished_at: number | null;
}

export type NewProposal = Pick<ProposalRow, 'id' | 'gov_hash' | 'collateral_txid' | 'time' | 'data_hex' | 'confirmations' | 'next_attempt_at' | 'received_hour'>;

const VOTES_TABLE = `
CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY NOT NULL,
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
  same_as_current INTEGER,
  maybe_sent INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID`;
const LAST_TABLE = `
CREATE TABLE IF NOT EXISTS last_broadcast (
  collateral_txid TEXT NOT NULL,
  collateral_n INTEGER NOT NULL,
  gov_hash TEXT NOT NULL,
  signal INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (collateral_txid, collateral_n, gov_hash, signal)
) WITHOUT ROWID`;
// No IP and no exact receive time, like votes. The UNIQUE key is the idempotency key of POST /v1/proposals (and its index also
// serves the per-hash count).
const PROPOSALS_TABLE = `
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY NOT NULL,
  gov_hash TEXT NOT NULL,
  collateral_txid TEXT NOT NULL,
  time INTEGER NOT NULL,
  data_hex TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  fail_n INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  core_message TEXT,
  missing_since INTEGER,
  received_hour INTEGER NOT NULL,
  submitted_at INTEGER,
  finished_at INTEGER,
  UNIQUE (gov_hash, collateral_txid)
) WITHOUT ROWID`;
const INDEXES = `
CREATE INDEX IF NOT EXISTS votes_due ON votes (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS votes_key ON votes (collateral_txid, collateral_n, gov_hash, signal);
CREATE INDEX IF NOT EXISTS proposals_due ON proposals (status, next_attempt_at);
`;

/** The CREATE statement of `table` as stored, or null. */
const tableSql = (db: Database.Database, table: string): string | null => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql ?? null;

/**
 * Databases from before WITHOUT ROWID (they kept the arrival order in the rowid): copy every row into the new table in id order,
 * drop the old one, and VACUUM so no page of it is left in the file. Held votes that were already sent once (re-broadcast after
 * not showing up, or retried after a Core error that may have been a lost answer) become `maybe-broadcast`.
 */
function migrate(db: Database.Database): boolean {
  let changed = false;
  for (const [table, create] of [
    ['votes', VOTES_TABLE],
    ['last_broadcast', LAST_TABLE],
  ] as const) {
    const sql = tableSql(db, table);
    if (sql === null || /WITHOUT\s+ROWID/i.test(sql)) continue;
    db.transaction(() => {
      const oldCols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      if (table === 'votes') db.exec('DROP INDEX IF EXISTS votes_due; DROP INDEX IF EXISTS votes_key;');
      db.exec(create);
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name).filter((c) => oldCols.has(c));
      const list = cols.join(', ');
      db.exec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM ${table}_old ORDER BY ${table === 'votes' ? 'id' : 'collateral_txid, collateral_n, gov_hash, signal'}`);
      db.exec(`DROP TABLE ${table}_old`);
      if (table === 'votes') db.exec(`UPDATE votes SET maybe_sent = 1, status = 'maybe-broadcast' WHERE status = 'held' AND (rebroadcasts > 0 OR last_error IN ('core-error', 'not-visible'))`);
    })();
    changed = true;
  }
  return changed;
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  // Rollback journal, not WAL (see the top of this file). Switching an existing WAL database checkpoints and removes its -wal file.
  const jm = db.pragma('journal_mode = DELETE', { simple: true });
  if (path !== ':memory:' && jm !== 'delete') throw new Error(`relay db: journal_mode is ${String(jm)}, expected delete (is another process using ${path}?)`);
  db.pragma('synchronous = FULL');
  db.pragma('secure_delete = ON');
  db.pragma('busy_timeout = 5000');
  const migrated = migrate(db);
  db.exec(VOTES_TABLE);
  db.exec(LAST_TABLE);
  // new in the held-proposal version: never existed as a rowid table, so a database from before simply gets it here
  db.exec(PROPOSALS_TABLE);
  db.exec(INDEXES);
  if (migrated) db.exec('VACUUM');
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
      activeForKey: db.prepare(`SELECT * FROM votes WHERE collateral_txid = ? AND collateral_n = ? AND gov_hash = ? AND signal = ? AND status IN ('held', 'maybe-broadcast', 'sending') ORDER BY time DESC, id`),
      // held + maybe-broadcast + sending: a vote waiting to be (re)sent or in flight still occupies a slot
      heldForMn: db.prepare(`SELECT COUNT(*) n FROM votes WHERE collateral_txid = ? AND collateral_n = ? AND status IN ('held', 'maybe-broadcast', 'sending')`),
      heldAll: db.prepare(`SELECT COUNT(*) n FROM votes WHERE status IN ('held', 'maybe-broadcast', 'sending')`),
      // next_attempt_at first: a vote that keeps failing moves into the future and cannot starve the others
      due: db.prepare(`SELECT * FROM votes WHERE status IN ('held', 'maybe-broadcast') AND release_at <= ? AND next_attempt_at <= ? ORDER BY next_attempt_at, release_at, id LIMIT ?`),
      newerLive: db.prepare(
        `SELECT 1 FROM votes WHERE collateral_txid = ? AND collateral_n = ? AND gov_hash = ? AND signal = ? AND time > ? AND status IN ('held', 'maybe-broadcast', 'sending', 'broadcast', 'confirmed') LIMIT 1`,
      ),
      broadcast: db.prepare(`SELECT * FROM votes WHERE status = 'broadcast' ORDER BY broadcast_at, id`),
      // never overwrites a final state (a cancel that won the race stays cancelled)
      finish: db.prepare(`UPDATE votes SET status = ?, finished_at = ?, last_error = ? WHERE id = ? AND status IN ('held', 'maybe-broadcast', 'sending', 'broadcast')`),
      markSending: db.prepare(`UPDATE votes SET status = 'sending' WHERE id = ? AND status IN ('held', 'maybe-broadcast')`),
      // a crash mid-voteraw: the call may have reached Core
      recoverSending: db.prepare(`UPDATE votes SET status = 'maybe-broadcast', maybe_sent = 1, next_attempt_at = ?, last_error = 'core-error' WHERE status = 'sending'`),
      // only a vote that never left the relay can be cancelled
      cancelHeld: db.prepare(`UPDATE votes SET status = 'cancelled', finished_at = ?, last_error = NULL WHERE id = ? AND status = 'held'`),
      supersedeHeld: db.prepare(`UPDATE votes SET status = 'superseded', finished_at = ?, last_error = NULL WHERE id = ? AND status = 'held'`),
      // sending -> waiting again (voteraw answered "wait" or failed); also used on rows that are still waiting. @maybe = 1: the
      // attempt may have reached Core (no answer), so the vote waits as maybe-broadcast from now on.
      reschedule: db.prepare(
        `UPDATE votes SET maybe_sent = MAX(maybe_sent, @maybe), status = CASE WHEN maybe_sent = 1 OR @maybe = 1 THEN 'maybe-broadcast' ELSE 'held' END, next_attempt_at = @at, last_error = @code WHERE id = @id AND status IN ('held', 'maybe-broadcast', 'sending')`,
      ),
      retry: db.prepare(
        `UPDATE votes SET maybe_sent = MAX(maybe_sent, @maybe), status = CASE WHEN maybe_sent = 1 OR @maybe = 1 THEN 'maybe-broadcast' ELSE 'held' END, next_attempt_at = @at, last_error = @code, attempts = attempts + 1, fail_n = fail_n + 1 WHERE id = @id AND status IN ('held', 'maybe-broadcast', 'sending')`,
      ),
      sent: db.prepare(`UPDATE votes SET status = 'broadcast', broadcast_at = ?, attempts = attempts + 1, fail_n = 0, last_error = NULL WHERE id = ? AND status = 'sending'`),
      confirm: db.prepare(`UPDATE votes SET status = 'confirmed', confirmed_at = ?, finished_at = ?, last_error = NULL WHERE id = ? AND status = 'broadcast'`),
      // it was broadcast once: it may be on the network even though this Core does not show it
      rebroadcast: db.prepare(`UPDATE votes SET status = 'maybe-broadcast', maybe_sent = 1, next_attempt_at = ?, rebroadcasts = rebroadcasts + 1, last_error = 'not-visible' WHERE id = ? AND status = 'broadcast'`),
      lastBroadcast: db.prepare('SELECT at FROM last_broadcast WHERE collateral_txid = ? AND collateral_n = ? AND gov_hash = ? AND signal = ?'),
      upsertLast: db.prepare(
        `INSERT INTO last_broadcast (collateral_txid, collateral_n, gov_hash, signal, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (collateral_txid, collateral_n, gov_hash, signal) DO UPDATE SET at = excluded.at`,
      ),
      purgeVotes: db.prepare(`DELETE FROM votes WHERE status IN ('confirmed', 'failed', 'cancelled', 'superseded') AND finished_at < ?`),
      purgeLast: db.prepare('DELETE FROM last_broadcast WHERE at < ?'),

      // ---- held proposals ----
      pInsert: db.prepare(
        `INSERT INTO proposals (id, gov_hash, collateral_txid, time, data_hex, status, confirmations, next_attempt_at, received_hour)
         VALUES (@id, @gov_hash, @collateral_txid, @time, @data_hex, 'waiting', @confirmations, @next_attempt_at, @received_hour)`,
      ),
      pById: db.prepare('SELECT * FROM proposals WHERE id = ?'),
      pByKey: db.prepare('SELECT * FROM proposals WHERE gov_hash = ? AND collateral_txid = ?'),
      pCountHash: db.prepare('SELECT COUNT(*) n FROM proposals WHERE gov_hash = ?'),
      pCountHeld: db.prepare(`SELECT COUNT(*) n FROM proposals WHERE status IN ('waiting', 'submitting')`),
      pDue: db.prepare(`SELECT * FROM proposals WHERE status = 'waiting' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`),
      // a row looked at again stays waiting (or retries); `from` names the state it must be in, so a check can never undo a claim
      pWait: db.prepare(
        `UPDATE proposals SET status = 'waiting', confirmations = @confirmations, next_attempt_at = @at, last_error = @code, fail_n = @fail_n, missing_since = @missing_since
         WHERE id = @id AND status = @from`,
      ),
      pMarkSubmitting: db.prepare(`UPDATE proposals SET status = 'submitting', confirmations = MAX(0, ?), attempts = attempts + 1, missing_since = NULL WHERE id = ? AND status = 'waiting'`),
      pSubmitted: db.prepare(`UPDATE proposals SET status = 'submitted', submitted_at = ?, finished_at = ?, last_error = NULL, core_message = NULL, fail_n = 0 WHERE id = ? AND status = 'submitting'`),
      // a row that failed for a reason that can pass (the collateral went missing, or took too long) is held again on a re-POST
      pRequeue: db.prepare(
        `UPDATE proposals SET status = 'waiting', last_error = NULL, core_message = NULL, finished_at = NULL, fail_n = 0, missing_since = NULL,
         next_attempt_at = @hour, received_hour = @hour WHERE id = @id AND status = 'failed' AND last_error IN ('collateral-missing', 'unconfirmed')`,
      ),
      // never overwrites a final state
      pFail: db.prepare(`UPDATE proposals SET status = 'failed', finished_at = ?, last_error = ?, core_message = ? WHERE id = ? AND status IN ('waiting', 'submitting')`),
      pRecover: db.prepare(`UPDATE proposals SET status = 'waiting', next_attempt_at = ?, last_error = 'core-error' WHERE status = 'submitting'`),
      purgeProposals: db.prepare(`DELETE FROM proposals WHERE status IN ('submitted', 'failed') AND finished_at < ?`),
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

  /** held -> cancelled. False if the vote was not held (maybe-broadcast votes are never cancelled). */
  cancelHeld(id: string, now: number): boolean {
    return this.q.cancelHeld.run(now, id).changes > 0;
  }
  supersedeHeld(id: string, now: number): boolean {
    return this.q.supersedeHeld.run(now, id).changes > 0;
  }
  /** Terminal failure (or any other terminal state) with a short error code. */
  finish(id: string, status: Exclude<VoteStatus, 'held' | 'maybe-broadcast' | 'sending' | 'broadcast'>, now: number, code: string | null): void {
    this.q.finish.run(status, now, code, id);
  }
  /** Not a failure: (sending ->) waiting, try again at `at` (one-hour rule, future time, ...). */
  reschedule(id: string, at: number, code: string | null): void {
    this.q.reschedule.run({ at, code, id, maybe: 0 });
  }
  /**
   * An error that counts towards the retry budget. Returns the new consecutive-error count. `maybeSent`: the attempt got no answer
   * (transport error, timeout), so Core may have the vote: it waits as maybe-broadcast and can no longer be cancelled.
   */
  retryLater(id: string, at: number, code: string, maybeSent = false): number {
    this.q.retry.run({ at, code, id, maybe: maybeSent ? 1 : 0 });
    return (this.get(id) as VoteRow).fail_n;
  }
  /** held / maybe-broadcast -> sending, atomically. False if the vote was not waiting any more (cancelled, superseded). Call right before voteraw. */
  markSending(id: string): boolean {
    return this.q.markSending.run(id).changes > 0;
  }
  /** Startup: rows left in `sending` by a crash go back to waiting as maybe-broadcast, due now. Returns how many. */
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
  /** broadcast -> maybe-broadcast, due immediately. */
  markRebroadcast(id: string, now: number): void {
    this.q.rebroadcast.run(now, id);
  }
  lastBroadcastAt(k: VoteKey): number | null {
    const r = this.q.lastBroadcast.get(k.txid, k.n, k.govHash, k.signal) as { at: number } | undefined;
    return r ? r.at : null;
  }

  purge(now: number, retentionDays: number): { votes: number; lastBroadcast: number; proposals: number } {
    const votes = this.q.purgeVotes.run(now - retentionDays * 86400).changes;
    const lastBroadcast = this.q.purgeLast.run(now - 2 * 3600).changes;
    const proposals = this.q.purgeProposals.run(now - retentionDays * 86400).changes;
    return { votes, lastBroadcast, proposals };
  }

  // ---- held proposals ----

  insertProposal(p: NewProposal): void {
    this.q.pInsert.run(p);
  }
  getProposal(id: string): ProposalRow | undefined {
    return this.q.pById.get(id) as ProposalRow | undefined;
  }
  /** The idempotency key of POST /v1/proposals. */
  findProposal(govHash: string, txid: string): ProposalRow | undefined {
    return this.q.pByKey.get(govHash, txid) as ProposalRow | undefined;
  }
  /** Rows (any state) for one gov hash. */
  countProposalsForHash(govHash: string): number {
    return (this.q.pCountHash.get(govHash) as { n: number }).n;
  }
  /** waiting + submitting */
  countHeldProposals(): number {
    return (this.q.pCountHeld.get() as { n: number }).n;
  }
  dueProposals(now: number, limit: number): ProposalRow[] {
    return this.q.pDue.all(now, limit) as ProposalRow[];
  }
  /** `from` (waiting, or submitting after a `gobject submit` that must be retried) -> waiting, looked at again at `at`. */
  proposalWait(id: string, from: 'waiting' | 'submitting', w: { confirmations: number; at: number; code: string | null; failN: number; missingSince: number | null }): boolean {
    return this.q.pWait.run({ id, from, confirmations: w.confirmations, at: w.at, code: w.code, fail_n: w.failN, missing_since: w.missingSince }).changes > 0;
  }
  /** waiting -> submitting in one conditional UPDATE (counts an attempt). False if the row was not waiting. Call right before `gobject submit`. */
  markProposalSubmitting(id: string, confirmations: number): boolean {
    return this.q.pMarkSubmitting.run(confirmations, id).changes > 0;
  }
  /** `hour`: the time rounded down to the hour (the caller rounds; see proposer.ts). */
  markProposalSubmitted(id: string, hour: number): boolean {
    return this.q.pSubmitted.run(hour, hour, id).changes > 0;
  }
  /** failed (collateral-missing / unconfirmed only) -> waiting, due at once, its wait counted from `hour` again. */
  requeueProposal(id: string, hour: number): boolean {
    return this.q.pRequeue.run({ id, hour }).changes > 0;
  }
  failProposal(id: string, hour: number, code: string, coreMessage: string | null = null): boolean {
    return this.q.pFail.run(hour, code, coreMessage, id).changes > 0;
  }
  /** Startup: rows left in `submitting` by a crash go back to waiting, due now (a resubmit is harmless). Returns how many. */
  recoverSubmitting(now: number): number {
    return this.q.pRecover.run(now).changes;
  }
}
