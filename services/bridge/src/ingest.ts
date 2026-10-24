// Ingest: archive governance objects and signed votes (ZMQ, RPC reconciliation, governance.dat), verify them, and keep
// masternode-list / budget snapshots. Everything is written to SQLite before anything is derived from it.
import { bytesToHex, checkCollateralTx, hexToBytes, recoverVoteSigner, uint256FromDisplay, validateProposalData, VOTE_SIGNAL } from '@govhub/verify';
import { recordEvent, type DB, type GovObjectRow, type VoteRow, type VoteStatus } from './archive/db.ts';
import type { CoreNetwork } from './config.ts';
import { govObjectHash, NULL_OUTPOINT, parseHashBody, parseRawGovObject, parseRawVote, serializeGovObject, type Outpoint, type ParsedGovObject, type ParsedVote } from './core/govparse.ts';
import { parseGovernanceDat } from './core/govdat.ts';
import type { CoreRpc, GobjectListEntry } from './core/rpc.ts';
import type { ZmqMessage } from './core/zmq.ts';
import { log } from './log.ts';
import { latestSnapshot, MnListCache, snapshotAt, snapshotMnList, type MnList } from './mnlist.ts';
import { triggerView } from './proposal.ts';

export const GOV_TYPE_PROPOSAL = 1;
export const GOV_TYPE_TRIGGER = 2;

export type Source = 'zmq' | 'rpc' | 'govdat';

const nowS = () => Math.floor(Date.now() / 1000);

export interface IngestStats {
  objectsNew: number;
  votesNew: number;
  votesDuplicate: number;
  badMessages: number;
}

export class Ingestor {
  readonly db: DB;
  readonly rpc: CoreRpc;
  readonly network: CoreNetwork;
  readonly lists: MnListCache;
  /** Best known tip height (from hashblock / RPC). */
  height = 0;
  tipHash = '';
  lastChainLockHash = '';
  /** Set by the bridge from `mnsync status` (IsBlockchainSynced). */
  chainSynced = false;
  stats: IngestStats = { objectsNew: 0, votesNew: 0, votesDuplicate: 0, badMessages: 0 };
  private verifyScheduled = false;
  private snapshotInFlight: Promise<MnList | null> | null = null;
  private lastSnapshotHeight = 0;
  private missingTriggerWarned = 0;

  constructor(db: DB, rpc: CoreRpc, network: CoreNetwork) {
    this.db = db;
    this.rpc = rpc;
    this.network = network;
    this.lists = new MnListCache(db);
  }

  // ------------------------------------------------------------------ ZMQ

  async onZmq(m: ZmqMessage): Promise<void> {
    switch (m.topic) {
      case 'rawgovernancevote': {
        let v: ParsedVote;
        try {
          v = parseRawVote(m.body);
        } catch (e) {
          this.badMessage(m, e);
          return;
        }
        this.archiveVote(v, 'zmq', this.height, m.receivedAt);
        this.scheduleVerify();
        return;
      }
      case 'rawgovernanceobject': {
        let o: ParsedGovObject;
        try {
          o = parseRawGovObject(m.body);
        } catch (e) {
          this.badMessage(m, e);
          return;
        }
        this.archiveObject(o, 'zmq', this.height, m.receivedAt);
        if (o.type === GOV_TYPE_PROPOSAL) void this.checkCollateral(o.hash).catch((e) => log.warn('collateral check failed', { hash: o.hash, error: String(e) }));
        return;
      }
      case 'hashblock': {
        // during initial block download Core publishes every connected block: leave height tracking to the RPC poll then
        if (!this.chainSynced) return;
        const hash = parseHashBody(m.body);
        // not awaited: an RPC round trip must not stall the ZMQ receive loop
        void this.rpc.getBlockHeader(hash).then(
          (h) => {
            if (h.height >= this.height) {
              this.height = h.height;
              this.tipHash = hash;
            }
          },
          (e) => log.warn('hashblock: header lookup failed', { hash, error: String(e) }),
        );
        return;
      }
      case 'hashchainlock':
        this.lastChainLockHash = parseHashBody(m.body);
        return;
    }
  }

  private badMessage(m: ZmqMessage, e: unknown): void {
    this.stats.badMessages++;
    this.db.prepare('INSERT INTO bad_messages(received_at, topic, seq, body_hex, error) VALUES (?, ?, ?, ?, ?)').run(m.receivedAt, m.topic, m.seq, bytesToHex(m.body), String((e as Error)?.message ?? e));
    log.error('unparseable zmq message archived in bad_messages', { topic: m.topic, seq: m.seq, error: String((e as Error)?.message ?? e) });
  }

  // ------------------------------------------------------------------ archive

  /** Inserts an object. If it is already known without raw bytes and this copy has them, fills them in. Returns true if new. */
  archiveObject(o: ParsedGovObject | RpcObject, source: Source, height: number, at = nowS()): boolean {
    const raw = 'raw' in o && o.raw ? bytesToHex(o.raw) : null;
    const sig = 'sig' in o && o.sig ? bytesToHex(o.sig) : null;
    const outpoint = o.masternodeOutpoint && o.masternodeOutpoint.txid !== NULL_OUTPOINT.txid ? `${o.masternodeOutpoint.txid}-${o.masternodeOutpoint.n}` : null;
    let hashOk = 0;
    if (raw !== null || o.type === GOV_TYPE_PROPOSAL) {
      try {
        hashOk = govObjectHash({ parentHash: o.parentHash, revision: o.revision, time: o.time, dataHex: o.dataHex, masternodeOutpoint: o.masternodeOutpoint ?? NULL_OUTPOINT, sig: 'sig' in o && o.sig ? o.sig : new Uint8Array() }) === o.hash ? 1 : 0;
      } catch {
        hashOk = 0;
      }
    }
    let dataValid: number | null = null;
    let dataErrors: string | null = null;
    if (o.type === GOV_TYPE_PROPOSAL) {
      // Relayed proposals are validated WITHOUT the expiry rule (Core: fCheckExpiration=false for network objects).
      const v = validateProposalData(o.dataHex, this.network);
      dataValid = v.valid ? 1 : 0;
      dataErrors = v.valid ? null : v.errors.join('; ');
    }
    const existing = this.db.prepare('SELECT raw_hex FROM gov_objects WHERE hash = ?').get(o.hash) as { raw_hex: string | null } | undefined;
    if (existing) {
      if (existing.raw_hex === null && raw !== null && hashOk) {
        this.db.prepare('UPDATE gov_objects SET raw_hex = ?, sig_hex = ?, revision = ?, mn_outpoint = ?, hash_ok = ? WHERE hash = ?').run(raw, sig, o.revision, outpoint, hashOk, o.hash);
      }
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO gov_objects(hash, type, parent_hash, revision, time, collateral_hash, data_hex, mn_outpoint, sig_hex, raw_hex, source,
           first_seen_height, first_seen_time, hash_ok, data_valid, data_errors, in_core, last_seen_in_core)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // a governance.dat copy may hold objects Core has dropped since: only ZMQ/RPC prove Core holds it now
      .run(o.hash, o.type, o.parentHash, o.revision, o.time, o.collateralHash, o.dataHex.toLowerCase(), outpoint, sig, raw, source, height, at, hashOk, dataValid, dataErrors, source === 'govdat' ? 0 : 1, source === 'govdat' ? null : at);
    this.stats.objectsNew++;
    if (!hashOk && raw !== null) recordEvent(this.db, 'object-hash-mismatch', { hash: o.hash, source });
    log.info('governance object archived', { hash: o.hash, type: o.type, source, hashOk: !!hashOk, dataValid });
    return true;
  }

  /** Inserts a vote (idempotent on the vote hash). Returns true if new. */
  archiveVote(v: ParsedVote, source: Source, height: number, at = nowS()): boolean {
    const status: VoteStatus = v.sig.length === 96 ? 'bls-unverified' : v.sig.length === 65 ? 'pending' : 'malformed';
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO votes(hash, raw_hex, parent_hash, collateral_txid, collateral_n, outcome, signal, time, sig_hex, source, first_seen_height, first_seen_time, sig_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.hash, bytesToHex(v.raw), v.parentHash, v.outpoint.txid, v.outpoint.n, v.outcome, v.signal, v.time, bytesToHex(v.sig), source, height, at, status);
    if (r.changes === 0) {
      this.stats.votesDuplicate++;
      // The vote hash does not cover the signature: a copy with a different signature is the same vote. If the stored copy's
      // signature failed, keep the old copy in `events` (history) and check this one instead.
      const ex = this.db.prepare('SELECT sig_hex, sig_status, source FROM votes WHERE hash = ?').get(v.hash) as { sig_hex: string; sig_status: VoteStatus; source: string };
      if (ex.sig_hex !== bytesToHex(v.sig) && (ex.sig_status === 'invalid' || ex.sig_status === 'malformed')) {
        recordEvent(this.db, 'vote-copy-replaced', { hash: v.hash, old: ex, newSource: source });
        this.db
          .prepare('UPDATE votes SET raw_hex = ?, sig_hex = ?, source = ?, sig_status = ?, signer_keyid = NULL, pro_tx_hash = NULL, checked_height = NULL WHERE hash = ?')
          .run(bytesToHex(v.raw), bytesToHex(v.sig), source, status, v.hash);
      }
      return false;
    }
    this.stats.votesNew++;
    return true;
  }

  // ------------------------------------------------------------------ verification

  private scheduleVerify(): void {
    if (this.verifyScheduled) return;
    this.verifyScheduled = true;
    setTimeout(() => {
      this.verifyScheduled = false;
      this.verifyAllPending().then(
        (n) => n > 0 && log.debug('votes verified', { n }),
        (e) => log.error('vote verification failed', { error: String((e as Error)?.stack ?? e) }),
      );
    }, 250);
  }

  /** verifyPendingVotes in batches, yielding to the event loop between them (a re-sync brings tens of thousands of votes). */
  async verifyAllPending(batch = 500): Promise<number> {
    let total = 0;
    for (;;) {
      const n = this.verifyPendingVotes(batch);
      total += n;
      if (n < batch) return total;
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  /**
   * Checks pending ECDSA vote signatures against the voting key of the masternode that owns the vote's collateral outpoint:
   * in the MN list in force when the vote was first seen (the list Core used to accept it), then in the latest list.
   * A vote is decided only once a list read AFTER it arrived exists (so a key change in the block before the vote is never
   * judged against a stale list); 'invalid' / 'unknown-mn' are re-checked whenever the list changes (recheckAfterListChange).
   * Returns the number of votes decided.
   */
  verifyPendingVotes(limit = 10_000): number {
    const latest = latestSnapshot(this.db);
    if (!latest) return 0;
    const rows = this.db.prepare("SELECT * FROM votes WHERE sig_status = 'pending' AND first_seen_time <= ? LIMIT ?").all(latest.takenAt, limit) as VoteRow[];
    if (rows.length === 0) return 0;
    const upd = this.db.prepare('UPDATE votes SET sig_status = ?, signer_keyid = ?, pro_tx_hash = ?, checked_height = ? WHERE hash = ?');
    let decided = 0;
    const invalid: string[] = [];
    this.db.transaction(() => {
      for (const v of rows) {
        const res = this.checkVote(v, latest.height);
        upd.run(res.status, res.signer, res.proTxHash, res.checkedHeight, v.hash);
        decided++;
        if (res.status === 'invalid') invalid.push(v.hash);
      }
    })();
    if (invalid.length) {
      recordEvent(this.db, 'invalid-vote-signatures', { count: invalid.length, hashes: invalid.slice(0, 50) });
      log.warn('votes with signatures that do not match the voting key', { count: invalid.length });
    }
    return decided;
  }

  checkVote(v: VoteRow, latestHeight: number): { status: VoteStatus; signer: string | null; proTxHash: string | null; checkedHeight: number | null } {
    const fields = { collateralTxid: v.collateral_txid, collateralIndex: v.collateral_n, govHashDisplay: v.parent_hash, signal: v.signal, outcome: v.outcome, time: v.time };
    const signer = recoverVoteSigner(hexToBytes(v.sig_hex), fields, this.network);
    const signerHex = signer ? bytesToHex(signer.keyId) : null;
    const key = `${v.collateral_txid}-${v.collateral_n}`;
    // first_seen_height 0 = the bridge did not know the height yet (start-up): only the latest list applies
    const candidates = [v.first_seen_height > 0 ? snapshotAt(this.db, v.first_seen_height) : null, snapshotAt(this.db, latestHeight)];
    let found: { proTxHash: string; height: number } | null = null;
    for (const snap of candidates) {
      if (!snap) continue;
      const entry = this.lists.load(snap.listHash)?.byOutpoint.get(key);
      if (!entry) continue;
      found ??= { proTxHash: entry.proTxHash, height: snap.height };
      if (signerHex && entry.votingKeyId === signerHex) return { status: 'valid', signer: signerHex, proTxHash: entry.proTxHash, checkedHeight: snap.height };
    }
    if (!found) return { status: 'unknown-mn', signer: signerHex, proTxHash: null, checkedHeight: candidates[0]?.height ?? null };
    return { status: 'invalid', signer: signerHex, proTxHash: found.proTxHash, checkedHeight: found.height };
  }

  /** After the MN list changed: votes that failed against older lists (new MN, changed voting key) are checked again. */
  recheckAfterListChange(): number {
    return this.db.prepare("UPDATE votes SET sig_status = 'pending' WHERE sig_status IN ('unknown-mn', 'invalid')").run().changes;
  }

  // ------------------------------------------------------------------ collateral

  /** Fetches the collateral tx (needs -txindex) and runs checkCollateralTx. Records height/blockhash for confirmations. */
  async checkCollateral(hash: string): Promise<GovObjectRow | undefined> {
    const row = this.db.prepare('SELECT * FROM gov_objects WHERE hash = ?').get(hash) as GovObjectRow | undefined;
    if (!row || row.type !== GOV_TYPE_PROPOSAL) return row;
    if (row.collateral_ok === 1 && row.collateral_height !== null) return row;
    let tx;
    try {
      tx = await this.rpc.getRawTransactionVerbose(row.collateral_hash);
    } catch (e) {
      this.db.prepare('UPDATE gov_objects SET collateral_error = ? WHERE hash = ?').run(`getrawtransaction: ${String((e as Error).message ?? e)}`, hash);
      return row;
    }
    const res = checkCollateralTx(hexToBytes(tx.hex), uint256FromDisplay(hash), { expectedTxid: row.collateral_hash });
    const height = tx.height ?? (tx.blockhash ? (await this.rpc.getBlockHeader(tx.blockhash)).height : null);
    this.db
      .prepare('UPDATE gov_objects SET collateral_raw_hex = ?, collateral_height = ?, collateral_blockhash = ?, collateral_ok = ?, collateral_error = ? WHERE hash = ?')
      .run(tx.hex, height, tx.blockhash ?? null, res.valid ? 1 : 0, res.valid ? null : `${res.failure}: ${res.message ?? ''}`, hash);
    if (!res.valid) {
      recordEvent(this.db, 'collateral-invalid', { hash, failure: res.failure, message: res.message });
      log.error('proposal collateral does not verify', { hash, failure: res.failure });
    }
    return this.db.prepare('SELECT * FROM gov_objects WHERE hash = ?').get(hash) as GovObjectRow;
  }

  // ------------------------------------------------------------------ RPC reconciliation

  async refreshHeight(): Promise<number> {
    const h = await this.rpc.getBlockCount();
    if (h > this.height) {
      this.height = h;
      this.tipHash = await this.rpc.getBlockHash(h);
    }
    return this.height;
  }

  /** Takes an MN-list snapshot at `height` unless one was taken at that height already. */
  async ensureSnapshot(height: number): Promise<MnList | null> {
    if (height <= this.lastSnapshotHeight) return null;
    if (this.snapshotInFlight) return this.snapshotInFlight;
    this.snapshotInFlight = (async () => {
      try {
        const before = latestSnapshot(this.db)?.listHash;
        const list = await snapshotMnList(this.db, this.rpc, this.network, height);
        this.lastSnapshotHeight = height;
        if (before !== undefined && before !== list.listHash) this.recheckAfterListChange();
        this.scheduleVerify();
        return list;
      } catch (e) {
        log.warn('mn list snapshot failed', { height, error: String((e as Error).message ?? e) });
        return null;
      } finally {
        this.snapshotInFlight = null;
      }
    })();
    return this.snapshotInFlight;
  }

  /**
   * `gobject list all`: archive objects Core has that we missed (e.g. before the listener ran) and mark the ones Core dropped.
   * Proposals carry no signature or outpoint, so their exact network bytes are rebuilt (revision 1; `gobject list` does not
   * return the revision) and accepted only if the rebuilt hash equals Core's. `markRemoved` = false while Core's governance
   * sync is incomplete (its list is partial then).
   */
  async reconcileObjects(opts: { markRemoved: boolean } = { markRemoved: true }): Promise<{ inCore: number; added: number; removed: number }> {
    const list = await this.rpc.gobjectList('all', 'all');
    const at = nowS();
    let added = 0;
    const seen = new Set<string>();
    for (const [hash, e] of Object.entries(list)) {
      seen.add(hash);
      if (this.archiveObject(rpcObject(hash, e), 'rpc', this.height, at)) added++;
      this.db.prepare('UPDATE gov_objects SET in_core = 1, last_seen_in_core = ?, removed_from_core_at = NULL WHERE hash = ?').run(at, hash);
    }
    let removed = 0;
    // an unsynced Core lists only part of the governance set: do not mark anything as dropped then
    for (const r of opts.markRemoved ? (this.db.prepare('SELECT hash FROM gov_objects WHERE in_core = 1').all() as Array<{ hash: string }>) : []) {
      if (!seen.has(r.hash)) {
        this.db.prepare('UPDATE gov_objects SET in_core = 0, removed_from_core_at = ? WHERE hash = ?').run(at, r.hash);
        removed++;
      }
    }
    // collateral for every proposal not yet checked
    const pending = this.db.prepare('SELECT hash FROM gov_objects WHERE type = 1 AND (collateral_ok IS NULL OR collateral_height IS NULL)').all() as Array<{ hash: string }>;
    for (const p of pending) await this.checkCollateral(p.hash);
    if (added || removed) recordEvent(this.db, 'reconcile', { inCore: seen.size, added, removed });
    return { inCore: seen.size, added, removed };
  }

  /** Records getgovernanceinfo + getsuperblockbudget(next) at the current height. */
  async snapshotBudget(): Promise<{ info: any; nextBudgetDuffs: number }> {
    const info = await this.rpc.getGovernanceInfo();
    const budget = await this.rpc.getSuperblockBudget(info.nextsuperblock);
    const nextBudgetDuffs = dashToDuffs(budget);
    this.db
      .prepare('INSERT INTO budget_snapshots(height, taken_at, governance_info, next_superblock, next_budget_duffs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(height) DO UPDATE SET taken_at = excluded.taken_at, governance_info = excluded.governance_info, next_budget_duffs = excluded.next_budget_duffs')
      .run(this.height, nowS(), JSON.stringify(info), info.nextsuperblock, nextBudgetDuffs);
    return { info, nextBudgetDuffs };
  }

  /**
   * After a superblock: what its coinbase actually paid. Payments come from the archived trigger for that height
   * (address + amount); each is matched to one coinbase output with exactly that script address and value.
   */
  async recordSuperblock(sbHeight: number): Promise<void> {
    if (sbHeight <= 0 || sbHeight > this.height) return;
    if (this.db.prepare('SELECT 1 FROM superblocks WHERE height = ?').get(sbHeight)) return;
    // the trigger tells which coinbase outputs are superblock payments; without it nothing honest can be recorded.
    // Several competing triggers can exist for one height: the one whose payments the coinbase contains is the one that won.
    const candidates = (this.db.prepare('SELECT hash, data_hex FROM gov_objects WHERE type = 2').all() as Array<{ hash: string; data_hex: string }>)
      .map((t) => ({ hash: t.hash, view: triggerView(t.data_hex) }))
      .filter((t) => t.view?.eventBlockHeight === sbHeight);
    if (candidates.length === 0) {
      if (this.missingTriggerWarned !== sbHeight) log.warn('superblock not recorded: its trigger is not in the archive (import a governance.dat that has it)', { height: sbHeight });
      this.missingTriggerWarned = sbHeight;
      return;
    }
    const hash = await this.rpc.getBlockHash(sbHeight);
    const block = await this.rpc.getBlock(hash, 2);
    const vout: any[] = block.tx?.[0]?.vout ?? [];
    let best: { hash: string; paid: number; payments: Array<{ address: string; amountDuffs: number; proposalHash: string | null; paid: boolean }> } | null = null;
    for (const c of candidates) {
      const outs = vout.map((o) => ({ address: (o.scriptPubKey?.address ?? o.scriptPubKey?.addresses?.[0] ?? null) as string | null, duffs: (o.valueSat ?? dashToDuffs(o.value)) as number, used: false }));
      let paid = 0;
      const payments = c.view!.payments.map((p) => {
        const o = outs.find((x) => !x.used && x.address === p.address && x.duffs === p.amountDuffs);
        if (o) {
          o.used = true;
          paid += p.amountDuffs;
        }
        return { ...p, paid: !!o };
      });
      if (!best || paid > best.paid) best = { hash: c.hash, paid, payments };
    }
    // Core only accepts a superblock that contains EVERY payment of its trigger: anything less means the winning trigger is
    // not archived. Record nothing (retried later) rather than a wrong `paid`.
    if (!best || best.payments.some((p) => !p.paid)) {
      if (this.missingTriggerWarned !== sbHeight) log.warn('superblock not recorded: no archived trigger matches its coinbase', { height: sbHeight, candidates: candidates.length });
      this.missingTriggerWarned = sbHeight;
      return;
    }
    const budget = dashToDuffs(await this.rpc.getSuperblockBudget(sbHeight));
    this.db.prepare('INSERT OR IGNORE INTO superblocks(height, block_hash, block_time, budget_duffs, paid_duffs, trigger_hash, payments, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sbHeight, hash, block.time, budget, best!.paid, best!.hash, JSON.stringify(best!.payments), nowS());
  }

  // ------------------------------------------------------------------ governance.dat backfill

  /** Imports objects and SIGNED votes from a copy of governance.dat. Returns counts. Never modifies the file. */
  async importGovernanceDat(file: Uint8Array, expectNetwork: string): Promise<{ objects: number; votes: number; newVotes: number; orphanVotes: number }> {
    const g = parseGovernanceDat(file);
    if (g.network !== expectNetwork) throw new Error(`governance.dat is for ${g.network}, bridge Core network is ${expectNetwork}`);
    let votes = 0;
    let newVotes = 0;
    this.db.transaction(() => {
      for (const o of g.objects) {
        this.archiveObject(o.object, 'govdat', this.height);
        for (const v of o.votes) {
          votes++;
          if (this.archiveVote(v, 'govdat', this.height)) newVotes++;
        }
      }
      for (const v of g.orphanVotes) if (this.archiveVote(v, 'govdat', this.height)) newVotes++;
    })();
    await this.verifyAllPending();
    return { objects: g.objects.length, votes, newVotes, orphanVotes: g.orphanVotes.length };
  }
}

/** An object as `gobject list` reports it. */
export interface RpcObject {
  hash: string;
  type: number;
  parentHash: string;
  revision: number;
  time: number;
  collateralHash: string;
  dataHex: string;
  masternodeOutpoint?: Outpoint;
  raw?: Uint8Array;
  sig?: Uint8Array;
}

export function rpcObject(hash: string, e: GobjectListEntry): RpcObject {
  const o: RpcObject = { hash, type: e.ObjectType, parentHash: '0'.repeat(64), revision: 1, time: e.CreationTime, collateralHash: e.CollateralHash, dataHex: e.DataHex.toLowerCase() };
  if (e.SigningMasternode) {
    const m = /^([0-9a-f]{64})-(\d+)$/.exec(e.SigningMasternode);
    if (m) o.masternodeOutpoint = { txid: m[1]!, n: Number(m[2]) };
  }
  if (e.ObjectType === GOV_TYPE_PROPOSAL) {
    const fields = { parentHash: o.parentHash, revision: 1, time: o.time, collateralHash: o.collateralHash, dataHex: o.dataHex, type: o.type, masternodeOutpoint: NULL_OUTPOINT, sig: new Uint8Array() };
    if (govObjectHash(fields) === hash) {
      o.raw = serializeGovObject(fields);
      o.sig = fields.sig;
      o.masternodeOutpoint = NULL_OUTPOINT;
    }
  }
  return o;
}

/** DASH amounts from RPC (JSON numbers with <= 8 decimals) to integer duffs. */
export function dashToDuffs(x: number): number {
  return Math.round(x * 1e8);
}

export const isFundingVote = (v: { signal: number }) => v.signal === VOTE_SIGNAL.FUNDING;
