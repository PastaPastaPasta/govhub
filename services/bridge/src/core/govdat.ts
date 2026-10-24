// Read-only parser for Dash Core's governance.dat (the governance cache dashd writes on shutdown).
//
// It holds every governance object Core kept, each with its vote file: the SIGNED votes (vchSig included) that Core
// counts. That makes a copy of governance.dat a second backfill source for signed votes next to the ZMQ re-sync
// (RPC never returns signatures: rpc/governance.cpp:816-819 rebuilds votes from vote_rec_t without them).
//
// Layout (Dash Core, src/):
//  CFlatDB file           flat-database.h:40-60 (write) / :100-150 (read): data || SHA256d(data)
//    data               = string("magicGovernanceCache") | 4-byte network magic | GovernanceStore
//  GovernanceStore        governance/governance.h:201-237 ("CGovernanceManager-Version-16")
//    string version | mapErasedGovernanceObjects map<uint256,int64> | CacheMap<uint256,CGovernanceVote> (always written
//    empty) | CacheMultiMap<uint256,OrphanVote> | mapObjects map<uint256, shared_ptr<CGovernanceObject>> | (more, not read)
//  CacheMap/CacheMultiMap cachemap.h:153-157, cachemultimap.h:195-199: uint32 nMaxSize | list<CacheItem{key, value}>
//  OrphanVote             governance/governance.h:44-54: vote | int64 expiration
//  CGovernanceObject      governance/object.h:294-317 (SER_DISK): Governance::Object | int64 nDeletionTime | bool fExpired |
//                         map<COutPoint, vote_rec_t> mapCurrentMNVotes | CGovernanceObjectVoteFile fileVotes
//  vote_rec_t             governance/object.h:112-130: map<int, vote_instance_t{int outcome, int64 last_update, int64 nCreationTime}>
//  vote file              governance/votedb.h:84-88: int nMemoryVotes | list<CGovernanceVote>
import { Reader, bytesEqual, bytesToHex, sha256d, uint256ToDisplay } from '@govhub/verify';
import { govObjectHash, readGovObject, readVote, serializeGovObject, serializeVote, type Outpoint, type ParsedGovObject, type ParsedVote } from './govparse.ts';

export const GOVDAT_MAGIC = 'magicGovernanceCache';
export const GOVDAT_VERSION = 'CGovernanceManager-Version-16';
export const NETWORK_MAGIC: Record<string, string> = { mainnet: 'bf0c6bbd', testnet: 'cee2caff', regtest: 'fcc1b7dc', devnet: 'e2caffce' };

export interface GovDatCurrentVote {
  outpoint: Outpoint;
  signal: number;
  outcome: number;
  time: number;
}

export interface GovDatObject {
  object: ParsedGovObject;
  deletionTime: number;
  expired: boolean;
  /** Core's mapCurrentMNVotes: what it counts (no signatures). */
  current: GovDatCurrentVote[];
  /** fileVotes: the signed votes Core holds for this object. */
  votes: ParsedVote[];
}

export interface GovDat {
  network: string;
  version: string;
  erased: Array<{ hash: string; time: number }>;
  orphanVotes: ParsedVote[];
  objects: GovDatObject[];
}

function readString(r: Reader): string {
  return new TextDecoder().decode(r.bytes(r.compactSize()));
}

function readVoteWithRaw(r: Reader): ParsedVote {
  const v = readVote(r, false);
  return { ...v, raw: serializeVote(v) };
}

export function parseGovernanceDat(file: Uint8Array): GovDat {
  if (file.length < 32) throw new Error('governance.dat too short');
  const data = file.subarray(0, file.length - 32);
  if (!bytesEqual(sha256d(data), file.subarray(file.length - 32))) throw new Error('governance.dat checksum mismatch');
  const r = new Reader(data);
  const magic = readString(r);
  if (magic !== GOVDAT_MAGIC) throw new Error(`unexpected magic message ${JSON.stringify(magic)}`);
  const netMagic = bytesToHex(r.bytes(4));
  const network = Object.entries(NETWORK_MAGIC).find(([, m]) => m === netMagic)?.[0] ?? `unknown(${netMagic})`;
  const version = readString(r);
  if (version !== GOVDAT_VERSION) throw new Error(`unsupported governance.dat version ${JSON.stringify(version)} (expected ${GOVDAT_VERSION})`);

  const erased: GovDat['erased'] = [];
  for (let i = 0, n = r.compactSize(); i < n; i++) {
    const hash = uint256ToDisplay(r.bytes(32));
    erased.push({ hash, time: Number(r.i64()) });
  }
  // historical invalid-vote cache (written empty, governance.h:205-206)
  r.u32();
  for (let i = 0, n = r.compactSize(); i < n; i++) {
    r.bytes(32);
    readVote(r, false);
  }
  // orphan votes
  const orphanVotes: ParsedVote[] = [];
  r.u32();
  for (let i = 0, n = r.compactSize(); i < n; i++) {
    r.bytes(32);
    orphanVotes.push(readVoteWithRaw(r));
    r.i64(); // expiration
  }
  const objects: GovDatObject[] = [];
  for (let i = 0, n = r.compactSize(); i < n; i++) {
    const key = uint256ToDisplay(r.bytes(32));
    const o = readGovObject(r);
    const hash = govObjectHash(o);
    if (hash !== key) throw new Error(`object hash ${hash} does not match its map key ${key}`);
    const object: ParsedGovObject = { ...o, hash, raw: serializeGovObject(o) };
    const deletionTime = Number(r.i64());
    const expired = r.u8() !== 0;
    const current: GovDatCurrentVote[] = [];
    for (let j = 0, m = r.compactSize(); j < m; j++) {
      const txid = uint256ToDisplay(r.bytes(32));
      const n2 = r.u32();
      for (let k = 0, q = r.compactSize(); k < q; k++) {
        const signal = r.i32();
        const outcome = r.i32();
        r.i64(); // last_update (local receive time, not signed)
        const time = Number(r.i64());
        current.push({ outpoint: { txid, n: n2 }, signal, outcome, time });
      }
    }
    r.i32(); // nMemoryVotes
    const votes: ParsedVote[] = [];
    for (let j = 0, m = r.compactSize(); j < m; j++) votes.push(readVoteWithRaw(r));
    objects.push({ object, deletionTime, expired, current, votes });
  }
  return { network, version, erased, orphanVotes, objects };
}
