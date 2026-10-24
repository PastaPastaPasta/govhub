// Records test fixtures from the live dev setup: raw ZMQ payloads already in the archive (votes and objects exactly as
// dashd published them), the MN-list entries needed to verify those votes, the Core-matched tallies, and real Core RPC
// responses. No secrets: everything here is public chain / governance data.
//
//   scripts/dev-ct164.sh exec node scripts/record-fixtures.ts [/path/to/governance.dat]
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactSize, concatBytes, hexToBytes, i32le, i64le, sha256d, u32le, uint256FromDisplay } from '@govhub/verify';
import { loadConfig } from '../src/config.ts';
import { parseGovernanceDat, GOVDAT_MAGIC, GOVDAT_VERSION, NETWORK_MAGIC } from '../src/core/govdat.ts';
import { serializeVote } from '../src/core/govparse.ts';
import { CoreRpc } from '../src/core/rpc.ts';
import type { GovObjectRow, MnEntryRow, TallyRow, VoteRow } from '../src/archive/db.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../test/fixtures');
mkdirSync(join(out, 'rpc'), { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 1) + '\n');

const cfg = loadConfig();
const db = new Database(cfg.dbPath, { readonly: true });
const rpc = new CoreRpc({ url: cfg.core.rpcUrl, user: cfg.core.rpcUser, password: cfg.core.rpcPassword });
const recordedAt = new Date().toISOString();

// ---- objects: every proposal as published on ZMQ, with its collateral tx ----
const props = db.prepare("SELECT * FROM gov_objects WHERE type = 1 AND raw_hex IS NOT NULL ORDER BY hash").all() as GovObjectRow[];
save('mainnet-objects.json', {
  recordedAt,
  source: 'ZMQ rawgovernanceobject from mainnet dashd v23.1.8 (CT 164) during the 2026-10-24 governance re-sync',
  objects: props.map((p) => ({ hash: p.hash, type: p.type, rawHex: p.raw_hex, collateralTxid: p.collateral_hash, collateralHeight: p.collateral_height, collateralRawTxHex: p.collateral_raw_hex })),
});

// ---- votes: three proposals whose tally matched Core (FundingResult AND getcurrentvotes), with the votes archived by then ----
// First Core-matched row per proposal; the vote set is what the archive held when that row was computed.
const matched = db
  .prepare(
    `SELECT t.* FROM tallies t JOIN (SELECT gov_hash, MIN(id) id FROM tallies WHERE core_match = 1 GROUP BY gov_hash) m ON m.id = t.id
     ORDER BY t.vote_count`,
  )
  .all() as TallyRow[];
if (matched.length < 3) throw new Error(`need 3 Core-matched tallies, have ${matched.length}`);
const pick = [matched[0]!, matched[Math.floor(matched.length / 2)]!, matched[matched.length - 1]!].filter((t, i, a) => a.findIndex((x) => x.gov_hash === t.gov_hash) === i);
const outpoints = new Set<string>();
const proposals = pick.map((t) => {
  const votes = db.prepare("SELECT * FROM votes WHERE parent_hash = ? AND signal = 1 AND sig_status = 'valid' AND first_seen_time <= ?").all(t.gov_hash, t.computed_at) as VoteRow[];
  for (const v of votes) outpoints.add(`${v.collateral_txid}-${v.collateral_n}`);
  // independent recount of the current vote per masternode (latest time; equal time: higher outcome), for the pinned voteSetHash
  const cur = new Map<string, VoteRow>();
  for (const v of votes) {
    const k = `${v.collateral_txid}-${v.collateral_n}`;
    const c = cur.get(k);
    if (!c || v.time > c.time || (v.time === c.time && v.outcome >= c.outcome)) cur.set(k, v);
  }
  const text = 'govhub-voteset-v1\n' + [...cur.keys()].sort().map((k) => `${k}|${cur.get(k)!.outcome}|${cur.get(k)!.time}\n`).join('');
  return {
    govHash: t.gov_hash,
    tally: {
      asOfHeight: t.as_of_height,
      listHash: t.list_hash,
      yesWeighted: t.yes_weighted,
      noWeighted: t.no_weighted,
      abstainWeighted: t.abstain_weighted,
      yesCount: t.yes_count,
      noCount: t.no_count,
      abstainCount: t.abstain_count,
      core: { yes: t.core_yes, no: t.core_no, abstain: t.core_abstain, absoluteYes: t.core_absolute },
      currentVotes: cur.size,
      voteSetHash: createHash('sha256').update(text).digest('hex'),
    },
    votes: votes.map((v) => ({ hash: v.hash, rawHex: v.raw_hex, firstSeenHeight: v.first_seen_height })),
  };
});
const lists = [...new Set(pick.map((t) => t.list_hash))];
if (lists.length !== 1) throw new Error('picked tallies use different MN lists; re-run after one refresh');
const head = db.prepare('SELECT * FROM mn_lists WHERE list_hash = ?').get(lists[0]) as any;
const snap = db.prepare('SELECT * FROM mn_snapshots WHERE list_hash = ? ORDER BY height DESC LIMIT 1').get(lists[0]) as any;
const entries = (db.prepare('SELECT * FROM mn_list_entries WHERE list_hash = ?').all(lists[0]) as MnEntryRow[]).filter((e) => outpoints.has(`${e.collateral_txid}-${e.collateral_n}`));
const bls = db.prepare("SELECT hash, raw_hex FROM votes WHERE sig_status = 'bls-unverified' AND source = 'zmq' LIMIT 1").get() as { hash: string; raw_hex: string } | undefined;
save('mainnet-votes.json', {
  recordedAt,
  network: 'mainnet',
  source: 'ZMQ rawgovernancevote from mainnet dashd v23.1.8 (CT 164); tallies equal Core FundingResult and getcurrentvotes at asOfHeight',
  mnList: {
    height: snap.height,
    listHash: lists[0],
    note: 'subset: only the masternodes that voted on these proposals (all entries of the full list for those outpoints)',
    fullCount: head.count,
    validWeighted: head.valid_weighted,
    entries: entries.map((e) => ({ proTxHash: e.pro_tx_hash, collateralTxid: e.collateral_txid, collateralIndex: e.collateral_n, type: e.type, votingAddress: e.voting_address, isValid: e.is_valid === 1, poseBanHeight: e.pose_ban_height, registeredHeight: e.registered_height })),
  },
  proposals,
  blsVote: bls ? { hash: bls.hash, rawHex: bls.raw_hex } : null,
});

// ---- RPC responses (shape fixtures); skipped with --no-rpc ----
if (!process.argv.includes('--no-rpc')) {
const height = await rpc.getBlockCount();
const info = await rpc.getGovernanceInfo();
const one = pick[pick.length - 1]!.gov_hash;
const list = await rpc.gobjectList('all', 'all');
const firstTwo = Object.fromEntries(Object.entries(list).slice(0, 2));
const proposalRow = props.find((p) => p.hash === one)!;
const sbHash = await rpc.getBlockHash(info.lastsuperblock);
const sbBlock = await rpc.getBlock(sbHash, 2);
const protx = await rpc.protxListRegistered(height);
const rpcFixtures: Record<string, unknown> = {
  'getgovernanceinfo.json': info,
  'getsuperblockbudget.json': { height: info.nextsuperblock, result: await rpc.getSuperblockBudget(info.nextsuperblock) },
  'gobject-list.json': firstTwo,
  'gobject-get.json': await rpc.gobjectGet(one),
  'gobject-getcurrentvotes.json': Object.fromEntries(Object.entries(await rpc.gobjectCurrentVotes(one)).slice(0, 5)),
  'getrawtransaction-verbose.json': await rpc.getRawTransactionVerbose(proposalRow.collateral_hash),
  'protx-list-registered.json': { height, count: protx.length, sample: [protx.find((e) => e.type === 'Regular'), protx.find((e) => e.type === 'Evo'), protx.find((e) => e.state.PoSeBanHeight !== -1)].filter(Boolean) },
  'getblock-superblock.json': { height: info.lastsuperblock, hash: sbHash, time: sbBlock.time, coinbase: sbBlock.tx[0] },
  'mnsync-status.json': await rpc.mnsyncStatus(),
  'getindexinfo.json': await rpc.getIndexInfo(),
};
for (const [name, data] of Object.entries(rpcFixtures)) save(join('rpc', name), { recordedAt, height, result: data });
}

// ---- a trimmed copy of a real mainnet governance.dat: its trigger and 5 of its (BLS) votes, re-serialized and re-checksummed ----
const govdatPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (govdatPath) {
  const g = parseGovernanceDat(readFileSync(govdatPath));
  const o = g.objects[0]!;
  const votes = o.votes.slice(0, 5);
  const str = (s: string) => concatBytes(compactSize(Buffer.byteLength(s)), Buffer.from(s));
  const cur = o.current.filter((c) => votes.some((v) => v.outpoint.txid === c.outpoint.txid && v.outpoint.n === c.outpoint.n));
  const parts: Uint8Array[] = [
    str(GOVDAT_MAGIC),
    hexToBytes(NETWORK_MAGIC.mainnet!),
    str(GOVDAT_VERSION),
    compactSize(g.erased.length),
    ...g.erased.flatMap((e) => [uint256FromDisplay(e.hash), i64le(e.time)]),
    u32le(0), compactSize(0), // invalid-vote cache
    u32le(0), compactSize(0), // orphan votes
    compactSize(1),
    uint256FromDisplay(o.object.hash),
    o.object.raw,
    i64le(o.deletionTime),
    Uint8Array.of(o.expired ? 1 : 0),
    compactSize(cur.length),
    ...cur.flatMap((c) => [uint256FromDisplay(c.outpoint.txid), u32le(c.outpoint.n), compactSize(1), i32le(c.signal), i32le(c.outcome), i64le(0), i64le(c.time)]),
    i32le(votes.length),
    compactSize(votes.length),
    ...votes.map((v) => serializeVote(v)),
  ];
  const data = concatBytes(...parts);
  writeFileSync(join(out, 'governance-trimmed.dat'), concatBytes(data, sha256d(data)));
  console.log(`governance-trimmed.dat: trigger ${o.object.hash}, ${votes.length} votes`);
}
console.log(JSON.stringify({ objects: props.length, proposals: proposals.map((p) => ({ govHash: p.govHash, votes: p.votes.length, current: p.tally.currentVotes })), mnEntries: entries.length }));
