// Offline fee estimates (SDK `documentCreateCost`) for the same documents the testnet cost round
// created, so the README can set estimate next to measurement.
//
//   npx vite-node scripts/estimate-costs.ts
//
// FINDING: documentCreateCost throws at platform version 13 ("drive unknown version on
// document_create_cost ... received: 0") in 5.0.0-rc.8 -- the estimator only exists for PV14.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractsDir, errText, saveResult } from './lib.ts';

const w: any = await import('evo5');
await w.ensureInitialized();
const schemas: Record<string, any> = {};
for (const n of ['gov', 'forum', 'badge', 'mod']) schemas[n] = JSON.parse(readFileSync(join(contractsDir, `${n}.json`), 'utf8'));
const contracts: Record<string, any> = {};
for (const n of Object.keys(schemas)) contracts[n] = new w.DataContract({ ownerId: 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec', identityNonce: 1n, schemas: schemas[n], fullValidation: true, platformVersion: 14 });

type Case = [contract: string, type: string, tag: string, fields: Record<string, number | false>];
const cases: Case[] = [
  ['gov', 'proposal', 'create (dataHex 520, url ~75)', { dataHex: 520, name: 17, url: 75, paymentAddress: 34 }],
  ['gov', 'tally', 'create', {}],
  ['gov', 'cycle', 'create', {}],
  ['gov', 'claimAttestation', 'create (note 40)', { note: 40 }],
  ['forum', 'profile', 'create', { displayName: 10, about: 30, avatarUrl: 31 }],
  ['forum', 'comment', 'create 50 chars', { body: 50, parentId: 32 }],
  ['forum', 'comment', 'create 280 chars', { body: 280, parentId: false }],
  ['forum', 'comment', 'create 1000 chars', { body: 1000, parentId: false }],
  ['forum', 'comment', 'create 5000 chars', { body: 5000, parentId: false }],
  ['forum', 'reaction', 'create', {}],
  ['forum', 'claim', 'create', {}],
  ['forum', 'proposalPost', 'create b0 1500 B', { title: 35, b0: 1500, b1: false, b2: false, links: 60 }],
  ['forum', 'proposalPost', 'create MAX (3 x 5120 B)', { title: 200, b0: 5120, b1: 5120, b2: 5120, links: 1000 }],
  ['forum', 'proposalDraft', 'create', { dataHex: 520, collateralTxid: false }],
  ['forum', 'block', 'create', { reason: 4 }],
  ['forum', 'blockSubs', 'create 3 lists', { lists: 96 }],
  ['forum', 'settings', 'create 600 B', { endpoints: 600 }],
  ['forum', 'vault', 'create', { sealed: 96 }],
  ['badge', 'issuerKey', 'create RSA-2048 (294 B)', { spki: 294, variant: 29 }],
  ['badge', 'issuerKey', 'create RSA-4096 (550 B)', { spki: 550, variant: 29 }],
  ['badge', 'issuerRevocation', 'create', {}],
  ['badge', 'issuerReport', 'create', {}],
  ['badge', 'mnBadge', 'create sig 256 B', { sig: 256 }],
  ['badge', 'mnBadge', 'create sig 384 B', { sig: 384 }],
  ['mod', 'block', 'create', { reason: false }],
];
const rows: any[] = [];
for (const [cname, type, tag, f] of cases) {
  const fields: Record<string, { present?: boolean; length?: number }> = {};
  for (const [k, v] of Object.entries(f)) fields[k] = v === false ? { present: false } : { present: true, length: v };
  try {
    const c = w.documentCreateCost(contracts[cname], type, { fields }, 14);
    rows.push({ contract: cname, type, tag, documentBytes: c.documentBytes, newValues: String(c.totalCredits.newValues), knownValues: String(c.totalCredits.knownValues), refundSameEpochNew: String(c.refund.sameEpoch.newValues) });
    console.log(`${(cname + '.' + type).padEnd(26)} ${tag.padEnd(32)} ${String(c.documentBytes).padStart(6)} B  new ${(Number(c.totalCredits.newValues) / 1e11).toFixed(8)}  known ${(Number(c.totalCredits.knownValues) / 1e11).toFixed(8)} DASH`);
  } catch (e) { console.log(`ERR ${cname}.${type}: ${errText(e)}`); rows.push({ contract: cname, type, tag, error: errText(e) }); }
}
let pv13: string;
try { w.documentCreateCost(contracts.forum, 'comment', {}, 13); pv13 = 'works'; } catch (e) { pv13 = errText(e); }
console.log(`\nestimator at platform version 13: ${pv13}`);
saveResult('estimates-pv14.json', { at: new Date().toISOString(), pv13Estimator: pv13, rows });
process.exit(0);
