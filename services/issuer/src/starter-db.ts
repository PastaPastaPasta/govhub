// Starter store: one starter per masternode and per proposal, for life. Its own SQLite file (STARTER_DB_PATH), so it can be backed
// up on its own: losing it re-opens every starter (README "Starter tokens").
//   starters(kind, subject, collateral, epoch, blinded_hash): PRIMARY KEY (kind, subject), UNIQUE (collateral), WITHOUT ROWID
//   kind 'mn': subject = proTxHash, collateral = its outpoint "txid:index" (a re-registered collateral gets nothing more)
//   kind 'proposal': subject = govHash, collateral NULL (SQLite's UNIQUE allows any number of NULLs)
// (epoch, blinded_hash) exist only for idempotent retries: they are set while the epoch's issuance window is open and cleared
// (NULL) by closeThrough() once S(E+1) plus the margin has passed; the dedup keys stay. No timestamps, IPs, request strings,
// signatures or per-time counts. WITHOUT ROWID: rows are stored in key order, so nothing records the order of issuance.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { equalBytes, type StarterKind } from '@govhub/badge';

export interface StarterReserveInput {
  kind: StarterKind;
  /** proTxHash or govHash, lowercase hex */
  subject: string;
  /** the MN's collateral outpoint; null for a proposal */
  collateral: string | null;
  epoch: number;
  blindedHash: Uint8Array;
}

export type StarterReserveOutcome =
  | { kind: 'signed'; blindSig: Uint8Array; retry: boolean }
  /** 'subject': this MN or proposal already has its starter; 'collateral': another proTxHash with this collateral has one */
  | { kind: 'conflict'; reason: 'subject' | 'collateral' };

export interface StarterStore {
  /**
   * Atomically (an IMMEDIATE transaction; `sign` runs inside it, so a failed signature stores nothing): a row for (kind, subject)
   * with the same epoch and blinded hash is a retry (signed again, RSA is deterministic); any other row for it is a conflict; a
   * collateral held by another proTxHash is a conflict; otherwise sign and insert.
   */
  reserve(o: StarterReserveInput, sign: () => Uint8Array): StarterReserveOutcome;
  /** Clears (epoch, blinded_hash) of every row with epoch <= `epoch` (its window closed); the dedup keys stay. Returns the rows. */
  closeThrough(epoch: number): number;
  close(): void;
}

export function openStarterStore(path: string): StarterStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // Same pragmas as the token store (db.ts): a rollback journal that is removed after each transaction, not a WAL that would keep
  // the rows in the order they were written until a checkpoint; secure_delete zeroes freed content (the cleared blinded hashes).
  const jm = db.pragma('journal_mode = DELETE', { simple: true });
  if (path !== ':memory:' && jm !== 'delete') throw new Error(`starter store: journal_mode is ${String(jm)}, expected delete (is another process using ${path}?)`);
  db.pragma('synchronous = FULL');
  db.pragma('secure_delete = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS starters (
      kind TEXT NOT NULL CHECK (kind IN ('mn', 'proposal')),
      subject TEXT NOT NULL,
      collateral TEXT UNIQUE CHECK ((kind = 'mn') = (collateral IS NOT NULL)),
      epoch INTEGER,
      blinded_hash BLOB,
      PRIMARY KEY (kind, subject)
    ) WITHOUT ROWID;
  `);
  const q = {
    bySubject: db.prepare<[string, string], { epoch: number | null; blinded_hash: Buffer | null }>('SELECT epoch, blinded_hash FROM starters WHERE kind = ? AND subject = ?'),
    byCollateral: db.prepare<[string], { subject: string }>('SELECT subject FROM starters WHERE collateral = ?'),
    insert: db.prepare<[string, string, string | null, number, Buffer]>('INSERT INTO starters (kind, subject, collateral, epoch, blinded_hash) VALUES (?, ?, ?, ?, ?)'),
    clear: db.prepare<[number]>('UPDATE starters SET epoch = NULL, blinded_hash = NULL WHERE epoch <= ?'),
  };

  const reserve = db.transaction((o: StarterReserveInput, sign: () => Uint8Array): StarterReserveOutcome => {
    const mine = q.bySubject.get(o.kind, o.subject);
    if (mine) return mine.epoch === o.epoch && mine.blinded_hash && equalBytes(mine.blinded_hash, o.blindedHash) ? { kind: 'signed', blindSig: sign(), retry: true } : { kind: 'conflict', reason: 'subject' };
    if (o.collateral !== null && q.byCollateral.get(o.collateral)) return { kind: 'conflict', reason: 'collateral' };
    const blindSig = sign();
    q.insert.run(o.kind, o.subject, o.collateral, o.epoch, Buffer.from(o.blindedHash));
    return { kind: 'signed', blindSig, retry: false };
  });

  return {
    reserve: (o, sign) => {
      if ((o.kind === 'mn') !== (o.collateral !== null)) throw new Error('starter store: a collateral belongs to kind mn only');
      return reserve.immediate(o, sign);
    },
    closeThrough: (epoch) => q.clear.run(epoch).changes,
    close: () => db.close(),
  };
}
