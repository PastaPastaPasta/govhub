// Re-registers the `badge` contract after the mnBadge index was changed from
// unique [$ownerId, issuerId, epoch] to unique [issuerId, epoch, $ownerId] (Drive only allows an `in`
// clause on the LAST or second-to-last index property, so "which of these 100 authors hold a badge
// from issuer I in epoch E" needs $ownerId last). Measures registration with the settled-balance
// method, then creates two mnBadge documents in the new contract.
//
//   npx vite-node scripts/testnet-badge-r2.ts
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractsDir, dash, errText, resultsDir, saveResult, sleep } from './lib.ts';
import { readState, wifOf, writeState } from './chain.ts';

process.on('unhandledRejection', (e) => { console.error('unhandled:', errText(e)); process.exit(1); });
const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.testnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const st: any = readState(null);
const who = (n: string) => st.items.find((i: any) => i.name === n);
const C = st.costs;
const schemas = JSON.parse(readFileSync(join(contractsDir, 'badge.json'), 'utf8'));
const schemaHash = createHash('sha256').update(JSON.stringify(schemas)).digest('hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const idBytes = (s: string): Uint8Array => { let v = 0n; for (const c of s) v = v * 58n + BigInt(B58.indexOf(c)); const o: number[] = []; while (v > 0n) { o.unshift(Number(v & 255n)); v >>= 8n; } for (const c of s) { if (c !== '1') break; o.unshift(0); } return Uint8Array.from(o); };
const rb = (n: number) => Uint8Array.from(randomBytes(n));

const ids: Record<string, any> = {}, signers: Record<string, any> = {};
for (const n of ['owner', 'u3', 'u6']) {
  ids[n] = await sdk.identities.fetch(who(n).identityId);
  const s = new w.IdentitySigner(); for (const k of who(n).keys) s.addKeyFromWif(wifOf(k.hex)); signers[n] = s;
}
const readBal = async (n: string) => BigInt(await sdk.identities.balance(who(n).identityId));
const stable = async (n: string) => { let p: bigint | undefined; for (let i = 0; i < 20; i++) { const b = await readBal(n); if (b === p) return b; p = b; await sleep(2000); } return p!; };
const settle = async (n: string, before: bigint) => { let c: bigint | undefined; for (let i = 0; i < 30; i++) { const b = await readBal(n); if (b !== before) { if (c === b) return b; c = b; await sleep(1200); continue; } c = undefined; await sleep(1500); } throw new Error('balance never changed after the transition'); };

if (!C.contracts.badge_r1) {
  C.contracts.badge_r1 = { ...C.contracts.badge, superseded: 'mnBadge index changed to [issuerId, epoch, $ownerId]; registration cost read was stale (lagging node)' };
  delete C.contracts.badge;
  writeState(st);
}
if (!C.contracts.badge) {
  const ownerId = who('owner').identityId;
  const before = await stable('owner');
  const nonce = BigInt((await sdk.identities.nonce(ownerId)) ?? 0n) + 1n;
  const dc = new w.DataContract({ ownerId, identityNonce: nonce, schemas, fullValidation: true, platformVersion: sdk.version() });
  const t0 = performance.now();
  const pub = await sdk.contracts.publish({ dataContract: dc, identityKey: ids.owner.getPublicKeyById(1), signer: signers.owner });
  const ms = Math.round(performance.now() - t0);
  const after = await settle('owner', before);
  let reg = 10_000_000_000n; for (const t of Object.values<any>(schemas)) { reg += 2_000_000_000n; for (const _ of t.indices ?? []) reg += 1_000_000_000n; }
  let back: any; for (let i = 0; i < 10 && !back; i++) { back = await sdk.contracts.fetch(pub.id.toString()); if (!back) await sleep(2000); }
  const same = back && JSON.stringify(back.toJSON(sdk.version()).documentSchemas) === JSON.stringify(dc.toJSON(sdk.version()).documentSchemas);
  C.contracts.badge = { id: pub.id.toString(), nonce: nonce.toString(), credits: (before - after).toString(), dash: dash(before - after), registrationFormulaCredits: reg.toString(), registrationFormulaDash: dash(reg), overheadCredits: (before - after - reg).toString(), readBackIdentical: !!same, ms, types: Object.keys(schemas).length, indexes: Object.values<any>(schemas).reduce((a, t) => a + (t.indices?.length ?? 0), 0), schemaSha256: schemaHash };
  writeState(st);
  console.log(`registered badge: ${C.contracts.badge.id} cost ${dash(before - after)} DASH (formula ${dash(reg)} + ${dash(before - after - reg)}), read-back ${same ? 'identical' : 'DIFFERENT'}`);
}
const contract = await sdk.contracts.fetch(C.contracts.badge.id);

// mnBadge documents in the new contract (u3 and u6), measured per payer
const rsa2048 = Uint8Array.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
const keyId = Uint8Array.from(createHash('sha256').update(rsa2048).digest());
const issuerId = who('owner').identityId;
const coreHeight = Number(((await sdk.contracts.fetchWithProof(C.contracts.badge.id)) as any).metadata.coreChainLockedHeight);
const out: any[] = C.badgeR2Ops ?? [];
if (!C.badgeR2Ops) for (const [payer, epoch, sigLen] of [['u3', 300n, 256], ['u6', 300n, 384], ['u3', 301n, 256]] as const) {
  const before = await stable(payer);
  const doc = w.Document.fromObject({ $formatVersion: '0', $id: new Uint8Array(32), $ownerId: idBytes(who(payer).identityId), $dataContractId: idBytes(C.contracts.badge.id), $type: 'mnBadge', $revision: 1n, $entropy: rb(32), $createdAtCoreBlockHeight: coreHeight, issuerId: idBytes(issuerId), epoch, keyId, msgPrefix: rb(32), sig: rb(sigLen) }, w.PlatformVersion.latest());
  try {
    await sdk.documents.create({ document: doc, identityKey: ids[payer].getPublicKeyById(2), signer: signers[payer] });
  } catch (e) { console.log(`FAIL mnBadge ${payer}/${epoch}: ${errText(e).slice(0, 300)}`); out.push({ payer, epoch: String(epoch), error: errText(e).slice(0, 300) }); continue; }
  const after = await settle(payer, before);
  out.push({ payer, epoch: String(epoch), sigBytes: sigLen, credits: (before - after).toString(), dash: dash(before - after) });
  console.log(`ok mnBadge ${payer} epoch ${epoch} sig ${sigLen} B: ${before - after} credits (${dash(before - after)} DASH)`);
}
C.badgeR2Ops = out; writeState(st);

// issuer documents (owner): the same shapes the cost round measured on the first badge contract
const issuerOps: any[] = C.badgeR2IssuerOps ?? [];
if (!C.badgeR2IssuerOps) {
  const plan: [string, number, Record<string, unknown>][] = [
    ['issuerKey', 1, { epoch: 300n, spki: rsa2048, keyId, variant: 'RSABSSA-SHA384-PSS-Randomized' }],
    ['issuerRevocation', 1, { epoch: 300n, keyId, effectiveCoreHeight: 1_578_400n }],
    ['issuerReport', 2, { epoch: 300n, tokensIssued: 2n }],
  ];
  for (const [type, keyIdx, props] of plan) {
    const before = await stable('owner');
    const doc = w.Document.fromObject({ $formatVersion: '0', $id: new Uint8Array(32), $ownerId: idBytes(issuerId), $dataContractId: idBytes(C.contracts.badge.id), $type: type, $revision: 1n, $entropy: rb(32), $createdAtCoreBlockHeight: coreHeight, ...props }, w.PlatformVersion.latest());
    try { await sdk.documents.create({ document: doc, identityKey: ids.owner.getPublicKeyById(keyIdx), signer: signers.owner }); } catch (e) { console.log(`FAIL ${type}: ${errText(e).slice(0, 300)}`); issuerOps.push({ type, error: errText(e).slice(0, 300) }); continue; }
    const after = await settle('owner', before);
    issuerOps.push({ type, credits: (before - after).toString(), dash: dash(before - after) });
    console.log(`ok ${type}: ${before - after} credits (${dash(before - after)} DASH)`);
  }
  C.badgeR2IssuerOps = issuerOps; writeState(st);
}
saveResult('testnet-badge-r2.json', { at: new Date().toISOString(), contract: C.contracts.badge, superseded: C.contracts.badge_r1, mnBadgeOps: out, issuerOps: C.badgeR2IssuerOps });
// refresh results/testnet-contracts.json for the query script
saveResult('testnet-contracts.json', { at: new Date().toISOString(), network: 'testnet (protocol 14)', owner: who('owner').identityId, contracts: C.contracts });
process.exit(0);
