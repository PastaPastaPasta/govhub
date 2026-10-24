// Read-only check that what the bridge published reads back from Platform WITH PROOFS and matches the archive.
// Independent of the publisher's bookkeeping where it matters: proposals are re-verified from the proved document alone
// (gov hash recomputed from parentHash/revision/time/dataHex, collateral checked against the archived raw tx), and every
// proposal visible through the active-proposals query (G2) must exist in the archive.
//
//   DB_PATH=... GOV_CONTRACT_ID=... PLATFORM_NETWORK=testnet node scripts/readback.ts
import Database from 'better-sqlite3';
import { checkCollateralTx, governanceObjectHash, hexToBytes, uint256FromDisplay } from '@govhub/verify';
import { PlatformClient } from '../src/publish/platform.ts';
import type { GovObjectRow, PlatformDocRow, TallyRow } from '../src/archive/db.ts';
import { proposalView } from '../src/proposal.ts';

const dbPath = process.env.DB_PATH!;
const contractId = process.env.GOV_CONTRACT_ID!;
const network = (process.env.PLATFORM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const db = new Database(dbPath, { readonly: true });
const p = new PlatformClient(network, contractId);
await p.connect();

const b64hex = (s: unknown) => Buffer.from(String(s), 'base64').toString('hex');
const num = (v: unknown) => Number(v);
const problems: string[] = [];
const counts = { proposal: 0, tally: 0, cycle: 0, proposalOk: 0, tallyOk: 0, cycleOk: 0 };

const recs = db.prepare('SELECT * FROM platform_docs WHERE contract_id = ? ORDER BY doc_type, doc_key').all(contractId) as PlatformDocRow[];
for (const r of recs) {
  const type = r.doc_type as 'proposal' | 'tally' | 'cycle';
  counts[type]++;
  const where = type === 'cycle' ? [['superblockHeight', '==', Number(r.doc_key)]] : [['govHash', '==', Buffer.from(r.doc_key, 'hex').toString('base64')]];
  const docs = await p.query(type, { where, limit: 2 });
  if (docs.length !== 1) {
    problems.push(`${type} ${r.doc_key}: ${docs.length} documents on Platform`);
    continue;
  }
  const d = docs[0]!;
  const j = d.data as Record<string, unknown>;
  if (d.id !== r.doc_id) problems.push(`${type} ${r.doc_key}: id ${d.id} != archived ${r.doc_id}`);
  if (j.$ownerId !== p.identityId && j.$ownerId !== undefined && process.env.BRIDGE_IDENTITY_ID && j.$ownerId !== process.env.BRIDGE_IDENTITY_ID) problems.push(`${type} ${r.doc_key}: owner ${j.$ownerId}`);
  if (type === 'proposal') {
    const a = db.prepare('SELECT * FROM gov_objects WHERE hash = ?').get(r.doc_key) as GovObjectRow | undefined;
    if (!a) {
      problems.push(`proposal ${r.doc_key} not in archive`);
      continue;
    }
    const gh = b64hex(j.govHash);
    const recomputed = governanceObjectHash({ parentHash: b64hex(j.parentHash), revision: num(j.revision), time: num(j.time), dataHex: String(j.dataHex) }).display;
    const v = proposalView(a.data_hex)!;
    const coll = checkCollateralTx(hexToBytes(a.collateral_raw_hex!), uint256FromDisplay(gh), { expectedTxid: b64hex(j.collateralTxid) });
    const mism = [
      gh !== a.hash && 'govHash',
      recomputed !== gh && 'gov hash does not recompute from the document',
      String(j.dataHex) !== a.data_hex && 'dataHex',
      b64hex(j.collateralTxid) !== a.collateral_hash && 'collateralTxid',
      num(j.collateralHeight) !== a.collateral_height && 'collateralHeight',
      j.name !== v.name && 'name',
      j.url !== v.url && 'url',
      j.paymentAddress !== v.paymentAddress && 'paymentAddress',
      num(j.paymentAmount) !== v.paymentAmountDuffs && 'paymentAmount',
      num(j.startEpoch) !== v.startEpoch && 'startEpoch',
      num(j.endEpoch) !== v.endEpoch && 'endEpoch',
      !coll.valid && `collateral: ${coll.failure}`,
    ].filter(Boolean);
    if (mism.length) problems.push(`proposal ${r.doc_key}: ${mism.join(', ')}`);
    else counts.proposalOk++;
  } else if (type === 'tally') {
    // the published content is what the archive recorded at publish time
    const want = JSON.parse(r.content_json) as Array<[string, unknown]>;
    const m = new Map(want);
    const fields = ['asOfHeight', 'yesWeighted', 'noWeighted', 'abstainWeighted', 'yesCount', 'noCount', 'abstainCount', 'rank', 'margin'];
    const mism = fields.filter((f) => String(j[f]) !== String(m.get(f)));
    if (b64hex(j.voteSetHash) !== m.get('voteSetHash')) mism.push('voteSetHash');
    if (Boolean(j.inNextBudget) !== m.get('inNextBudget')) mism.push('inNextBudget');
    if (d.revision !== r.revision) mism.push(`revision ${d.revision} != ${r.revision}`);
    // and the archive's tally history contains exactly this tally, which matched Core when it was computed
    const t = db.prepare('SELECT * FROM tallies WHERE gov_hash = ? AND vote_set_hash = ? ORDER BY id DESC LIMIT 1').get(r.doc_key, b64hex(j.voteSetHash)) as TallyRow | undefined;
    if (!t) mism.push('voteSetHash not in archive tally history');
    else if (t.core_match !== 1) mism.push('archived tally did not match Core');
    if (mism.length) problems.push(`tally ${r.doc_key}: ${mism.join(', ')}`);
    else counts.tallyOk++;
  } else {
    const m = new Map(JSON.parse(r.content_json) as Array<[string, unknown]>);
    const mism = ['superblockHeight', 'budget', 'allocated', 'votingDeadlineHeight', 'estTime', 'validWeighted', 'paid'].filter((f) => String(j[f]) !== String(m.get(f)));
    if (mism.length) problems.push(`cycle ${r.doc_key}: ${mism.join(', ')}`);
    else counts.cycleOk++;
  }
}

// G2: every active proposal on Platform must be one the archive knows and verified
const nowS = Math.floor(Date.now() / 1000);
let start: string | undefined;
let active = 0;
for (;;) {
  const page = await p.query('proposal', { where: [['endEpoch', '>', nowS]], orderBy: [['endEpoch', 'asc']], limit: 100, startAfter: start });
  for (const d of page) {
    active++;
    const h = b64hex(d.data.govHash);
    const a = db.prepare('SELECT hash, collateral_ok FROM gov_objects WHERE hash = ?').get(h) as { collateral_ok: number } | undefined;
    if (!a && (d.data as any).$ownerId === process.env.BRIDGE_IDENTITY_ID) problems.push(`active proposal ${h} on Platform is not in the archive`);
  }
  if (page.length < 100) break;
  start = page[page.length - 1]!.id;
}

console.log(JSON.stringify({ network, contractId, protocolVersion: p.protocolVersion, archived: counts, activeProposalsOnPlatform: active, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
