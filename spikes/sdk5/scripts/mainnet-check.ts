// Mainnet PV13 write check, stages 2-5: register the throwaway contract `pv13check` (comment, reaction, mnBadge copied
// from packages/contracts-v1), write a handful of documents (incl. a flip and a delete), measure each op's cost from
// SETTLED balances, then run every documented query shape for these types and assert the results.
//
//   vite-node scripts/mainnet-check.ts     (needs mainnet-identity.ts first; resumable via state.json -> check)
//
// HARD BUDGET: 0.3 DASH. Every costly step first checks (burned so far + conservative estimate) <= 0.3 DASH.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { contractsDir, dash, errText, resultsDir, saveResult, sleep } from './lib.ts';
import { IDENTITY_KEYS, IDENTITY_KEY_PATH, keyHexAt, readState, wifOf, writeState } from './mainnet-lib.ts';

process.on('unhandledRejection', (e) => { console.log(`UNHANDLED: ${errText(e)}`); console.log((e as any)?.stack?.split('\n').slice(0, 6).join('\n') ?? ''); process.exit(4); });
const BUDGET_CREDITS = 30_000_000_000n; // 0.3 DASH
const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.mainnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const PV = sdk.version();
console.log(`connected; sdk.version() ${PV}`);

const st: any = readState(null);
if (!st?.items?.every((i: any) => i.state === 'done')) throw new Error('run mainnet-identity.ts first');
st.check ??= { contract: null, docs: {}, ops: [], failures: [], queries: [] };
const C = st.check;
const save = () => writeState(st);
const who = (n: string) => st.items.find((i: any) => i.name === n);
const M = who('main').identityId as string, S = who('second').identityId as string;

// ---------- helpers ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const idBytes = (s: string): Uint8Array => {
  let v = 0n; for (const c of s) v = v * 58n + BigInt(B58.indexOf(c));
  const out: number[] = []; while (v > 0n) { out.unshift(Number(v & 255n)); v >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
};
const b58 = (b: Uint8Array): string => {
  let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x);
  let out = ''; while (v > 0n) { out = B58[Number(v % 58n)] + out; v /= 58n; }
  for (const x of b) { if (x !== 0) break; out = '1' + out; }
  return out;
};
// PV13 document id = sha256d(contractId || ownerId || typeName || entropy) (verified against evo-sdk's own derivation in mainnet-docid-probe.ts).
// evo-sdk rc.8 at PV13 REJECTS a zero `$id` (what the testnet/PV14 scripts pass), and Document.generateId() throws 'identityContractNonce is required' (PV14 rule).
const sha256d = (b: Buffer) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
const pv13DocId = (cid: string, owner: string, type: string, entropy: Uint8Array): Uint8Array => Uint8Array.from(sha256d(Buffer.concat([idBytes(cid), idBytes(owner), Buffer.from(type), entropy])));
const rb = (n: number) => Uint8Array.from(randomBytes(n));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const cmpBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const now = () => BigInt(Date.now());

const identities: Record<string, any> = {};
const signers: Record<string, any> = {};
for (const it of st.items) {
  identities[it.name] = await sdk.identities.fetch(it.identityId);
  const s = new w.IdentitySigner();
  for (const k of IDENTITY_KEYS) s.addKeyFromWif(wifOf(keyHexAt(IDENTITY_KEY_PATH(it.identityIndex, k.keyId))));
  signers[it.name] = s;
}
const keyOf = (name: string, id: number) => identities[name].getPublicKeyById(id);
const idOf = (name: string) => who(name).identityId as string;

// ---------- budget ledger ----------
const burnedCredits = (): bigint => {
  let b = BigInt(st.ledger.l1FeeDuffs) * 1000n;
  for (const it of st.items) b += BigInt(it.createFeeCredits);
  if (C.contract) b += BigInt(C.contract.credits);
  for (const o of C.ops) b += BigInt(o.credits);
  return b;
};
function budgetGuard(label: string, estCredits: bigint) {
  const total = burnedCredits() + estCredits;
  console.log(`  [budget] burned ${dash(burnedCredits())} + est ${dash(estCredits)} = ${dash(total)} of ${dash(BUDGET_CREDITS)} DASH`);
  if (total > BUDGET_CREDITS) {
    console.log(`STOP: ${label} would exceed the 0.3 DASH budget`);
    save();
    process.exit(3);
  }
}

// ---------- balances (nodes can lag: read until stable) ----------
const readBal = async (name: string): Promise<bigint> => BigInt(await sdk.identities.balance(idOf(name)));
async function stableBalance(name: string): Promise<bigint> {
  let prev: bigint | undefined;
  for (let i = 0; i < 25; i++) {
    const b = await readBal(name);
    if (prev === b) return b;
    prev = b; await sleep(2000);
  }
  return prev!;
}
async function balanceAfter(name: string, before: bigint): Promise<{ after: bigint; unchanged: boolean }> {
  let candidate: bigint | undefined;
  for (let i = 0; i < 40; i++) {
    const b = await readBal(name);
    if (b !== before) { if (candidate === b) return { after: b, unchanged: false }; candidate = b; await sleep(1200); continue; }
    candidate = undefined; await sleep(1500);
  }
  return { after: before, unchanged: true };
}
const lastBal: Record<string, bigint> = {};
async function measured(label: string, meta: Record<string, unknown>, payer: string, estCredits: bigint, fn: () => Promise<unknown>): Promise<boolean> {
  if (C.ops.some((o: any) => o.label === label)) { console.log(`skip ${label} (done)`); return true; }
  budgetGuard(label, estCredits);
  const before = (lastBal[payer] ??= await stableBalance(payer));
  const t0 = performance.now();
  let retries = 0;
  for (;;) {
    try { await fn(); break; } catch (e) {
      const msg = errText(e);
      if (retries < 4 && /not found|40101|nonce/i.test(msg)) { retries++; console.log(`  ... ${label}: ${msg.slice(0, 80)}; retry ${retries}/4 in 4s (lagging node)`); await sleep(4000); continue; }
      console.log(`FAIL ${label}: ${msg.slice(0, 400)}`);
      C.failures.push({ label, error: msg.slice(0, 800) }); save();
      return false;
    }
  }
  const ms = Math.round(performance.now() - t0);
  const { after, unchanged } = await balanceAfter(payer, before);
  lastBal[payer] = after;
  const credits = before - after;
  C.ops.push({ label, ...meta, payer, credits: credits.toString(), dash: dash(credits), ms, retries, ...(unchanged ? { unchanged: true } : {}) }); save();
  console.log(`ok   ${label.padEnd(52)} ${String(credits).padStart(13)} credits (${dash(credits)} DASH)  ${ms} ms${unchanged ? '  UNCHANGED?' : ''}`);
  return true;
}

// ---------- 1. the contract ----------
const forum = JSON.parse(readFileSync(join(contractsDir, 'forum.json'), 'utf8'));
const badge = JSON.parse(readFileSync(join(contractsDir, 'badge.json'), 'utf8'));
const schemas: Record<string, any> = { comment: forum.comment, reaction: forum.reaction, mnBadge: badge.mnBadge };
const nTypes = Object.keys(schemas).length;
const nIdx = Object.values<any>(schemas).reduce((a, t) => a + t.indices.length, 0);
// PV13 fee schedule (rs-platform-version fee/data_contract_registration/v2.rs): 0.1 base + 0.02 per type + 0.01 per index (unique or not)
const formula = 10_000_000_000n + BigInt(nTypes) * 2_000_000_000n + BigInt(nIdx) * 1_000_000_000n;
console.log(`contract pv13check: ${nTypes} types, ${nIdx} indexes; registration formula ${dash(formula)} DASH (+ ~0.003 storage)`);

if (!C.contract) {
  const mainBal = await stableBalance('main');
  console.log(`main balance ${dash(mainBal)} DASH`);
  budgetGuard('contract registration', formula + 400_000_000n);
  if (mainBal < formula + 400_000_000n) { console.log('STOP: main identity balance too low for the registration'); process.exit(3); }
  const nonce = BigInt((await sdk.identities.nonce(M)) ?? 0n) + 1n;
  const dc = new w.DataContract({ ownerId: M, identityNonce: nonce, schemas, fullValidation: true, platformVersion: PV });
  const t0 = performance.now();
  const published = await sdk.contracts.publish({ dataContract: dc, identityKey: keyOf('main', 1), signer: signers.main });
  const ms = Math.round(performance.now() - t0);
  const id = published.id.toString();
  const { after } = await balanceAfter('main', mainBal);
  lastBal.main = after;
  let back: any; for (let i = 0; i < 15 && !back; i++) { back = await sdk.contracts.fetch(id); if (!back) await sleep(2000); }
  const same = !!back && JSON.stringify(back.toJSON(PV).documentSchemas) === JSON.stringify(dc.toJSON(PV).documentSchemas);
  C.contract = { id, nonce: nonce.toString(), credits: (mainBal - after).toString(), dash: dash(mainBal - after), formulaCredits: formula.toString(), overheadCredits: (mainBal - after - formula).toString(), readBackIdentical: same, ms, types: nTypes, indexes: nIdx, platformVersionUsed: PV };
  save();
  console.log(`registered pv13check ${id}: cost ${dash(mainBal - after)} DASH (formula ${dash(formula)} + ${dash(mainBal - after - formula)}), read-back ${same ? 'identical' : 'DIFFERENT'}, ${ms} ms`);
}
const CID: string = C.contract.id;
const contract = await sdk.contracts.fetch(CID);

// ---------- 2. documents ----------
const stampsFor = (type: string) => {
  const req: string[] = schemas[type].required ?? [];
  const e: Record<string, any> = {};
  const t = now();
  if (req.includes('$createdAt')) e.$createdAt = t;
  if (req.includes('$updatedAt')) e.$updatedAt = t;
  return e;
};
const coreHeight = async (): Promise<number> => Number((await sdk.contracts.fetchWithProof(CID) as any).metadata.coreChainLockedHeight);
const ser = (v: any): any => (typeof v === 'bigint' ? { $big: v.toString() } : v instanceof Uint8Array ? { $hex: hexOf(v) } : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)])) : v);
const de = (v: any): any => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v && typeof v === 'object' && '$hex' in v ? unhex(v.$hex) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, de(x)])) : v);

async function create(key: string, type: string, owner: string, props: Record<string, any>, est: bigint, note = '') {
  if (C.docs[key]) { console.log(`skip create ${key} (exists)`); return; }
  const extra: Record<string, any> = stampsFor(type);
  if ((schemas[type].required ?? []).includes('$createdAtCoreBlockHeight')) extra.$createdAtCoreBlockHeight = await coreHeight();
  const entropy = rb(32);
  // PV13: the SDK checks $id against the id derived from ($type, owner, contract, entropy); a zero $id (accepted at PV14) is rejected
  const docId = (PV === 13 ? pv13DocId(CID, idOf(owner), type, entropy) : new Uint8Array(32));
  const doc = w.Document.fromObject({ $formatVersion: '0', $id: docId, $ownerId: idBytes(idOf(owner)), $dataContractId: idBytes(CID), $type: type, $revision: 1n, $entropy: entropy, ...extra, ...props }, w.PlatformVersion.latest());
  let created: any;
  const ok = await measured(`pv13check.${type} create ${key}${note ? ' (' + note + ')' : ''}`, { type, op: 'create', key, note }, owner, est, async () => {
    created = await sdk.documents.create({ document: doc, identityKey: keyOf(owner, 2), signer: signers[owner] });
  });
  if (ok && created) { C.docs[key] = { type, owner, id: created.id.toString(), props: ser(props), revision: '1' }; save(); }
}
async function replace(key: string, patch: Record<string, any>, est: bigint, note = '') {
  const d = C.docs[key]; if (!d) { console.log(`skip replace ${key}: no doc`); return; }
  const label = `pv13check.${d.type} replace ${key}${note ? ' (' + note + ')' : ''}`;
  if (C.ops.some((o: any) => o.label === label)) { console.log(`skip ${label} (done)`); return; }
  const props = { ...de(d.props), ...patch };
  const rev = BigInt(d.revision) + 1n;
  const doc = w.Document.fromObject({ $formatVersion: '0', $id: idBytes(d.id), $ownerId: idBytes(idOf(d.owner)), $dataContractId: idBytes(CID), $type: d.type, $revision: rev, $updatedAt: now(), ...props }, w.PlatformVersion.latest());
  const ok = await measured(label, { type: d.type, op: 'replace', key, note }, d.owner, est, async () => {
    await sdk.documents.replace({ document: doc, identityKey: keyOf(d.owner, 2), signer: signers[d.owner] });
  });
  if (ok) { d.props = ser(props); d.revision = rev.toString(); save(); }
}
async function del(key: string, est: bigint, note = '') {
  const d = C.docs[key]; if (!d) { console.log(`skip delete ${key}: no doc`); return; }
  const label = `pv13check.${d.type} delete ${key}${note ? ' (' + note + ')' : ''}`;
  if (C.ops.some((o: any) => o.label === label)) return;
  const ok = await measured(label, { type: d.type, op: 'delete', key, note }, d.owner, est, async () => {
    await sdk.documents.delete({ document: { id: d.id, ownerId: idOf(d.owner), dataContractId: CID, documentTypeName: d.type }, identityKey: keyOf(d.owner, 2), signer: signers[d.owner] });
  });
  if (ok) { d.deleted = true; save(); }
}

C.fixtures ??= { G1: hexOf(rb(32)), G2: hexOf(rb(32)), T1: hexOf(rb(32)), T2: hexOf(rb(32)), T3: hexOf(rb(32)), epoch: 300 };
save();
const F = C.fixtures;
const G1 = unhex(F.G1), G2 = unhex(F.G2), T1 = unhex(F.T1), T2 = unhex(F.T2), T3 = unhex(F.T3);
const EPOCH = F.epoch as number;
const ISSUER = M; // dummy issuer identifier: the main identity's id
const EST_COMMENT = 800_000_00n * 10n / 10n; // 0.0008 DASH conservative
const EST_REACT = 800_000_00n * 10n / 10n;
const EST_SMALL = 100_000_00n * 10n / 10n;
const EST_BADGE = 1_000_000_00n * 10n / 10n; // 0.001 DASH

console.log('\n--- documents ---');
await create('C1', 'comment', 'main', { govHash: G1, body: 'pv13check comment 1 on G1', fmt: 0n }, EST_COMMENT, 'main, G1');
await create('C2', 'comment', 'second', { govHash: G1, body: 'pv13check reply on G1', fmt: 1n, parentId: idBytes(C.docs.C1?.id ?? M) }, EST_COMMENT, 'second, reply to C1');
await create('C3', 'comment', 'main', { govHash: G2, body: 'pv13check comment on G2', fmt: 0n }, EST_COMMENT, 'main, G2');
await create('R1', 'reaction', 'main', { target: T1, kind: 2n, value: 1n }, EST_REACT, 'main -> T1 +1');
await create('R2', 'reaction', 'main', { target: T2, kind: 2n, value: 1n }, EST_REACT, 'main -> T2 +1');
await create('R3', 'reaction', 'second', { target: T1, kind: 2n, value: 1n }, EST_REACT, 'second -> T1 +1');
await create('R4', 'reaction', 'main', { target: T3, kind: 1n, value: -1n }, EST_REACT, 'main -> T3 -1');
await replace('R1', { value: -1n }, EST_SMALL, 'flip to -1');
await del('R2', EST_SMALL, 'unreact');
await create('B1', 'mnBadge', 'main', { issuerId: idBytes(ISSUER), epoch: BigInt(EPOCH), keyId: rb(32), msgPrefix: rb(32), sig: rb(256) }, EST_BADGE, `epoch ${EPOCH}`);
await create('B2', 'mnBadge', 'second', { issuerId: idBytes(ISSUER), epoch: BigInt(EPOCH), keyId: rb(32), msgPrefix: rb(32), sig: rb(256) }, EST_BADGE, `epoch ${EPOCH}`);
await create('B3', 'mnBadge', 'main', { issuerId: idBytes(ISSUER), epoch: BigInt(EPOCH + 1), keyId: rb(32), msgPrefix: rb(32), sig: rb(384) }, EST_BADGE, `epoch ${EPOCH + 1}, sig 384 B`);
// duplicate-owner check of the unique index: a second badge for (issuer, epoch, main) must be rejected (no fee expected)
if (!C.uniqueProbe) {
  const before = await stableBalance('main');
  const dupEntropy = rb(32);
  const doc = w.Document.fromObject({ $formatVersion: '0', $id: pv13DocId(CID, M, 'mnBadge', dupEntropy), $ownerId: idBytes(M), $dataContractId: idBytes(CID), $type: 'mnBadge', $revision: 1n, $entropy: dupEntropy, $createdAtCoreBlockHeight: await coreHeight(), issuerId: idBytes(ISSUER), epoch: BigInt(EPOCH), keyId: rb(32), msgPrefix: rb(32), sig: rb(256) }, w.PlatformVersion.latest());
  let outcome = 'ACCEPTED (unexpected)';
  try { await sdk.documents.create({ document: doc, identityKey: keyOf('main', 2), signer: signers.main }); } catch (e) { outcome = `rejected: ${errText(e).slice(0, 200)}`; }
  const after = await stableBalance('main');
  C.uniqueProbe = { name: 'duplicate mnBadge (issuer, epoch, owner)', outcome, balanceDeltaCredits: (before - after).toString() };
  if (before !== after) { C.ops.push({ label: 'pv13check.mnBadge duplicate-create probe', type: 'mnBadge', op: 'probe', payer: 'main', credits: (before - after).toString(), dash: dash(before - after), ms: 0, retries: 0 }); lastBal.main = after; }
  save();
  console.log(`unique index probe: ${outcome}; balance delta ${before - after}`);
}

// ---------- 3. read stored docs (createdAt etc.) ----------
const fetched: Record<string, any> = {};
for (const [key, d] of Object.entries<any>(C.docs)) {
  if (d.deleted) continue;
  let doc: any;
  for (let i = 0; i < 15 && !doc; i++) { doc = await sdk.documents.get(CID, d.type, d.id); if (!doc) await sleep(2000); }
  fetched[key] = doc;
  if (!doc) { console.log(`WARN: ${key} not readable`); continue; }
  d.createdAt = String(doc.createdAt); d.updatedAt = doc.updatedAt !== undefined ? String(doc.updatedAt) : undefined; d.createdAtCoreBlockHeight = doc.createdAtCoreBlockHeight;
}
save();
const keyById: Record<string, string> = Object.fromEntries(Object.entries<any>(C.docs).map(([k, d]) => [d.id, k]));
const ca = (k: string) => BigInt(C.docs[k].createdAt);
const byCreated = (keys: string[], dir: 'asc' | 'desc') => keys.slice().sort((a, b) => { const d = ca(a) - ca(b); return (dir === 'asc' ? 1 : -1) * (d < 0n ? -1 : d > 0n ? 1 : 0); });
const sortedByBytes = (keys: string[], f: (k: string) => Uint8Array) => keys.slice().sort((a, b) => cmpBytes(f(a), f(b)));
const ownerBytes = (k: string) => idBytes(idOf(C.docs[k].owner));
const createdTies = (keys: string[]) => new Set(keys.map((k) => String(ca(k)))).size !== keys.length;

// ---------- 4. queries ----------
console.log('\n--- queries ---');
type Spec = {
  id: string; type: string; where?: any[]; orderBy?: any[]; limit?: number; startAfter?: string;
  expect?: string[];            // doc keys expected (set; sequence if `ordered`)
  ordered?: boolean;
  reject?: boolean;             // an error is the expected outcome
  observe?: boolean;            // no assertion: record what PV13 does; `wouldBe` = the keys a correct plan would return
  wouldBe?: string[];
  note?: string;
  expectValue?: { key: string; field: string; value: number };
};
async function runOnce(s: Spec): Promise<{ keys: string[] | null; error?: string; ms: number; height?: string; values?: Record<string, number> }> {
  const t0 = performance.now();
  try {
    const r: any = await sdk.documents.queryWithProof({ dataContractId: CID, documentTypeName: s.type, where: s.where, orderBy: s.orderBy, limit: s.limit ?? 100, startAfter: s.startAfter });
    const docs = [...r.data.values()].filter(Boolean) as any[];
    const values: Record<string, number> = {};
    for (const d of docs) if (d.properties?.value !== undefined) values[keyById[d.id.toString()] ?? d.id.toString()] = Number(d.properties.value);
    return { keys: docs.map((d) => keyById[d.id.toString()] ?? `?${d.id.toString()}`), ms: Math.round(performance.now() - t0), height: String(r.metadata?.height), values };
  } catch (e) { return { keys: null, error: errText(e).slice(0, 300), ms: Math.round(performance.now() - t0) }; }
}
const fmt = (k: string[] | null) => (k === null ? 'ERROR' : `[${k.join(',')}]`);
const json = (v: any) => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `bytes(${x.length})` : typeof x === 'bigint' ? x.toString() : x));
const whereShown = (v: any) => json(v);
const rows: any[] = C.queries;
async function q(s: Spec) {
  if (rows.some((r) => r.id === s.id)) return rows.find((r) => r.id === s.id);
  const outcomes: any[] = [];
  let verdict = '', ok = false;
  const maxAttempts = s.observe ? 3 : 4;
  for (let a = 0; a < maxAttempts; a++) {
    const o = await runOnce(s);
    outcomes.push({ keys: o.keys, error: o.error, ms: o.ms, height: o.height });
    if (s.observe) { if (a < maxAttempts - 1) await sleep(1500); continue; }
    if (s.reject) { ok = o.keys === null; verdict = ok ? 'rejected as expected' : `NOT rejected, returned ${fmt(o.keys)}`; if (ok) break; }
    else if (o.keys === null) { verdict = `error: ${o.error}`; ok = false; }
    else {
      const exp = s.expect ?? [];
      const same = s.ordered ? JSON.stringify(o.keys) === JSON.stringify(exp) : JSON.stringify([...o.keys].sort()) === JSON.stringify([...exp].sort());
      ok = same;
      if (same && s.expectValue) { const v = o.values?.[s.expectValue.key]; if (v !== s.expectValue.value) { ok = false; verdict = `value ${s.expectValue.field}=${v}, expected ${s.expectValue.value}`; } }
      if (ok) verdict = `${fmt(o.keys)}${s.ordered ? ' in expected order' : ''}${s.expectValue ? ` ${s.expectValue.key}.${s.expectValue.field}=${s.expectValue.value}` : ''}`;
      else if (!verdict) verdict = `got ${fmt(o.keys)} expected ${fmt(exp)}${s.ordered ? ' (ordered)' : ''}`;
    }
    if (ok) break;
    if (a < maxAttempts - 1) { console.log(`  ... ${s.id}: ${verdict}; retry (lagging node?)`); await sleep(3000); }
  }
  let classification: string | undefined;
  if (s.observe) {
    const want = JSON.stringify([...(s.wouldBe ?? [])].sort());
    const cls = outcomes.map((o) => o.keys === null ? `error` : JSON.stringify([...o.keys].sort()) === want ? 'correct' : o.keys.length === 0 ? 'empty' : 'wrong-set');
    classification = [...new Set(cls)].join('|');
    verdict = outcomes.map((o) => fmt(o.keys) + (o.error ? ` ${o.error}` : '')).join(' ; ');
    ok = true;
  }
  const row = { id: s.id, type: s.type, where: whereShown(s.where), orderBy: json(s.orderBy), limit: s.limit, startAfter: s.startAfter ? 'last id of page 1' : undefined, kind: s.observe ? 'observe' : s.reject ? 'expect-reject' : 'assert', ok, classification, verdict, attempts: outcomes.length, outcomes, note: s.note };
  rows.push(row); save();
  console.log(`${s.observe ? 'OBS ' : ok ? 'ok  ' : 'FAIL'} ${s.id.padEnd(9)} comment/reaction/mnBadge.${s.type.padEnd(9)} ${verdict.slice(0, 160)}${classification ? `  => ${classification}` : ''}`);
  return row;
}

// expectations from the live data
const G1Comments = byCreated(['C1', 'C2'], 'asc');
const M_Comments = ['C1', 'C3'];
if (createdTies(G1Comments) || createdTies(M_Comments)) console.log('NOTE: comments share a $createdAt (same block time); order assertions fall back to set equality where tied');
const T1c = C.docs.C1 && ca('C1');

// ---- comment ----
await q({ id: 'F2', type: 'comment', where: [['govHash', '==', b64(G1)]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']], expect: G1Comments, ordered: !createdTies(G1Comments) });
await q({ id: 'F2c', type: 'comment', where: [['govHash', '==', b64(G1)]], orderBy: [['govHash', 'desc'], ['$createdAt', 'desc']], expect: byCreated(['C1', 'C2'], 'desc'), ordered: !createdTies(G1Comments) });
{
  const since = ca('C1');
  const exp = ['C1', 'C2'].filter((k) => ca(k) > since);
  await q({ id: 'F2d', type: 'comment', where: [['govHash', '==', b64(G1)], ['$createdAt', '>', Number(since)]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']], expect: exp, ordered: true, note: `since C1.$createdAt=${since}` });
}
await q({ id: 'F3', type: 'comment', where: [['$ownerId', '==', M]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], expect: byCreated(M_Comments, 'desc'), ordered: !createdTies(M_Comments) });
await q({ id: 'F3a', type: 'comment', where: [['$ownerId', '==', M]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], expect: byCreated(M_Comments, 'asc'), ordered: !createdTies(M_Comments) });
{
  const asc = byCreated(M_Comments, 'asc');
  const p1 = await q({ id: 'F3p1', type: 'comment', where: [['$ownerId', '==', M]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 1, expect: [asc[0]], ordered: true, note: 'paging page 1' });
  const lastId = C.docs[p1.outcomes[0].keys?.[0] ?? asc[0]].id;
  await q({ id: 'F3p2', type: 'comment', where: [['$ownerId', '==', M]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 1, startAfter: lastId, expect: [asc[1]], ordered: true, note: 'paging page 2 via startAfter' });
}
// PV13 finding: `desc` is ignored on equality-only queries (F2c, F3 above return ascending). It IS honoured once the last
// index property carries a range clause, so the working desc shapes add `$createdAt > 0` (see mainnet-order-probe.ts).
await q({ id: 'F2c-fix', type: 'comment', where: [['govHash', '==', b64(G1)], ['$createdAt', '>', 0]], orderBy: [['govHash', 'asc'], ['$createdAt', 'desc']], expect: byCreated(['C1', 'C2'], 'desc'), ordered: !createdTies(G1Comments), note: 'desc workaround: + range $createdAt > 0' });
await q({ id: 'F3-fix', type: 'comment', where: [['$ownerId', '==', M], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], expect: byCreated(M_Comments, 'desc'), ordered: !createdTies(M_Comments), note: 'desc workaround: + range $createdAt > 0' });
await q({ id: 'F2-noOB', type: 'comment', where: [['govHash', '==', b64(G1)]], observe: true, wouldBe: ['C1', 'C2'], note: 'no orderBy (only byProposal can match)' });
await q({ id: 'F3-noOB', type: 'comment', where: [['$ownerId', '==', M]], observe: true, wouldBe: ['C1', 'C3'], note: 'no orderBy (only byAuthor can match)' });
await q({ id: 'X3', type: 'comment', where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'asc']], reject: true, note: 'no index starts with $createdAt' });
await q({ id: 'X4', type: 'comment', where: [['govHash', 'in', [b64(G1), b64(G2)]], ['$createdAt', '>', 0]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']], observe: true, wouldBe: ['C1', 'C2', 'C3'], note: 'in (second-to-last) + range on last: documented as unused' });

// ---- reaction (final state: R1 main/T1/-1 (flipped), R3 second/T1/+1, R4 main/T3/-1; R2 main/T2 deleted) ----
const T1Reactions = byCreated(['R1', 'R3'], 'asc');
await q({ id: 'F5', type: 'reaction', where: [['$ownerId', '==', M], ['target', '==', b64(T1)]], expect: ['R1'], expectValue: { key: 'R1', field: 'value', value: -1 }, note: 'covers byOwnerTarget fully; value must show the flip' });
await q({ id: 'F5-second', type: 'reaction', where: [['$ownerId', '==', S], ['target', '==', b64(T1)]], expect: ['R3'], expectValue: { key: 'R3', field: 'value', value: 1 } });
await q({ id: 'F5b', type: 'reaction', where: [['$ownerId', '==', M], ['target', 'in', [b64(T1), b64(T2), b64(T3)]]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']], expect: sortedByBytes(['R1', 'R4'], (k) => (k === 'R1' ? T1 : T3)), ordered: true, note: 'T2 was deleted, so only R1 and R4' });
await q({ id: 'F6', type: 'reaction', where: [['target', '==', b64(T1)]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']], expect: T1Reactions, ordered: !createdTies(T1Reactions), note: '(a) documented shape: must plan byTarget and return both owners' });
await q({ id: 'F6-T3', type: 'reaction', where: [['target', '==', b64(T3)]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']], expect: ['R4'] });
await q({ id: 'F6-T2-deleted', type: 'reaction', where: [['target', '==', b64(T2)]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']], expect: [], note: 'deleted reaction must be gone' });
await q({ id: 'F6-noOB', type: 'reaction', where: [['target', '==', b64(T1)]], observe: true, wouldBe: ['R1', 'R3'], note: '(b) same query WITHOUT orderBy: gapped byOwnerTarget [$ownerId,target] ties byTarget by name' });
await q({ id: 'F6-noOB-T3', type: 'reaction', where: [['target', '==', b64(T3)]], observe: true, wouldBe: ['R4'], note: '(b) without orderBy, other target' });
await q({ id: 'F6-OB-createdAtOnly', type: 'reaction', where: [['target', '==', b64(T1)]], orderBy: [['$createdAt', 'asc']], observe: true, wouldBe: ['R1', 'R3'], note: 'X5: orderBy may omit the equality prefix' });
await q({ id: 'F6-OB-targetOnly', type: 'reaction', where: [['target', '==', b64(T1)]], orderBy: [['target', 'asc']], observe: true, wouldBe: ['R1', 'R3'], note: 'orderBy on target only (ambiguous: first property of byTarget, second of byOwnerTarget)' });
await q({ id: 'F6-desc-fix', type: 'reaction', where: [['target', '==', b64(T1)], ['$createdAt', '>', 0]], orderBy: [['target', 'asc'], ['$createdAt', 'desc']], expect: byCreated(['R1', 'R3'], 'desc'), ordered: !createdTies(T1Reactions), note: 'newest first via range workaround' });
await q({ id: 'F5-owner-only', type: 'reaction', where: [['$ownerId', '==', M]], expect: ['R1', 'R4'], note: 'valid byOwnerTarget prefix (not a documented shape; sanity)' });

// ---- mnBadge (B1 main e300, B2 second e300, B3 main e301) ----
const owners300 = sortedByBytes(['B1', 'B2'], ownerBytes);
await q({ id: 'B4', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['epoch', '==', EPOCH], ['$ownerId', 'in', [M, S, b58(rb(32))]]], orderBy: [['$ownerId', 'asc']], expect: owners300, ordered: true, note: '(c) equality prefix + in on LAST property; one non-holder in the list' });
await q({ id: 'B4-inonly-holders', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['epoch', '==', EPOCH + 1], ['$ownerId', 'in', [M, S]]], orderBy: [['$ownerId', 'asc']], expect: ['B3'], note: '(c) epoch 301: only main holds a badge' });
await q({ id: 'B4b', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['epoch', '==', EPOCH], ['$ownerId', '==', S]], expect: ['B2'] });
await q({ id: 'B4c', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['epoch', '==', EPOCH]], orderBy: [['$ownerId', 'asc']], expect: owners300, ordered: true });
await q({ id: 'B4d', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['epoch', '>=', EPOCH]], orderBy: [['epoch', 'asc']], expect: ['B1', 'B2', 'B3'], ordered: false, note: 'equality + range on epoch; B1/B2 share epoch 300 and precede B3' });
{
  const r = rows.find((x) => x.id === 'B4d');
  const o = r?.outcomes?.[r.outcomes.length - 1]?.keys as string[] | null;
  if (o && o.length === 3 && o[2] !== 'B3') { r.ok = false; r.verdict += ' ; ORDER WRONG (B3 epoch 301 must be last)'; save(); console.log('FAIL B4d order'); }
}
await q({ id: 'B4d-desc', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['epoch', '>=', 0]], orderBy: [['epoch', 'desc']], expect: ['B3'], ordered: false, note: 'desc on the range property: B3 (epoch 301) must come first' });
{
  const r = rows.find((x) => x.id === 'B4d-desc');
  const o = r?.outcomes?.[r.outcomes.length - 1]?.keys as string[] | null;
  if (r && o && o[0] !== 'B3') { r.ok = false; r.verdict = `first=${o[0]}, expected B3 first`; save(); }
  else if (r && o && o.length === 3) { r.ok = true; r.verdict = `[${o.join(',')}] epoch desc honoured`; save(); }
}
await q({ id: 'B4-desc', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['epoch', '==', EPOCH], ['$ownerId', 'in', [M, S]]], orderBy: [['$ownerId', 'desc']], expect: owners300.slice().reverse(), ordered: true, note: 'in + desc' });
await q({ id: 'X1', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['$ownerId', '==', M]], observe: true, wouldBe: ['B1', 'B3'], note: 'GAP: skips epoch in [issuerId, epoch, $ownerId] (the PV13 gapped-index bug shape; must NOT be used)' });
await q({ id: 'X1-noprefix-epoch', type: 'mnBadge', where: [['epoch', '==', EPOCH], ['$ownerId', '==', M]], observe: true, wouldBe: ['B1'], note: 'GAP: skips issuerId (first property)' });
await q({ id: 'X2', type: 'mnBadge', where: [['$ownerId', '==', M]], observe: true, wouldBe: ['B1', 'B3'], note: 'NOT A PREFIX: $ownerId is the last index property' });
await q({ id: 'X2c', type: 'mnBadge', where: [['$ownerId', 'in', [M, S]]], orderBy: [['$ownerId', 'asc']], observe: true, wouldBe: ['B1', 'B2', 'B3'], note: 'in on $ownerId without the issuerId/epoch prefix' });
await q({ id: 'X2b', type: 'mnBadge', where: [['issuerId', '==', ISSUER], ['epoch', 'in', [EPOCH, EPOCH + 1]]], orderBy: [['epoch', 'asc']], observe: true, wouldBe: ['B1', 'B2', 'B3'], note: 'in on the second-to-last property: documented as unused' });
await q({ id: 'X2e', type: 'mnBadge', where: [['issuerId', '==', ISSUER]], observe: true, wouldBe: ['B1', 'B2', 'B3'], note: 'issuer only (prefix of length 1, difference 2 = MAX_INDEX_DIFFERENCE), no orderBy' });

// (d) byte-array where values: base64 string works (every query above); Uint8Array / hex / base58 variants
{
  const probes: [string, any][] = [
    ['base64-string', b64(T3)],
    ['Uint8Array', T3],
    ['hex-string', hexOf(T3)],
    ['array-of-numbers', Array.from(T3)],
  ];
  const out: any[] = [];
  for (const [name, val] of probes) {
    const o = await runOnce({ id: `X0-${name}`, type: 'reaction', where: [['target', '==', val]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']] });
    out.push({ encoding: name, result: o.keys === null ? `error: ${o.error}` : fmt(o.keys), expected: '[R4]' });
    console.log(`byteArray where as ${name.padEnd(16)} -> ${o.keys === null ? 'ERROR ' + o.error?.slice(0, 120) : fmt(o.keys)}`);
  }
  C.byteArrayEncodings = out; save();
}

// ---------- 5. results ----------
await sleep(2000);
const finalBal: Record<string, string> = {};
for (const n of ['main', 'second']) finalBal[n] = (await stableBalance(n)).toString();
const testnet = JSON.parse(readFileSync(join(resultsDir, 'testnet-costs.json'), 'utf8'));
const tOps: any[] = testnet.ops;
const tFind = (re: RegExp) => tOps.find((o) => re.test(o.label));
const comparable: Record<string, { label: string; credits: bigint } | undefined> = {
  C1: (() => { const o = tFind(/forum\.comment create .*50 chars/); return o && { label: 'testnet forum.comment create B (50 chars, reply)', credits: BigInt(o.credits) }; })(),
  C2: (() => { const o = tFind(/forum\.comment create .*50 chars/); return o && { label: 'testnet forum.comment create B (50 chars, reply)', credits: BigInt(o.credits) }; })(),
  C3: (() => { const o = tFind(/forum\.comment create .*50 chars/); return o && { label: 'testnet forum.comment create B (50 chars, reply)', credits: BigInt(o.credits) }; })(),
  R1: (() => { const o = tFind(/forum\.reaction create .*community up-vote/); return o && { label: 'testnet forum.reaction create A', credits: BigInt(o.credits) }; })(),
  R2: (() => { const o = tFind(/forum\.reaction create .*second target/); return o && { label: 'testnet forum.reaction create B', credits: BigInt(o.credits) }; })(),
  R3: (() => { const o = tFind(/forum\.reaction create .*community up-vote/); return o && { label: 'testnet forum.reaction create A', credits: BigInt(o.credits) }; })(),
  R4: (() => { const o = tFind(/forum\.reaction create .*second target/); return o && { label: 'testnet forum.reaction create B', credits: BigInt(o.credits) }; })(),
  B1: (() => { const o = tFind(/badge\.mnBadge create .*RSA-2048 sig 256/); return o && { label: 'testnet badge.mnBadge create A (sig 256 B)', credits: BigInt(o.credits) }; })(),
  B2: (() => { const o = tFind(/badge\.mnBadge create .*RSA-2048 sig 256/); return o && { label: 'testnet badge.mnBadge create A (sig 256 B)', credits: BigInt(o.credits) }; })(),
  B3: (() => { const o = tFind(/badge\.mnBadge create .*sig 384/); return o && { label: 'testnet badge.mnBadge create B (sig 384 B)', credits: BigInt(o.credits) }; })(),
};
const replaceCmp = (() => { const o = tFind(/forum\.reaction replace/); return o && { label: 'testnet forum.reaction replace (flip)', credits: BigInt(o.credits) }; })();
const deleteCmp = (() => { const o = tFind(/forum\.reaction delete/); return o && { label: 'testnet forum.reaction delete B', credits: BigInt(o.credits) }; })();
const costRows = C.ops.map((o: any) => {
  const cmp = o.op === 'create' ? comparable[o.key] : o.op === 'replace' ? replaceCmp : o.op === 'delete' ? deleteCmp : undefined;
  const c = BigInt(o.credits);
  return { op: o.label, credits: o.credits, dash: o.dash, ms: o.ms, ...(cmp ? { testnetComparable: cmp.label, testnetCredits: cmp.credits.toString(), testnetDash: dash(cmp.credits), deltaCredits: (c - cmp.credits).toString(), deltaPct: Number(((Number(c - cmp.credits) / Number(cmp.credits)) * 100).toFixed(1)) } : {}) };
});
const idA = who('main'), idB = who('second');
const testnetIdentity3 = '106,495,300 credits (0.00106495 DASH, testnet u3)';
const totalBurned = burnedCredits();
const failedAsserts = rows.filter((r) => r.kind !== 'observe' && !r.ok);
saveResult('mainnet-write-check.json', {
  at: new Date().toISOString(), network: `mainnet (protocol ${PV})`,
  contract: { name: 'pv13check', id: CID, owner: M, types: Object.keys(schemas), registration: C.contract },
  identities: { main: M, second: S },
  documents: Object.fromEntries(Object.entries<any>(C.docs).map(([k, d]) => [k, { type: d.type, owner: d.owner, id: d.id, deleted: !!d.deleted, createdAt: d.createdAt }])),
  fixtures: { G1: F.G1, G2: F.G2, T1: F.T1, T2: F.T2, T3: F.T3, epoch: EPOCH, issuerId: ISSUER },
  uniqueIndexProbe: C.uniqueProbe,
  failures: C.failures,
  costs: { rows: costRows, identityCreate3KeysMainnet: st.items.map((it: any) => ({ name: it.name, credits: it.createFeeCredits, dash: dash(BigInt(it.createFeeCredits)) })), identityCreate3KeysTestnet: testnetIdentity3, contractRegistration: { ...C.contract, testnetFormulaNote: 'testnet 3-type/5-index equivalent = 0.1 + 3*0.02 + 5*0.01 = 0.21 DASH + storage' } },
  budget: { limitDash: '0.30000000', l1FeeDuffs: st.ledger.l1FeeDuffs, burnedCredits: totalBurned.toString(), burnedDash: dash(totalBurned), lockedDash: dash(st.items.reduce((a: bigint, it: any) => a + BigInt(it.lockedCredits), 0n)), balancesAfterCredits: finalBal, balancesAfterDash: Object.fromEntries(Object.entries(finalBal).map(([k, v]) => [k, dash(BigInt(v))])) },
  queries: rows,
  byteArrayEncodings: C.byteArrayEncodings,
  summary: { asserted: rows.filter((r) => r.kind !== 'observe').length, assertedOk: rows.filter((r) => r.kind !== 'observe' && r.ok).length, observed: rows.filter((r) => r.kind === 'observe').length },
});
console.log(`\nasserted queries: ${rows.filter((r) => r.kind !== 'observe' && r.ok).length}/${rows.filter((r) => r.kind !== 'observe').length} ok; observed ${rows.filter((r) => r.kind === 'observe').length}`);
for (const f of failedAsserts) console.log(`  FAIL ${f.id}: ${f.verdict}`);
console.log(`burned ${dash(totalBurned)} DASH; balances main ${dash(BigInt(finalBal.main))} second ${dash(BigInt(finalBal.second))}`);
process.exit(failedAsserts.length || C.failures.length ? 1 : 0);
