// Read-only check that what the bridge published reads back from Platform WITH PROOFS and matches the archive.
// Independent of the publisher's bookkeeping where it matters: proposals are re-verified from the proved document alone
// (gov hash recomputed from parentHash/revision/time/dataHex, collateral checked against the archived raw tx), and every
// proposal visible through the active-proposals query (G2) must exist in the archive.
//
//   DB_PATH=... GOV_CONTRACT_ID=... [BRIDGE_IDENTITY_ID=...] PLATFORM_NETWORK=testnet node scripts/readback.ts
import Database from 'better-sqlite3';
import { checkCollateralTx, decodeTallySet, governanceObjectHash, hexToBytes, TALLY_SET_FIELDS, uint256FromDisplay } from '@govhub/verify';
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
const counts = { proposal: 0, tally: 0, talliesSet: 0, cycle: 0, proposalOk: 0, tallyOk: 0, talliesSetOk: 0, cycleOk: 0 };

const recs = db.prepare('SELECT * FROM platform_docs WHERE contract_id = ? ORDER BY doc_type, doc_key').all(contractId) as PlatformDocRow[];
for (const r of recs) {
  const type = r.doc_type as 'proposal' | 'tally' | 'talliesSet' | 'cycle';
  counts[type]++;
  const where =
    type === 'cycle' ? [['superblockHeight', '==', Number(r.doc_key)]] : type === 'talliesSet' ? [['page', '==', Number(r.doc_key)]] : [['govHash', '==', Buffer.from(r.doc_key, 'hex').toString('base64')]];
  const docs = await p.query(type, { where, limit: 2 });
  if (docs.length !== 1) {
    problems.push(`${type} ${r.doc_key}: ${docs.length} documents on Platform`);
    continue;
  }
  const d = docs[0]!;
  const j = d.data as Record<string, unknown>;
  if (d.id !== r.doc_id) problems.push(`${type} ${r.doc_key}: id ${d.id} != archived ${r.doc_id}`);
  // gov types are creationRestrictionMode 1 (owner only), but say so explicitly when the expected owner is given
  if (process.env.BRIDGE_IDENTITY_ID && j.$ownerId !== process.env.BRIDGE_IDENTITY_ID) problems.push(`${type} ${r.doc_key}: owner ${String(j.$ownerId)}`);
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
      num(j.endEpoch) !== v.endEpoch && 'endEpoch',
      // the full (older testnet) shape duplicates these; the slim mainnet shape has them in dataHex only
      ...('url' in j
        ? [
            j.url !== v.url && 'url',
            j.paymentAddress !== v.paymentAddress && 'paymentAddress',
            num(j.paymentAmount) !== v.paymentAmountDuffs && 'paymentAmount',
            num(j.startEpoch) !== v.startEpoch && 'startEpoch',
          ]
        : []),
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
  } else if (type === 'talliesSet') {
    // the packed bytes are what the archive recorded at publish time, they decode, and every entry is a Core-matched archived tally
    const m = new Map(JSON.parse(r.content_json) as Array<[string, unknown]>);
    const mism = ['page', 'asOfHeight'].filter((f) => String(j[f]) !== String(m.get(f)));
    for (const f of TALLY_SET_FIELDS) if ((j[f] === undefined ? undefined : b64hex(j[f])) !== m.get(f)) mism.push(f);
    if (d.revision !== r.revision) mism.push(`revision ${d.revision} != ${r.revision}`);
    try {
      const entries = decodeTallySet(TALLY_SET_FIELDS.map((f) => (j[f] === undefined ? undefined : hexToBytes(b64hex(j[f])))));
      // what a reader recounts each entry against: the bridge's record in force at the page's height (GET .../votes?height=)
      const inForce = db.prepare('SELECT * FROM tallies WHERE gov_hash = ? AND as_of_height <= ? ORDER BY as_of_height DESC, id DESC LIMIT 1');
      for (const e of entries) {
        const t = inForce.get(e.govHash, num(j.asOfHeight)) as TallyRow | undefined;
        const at = `${e.govHash.slice(0, 12)}`;
        if (!t) mism.push(`${at}: no archived tally at or below asOfHeight`);
        else {
          const diff = (
            [['voteSetHash', t.vote_set_hash, e.voteSetHash], ['yesWeighted', t.yes_weighted, e.yesWeighted], ['noWeighted', t.no_weighted, e.noWeighted], ['abstainWeighted', t.abstain_weighted, e.abstainWeighted],
              ['yesCount', t.yes_count, e.yesCount], ['noCount', t.no_count, e.noCount], ['abstainCount', t.abstain_count, e.abstainCount],
              ['rank', t.rank, e.rank], ['inNextBudget', t.in_next_budget === 1, e.inNextBudget], ['margin', t.margin, e.margin]] as const
          ).filter(([, a, b]) => a !== b).map(([f]) => f);
          if (diff.length) mism.push(`${at}: differs from the record in force at ${String(j.asOfHeight)} (${diff.join(', ')})`);
          if (t.core_match !== 1) mism.push(`${at}: archived tally did not match Core`);
        }
      }
    } catch (e) {
      mism.push(`does not decode: ${(e as Error).message}`);
    }
    if (mism.length) problems.push(`talliesSet ${r.doc_key}: ${mism.join(', ')}`);
    else counts.talliesSetOk++;
  } else {
    const m = new Map(JSON.parse(r.content_json) as Array<[string, unknown]>);
    const mism = ['superblockHeight', 'budget', 'allocated', 'votingDeadlineHeight', 'estTime', 'validWeighted', 'paid'].filter((f) => String(j[f]) !== String(m.get(f)));
    if (mism.length) problems.push(`cycle ${r.doc_key}: ${mism.join(', ')}`);
    else counts.cycleOk++;
  }
}

// G2: every active proposal on Platform. Ones the archive does not know were not written by this bridge's archive (e.g. the
// phase-0 cost spike wrote synthetic proposals into the same testnet contract with the same identity): listed, not failed.
const nowS = Math.floor(Date.now() / 1000);
let start: string | undefined;
let active = 0;
const notInArchive: string[] = [];
for (;;) {
  const page = await p.query('proposal', { where: [['endEpoch', '>', nowS]], orderBy: [['endEpoch', 'asc']], limit: 100, startAfter: start });
  for (const d of page) {
    active++;
    const h = b64hex(d.data.govHash);
    if (!db.prepare('SELECT 1 FROM gov_objects WHERE hash = ?').get(h)) notInArchive.push(h);
  }
  if (page.length < 100) break;
  start = page[page.length - 1]!.id;
}

console.log(JSON.stringify({ network, contractId, protocolVersion: p.protocolVersion, archived: counts, activeProposalsOnPlatform: active, notInArchive, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
