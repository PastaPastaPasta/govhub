// TESTNET: adds the `keyring` document type to the deployed forum contract (a DataContractUpdate: new document types are allowed on
// an existing contract at PV13 and PV14; new indexes on existing types are not), then writes, reads back and opens a real keyring
// with the u6 test identity and records the fees.
//
//   npx vite-node scripts/testnet-forum-keyring.ts [--dry] [--update] [--keyring]
//
// Keys come from ~/.local/share/govhub-phase0/testnet/state.json at run time (the contract owner's CRITICAL key signs the update);
// nothing secret is printed or written. Results without secrets: scripts/results/testnet-forum-keyring.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvoPlatform } from '../src/evo.ts';
import { bytesToHex, hexToBytes, randomBytes } from '../src/bytes.ts';
import { makeSession } from '../src/signin.ts';
import { SeedWallet } from '../src/seed.ts';
import type { SigningKey } from '../src/platform.ts';
import { KeyringKind, UnlockerType, encodeKeys } from '../src/keyring/format.ts';
import { addUnlocker, emptyKeyring, loadKeyring, passkeyUnlockKey, saveKeys, savePending, type UnlockKey } from '../src/keyring/keyring.ts';
import { createEvoKeyringStore } from '../src/keyring/evo-store.ts';

process.on('unhandledRejection', (e: any) => { console.error('unhandled:', e?.name, e?.code, e?.message ?? String(e)); process.exit(1); });
const FORUM = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const dash = (credits: bigint) => (Number(credits) / 1e11).toFixed(8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const resultsFile = join(here, 'results/testnet-forum-keyring.json');
const results: Record<string, unknown> = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : {};
const save = () => writeFileSync(resultsFile, JSON.stringify(results, null, 2) + '\n');

const state = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase0/testnet/state.json'), 'utf8')) as { items: Array<{ name: string; identityId: string; keys: Array<{ keyId: number; purpose: string; securityLevel: string; hex: string }> }> };
const item = (n: string) => state.items.find((i) => i.name === n)!;
const keyOf = (n: string, level: 'critical' | 'high') => item(n).keys.find((k) => k.purpose === 'authentication' && k.securityLevel === level)!;

const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const pv = () => sdk.version();
log(`connected: Platform protocol ${pv()}`);
const w = evo as any;

const balance = async (id: string) => BigInt((await sdk.identities.balance(id)) ?? 0n);
async function settledBalance(id: string, before: bigint): Promise<bigint> {
  let last: bigint | undefined;
  for (let i = 0; i < 40; i++) {
    const b = await balance(id);
    if (b !== before) {
      if (b === last) return b;
      last = b;
    }
    await sleep(1500);
  }
  return last ?? before;
}

const schemaFile = JSON.parse(readFileSync(join(here, '../../contracts-v1/forum.json'), 'utf8'));

// ---- 1. contract update ----
{
  const res = await sdk.contracts.fetchWithProof(FORUM);
  const contract = res.data!;
  const json = contract.toJSON(pv() as never) as any;
  log(`forum contract version ${json.version}, types: ${Object.keys(json.documentSchemas).join(', ')}`);
  results.before = { version: json.version, types: Object.keys(json.documentSchemas), height: String((res as any).metadata?.height ?? '') };
  if (json.documentSchemas.keyring) {
    log('keyring type already present');
  } else if (args.has('--update') && !args.has('--dry')) {
    // every existing type must be byte-for-byte what the repo has (only `keyring` is new)
    for (const [t, s] of Object.entries(json.documentSchemas)) {
      if (JSON.stringify(s) !== JSON.stringify(schemaFile[t])) log(`NOTE: on-chain ${t} differs from forum.json in key order or content; keeping the on-chain one`);
    }
    json.documentSchemas.keyring = schemaFile.keyring;
    json.version = Number(json.version) + 1;
    const dc = w.DataContract.fromJSON(json, true, pv());
    const owner = item('owner');
    const identity = await sdk.identities.fetch(owner.identityId);
    const crit = keyOf('owner', 'critical');
    const signer = new w.IdentitySigner();
    signer.addKey(w.PrivateKey.fromBytes(hexToBytes(crit.hex), 'testnet'));
    const before = await balance(owner.identityId);
    const t0 = Date.now();
    await sdk.contracts.update({ dataContract: dc, identityKey: identity!.getPublicKeyById(crit.keyId)!, signer });
    const ms = Date.now() - t0;
    let back: any;
    for (let i = 0; i < 20; i++) {
      const r = await sdk.contracts.fetchWithProof(FORUM);
      back = r.data?.toJSON(pv() as never);
      if (back?.documentSchemas?.keyring) break;
      await sleep(2000);
    }
    const after = await settledBalance(owner.identityId, before);
    const same = JSON.stringify(back.documentSchemas.keyring) === JSON.stringify(schemaFile.keyring);
    log(`updated: version ${back.version}, keyring read back ${same ? 'identical' : 'DIFFERENT'}, fee ${dash(before - after)} DASH, ${ms} ms`);
    results.update = { at: new Date().toISOString(), contractId: FORUM, owner: owner.identityId, signedWithKeyId: crit.keyId, versionAfter: back.version, keyringIdentical: same, feeCredits: String(before - after), feeDash: dash(before - after), ms };
    save();
  } else {
    log('keyring type missing (run with --update to add it)');
  }
}

// ---- 2. a real keyring write / read / open with u6 ----
if (args.has('--keyring')) {
  const u = item('u6');
  const high = keyOf('u6', 'high');
  const key: SigningKey = { id: high.keyId, purpose: 0, securityLevel: 2, type: 0, privateKey: hexToBytes(high.hex) };
  const platform = createEvoPlatform(evo, sdk, 'testnet');
  const store = createEvoKeyringStore(evo, sdk, platform, FORUM);
  const ctx = { store, contractId: FORUM };
  // a throwaway seed and PRF stand in for the user's: the session object only needs the identity and its HIGH key
  const wallet = SeedWallet.fromEntropy(randomBytes(16), 'testnet');
  const s = makeSession({ network: 'testnet', identityId: u.identityId, identityIndex: null, keyId: high.keyId, securityLevel: 2, source: 'key', privateKey: key.privateKey.slice(), wallet });
  const prf = randomBytes(32);
  const pk: UnlockKey = passkeyUnlockKey(prf);
  const runs: Array<Record<string, unknown>> = [];
  const existing = await store.get(u.identityId, KeyringKind.KEYS);
  const k = emptyKeyring(u.identityId, []);
  k.keysDoc = existing;
  addUnlocker(k, pk);
  const measure = async (what: string, fn: () => Promise<void>) => {
    const before = await balance(u.identityId);
    const t0 = Date.now();
    await fn();
    const ms = Date.now() - t0;
    const after = await settledBalance(u.identityId, before);
    runs.push({ what, feeCredits: String(before - after), feeDash: dash(before - after), ms });
    log(`${what}: ${dash(before - after)} DASH, ${ms} ms`);
  };
  for (let i = 0; i < 3; i++) k.content.keys.push({ privateKey: randomBytes(32), compressed: true, label: `test key ${i}` });
  await measure(existing ? 'keys replace (bucket 1, 3 keys)' : 'keys create (bucket 1, 3 keys)', () => saveKeys(ctx, s, k));
  for (let i = 3; i < 40; i++) k.content.keys.push({ privateKey: randomBytes(32), compressed: true, label: `test key ${i}` });
  await measure('keys replace (bucket 2, 40 keys)', () => saveKeys(ctx, s, k));
  k.content.keys.splice(5).forEach((x) => x.privateKey.fill(0));
  await measure('keys replace (bucket 1 again, 5 keys)', () => saveKeys(ctx, s, k));
  k.pending.votes.push({ collateralTxid: bytesToHex(randomBytes(32)), collateralIndex: 1, govHash: bytesToHex(randomBytes(32)), outcome: 3, time: Math.floor(Date.now() / 1000), sig: randomBytes(65), releaseAt: Math.floor(Date.now() / 1000), refs: [] });
  const existingPending = await store.get(u.identityId, KeyringKind.PENDING);
  k.pendingDoc = existingPending;
  await measure(existingPending ? 'pending replace (bucket 1)' : 'pending create (bucket 1)', () => savePending(ctx, s, k));
  // fresh read with proofs, opened with the passkey stand-in
  let opened = null;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = await loadKeyring(ctx, u.identityId, passkeyUnlockKey(prf)).catch((e) => (log(`read: ${(e as Error).message}`), null));
    if (!opened || opened.content.keys.length !== 5) {
      opened = null;
      await sleep(2000);
    }
  }
  const sizes = { wraps: k.keysDoc!.sealed.wraps.length, chunks: k.keysDoc!.sealed.chunks.map((c) => c.length), plaintextBucket1: encodeKeys(k.content).plaintext.length };
  log(`read back with proofs and opened: ${opened ? `${opened.content.keys.length} keys, ${opened.pending.votes.length} pending, unlocker ${opened.openedWith === UnlockerType.PASSKEY ? 'passkey' : 'seed'}` : 'FAILED'}`);
  results.keyring = { at: new Date().toISOString(), identity: u.identityId, keysDocId: k.keysDoc!.id, keysRevision: k.keysDoc!.revision, pendingDocId: k.pendingDoc!.id, runs, readBackOpened: !!opened, sizes };
  save();
  k.close();
  opened?.close();
  s.end();
}
process.exit(0);
