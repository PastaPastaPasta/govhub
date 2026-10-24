// SQLite archive. Append-only for history: rows are inserted or annotated, never deleted.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Every governance object ever seen (proposals and triggers). Hashes are DISPLAY hex.
CREATE TABLE IF NOT EXISTS gov_objects (
  hash TEXT PRIMARY KEY,
  type INTEGER NOT NULL,
  parent_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  time INTEGER NOT NULL,
  collateral_hash TEXT NOT NULL,
  data_hex TEXT NOT NULL,
  mn_outpoint TEXT,
  sig_hex TEXT,
  raw_hex TEXT,
  source TEXT NOT NULL,
  first_seen_height INTEGER NOT NULL,
  first_seen_time INTEGER NOT NULL,
  hash_ok INTEGER NOT NULL,
  data_valid INTEGER,
  data_errors TEXT,
  collateral_raw_hex TEXT,
  collateral_height INTEGER,
  collateral_blockhash TEXT,
  collateral_ok INTEGER,
  collateral_error TEXT,
  in_core INTEGER NOT NULL DEFAULT 1,
  last_seen_in_core INTEGER,
  removed_from_core_at INTEGER
);
CREATE INDEX IF NOT EXISTS gov_objects_type ON gov_objects(type);

-- Every signed vote ever seen, raw SER_NETWORK bytes plus parsed fields.
CREATE TABLE IF NOT EXISTS votes (
  hash TEXT PRIMARY KEY,
  raw_hex TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  collateral_txid TEXT NOT NULL,
  collateral_n INTEGER NOT NULL,
  outcome INTEGER NOT NULL,
  signal INTEGER NOT NULL,
  time INTEGER NOT NULL,
  sig_hex TEXT NOT NULL,
  source TEXT NOT NULL,
  first_seen_height INTEGER NOT NULL,
  first_seen_time INTEGER NOT NULL,
  sig_status TEXT NOT NULL DEFAULT 'pending',
  signer_keyid TEXT,
  pro_tx_hash TEXT,
  checked_height INTEGER
);
CREATE INDEX IF NOT EXISTS votes_parent ON votes(parent_hash, signal);
CREATE INDEX IF NOT EXISTS votes_status ON votes(sig_status);
CREATE INDEX IF NOT EXISTS votes_outpoint ON votes(collateral_txid, collateral_n);

-- Masternode lists, content-addressed (the voting-relevant fields change rarely), plus which list was current at a height.
CREATE TABLE IF NOT EXISTS mn_lists (
  list_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  valid_count INTEGER NOT NULL,
  valid_weighted INTEGER NOT NULL,
  total_weighted INTEGER NOT NULL,
  first_height INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mn_list_entries (
  list_hash TEXT NOT NULL,
  pro_tx_hash TEXT NOT NULL,
  collateral_txid TEXT NOT NULL,
  collateral_n INTEGER NOT NULL,
  type TEXT NOT NULL,
  weight INTEGER NOT NULL,
  voting_address TEXT NOT NULL,
  voting_keyid TEXT,
  is_valid INTEGER NOT NULL,
  pose_ban_height INTEGER NOT NULL,
  registered_height INTEGER NOT NULL,
  PRIMARY KEY (list_hash, pro_tx_hash)
);
CREATE INDEX IF NOT EXISTS mn_list_entries_collateral ON mn_list_entries(list_hash, collateral_txid, collateral_n);
CREATE TABLE IF NOT EXISTS mn_snapshots (
  height INTEGER PRIMARY KEY,
  block_hash TEXT NOT NULL,
  list_hash TEXT NOT NULL,
  taken_at INTEGER NOT NULL
);

-- getgovernanceinfo / getsuperblockbudget, one row per height they were read at.
CREATE TABLE IF NOT EXISTS budget_snapshots (
  height INTEGER PRIMARY KEY,
  taken_at INTEGER NOT NULL,
  governance_info TEXT NOT NULL,
  next_superblock INTEGER NOT NULL,
  next_budget_duffs INTEGER NOT NULL
);
-- Superblocks that have happened: what the coinbase actually paid against the trigger.
CREATE TABLE IF NOT EXISTS superblocks (
  height INTEGER PRIMARY KEY,
  block_hash TEXT NOT NULL,
  block_time INTEGER NOT NULL,
  budget_duffs INTEGER NOT NULL,
  paid_duffs INTEGER NOT NULL,
  trigger_hash TEXT,
  payments TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

-- Bridge tallies (history), each compared with Core's FundingResult.
CREATE TABLE IF NOT EXISTS tallies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gov_hash TEXT NOT NULL,
  as_of_height INTEGER NOT NULL,
  list_hash TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  yes_weighted INTEGER NOT NULL,
  no_weighted INTEGER NOT NULL,
  abstain_weighted INTEGER NOT NULL,
  yes_count INTEGER NOT NULL,
  no_count INTEGER NOT NULL,
  abstain_count INTEGER NOT NULL,
  vote_count INTEGER NOT NULL,
  vote_set_hash TEXT NOT NULL,
  rank INTEGER NOT NULL,
  in_next_budget INTEGER NOT NULL,
  margin INTEGER NOT NULL,
  core_yes INTEGER,
  core_no INTEGER,
  core_abstain INTEGER,
  core_absolute INTEGER,
  core_match INTEGER,
  mismatch TEXT,
  -- JSON array of the vote hashes behind vote_set_hash (lets the API serve the exact set of a past tally)
  counted_votes TEXT
);
CREATE INDEX IF NOT EXISTS tallies_gov ON tallies(gov_hash, id);

-- Platform documents this bridge published (one row per contract/type/key) and every write attempt.
CREATE TABLE IF NOT EXISTS platform_docs (
  contract_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (contract_id, doc_type, doc_key)
);
CREATE TABLE IF NOT EXISTS publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  contract_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  op TEXT NOT NULL,
  doc_id TEXT,
  revision INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1
);

-- Anything noteworthy: ZMQ gaps, tally mismatches, invalid signatures, reconcile results.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
-- ZMQ bodies that failed to parse (kept verbatim).
CREATE TABLE IF NOT EXISTS bad_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  topic TEXT NOT NULL,
  seq INTEGER NOT NULL,
  body_hex TEXT NOT NULL,
  error TEXT NOT NULL
);
`;

export function openArchive(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')").run();
  return db;
}

/** Additive migrations for archives created by earlier versions (columns are only ever added). */
function migrate(db: DB): void {
  const cols = new Set((db.prepare('PRAGMA table_info(tallies)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('counted_votes')) db.exec('ALTER TABLE tallies ADD COLUMN counted_votes TEXT');
}

export function recordEvent(db: DB, kind: string, detail: unknown): void {
  db.prepare('INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)').run(Math.floor(Date.now() / 1000), kind, JSON.stringify(detail));
}

export function getMeta(db: DB, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------------- row types ----------------

export interface GovObjectRow {
  hash: string;
  type: number;
  parent_hash: string;
  revision: number;
  time: number;
  collateral_hash: string;
  data_hex: string;
  mn_outpoint: string | null;
  sig_hex: string | null;
  raw_hex: string | null;
  source: string;
  first_seen_height: number;
  first_seen_time: number;
  hash_ok: number;
  data_valid: number | null;
  data_errors: string | null;
  collateral_raw_hex: string | null;
  collateral_height: number | null;
  collateral_blockhash: string | null;
  collateral_ok: number | null;
  collateral_error: string | null;
  in_core: number;
  last_seen_in_core: number | null;
  removed_from_core_at: number | null;
}

export interface VoteRow {
  hash: string;
  raw_hex: string;
  parent_hash: string;
  collateral_txid: string;
  collateral_n: number;
  outcome: number;
  signal: number;
  time: number;
  sig_hex: string;
  source: string;
  first_seen_height: number;
  first_seen_time: number;
  sig_status: VoteStatus;
  signer_keyid: string | null;
  pro_tx_hash: string | null;
  checked_height: number | null;
}

/** pending: not checked yet; valid / invalid: ECDSA voting-key check; unknown-mn: outpoint not in the MN list it was checked against;
 *  bls-unverified: 96-byte operator-key signature (non-funding signals, triggers), archived but not verified by the bridge. */
export type VoteStatus = 'pending' | 'valid' | 'invalid' | 'unknown-mn' | 'bls-unverified' | 'malformed';

export interface MnEntryRow {
  list_hash: string;
  pro_tx_hash: string;
  collateral_txid: string;
  collateral_n: number;
  type: string;
  weight: number;
  voting_address: string;
  voting_keyid: string | null;
  is_valid: number;
  pose_ban_height: number;
  registered_height: number;
}

export interface TallyRow {
  id: number;
  gov_hash: string;
  as_of_height: number;
  list_hash: string;
  computed_at: number;
  yes_weighted: number;
  no_weighted: number;
  abstain_weighted: number;
  yes_count: number;
  no_count: number;
  abstain_count: number;
  vote_count: number;
  vote_set_hash: string;
  rank: number;
  in_next_budget: number;
  margin: number;
  core_yes: number | null;
  core_no: number | null;
  core_abstain: number | null;
  core_absolute: number | null;
  core_match: number | null;
  mismatch: string | null;
  counted_votes: string | null;
}

export interface PlatformDocRow {
  contract_id: string;
  doc_type: string;
  doc_key: string;
  doc_id: string;
  revision: number;
  content_hash: string;
  content_json: string;
  published_at: number;
}
