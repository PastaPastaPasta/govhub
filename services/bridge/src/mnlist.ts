// Masternode list snapshots: the fields that matter for vote verification and tallies, stored content-addressed.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, decodeAddress, utf8ToBytes, type Network } from '@govhub/verify';
import type { DB, MnEntryRow } from './archive/db.ts';
import type { CoreRpc, ProTxEntry } from './core/rpc.ts';

/** GetMnType(type).voting_weight (evo/dmn_types.h:32-46): Regular 1, Evo 4, anything else 0. */
export function mnWeight(type: string): number {
  return type === 'Regular' ? 1 : type === 'Evo' ? 4 : 0;
}

export interface MnEntry {
  proTxHash: string;
  collateralTxid: string;
  collateralN: number;
  type: string;
  weight: number;
  votingAddress: string;
  /** hash160 of the voting key (hex), decoded from votingAddress; null if the address does not decode for the network. */
  votingKeyId: string | null;
  /** Not PoSe-banned (`PoSeBanHeight == -1`), i.e. counted in `m_valid_weighted` / the funding threshold. */
  isValid: boolean;
  poseBanHeight: number;
  registeredHeight: number;
}

export interface MnList {
  listHash: string;
  entries: MnEntry[];
  count: number;
  validCount: number;
  /** Sum of weights of valid (not banned) MNs: Core's GetCounts().m_valid_weighted, the base of the funding threshold. */
  validWeighted: number;
  totalWeighted: number;
}

export function reduceProTxList(list: ProTxEntry[], network: Network): MnList {
  const entries: MnEntry[] = list.map((e) => {
    const dec = decodeAddress(e.state.votingAddress, network);
    return {
      proTxHash: e.proTxHash,
      collateralTxid: e.collateralHash,
      collateralN: e.collateralIndex,
      type: e.type,
      weight: mnWeight(e.type),
      votingAddress: e.state.votingAddress,
      votingKeyId: dec && dec.type === 'p2pkh' ? bytesToHex(dec.hash160) : null,
      isValid: e.state.PoSeBanHeight === -1,
      poseBanHeight: e.state.PoSeBanHeight,
      registeredHeight: e.state.registeredHeight,
    };
  });
  return finishList(entries);
}

export function finishList(entries: MnEntry[]): MnList {
  entries.sort((a, b) => (a.proTxHash < b.proTxHash ? -1 : a.proTxHash > b.proTxHash ? 1 : 0));
  const canonical = entries.map((e) => [e.proTxHash, e.collateralTxid, e.collateralN, e.type, e.votingAddress, e.isValid ? 1 : 0, e.poseBanHeight, e.registeredHeight].join(',')).join('\n');
  const listHash = bytesToHex(sha256(utf8ToBytes(canonical)));
  let validCount = 0;
  let validWeighted = 0;
  let totalWeighted = 0;
  for (const e of entries) {
    totalWeighted += e.weight;
    if (e.isValid) {
      validCount++;
      validWeighted += e.weight;
    }
  }
  return { listHash, entries, count: entries.length, validCount, validWeighted, totalWeighted };
}

export function storeMnList(db: DB, list: MnList, height: number, blockHash: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    const known = db.prepare('SELECT 1 FROM mn_lists WHERE list_hash = ?').get(list.listHash);
    if (!known) {
      db.prepare('INSERT INTO mn_lists(list_hash, count, valid_count, valid_weighted, total_weighted, first_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        list.listHash,
        list.count,
        list.validCount,
        list.validWeighted,
        list.totalWeighted,
        height,
        now,
      );
      const ins = db.prepare(
        'INSERT INTO mn_list_entries(list_hash, pro_tx_hash, collateral_txid, collateral_n, type, weight, voting_address, voting_keyid, is_valid, pose_ban_height, registered_height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const e of list.entries) {
        ins.run(list.listHash, e.proTxHash, e.collateralTxid, e.collateralN, e.type, e.weight, e.votingAddress, e.votingKeyId, e.isValid ? 1 : 0, e.poseBanHeight, e.registeredHeight);
      }
    }
    db.prepare('INSERT INTO mn_snapshots(height, block_hash, list_hash, taken_at) VALUES (?, ?, ?, ?) ON CONFLICT(height) DO UPDATE SET block_hash = excluded.block_hash, list_hash = excluded.list_hash, taken_at = excluded.taken_at').run(
      height,
      blockHash,
      list.listHash,
      now,
    );
  })();
}

export async function snapshotMnList(db: DB, rpc: CoreRpc, network: Network, height: number): Promise<MnList> {
  const [raw, blockHash] = await Promise.all([rpc.protxListRegistered(height), rpc.getBlockHash(height)]);
  const list = reduceProTxList(raw, network);
  storeMnList(db, list, height, blockHash);
  return list;
}

export interface SnapshotRef {
  height: number;
  blockHash: string;
  listHash: string;
}

/** The snapshot in force at `height` (latest at or below it), else the earliest one after it. */
export function snapshotAt(db: DB, height: number): SnapshotRef | null {
  const row =
    (db.prepare('SELECT height, block_hash, list_hash FROM mn_snapshots WHERE height <= ? ORDER BY height DESC LIMIT 1').get(height) as any) ??
    (db.prepare('SELECT height, block_hash, list_hash FROM mn_snapshots ORDER BY height ASC LIMIT 1').get() as any);
  return row ? { height: row.height, blockHash: row.block_hash, listHash: row.list_hash } : null;
}

export function latestSnapshot(db: DB): SnapshotRef | null {
  const row = db.prepare('SELECT height, block_hash, list_hash FROM mn_snapshots ORDER BY height DESC LIMIT 1').get() as any;
  return row ? { height: row.height, blockHash: row.block_hash, listHash: row.list_hash } : null;
}

const rowToEntry = (r: MnEntryRow): MnEntry => ({
  proTxHash: r.pro_tx_hash,
  collateralTxid: r.collateral_txid,
  collateralN: r.collateral_n,
  type: r.type,
  weight: r.weight,
  votingAddress: r.voting_address,
  votingKeyId: r.voting_keyid,
  isValid: r.is_valid === 1,
  poseBanHeight: r.pose_ban_height,
  registeredHeight: r.registered_height,
});

/** Small cache of loaded lists keyed by list hash (lists are immutable once stored). */
export class MnListCache {
  private readonly db: DB;
  private readonly cache = new Map<string, { list: MnList; byOutpoint: Map<string, MnEntry> }>();

  constructor(db: DB) {
    this.db = db;
  }

  load(listHash: string): { list: MnList; byOutpoint: Map<string, MnEntry> } | null {
    const hit = this.cache.get(listHash);
    if (hit) return hit;
    const head = this.db.prepare('SELECT * FROM mn_lists WHERE list_hash = ?').get(listHash) as any;
    if (!head) return null;
    const rows = this.db.prepare('SELECT * FROM mn_list_entries WHERE list_hash = ? ORDER BY pro_tx_hash').all(listHash) as MnEntryRow[];
    const entries = rows.map(rowToEntry);
    const list: MnList = { listHash, entries, count: head.count, validCount: head.valid_count, validWeighted: head.valid_weighted, totalWeighted: head.total_weighted };
    const byOutpoint = new Map(entries.map((e) => [`${e.collateralTxid}-${e.collateralN}`, e]));
    const v = { list, byOutpoint };
    if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(listHash, v);
    return v;
  }
}
