// TESTNET, pre-mainnet cost pass: what the bridge pays per write before and after packing tallies and slimming `proposal`, and the
// contract updates that add `talliesSet` to the deployed testnet gov contracts. Every document is built by the bridge's own
// publisher code (proposalProps, tallyProps, tallySetProps) and written through its PlatformClient.
//
//   node scripts/testnet-cost-pass.ts register   rehearsal contract from packages/contracts-v1/gov.json (the MAINNET definition)
//   node scripts/testnet-cost-pass.ts measure    fees: proposal create (slim vs full), tally replace vs packed replace (6, 30, 161)
//   node scripts/testnet-cost-pass.ts update     DataContractUpdate: talliesSet (gov-testnet.json) onto the dev and testnet gov contracts
//
// Resumable: each step is skipped once recorded. Payers: the dev gov owner (~/.local/share/govhub-phase0/testnet/state.json, item
// "owner"; it owns the dev gov contract and the rehearsal contract) and the testnet bridge identity (~/.local/share/govhub-testnet/
// state.json; it owns the testnet gov contract). Keys are read at run time; nothing secret is printed or written.
// Results: scripts/results/testnet-cost-pass.json. Testnet runs protocol 14: fees approximate PV13, they do not match it exactly.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, type TallySetEntry } from '@govhub/verify';
import type { GovObjectRow } from '../src/archive/db.ts';
import { PlatformClient } from '../src/publish/platform.ts';
import { proposalProps, tallyProps, tallySetProps } from '../src/publish/publisher.ts';
import type { ComputedTally } from '../src/tally.ts';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '../../../packages/contracts-v1');
const resultsFile = join(here, 'results/testnet-cost-pass.json');
const R: any = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : { network: 'testnet', note: 'testnet runs protocol 14: fees approximate PV13, they do not match it exactly' };
const save = () => writeFileSync(resultsFile, JSON.stringify(R, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dash = (c: bigint) => (Number(c) / 1e11).toFixed(8);
const errText = (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));

const DEV_GOV = '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ';
const TESTNET_GOV = '5gMnJLDpcoMaQCQNqmHtBiSqCxRCmroXFAffPNdJ2NJC';

interface Key { keyId: number; purpose: string; securityLevel: string; hex: string }
interface Payer { name: string; identityId: string; keys: Key[] }
const phase0 = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase0/testnet/state.json'), 'utf8')) as { items: Payer[] };
const devOwner: Payer = { ...phase0.items.find((i) => i.name === 'owner')!, name: 'dev owner' };
const tb = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-testnet/state.json'), 'utf8')) as { identityId: string; keys: Key[] };
const testnetBridge: Payer = { name: 'testnet bridge', identityId: tb.identityId, keys: tb.keys };
const key = (p: Payer, level: 'critical' | 'high') => p.keys.find((k) => k.purpose === 'authentication' && k.securityLevel === level)!;

const w: any = await import('@dashevo/evo-sdk');
await w.ensureInitialized?.();
const sdk = w.EvoSDK.testnetTrusted({ settings: { timeoutMs: 60_000, retries: 2 } });
await sdk.connect();
const pv = (): number => sdk.version();
log(`testnet Platform protocol ${pv()}`);

const balance = async (id: string) => BigInt((await sdk.identities.balance(id)) ?? 0n);
/** A balance two consecutive reads agree on (reads hit random nodes, one may lag a block). */
async function stableBalance(id: string): Promise<bigint> {
  let last = await balance(id);
  for (let i = 0; i < 10; i++) {
    await sleep(1200);
    const b = await balance(id);
    if (b === last) return b;
    last = b;
  }
  return last;
}
/** After a write: poll until the balance moved off `before` and two reads agree. */
async function settled(id: string, before: bigint): Promise<bigint> {
  let last: bigint | undefined;
  for (let i = 0; i < 60; i++) {
    const b = await balance(id);
    if (b !== before) {
      if (b === last) return b;
      last = b;
    }
    await sleep(1500);
  }
  return last ?? before;
}

R.ops ??= [];
const lastBal = new Map<string, bigint>();
/** Runs a write once (by label), records its fee from the payer's settled balance. */
async function measured(label: string, payer: Payer, meta: Record<string, unknown>, fn: () => Promise<unknown>): Promise<boolean> {
  if (R.ops.some((o: any) => o.label === label)) {
    log(`skip ${label} (recorded)`);
    return true;
  }
  const before = lastBal.get(payer.identityId) ?? (await stableBalance(payer.identityId));
  const t0 = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      break;
    } catch (e) {
      const m = errText(e);
      if (attempt < 4 && /not found|40101|nonce|timeout|deadline/i.test(m)) {
        log(`  retry ${label}: ${m.slice(0, 100)}`);
        await sleep(4000 * attempt);
        continue;
      }
      log(`FAIL ${label}: ${m.slice(0, 300)}`);
      R.failures = [...(R.failures ?? []), { label, error: m.slice(0, 500) }];
      save();
      return false;
    }
  }
  const ms = Date.now() - t0;
  const after = await settled(payer.identityId, before);
  lastBal.set(payer.identityId, after);
  const credits = before - after;
  R.ops.push({ label, payer: payer.name, ...meta, credits: credits.toString(), dash: dash(credits), ms });
  save();
  log(`ok   ${label.padEnd(64)} ${String(credits).padStart(12)} credits  ${dash(credits)} DASH  ${ms} ms`);
  return true;
}

const client = async (contractId: string, p: Payer): Promise<PlatformClient> => {
  const c = new PlatformClient('testnet', contractId);
  const k = key(p, 'high');
  await c.loadIdentity({ identityId: p.identityId, keyId: k.keyId, privateKeyHex: k.hex });
  return c;
};
const critSigner = (p: Payer) => {
  const s = new w.IdentitySigner();
  s.addKey(w.PrivateKey.fromHex(key(p, 'critical').hex, 'testnet'));
  return s;
};

// ---- realistic content ----------------------------------------------------------------------------------------------------
const mainnetProposals = JSON.parse(readFileSync(join(here, '../../../packages/verify/test/fixtures/mainnet-proposals.json'), 'utf8')).proposals as Array<{ hash: string; collateralHash: string; creationTime: number; dataHex: string }>;
// the median-size real mainnet proposal data
const typical = [...mainnetProposals].sort((a, b) => a.dataHex.length - b.dataHex.length)[Math.floor(mainnetProposals.length / 2)]!;
const rhex = (n: number) => bytesToHex(Uint8Array.from(randomBytes(n)));
/** The archive row the bridge would publish for a new proposal with the typical data (a fresh random gov hash: the index is unique). */
const proposalRow = (): GovObjectRow => ({ hash: rhex(32), parent_hash: '0'.repeat(64), revision: 1, time: typical.creationTime, collateral_hash: typical.collateralHash, data_hex: typical.dataHex, collateral_height: 2_550_000 }) as GovObjectRow;
const tallyOf = (i: number): ComputedTally =>
  ({ govHash: rhex(32), asOfHeight: 1_579_000, weighted: { yes: 1500 + i * 13, no: 120 + i, abstain: 9 }, unweighted: { yes: 1100 + i * 9, no: 90 + i, abstain: 7 }, voteSetHash: rhex(32), rank: i + 1, inNextBudget: i < 20, margin: 1168 - i * 40 }) as unknown as ComputedTally;
const entryOf = (t: ComputedTally): TallySetEntry => ({ govHash: t.govHash, yesWeighted: t.weighted.yes, noWeighted: t.weighted.no, abstainWeighted: t.weighted.abstain, yesCount: t.unweighted.yes, noCount: t.unweighted.no, abstainCount: t.unweighted.abstain, voteSetHash: t.voteSetHash, rank: t.rank, inNextBudget: t.inNextBudget, margin: t.margin });

const cmd = process.argv[2];

// ---- register: the mainnet gov definition, on testnet ------------------------------------------------------------------------
if (cmd === 'register') {
  const schemas = JSON.parse(readFileSync(join(contractsDir, 'gov.json'), 'utf8'));
  if (R.rehearsal?.contractId && (await sdk.contracts.fetch(R.rehearsal.contractId).catch(() => null))) log(`rehearsal contract ${R.rehearsal.contractId} already registered`);
  else {
    const identity = await sdk.identities.fetch(devOwner.identityId);
    const nonce = BigInt((await sdk.identities.nonce(devOwner.identityId)) ?? 0n) + 1n;
    const dc = new w.DataContract({ ownerId: devOwner.identityId, identityNonce: nonce, schemas, fullValidation: true, platformVersion: pv() });
    R.rehearsal = { contractId: dc.id.toString(), definition: 'packages/contracts-v1/gov.json (mainnet)', owner: devOwner.identityId };
    save();
    await measured('register gov.json (mainnet definition: 5 types, 7 indexes)', devOwner, { op: 'contract create' }, () => sdk.contracts.publish({ dataContract: dc, identityKey: identity.getPublicKeyById(key(devOwner, 'critical').keyId), signer: critSigner(devOwner) }));
    const back = await sdk.contracts.fetch(R.rehearsal.contractId);
    R.rehearsal.schemasIdentical = JSON.stringify(back.toJSON(pv()).documentSchemas) === JSON.stringify(dc.toJSON(pv()).documentSchemas);
    save();
    log(`rehearsal contract ${R.rehearsal.contractId}; schemas read back ${R.rehearsal.schemasIdentical ? 'identical' : 'DIFFERENT'}`);
  }
}

// ---- measure ------------------------------------------------------------------------------------------------------------------
if (cmd === 'measure') {
  if (!R.rehearsal?.contractId) throw new Error('run `register` first');
  const reh = await client(R.rehearsal.contractId, devOwner);
  const dev = await client(DEV_GOV, devOwner);
  if (!reh.hasDocType('talliesSet') || reh.hasProperty('proposal', 'url')) throw new Error('rehearsal contract is not the mainnet shape');
  if (dev.hasProperty('proposal', 'url') !== true) throw new Error('dev gov contract is not the full (old) shape');

  // proposal create: full shape (dev gov, the deployed testnet shape) vs slim (rehearsal = mainnet gov.json); same data
  R.docIds ??= {};
  // #1 in the fresh rehearsal contract also pays for creating its index trees: #2..#4 are the steady state
  for (const i of [1, 2, 3, 4]) {
    const full = proposalProps(proposalRow(), { slim: false });
    const slim = proposalProps(proposalRow(), { slim: true });
    if ('error' in full || 'error' in slim) throw new Error('typical proposal does not build');
    await measured(`proposal create, full shape (old), #${i}`, devOwner, { op: 'create', type: 'proposal', shape: 'full', dataHexChars: typical.dataHex.length }, async () => {
      R.docIds[`fullProposal${i}`] = (await dev.create('proposal', full.props, { createdAt: true })).id;
    });
    await measured(`proposal create, slim shape (mainnet), #${i}`, devOwner, { op: 'create', type: 'proposal', shape: 'slim', dataHexChars: typical.dataHex.length }, async () => {
      R.docIds[`slimProposal${i}`] = (await reh.create('proposal', slim.props, { createdAt: true })).id;
    });
  }
  save();
  // the synthetic full-shape proposals do not stay in the dev contract (its readers would list them)
  for (const i of [1, 2, 3, 4]) {
    const id = R.docIds[`fullProposal${i}`];
    if (!id) continue;
    await measured(`proposal delete (synthetic, dev gov), #${i}`, devOwner, { op: 'delete', type: 'proposal' }, () =>
      (dev as any).sdk.documents.delete({ document: { id, ownerId: devOwner.identityId, dataContractId: DEV_GOV, documentTypeName: 'proposal' }, identityKey: (dev as any).identityKey, signer: (dev as any).signer }),
    );
  }

  // per-proposal tally: create (= the final tally of an ended proposal) and replace (one changed proposal, the old hourly cost)
  const t = tallyOf(0);
  let rev = 1;
  await measured('tally create (per proposal; = final tally at end)', devOwner, { op: 'create', type: 'tally' }, async () => {
    R.docIds.tally = (await reh.create('tally', tallyProps(t))).id;
  });
  for (const i of [1, 2, 3]) {
    t.weighted.yes += 4;
    t.unweighted.yes += 1;
    t.asOfHeight += 1;
    rev++;
    await measured(`tally replace (one proposal changed), #${i}`, devOwner, { op: 'replace', type: 'tally' }, () => reh.replace('tally', R.docIds.tally, rev, tallyProps(t)));
  }

  // packed: page p holds n entries; replaces change one entry (the common case) or add one (a new proposal)
  for (const [page, n] of [[0, 6], [1, 30], [2, 161]] as const) {
    const ts = Array.from({ length: n }, (_, i) => tallyOf(i));
    let height = 1_579_000;
    let r = 1;
    const props = () => tallySetProps(page, height, ts.map(entryOf));
    const bytes = () => 3 + ts.length * 95;
    await measured(`talliesSet create, ${n} entries`, devOwner, { op: 'create', type: 'talliesSet', entries: n, packedBytes: bytes() }, async () => {
      R.docIds[`set${n}`] = (await reh.create('talliesSet', props())).id;
    });
    for (const i of n === 161 ? [1, 2] : [1, 2, 3]) {
      ts[i]!.weighted.yes += 4;
      ts[i]!.unweighted.yes += 1;
      height += 1;
      r++;
      await measured(`talliesSet replace, ${n} entries, one changed, #${i}`, devOwner, { op: 'replace', type: 'talliesSet', entries: n, packedBytes: bytes() }, () => reh.replace('talliesSet', R.docIds[`set${n}`], r, props()));
    }
    if (n === 30) {
      ts.push(tallyOf(30));
      height += 1;
      r++;
      await measured('talliesSet replace, 30 -> 31 entries (a proposal joined)', devOwner, { op: 'replace', type: 'talliesSet', entries: 31, packedBytes: bytes() }, () => reh.replace('talliesSet', R.docIds.set30, r, props()));
    }
  }
  save();
}

// ---- update: talliesSet onto the deployed testnet gov contracts -------------------------------------------------------------
if (cmd === 'update') {
  const file = JSON.parse(readFileSync(join(contractsDir, 'gov-testnet.json'), 'utf8'));
  R.updates ??= {};
  for (const [label, contractId, owner] of [['dev gov', DEV_GOV, devOwner], ['testnet gov', TESTNET_GOV, testnetBridge]] as const) {
    const res = await sdk.contracts.fetchWithProof(contractId);
    const json = res.data!.toJSON(pv()) as any;
    if (json.documentSchemas.talliesSet) {
      log(`${label}: talliesSet already present (version ${json.version})`);
      continue;
    }
    if (json.ownerId !== owner.identityId) throw new Error(`${label}: owner ${json.ownerId} is not ${owner.identityId}`);
    // every existing type must be what gov-testnet.json says it is (only talliesSet is new)
    const differs = Object.keys(json.documentSchemas).filter((t) => JSON.stringify(json.documentSchemas[t]) !== JSON.stringify(file[t]));
    if (differs.length) log(`${label}: NOTE on-chain ${differs.join(', ')} differ from gov-testnet.json in key order or content; keeping the on-chain ones`);
    const before = { version: json.version, types: Object.keys(json.documentSchemas), height: String(res.metadata?.height ?? '') };
    json.documentSchemas.talliesSet = file.talliesSet;
    json.version = Number(json.version) + 1;
    const dc = w.DataContract.fromJSON(json, true, pv());
    const identity = await sdk.identities.fetch(owner.identityId);
    const crit = identity.getPublicKeyById(key(owner, 'critical').keyId);
    let stHash: string | null = null;
    await measured(`DataContractUpdate ${label}: + talliesSet`, owner, { op: 'contract update', contractId }, async () => {
      // the transition is built and signed here so its hash (the Platform transaction id) can be recorded
      const nonce = BigInt((await sdk.identities.contractNonce(owner.identityId, contractId)) ?? 0n) + 1n;
      const st = new w.DataContractUpdateTransition(dc, nonce, pv()).toStateTransition();
      st.sign(w.PrivateKey.fromHex(key(owner, 'critical').hex, 'testnet'), crit);
      stHash = st.hash(false);
      await sdk.stateTransitions.broadcastAndWaitForAffectedState(st);
    });
    let back: any;
    for (let i = 0; i < 20; i++) {
      const r = await sdk.contracts.fetchWithProof(contractId);
      back = { json: r.data?.toJSON(pv()), height: String(r.metadata?.height ?? '') };
      if (back.json?.documentSchemas?.talliesSet) break;
      await sleep(2000);
    }
    const same = JSON.stringify(back.json.documentSchemas.talliesSet) === JSON.stringify(file.talliesSet);
    const op = R.ops.find((o: any) => o.label === `DataContractUpdate ${label}: + talliesSet`);
    R.updates[label] = { contractId, owner: owner.identityId, signedWithKeyId: key(owner, 'critical').keyId, stateTransitionHash: stHash, before, versionAfter: back.json.version, typesAfter: Object.keys(back.json.documentSchemas), provedAtHeight: back.height, talliesSetIdentical: same, feeCredits: op?.credits, feeDash: op?.dash };
    save();
    log(`${label} ${contractId}: version ${before.version} -> ${back.json.version}, talliesSet read back ${same ? 'identical' : 'DIFFERENT'}, tx ${stHash}`);
  }
}

if (!['register', 'measure', 'update'].includes(cmd ?? '')) console.error('usage: testnet-cost-pass.ts register|measure|update');
process.exit(0);
