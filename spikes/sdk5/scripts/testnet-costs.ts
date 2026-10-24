// Stage 2 of the testnet write spike: register the four v1 contracts and exercise every document
// type, recording the credits each operation costs (identity balance before/after) next to the
// SDK's offline estimate (documentCreateCost at platform version 13 and 14).
//
//   npm run testnet:costs      (needs `npm run testnet:identity` first; resumable)
//
// Testnet runs protocol 14, so absolute fees are indicative of PV13, not exact. Registration fees
// (0.1 + 0.02/type + 0.01/index DASH) are identical in the PV13 and PV14 fee schedules.
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractsDir, dash, errText, plain, saveResult, sleep } from './lib.ts';
import { readState, writeState, wifOf } from './chain.ts';

const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.testnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();

const st: any = readState(null);
if (!st?.items?.every((i: any) => i.state === 'done')) throw new Error('run testnet:identity first');
const who = (n: string) => st.items.find((i: any) => i.name === n);
st.costs ??= { contracts: {}, docs: {}, ops: [], failures: [] };
const C = st.costs;
const save = () => writeState(st);

// ---------- small helpers ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const idBytes = (s: string): Uint8Array => {
  let v = 0n; for (const c of s) v = v * 58n + BigInt(B58.indexOf(c));
  const out: number[] = []; while (v > 0n) { out.unshift(Number(v & 255n)); v >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
};
const rb = (n: number) => Uint8Array.from(randomBytes(n));
const zeros = (n: number) => new Uint8Array(n);
const now = () => BigInt(Date.now());
const nowS = () => Math.floor(Date.now() / 1000);
const ser = (v: any): any => (typeof v === 'bigint' ? { $big: v.toString() } : v instanceof Uint8Array ? { $hex: Buffer.from(v).toString('hex') } : Array.isArray(v) ? v.map(ser) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)])) : v);
const de = (v: any): any => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v && typeof v === 'object' && '$hex' in v ? Uint8Array.from(Buffer.from(v.$hex, 'hex')) : Array.isArray(v) ? v.map(de) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, de(x)])) : v);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const identities: Record<string, any> = {};
const signers: Record<string, any> = {};
for (const name of ['owner', 'u3', 'u6']) {
  const it = who(name);
  identities[name] = await sdk.identities.fetch(it.identityId);
  const s = new w.IdentitySigner();
  for (const k of it.keys) s.addKeyFromWif(wifOf(k.hex));
  signers[name] = s;
}
const keyOf = (name: string, id: number) => identities[name].getPublicKeyById(id);

// ---------- measurement ----------
// Balance reads come from a random DAPI node per call and a node can lag a block behind, which made
// round-1 deltas land on the wrong operation (see FINDINGS). Round 2 therefore:
//  - uses the previous operation's settled "after" as the next "before";
//  - after an op, polls until the balance differs from "before" AND two consecutive reads agree;
//  - retries a broadcast that a lagging node rejects as "not found" (40101).
if (!st.costsRound1) {
  st.costsRound1 = { ops: C.ops, failures: C.failures, docs: C.docs, note: 'unreliable balance reads (stale nodes); superseded by round 2' };
  C.ops = []; C.failures = []; C.docs = {};
  save();
}
const lastBal: Record<string, bigint> = {};
const readBal = async (name: string): Promise<bigint> => BigInt(await sdk.identities.balance(who(name).identityId));
async function stableBalance(name: string): Promise<bigint> {
  let prev: bigint | undefined;
  for (let i = 0; i < 20; i++) {
    const b = await readBal(name);
    if (prev === b) return b;
    prev = b; await sleep(2000);
  }
  return prev!;
}
async function balanceAfter(name: string, before: bigint): Promise<{ after: bigint; unchanged: boolean }> {
  let candidate: bigint | undefined;
  for (let i = 0; i < 30; i++) {
    const b = await readBal(name);
    if (b !== before) { if (candidate === b) return { after: b, unchanged: false }; candidate = b; await sleep(1200); continue; }
    candidate = undefined; await sleep(1500);
  }
  return { after: before, unchanged: true };
}
async function measured(label: string, meta: Record<string, unknown>, payer: string, fn: () => Promise<unknown>, estimate?: () => any) {
  if (C.ops.some((o: any) => o.label === label)) { console.log(`skip ${label} (done)`); return true; }
  const before = (lastBal[payer] ??= await stableBalance(payer));
  const t0 = performance.now();
  let retries = 0;
  for (;;) {
    try { await fn(); break; } catch (e) {
      const msg = errText(e);
      if (retries < 4 && /not found|40101|nonce/i.test(msg)) { retries++; console.log(`  … ${label}: ${msg.slice(0, 80)}; retry ${retries}/4 in 4s (lagging node)`); await sleep(4000); continue; }
      console.log(`FAIL ${label}: ${msg.slice(0, 300)}`);
      C.failures.push({ label, error: msg.slice(0, 600) }); save();
      return false;
    }
  }
  const ms = Math.round(performance.now() - t0);
  const { after, unchanged } = await balanceAfter(payer, before);
  lastBal[payer] = after;
  const credits = before - after;
  let est: any;
  try { est = estimate?.(); } catch (e) { est = { error: errText(e) }; }
  const row = { label, ...meta, payer, credits: credits.toString(), dash: dash(credits), ms, retries, ...(unchanged ? { unchanged: true } : {}), estimate: est };
  C.ops.push(row); save();
  console.log(`ok   ${label.padEnd(58)} ${String(credits).padStart(12)} credits (${dash(credits)} DASH)  ${ms} ms${unchanged ? '  UNCHANGED?' : ''}${est?.pv13 ? `  est13 ${est.pv13.new}/${est.pv13.known}  est14 ${est.pv14.new}` : ''}`);
  return true;
}
const balanceOf = readBal;

await measured('identity.creditTransfer owner->u6 0.02 DASH', { contract: '-', type: 'identity', op: 'creditTransfer' }, 'owner', async () => {
  await sdk.identities.creditTransfer({ identity: identities.owner, recipientId: who('u6').identityId, amount: 2_000_000_000n, signer: signers.owner, signingKey: keyOf('owner', 3) });
});
{
  const row = C.ops.find((o: any) => o.label.startsWith('identity.creditTransfer'));
  if (row && !row.netFeeCredits) { row.netFeeCredits = (BigInt(row.credits) - 2_000_000_000n).toString(); row.netFeeDash = dash(BigInt(row.netFeeCredits)); save(); console.log(`  credit transfer net fee ${row.netFeeCredits} credits (${row.netFeeDash} DASH)`); }
}

// ---------- 1. contracts ----------
const schemas: Record<string, any> = {};
for (const n of ['gov', 'forum', 'badge', 'mod']) schemas[n] = JSON.parse(readFileSync(join(contractsDir, `${n}.json`), 'utf8'));
const registrationEstimate = (s: any) => {
  let c = 10_000_000_000n;
  for (const t of Object.values<any>(s)) { c += 2_000_000_000n; for (const ix of t.indices ?? []) c += 1_000_000_000n; }
  return c;
};
const contracts: Record<string, any> = {};
for (const n of ['gov', 'forum', 'badge', 'mod']) {
  const ownerId = who('owner').identityId;
  if (C.contracts[n]) { contracts[n] = await sdk.contracts.fetch(C.contracts[n].id); console.log(`contract ${n} already registered: ${C.contracts[n].id}`); continue; }
  const before = await stableBalance('owner');
  const nonce = (BigInt((await sdk.identities.nonce(ownerId)) ?? 0n)) + 1n;
  const dc = new w.DataContract({ ownerId, identityNonce: nonce, schemas: schemas[n], fullValidation: true, platformVersion: sdk.version() });
  const t0 = performance.now();
  let published: any;
  try {
    published = await sdk.contracts.publish({ dataContract: dc, identityKey: keyOf('owner', 1), signer: signers.owner });
  } catch (e) { console.log(`FAIL publish ${n}: ${errText(e).slice(0, 400)}`); C.failures.push({ label: `publish ${n}`, error: errText(e).slice(0, 600) }); save(); throw e; }
  const ms = Math.round(performance.now() - t0);
  const id = published.id.toString();
  const { after } = await balanceAfter('owner', before);
  lastBal.owner = after;
  let back: any; for (let i = 0; i < 10 && !back; i++) { back = await sdk.contracts.fetch(id); if (!back) await sleep(2000); }
  const same = back && JSON.stringify(back.toJSON(sdk.version()).documentSchemas) === JSON.stringify(dc.toJSON(sdk.version()).documentSchemas);
  const reg = registrationEstimate(schemas[n]);
  C.contracts[n] = { id, nonce: nonce.toString(), credits: (before - after).toString(), dash: dash(before - after), registrationFormulaCredits: reg.toString(), registrationFormulaDash: dash(reg), overheadCredits: (before - after - reg).toString(), readBackIdentical: !!same, ms, types: Object.keys(schemas[n]).length, indexes: Object.values<any>(schemas[n]).reduce((a, t) => a + (t.indices?.length ?? 0), 0) };
  save();
  contracts[n] = back ?? published;
  console.log(`registered ${n}: ${id}  cost ${dash(before - after)} DASH (formula ${dash(reg)} + ${dash(before - after - reg)} storage/processing)  readBack ${same ? 'identical' : 'DIFFERENT'}  ${ms} ms`);
}
saveResult('testnet-contracts.json', { at: new Date().toISOString(), network: 'testnet (protocol 14)', owner: who('owner').identityId, contracts: C.contracts });

// ---------- 2. documents ----------
const cid = (n: string) => C.contracts[n].id as string;
const estimateFor = (cname: string, type: string, props: Record<string, any>) => () => {
  const def = schemas[cname][type];
  const fields: Record<string, { present?: boolean; length?: number }> = {};
  for (const p of Object.keys(def.properties)) {
    const v = props[p];
    fields[p] = v === undefined ? { present: false } : typeof v === 'string' ? { present: true, length: v.length } : v instanceof Uint8Array ? { present: true, length: v.length } : { present: true };
  }
  const out: any = {};
  for (const [k, ver] of [['pv13', 13], ['pv14', 14]] as const) {
    const c = w.documentCreateCost(contracts[cname], type, { fields }, ver);
    out[k] = { new: String(c.totalCredits.newValues), known: String(c.totalCredits.knownValues), bytes: c.documentBytes, refundSameEpoch: String(c.refund.sameEpoch.newValues) };
  }
  return out;
};

function build(cname: string, type: string, owner: string, props: Record<string, any>, extra: Record<string, any> = {}) {
  const obj: any = { $formatVersion: '0', $id: new Uint8Array(32), $ownerId: idBytes(who(owner).identityId), $dataContractId: idBytes(cid(cname)), $type: type, $revision: 1n, $entropy: rb(32), ...extra, ...props };
  return w.Document.fromObject(obj, w.PlatformVersion.latest());
}
const coreHeight = async (): Promise<number> => {
  const r: any = await sdk.contracts.fetchWithProof(cid('gov'));
  return Number(r.metadata.coreChainLockedHeight);
};
const stamps = (cname: string, type: string, withCoreHeight = false) => {
  const req: string[] = schemas[cname][type].required ?? [];
  const e: Record<string, any> = {};
  const t = now();
  if (req.includes('$createdAt')) e.$createdAt = t;
  if (req.includes('$updatedAt')) e.$updatedAt = t;
  return e;
};

async function create(cname: string, type: string, owner: string, keyId: number, key: string, props: Record<string, any>, note = '') {
  const label = `${cname}.${type} create (${key})${note ? ' ' + note : ''}`;
  const extra: Record<string, any> = stamps(cname, type);
  if ((schemas[cname][type].required ?? []).includes('$createdAtCoreBlockHeight')) extra.$createdAtCoreBlockHeight = await coreHeight();
  const doc = build(cname, type, owner, props, extra);
  let created: any;
  const ok = await measured(label, { contract: cname, type, op: 'create', note }, owner, async () => {
    created = await sdk.documents.create({ document: doc, identityKey: keyOf(owner, keyId), signer: signers[owner] });
  }, estimateFor(cname, type, props));
  if (ok && created) {
    C.docs[key] = { contract: cname, type, owner, keyId, id: created.id.toString(), props: ser(props), revision: '1' };
    save();
  }
  return ok;
}
async function replace(key: string, patch: Record<string, any>, note = '') {
  const d = C.docs[key]; if (!d) { console.log(`skip replace ${key}: no doc`); return; }
  const props = { ...de(d.props), ...patch };
  const rev = BigInt(d.revision) + 1n;
  const doc = w.Document.fromObject({ $formatVersion: '0', $id: idBytes(d.id), $ownerId: idBytes(who(d.owner).identityId), $dataContractId: idBytes(cid(d.contract)), $type: d.type, $revision: rev, $updatedAt: now(), ...props }, w.PlatformVersion.latest());
  const ok = await measured(`${d.contract}.${d.type} replace (${key})${note ? ' ' + note : ''}`, { contract: d.contract, type: d.type, op: 'replace', note }, d.owner, async () => {
    await sdk.documents.replace({ document: doc, identityKey: keyOf(d.owner, d.keyId), signer: signers[d.owner] });
  });
  if (ok) { d.props = ser(props); d.revision = rev.toString(); save(); }
}
async function del(key: string, note = '') {
  const d = C.docs[key]; if (!d) { console.log(`skip delete ${key}: no doc`); return; }
  const ok = await measured(`${d.contract}.${d.type} delete (${key})${note ? ' ' + note : ''}`, { contract: d.contract, type: d.type, op: 'delete', note }, d.owner, async () => {
    await sdk.documents.delete({ document: { id: d.id, ownerId: who(d.owner).identityId, dataContractId: cid(d.contract), documentTypeName: d.type }, identityKey: keyOf(d.owner, d.keyId), signer: signers[d.owner] });
  });
  if (ok) { delete C.docs[key]; save(); }
}

// realistic payloads (round 2: all-new random keys; round-1 documents stay on chain)
const owner = who('owner').identityId, u3 = who('u3').identityId, u6 = who('u6').identityId;
const govHash = rb(32), govHash2 = rb(32);
const propJson = JSON.stringify({ end_epoch: nowS() + 7776000, name: 'govhub-spike-r2-1', payment_address: 'yMbJNiVrPFaPJjCu4YjtiUtdb4zBofpNwo', payment_amount: 123.45, start_epoch: nowS(), type: 1, url: `https://gov.dashhq.org/p/${owner}/govhub-spike-r2-1` });
const dataHex = Buffer.from(propJson).toString('hex');
console.log(`proposal data: ${propJson.length} bytes -> ${dataHex.length} hex chars`);
const mkProposal = (name: string, gh: Uint8Array) => ({ govHash: gh, parentHash: zeros(32), revision: 1n, time: BigInt(nowS()), dataHex, name, url: `https://gov.dashhq.org/p/${owner}/${name}`, paymentAddress: 'yMbJNiVrPFaPJjCu4YjtiUtdb4zBofpNwo', paymentAmount: 12_345_000_000n, startEpoch: BigInt(nowS()), endEpoch: BigInt(nowS() + 7_776_000), collateralTxid: rb(32), collateralHeight: 1_578_000n });
const mkTally = (gh: Uint8Array, y = 1200n) => ({ govHash: gh, asOfHeight: 1_578_100n, yesWeighted: y, noWeighted: 150n, abstainWeighted: 20n, yesCount: y - 100n, noCount: 140n, abstainCount: 20n, voteSetHash: rb(32), rank: 7n, inNextBudget: true, margin: 420n });
const mkCycle = (h: bigint) => ({ superblockHeight: h, budget: 6_000_000_000_000n, allocated: 4_500_000_000_000n, votingDeadlineHeight: h - 1662n, estTime: BigInt(nowS() + 2_000_000), validWeighted: 4800n, paid: 0n });
const bodyOf = (n: number) => 'x'.repeat(n);
const G = (k: string) => `R2.${k}`;

// ---- gov (owner, HIGH key 2). First create per type = "new index values" case; second = known values. ----
await create('gov', 'proposal', 'owner', 2, G('gov.proposal.A'), mkProposal('govhub-spike-r2-1', govHash));
await create('gov', 'proposal', 'owner', 2, G('gov.proposal.B'), mkProposal('govhub-spike-r2-2', govHash2));
await create('gov', 'tally', 'owner', 2, G('gov.tally.A'), mkTally(govHash));
await replace(G('gov.tally.A'), { asOfHeight: 1_578_200n, yesWeighted: 1300n, yesCount: 1200n, margin: 520n }, '(tally refresh)');
await create('gov', 'tally', 'owner', 2, G('gov.tally.B'), mkTally(govHash2, 900n));
await create('gov', 'cycle', 'owner', 2, G('gov.cycle.A'), mkCycle(2_570_000n));
await replace(G('gov.cycle.A'), { allocated: 4_800_000_000_000n, validWeighted: 4810n });
await create('gov', 'claimAttestation', 'owner', 2, G('gov.claimAttestation.A'), { govHash, identityId: idBytes(u3), method: 4n, note: 'hosting-team attestation (P2SH payout)' });

// ---- forum: u3 for everything except the one-per-owner types (profile, blockSubs, settings) which u3 already holds from round 1 -> u6 ----
await create('forum', 'profile', 'u6', 2, G('forum.profile.A'), { displayName: 'spike user 6', about: 'govhub phase-0 spike profile', avatarUrl: 'https://example.org/avatar.png' });
await replace(G('forum.profile.A'), { about: 'govhub phase-0 spike profile (edited)' });
await create('forum', 'comment', 'u3', 2, G('forum.comment.A'), { govHash, body: bodyOf(280), fmt: 1n }, '280 chars');
await create('forum', 'comment', 'u3', 2, G('forum.comment.B'), { govHash, body: bodyOf(50), fmt: 0n, parentId: idBytes(C.docs[G('forum.comment.A')]?.id ?? owner) }, '50 chars, reply');
await create('forum', 'comment', 'u3', 2, G('forum.comment.C'), { govHash, body: bodyOf(1000), fmt: 1n }, '1000 chars');
await create('forum', 'comment', 'u3', 2, G('forum.comment.D'), { govHash, body: bodyOf(5000), fmt: 1n }, '5000 chars (max)');
await create('forum', 'reaction', 'u3', 2, G('forum.reaction.A'), { target: govHash, kind: 2n, value: 1n }, 'community up-vote on proposal');
await replace(G('forum.reaction.A'), { value: -1n }, 'flip to down');
await create('forum', 'reaction', 'u3', 2, G('forum.reaction.B'), { target: govHash2, kind: 2n, value: 1n }, 'second target');
await create('forum', 'claim', 'u3', 2, G('forum.claim.A'), { govHash, method: 2n, sig: rb(65) });
await create('forum', 'proposalPost', 'u3', 2, G('forum.proposalPost.A'), { govHash, title: 'Spike proposal: build gov.dashhq.org', b0: rb(1500), links: 'https://gov.dashhq.org https://github.com/PastaPastaPasta/govhub' }, 'b0 1500 B');
await replace(G('forum.proposalPost.A'), { b1: rb(2500) }, 'add b1 2500 B');
await create('forum', 'proposalPost', 'u3', 2, G('forum.proposalPost.MAX'), { govHash: govHash2, title: 'x'.repeat(200), b0: rb(5120), b1: rb(5120), b2: rb(5120), links: 'x'.repeat(1000) }, 'MAX: b0+b1+b2 = 15360 B + title/links');
await create('forum', 'proposalDraft', 'u3', 2, G('forum.proposalDraft.A'), { time: BigInt(nowS()), revision: 1n, dataHex, govHash, stage: 1n });
await replace(G('forum.proposalDraft.A'), { stage: 2n, collateralTxid: rb(32) }, 'stage 1 -> 2, + collateralTxid');
await create('forum', 'block', 'u3', 2, G('forum.block.A'), { target: rb(32), kind: 1n, reason: 'spam' });
await create('forum', 'blockSubs', 'u6', 2, G('forum.blockSubs.A'), { lists: rb(96), defaultOff: false }, '3 lists');
await replace(G('forum.blockSubs.A'), { lists: rb(160), defaultOff: true }, '5 lists');
await create('forum', 'settings', 'u6', 2, G('forum.settings.A'), { endpoints: rb(600) }, '600 B deflated JSON');
await replace(G('forum.settings.A'), { endpoints: rb(900) }, '900 B');
await create('forum', 'vault', 'u3', 2, G('forum.vault.A'), { credentialId: rb(32), recipientKey: rb(32), version: 1n, authKeyId: 2n, enc: rb(32), sealed: rb(96) });
await replace(G('forum.vault.A'), { sealed: rb(112), version: 2n });

// ---- badge ----
const rsa = (bits: number) => { const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits }); return publicKey.export({ type: 'spki', format: 'der' }) as Buffer; };
const spki2048 = Uint8Array.from(rsa(2048)), spki4096 = Uint8Array.from(rsa(4096));
const sha = (b: Uint8Array) => Uint8Array.from(createHash('sha256').update(b).digest());
const VARIANT = 'RSABSSA-SHA384-PSS-Randomized';
await create('badge', 'issuerKey', 'owner', 1, G('badge.issuerKey.A'), { epoch: 200n, spki: spki2048, keyId: sha(spki2048), variant: VARIANT }, `RSA-2048 SPKI ${spki2048.length} B, CRITICAL key`);
await create('badge', 'issuerKey', 'owner', 1, G('badge.issuerKey.B'), { epoch: 201n, spki: spki4096, keyId: sha(spki4096), variant: VARIANT }, `RSA-4096 SPKI ${spki4096.length} B`);
await create('badge', 'issuerRevocation', 'owner', 1, G('badge.issuerRevocation.A'), { epoch: 200n, keyId: sha(spki2048), effectiveCoreHeight: 1_578_300n }, 'CRITICAL key');
await create('badge', 'issuerReport', 'owner', 2, G('badge.issuerReport.A'), { epoch: 200n, tokensIssued: 123n });
await create('badge', 'mnBadge', 'u3', 2, G('badge.mnBadge.A'), { issuerId: idBytes(owner), epoch: 200n, keyId: sha(spki2048), msgPrefix: rb(32), sig: rb(256) }, 'RSA-2048 sig 256 B');
await create('badge', 'mnBadge', 'u6', 2, G('badge.mnBadge.B'), { issuerId: idBytes(owner), epoch: 201n, keyId: sha(spki4096), msgPrefix: rb(32), sig: rb(384) }, 'sig 384 B (u6)');

// ---- mod (owner) ----
await create('mod', 'block', 'owner', 2, G('mod.block.A'), { target: rb(32), kind: 1n, reason: 'spam' });
await create('mod', 'block', 'owner', 2, G('mod.block.B'), { target: rb(32), kind: 1n });

// ---- deletes (second doc of each deletable type; the first stays on chain for the query tests) ----
await del(G('gov.proposal.B'));
await del(G('gov.tally.B'));
await del(G('forum.comment.B'));
await del(G('forum.comment.C'));
await del(G('forum.comment.D'));
await del(G('forum.reaction.B'));
await del(G('forum.proposalPost.MAX'));
await del(G('mod.block.B'));

// ---------- summary ----------
// contracts whose registration delta was read from a lagging node (round 1) are reported as unmeasured
for (const c of Object.values<any>(C.contracts)) if (BigInt(c.overheadCredits) < 0n || BigInt(c.overheadCredits) > 500_000_000n) { c.measurementSuspect = true; c.note = 'balance read came from a lagging node; use registrationFormulaCredits + ~0.002-0.003 DASH storage'; }
const final: Record<string, string> = {};
for (const n of ['owner', 'u3', 'u6']) final[n] = (await balanceOf(n)).toString();
saveResult('testnet-costs.json', { at: new Date().toISOString(), network: 'testnet (protocol 14): fees indicative of PV13, not exact', creditsPerDash: '100000000000', contracts: C.contracts, ops: C.ops, failures: C.failures, balancesAfter: final, round1: { note: st.costsRound1.note, failures: st.costsRound1.failures, ops: st.costsRound1.ops }, documentsLeftOnChain: Object.fromEntries(Object.entries<any>({ ...(st.costsRound1.docs ?? {}), ...C.docs }).map(([k, d]) => [k, { contract: d.contract, type: d.type, id: d.id, owner: who(d.owner).identityId }])) });
console.log(`\nfailures: ${C.failures.length}`);
for (const f of C.failures) console.log(`  ${f.label}: ${f.error.slice(0, 200)}`);
console.log(`balances after: ${JSON.stringify(Object.fromEntries(Object.entries(final).map(([k, v]) => [k, dash(BigInt(v))])))}`);
process.exit(C.failures.length ? 1 : 0);
