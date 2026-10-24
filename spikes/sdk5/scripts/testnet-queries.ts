// Runs every query shape documented in packages/contracts-v1/README.md against the contracts the
// cost spike registered on testnet, with proofs (documents.queryWithProof), and records the
// result count. A shape is only listed in the README if it passes here.
//
//   npm run testnet:queries
//
// Rule for every shape (PV13 gapped-index bug): equality on a prefix of the index, then at most
// ONE range or `in` on the NEXT index property, orderBy in index order, nothing after it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errText, plain, resultsDir, saveResult } from './lib.ts';
import { readState } from './chain.ts';

const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.testnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const st: any = readState(null);
const who = (n: string) => st.items.find((i: any) => i.name === n).identityId as string;
const contracts = JSON.parse(readFileSync(join(resultsDir, 'testnet-contracts.json'), 'utf8')).contracts as Record<string, { id: string }>;

const rows: any[] = [];
type Q = { id: string; contract: string; type: string; where?: any[]; orderBy?: any[]; limit?: number; startAfter?: string; expect?: 'rows' | 'any'; reject?: boolean; order?: { field: string; dir: 'asc' | 'desc' } };
async function run(q: Q, note = ''): Promise<any[]> {
  const t0 = performance.now();
  try {
    const r: any = await sdk.documents.queryWithProof({ dataContractId: contracts[q.contract].id, documentTypeName: q.type, where: q.where, orderBy: q.orderBy, limit: q.limit ?? 100, startAfter: q.startAfter });
    const docs = [...r.data.values()].filter(Boolean);
    const ms = Math.round(performance.now() - t0);
    let ok = q.reject ? false : (q.expect ?? 'rows') === 'any' || docs.length > 0;
    let orderNote = '';
    if (q.order && docs.length >= 2) {
      const vals = docs.map((d: any) => BigInt(prop(d, q.order!.field)));
      const sorted = vals.every((v: bigint, i: number) => i === 0 || (q.order!.dir === 'asc' ? vals[i - 1] <= v : vals[i - 1] >= v));
      orderNote = sorted ? ` [order ${q.order.field} ${q.order.dir} verified on ${docs.length} docs]` : ' [ORDER WRONG]';
      if (!sorted) ok = false;
    }
    rows.push({ id: q.id, contract: q.contract, type: q.type, where: JSON.stringify(q.where, (_k, v) => (v instanceof Uint8Array ? `bytes(${v.length})` : typeof v === 'bigint' ? v.toString() : v)), orderBy: JSON.stringify(q.orderBy), count: docs.length, ok, reject: !!q.reject, ms, height: String(r.metadata?.height), note: note + orderNote, ...(q.order && docs.length >= 2 ? { orderVerified: ok } : {}) });
    console.log(`${ok ? 'ok  ' : q.reject ? 'ACCEPTED' : 'EMPTY'} ${q.id.padEnd(6)} ${q.contract}.${q.type.padEnd(14)} ${String(docs.length).padStart(3)} docs ${ms} ms ${note}${orderNote}`);
    return docs;
  } catch (e) {
    rows.push({ id: q.id, contract: q.contract, type: q.type, where: JSON.stringify(q.where, (_k, v) => (v instanceof Uint8Array ? `bytes(${v.length})` : typeof v === 'bigint' ? v.toString() : v)), orderBy: JSON.stringify(q.orderBy), ok: q.reject === true, reject: !!q.reject, rejected: true, error: errText(e).slice(0, 300), note });
    console.log(`FAIL  ${q.id.padEnd(6)} ${q.contract}.${q.type}: ${errText(e).slice(0, 200)}`);
    return [];
  }
}
const prop = (d: any, k: string) => { const j = d.toJSON(); return j[k]; };
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const owner = who('owner'), u3 = who('u3'), u6 = who('u6');
const nowMs = Date.now();

// ---- discover real values from chain ----
const props0 = await run({ id: 'G0', contract: 'gov', type: 'proposal', where: [['endEpoch', '>', 0]], orderBy: [['endEpoch', 'asc']], limit: 5 }, 'discover');
const govHashB64: string = prop(props0[0], 'govHash'); // JSON form of a byteArray is base64
// FINDING: byteArray values in `where` must be base64 STRINGS; a Uint8Array fails with
// "serde deserialization error: invalid type: byte array, expected any valid JSON value".
const govHash = govHashB64;
console.log(`  govHash sample (base64): ${govHashB64}`);

// bytes argument encodings: Uint8Array vs base64 string
await run({ id: 'G1', contract: 'gov', type: 'proposal', where: [['govHash', '==', govHash]] }, 'proposal by govHash (base64 string value)');
await run({ id: 'X0', contract: 'gov', type: 'proposal', where: [['govHash', '==', b64(govHashB64)]], reject: true }, 'NEGATIVE: byteArray value as Uint8Array is rejected client-side');

const T = (tag: string, arr: Q[]) => arr; // grouping aid

// ---- gov ----
await run({ id: 'G2', contract: 'gov', type: 'proposal', where: [['endEpoch', '>', Math.floor(nowMs / 1000)]], orderBy: [['endEpoch', 'asc']], limit: 100, order: { field: 'endEpoch', dir: 'asc' } }, 'active proposals (range on endEpoch)');
await run({ id: 'G3', contract: 'gov', type: 'proposal', where: [['endEpoch', '<=', Math.floor(nowMs / 1000)]], orderBy: [['endEpoch', 'desc']], limit: 100, expect: 'any' }, 'past proposals, newest end first');
const pName = prop(props0[0], 'name');
await run({ id: 'G4', contract: 'gov', type: 'proposal', where: [['name', '==', pName]], orderBy: [['name', 'asc'], ['$createdAt', 'asc']] }, 'by name, oldest first');
await run({ id: 'G4b', contract: 'gov', type: 'proposal', where: [['name', '==', pName]], orderBy: [['$createdAt', 'asc']] }, 'by name, orderBy $createdAt only');
const hashes = props0.map((d) => prop(d, 'govHash') as string);
await run({ id: 'G5', contract: 'gov', type: 'tally', where: [['govHash', 'in', hashes]], orderBy: [['govHash', 'asc']] }, 'tallies for visible proposals (in)');
await run({ id: 'G5b', contract: 'gov', type: 'tally', where: [['govHash', '==', govHash]] }, 'tally by govHash');
await run({ id: 'G6', contract: 'gov', type: 'cycle', where: [['superblockHeight', '>', 0]], orderBy: [['superblockHeight', 'desc']], limit: 5 }, 'latest cycles');
await run({ id: 'G6b', contract: 'gov', type: 'cycle', where: [['superblockHeight', '==', 2_570_000]] }, 'one cycle');
await run({ id: 'G7', contract: 'gov', type: 'claimAttestation', where: [['govHash', '==', govHash]], orderBy: [['govHash', 'asc']] }, 'attestations for a proposal');

// ---- forum ----
await run({ id: 'F1', contract: 'forum', type: 'profile', where: [['$ownerId', '==', u3]] }, 'profile by owner');
await run({ id: 'F1b', contract: 'forum', type: 'profile', where: [['$ownerId', 'in', [u3, u6]]], orderBy: [['$ownerId', 'asc']] }, 'profiles for commenters (in)');
await run({ id: 'F2', contract: 'forum', type: 'comment', where: [['govHash', '==', govHash]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']], limit: 2 }, 'comments of a proposal, oldest first');
const pg1 = await run({ id: 'F3p1', contract: 'forum', type: 'comment', where: [['$ownerId', '==', u3]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 1 }, 'paging: page 1 (limit 1)');
if (pg1[0]) await run({ id: 'F3p2', contract: 'forum', type: 'comment', where: [['$ownerId', '==', u3]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 1, startAfter: pg1[0].id.toString() }, 'paging: page 2 via startAfter');
await run({ id: 'F2c', contract: 'forum', type: 'comment', where: [['govHash', '==', govHash]], orderBy: [['govHash', 'desc'], ['$createdAt', 'desc']], limit: 5 }, 'newest first');
await run({ id: 'F2d', contract: 'forum', type: 'comment', where: [['govHash', '==', govHash], ['$createdAt', '>', nowMs - 86_400_000]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']] }, 'comments since T (equality + range)');
await run({ id: 'F3', contract: 'forum', type: 'comment', where: [['$ownerId', '==', u3]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 5, order: { field: '$createdAt', dir: 'desc' } }, 'comments by author, newest first');
await run({ id: 'F3a', contract: 'forum', type: 'comment', where: [['$ownerId', '==', u3]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 5, order: { field: '$createdAt', dir: 'asc' } }, 'comments by author, oldest first');
await run({ id: 'F5', contract: 'forum', type: 'reaction', where: [['$ownerId', '==', u3], ['target', '==', govHash]] }, 'my reaction on a target');
await run({ id: 'F5b', contract: 'forum', type: 'reaction', where: [['$ownerId', '==', u3], ['target', 'in', [govHash, prop(props0[1] ?? props0[0], 'govHash')]]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']] }, 'my reactions on visible targets (in)');
await run({ id: 'F6', contract: 'forum', type: 'reaction', where: [['target', '==', govHash]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']] }, 'all reactions on a target');
await run({ id: 'F7', contract: 'forum', type: 'claim', where: [['govHash', '==', govHash]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']] }, 'claims on a proposal');
await run({ id: 'F8', contract: 'forum', type: 'proposalPost', where: [['govHash', '==', govHash], ['$ownerId', '==', u3]] }, 'owner post (unique)');
await run({ id: 'F8b', contract: 'forum', type: 'proposalPost', where: [['govHash', '==', govHash]], orderBy: [['govHash', 'asc'], ['$ownerId', 'asc']] }, 'all posts for a proposal');
await run({ id: 'F9', contract: 'forum', type: 'proposalDraft', where: [['$ownerId', '==', u3]], orderBy: [['$ownerId', 'asc'], ['govHash', 'asc']] }, 'my drafts');
await run({ id: 'F9b', contract: 'forum', type: 'proposalDraft', where: [['stage', '==', 2]], orderBy: [['stage', 'asc'], ['$updatedAt', 'asc']] }, 'relay: drafts awaiting submit');
await run({ id: 'F9c', contract: 'forum', type: 'proposalDraft', where: [['stage', '==', 2], ['$updatedAt', '>', nowMs - 86_400_000]], orderBy: [['stage', 'asc'], ['$updatedAt', 'asc']] }, 'relay: drafts updated since T');
await run({ id: 'F10', contract: 'forum', type: 'block', where: [['$ownerId', '==', u3]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']] }, 'my block list');
await run({ id: 'F10b', contract: 'forum', type: 'block', where: [['$ownerId', '==', u3], ['target', 'in', [owner, u6]]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']], expect: 'any' }, 'is X blocked (in)');
await run({ id: 'F11', contract: 'forum', type: 'blockSubs', where: [['$ownerId', '==', u6]] }, 'my list subscriptions');
await run({ id: 'F12', contract: 'forum', type: 'settings', where: [['$ownerId', '==', u6]] }, 'my settings');
const vaults = await run({ id: 'F13', contract: 'forum', type: 'vault', where: [['$ownerId', '==', u3]], orderBy: [['$ownerId', 'asc'], ['credentialId', 'asc']] }, 'my vault entries');
if (vaults[0]) await run({ id: 'F13b', contract: 'forum', type: 'vault', where: [['$ownerId', '==', u3], ['credentialId', '==', prop(vaults[0], 'credentialId')]] }, 'vault entry for one credential');

// ---- badge ----
await run({ id: 'B1', contract: 'badge', type: 'issuerKey', where: [['$ownerId', '==', owner], ['epoch', '==', 300]] }, 'issuer key for epoch');
await run({ id: 'B1b', contract: 'badge', type: 'issuerKey', where: [['$ownerId', '==', owner]], orderBy: [['$ownerId', 'asc'], ['epoch', 'desc']] }, 'all keys of an issuer, newest first');
await run({ id: 'B1c', contract: 'badge', type: 'issuerKey', where: [['$ownerId', '==', owner], ['epoch', '>=', 200]], orderBy: [['$ownerId', 'asc'], ['epoch', 'asc']] }, 'keys from epoch E (equality + range)');
await run({ id: 'B2', contract: 'badge', type: 'issuerRevocation', where: [['$ownerId', '==', owner], ['epoch', '==', 300]] }, 'revocation for epoch');
await run({ id: 'B3', contract: 'badge', type: 'issuerReport', where: [['$ownerId', '==', owner], ['epoch', '==', 300]] }, 'issuer report for epoch');
await run({ id: 'B4', contract: 'badge', type: 'mnBadge', where: [['issuerId', '==', owner], ['epoch', '==', 300], ['$ownerId', 'in', [u3, u6]]], orderBy: [['$ownerId', 'asc']] }, 'which of these authors hold a badge from issuer I in epoch E (equality prefix + in on LAST property)');
await run({ id: 'B4b', contract: 'badge', type: 'mnBadge', where: [['issuerId', '==', owner], ['epoch', '==', 300], ['$ownerId', '==', u3]] }, 'exact badge lookup (unique)');
await run({ id: 'B4c', contract: 'badge', type: 'mnBadge', where: [['issuerId', '==', owner], ['epoch', '==', 300]], orderBy: [['$ownerId', 'asc']] }, 'all badge holders of issuer I in epoch E (paged)');
await run({ id: 'B4d', contract: 'badge', type: 'mnBadge', where: [['issuerId', '==', owner], ['epoch', '>=', 300]], orderBy: [['epoch', 'asc']] }, 'badges of issuer I from epoch E on (equality + range)');

// ---- mod ----
await run({ id: 'M1', contract: 'mod', type: 'block', where: [['$ownerId', '==', owner]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']] }, 'default block list');
await run({ id: 'M1b', contract: 'mod', type: 'block', where: [['$ownerId', '==', owner], ['$createdAt', '>', nowMs - 7 * 86_400_000]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], order: { field: '$createdAt', dir: 'asc' } }, 'default list: new since T');
await run({ id: 'M1c', contract: 'mod', type: 'block', where: [['$ownerId', '==', owner], ['target', 'in', [u3, u6]]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']], expect: 'any' }, 'is X on the default list (in)');

// ---- negative probes: shapes we must NOT use (documented as such) ----
console.log('\nNegative probes (gapped / unindexed shapes):');
await run({ id: 'X1', contract: 'badge', type: 'mnBadge', where: [['issuerId', '==', owner], ['$ownerId', '==', u3]], reject: true }, 'GAP: skips epoch in [issuerId, epoch, $ownerId] (the PV13 gapped-index bug shape)');
await run({ id: 'X2', contract: 'badge', type: 'mnBadge', where: [['$ownerId', '==', u3]], reject: true }, 'NOT A PREFIX: $ownerId is the last index property');
await run({ id: 'X2b', contract: 'badge', type: 'mnBadge', where: [['issuerId', '==', owner], ['epoch', 'in', [300, 301]]], orderBy: [['epoch', 'asc']], expect: 'any' }, 'ALLOWED on PV14 testnet but unused: in on the SECOND-TO-LAST property');
await run({ id: 'X2c', contract: 'badge', type: 'mnBadge', where: [['$ownerId', 'in', [u3, u6]]], orderBy: [['$ownerId', 'asc']], reject: true }, 'REJECTED: $ownerId in [...] without the issuerId/epoch prefix (a gap before the last property)');
await run({ id: 'X2d', contract: 'badge_r1', type: 'mnBadge', where: [['$ownerId', 'in', [u3, u6]]], orderBy: [['$ownerId', 'asc']], reject: true }, 'REJECTED: in on the FIRST property of the superseded PLAN-order index [$ownerId, issuerId, epoch]');
await run({ id: 'X3', contract: 'forum', type: 'comment', where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'asc']], reject: true }, 'NO INDEX starts with $createdAt');
await run({ id: 'X4', contract: 'forum', type: 'comment', where: [['govHash', 'in', [govHash, hashes[1] ?? govHash]], ['$createdAt', '>', 0]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']], expect: 'any' }, 'ALLOWED on PV14 testnet but unused: in (second-to-last) + range on the last property');
await run({ id: 'X5', contract: 'forum', type: 'reaction', where: [['target', '==', govHash]], orderBy: [['$createdAt', 'asc']], expect: 'any' }, 'ALLOWED: orderBy may omit the equality prefix property');

const bad = rows.filter((r) => (!r.id.startsWith('X') || r.reject) && !r.ok);
saveResult('testnet-queries.json', { at: new Date().toISOString(), network: 'testnet (protocol 14); PV13 gapped-index behaviour cannot be exercised here', contracts: Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, v.id])), rows });
console.log(`\n${rows.length} queries; ${bad.length} unexpected failures/empties among the documented shapes`);
for (const b of bad) console.log(`  ${b.id}: ${b.error ?? 'empty'}`);
process.exit(bad.length ? 1 : 0);
