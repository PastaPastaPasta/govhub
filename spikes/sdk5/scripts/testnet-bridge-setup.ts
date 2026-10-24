// Create a dedicated testnet bridge identity and register a testnet `gov` contract owned by it, for a
// bridge that runs with CORE_NETWORK=testnet and PLATFORM_NETWORK=testnet (deploy/README.md section 5).
//
//   npx vite-node scripts/testnet-bridge-setup.ts [lockDuffs=100000000]      (resumable)
//
// Funding: the EvoVote QA wallet (~/.local/share/evovote-v2-qa-20261018/wallet.key) pays one P2PKH output to a
// one-shot lock key, which becomes a type-8 asset lock; the identity is created from a chain asset-lock proof.
// Keys: 0 AUTH/MASTER, 1 AUTH/CRITICAL (registers the contract), 2 AUTH/HIGH (the bridge's signing key),
// 3 TRANSFER/CRITICAL (to move credits out later).
//
// Everything secret stays in ~/.local/share/govhub-testnet/ (0700 dir, 0600 files): state.json (all keys) and
// bridge_identity.json (only the HIGH key, the file the bridge mounts). Nothing secret is printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contractsDir, dash, errText, sleep } from './lib.ts';
import { addressOf, broadcastTx, buildAssetLockTx, buildSplitTx, fetchUtxos, freshKeyHex, pubKeyOf, redact, waitMined, wifOf } from './chain.ts';

const DIR = join(homedir(), '.local/share/govhub-testnet');
const STATE = join(DIR, 'state.json');
const KEYFILE = join(DIR, 'bridge_identity.json');
const QA_WALLET_KEY = join(homedir(), '.local/share/evovote-v2-qa-20261018/wallet.key');
const lockDuffs = Number(process.argv[2] ?? 100_000_000);
if (!Number.isInteger(lockDuffs) || lockDuffs < 30_000_000) throw new Error('lockDuffs must be >= 0.3 tDASH (the gov contract alone costs ~0.24)');

const writePrivate = (path: string, data: unknown) => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
};
const KEY = (keyId: number, purpose: string, securityLevel: string) => ({ keyId, purpose, securityLevel, hex: freshKeyHex() });
const st: any = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : { createdAt: new Date().toISOString(), lockDuffs, lockHex: freshKeyHex(), keys: [KEY(0, 'authentication', 'master'), KEY(1, 'authentication', 'critical'), KEY(2, 'authentication', 'high'), KEY(3, 'transfer', 'critical')], state: 'planned' };
st.lockAddress = addressOf(st.lockHex);
const save = () => writePrivate(STATE, st);
save();
console.log(`state: ${STATE} (0600); lock address ${st.lockAddress}`);

const retry = async <T>(label: string, fn: () => Promise<T>, tries = 12): Promise<T> => {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      console.log(`  … ${label}: ${redact(errText(e)).slice(0, 120)}; retry ${i + 1}/${tries} in 10 s`);
      await sleep(10_000);
    }
  }
};

// ---- 1. fund the lock key from the QA wallet, then the asset lock ----
if (st.state === 'planned') {
  const qaHex = readFileSync(QA_WALLET_KEY, 'utf8').trim();
  const qaAddr = addressOf(qaHex);
  const utxos = await fetchUtxos(qaAddr);
  const total = utxos.reduce((a: number, u: any) => a + u.satoshis, 0);
  console.log(`QA wallet ${qaAddr}: ${total / 1e8} tDASH in ${utxos.length} UTXOs`);
  const send = lockDuffs + 500; // buildAssetLockTx keeps 500 duffs as the lock tx fee
  if (total < send + 100_000) throw new Error('QA wallet has insufficient funds');
  const split = buildSplitTx(qaHex, utxos, [{ address: st.lockAddress, duffs: send }]);
  st.fundingTxid = split.txid; st.state = 'funding'; save();
  await retry('funding broadcast', () => broadcastTx(split.rawtx));
  console.log(`funding tx ${split.txid}: ${send / 1e8} tDASH -> lock key`);
}
if (st.state === 'funding') {
  const utxo = await retry('funding output', async () => {
    const u = (await fetchUtxos(st.lockAddress)).find((x: any) => x.txid === st.fundingTxid);
    if (!u) throw new Error('funding output not visible yet');
    return u;
  });
  const lock = buildAssetLockTx(st.lockHex, utxo);
  st.lockTxid = lock.txid; st.creditDuffs = lock.creditDuffs; save();
  await retry('lock broadcast', () => broadcastTx(lock.rawtx));
  st.state = 'locked'; save();
  console.log(`asset lock ${lock.txid}: ${lock.creditDuffs} duffs`);
}

// ---- 2. identity ----
const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.testnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const signer = new w.IdentitySigner();
for (const k of st.keys) signer.addKeyFromWif(wifOf(k.hex));
const balance = async () => BigInt(await sdk.identities.balance(st.identityId));
const stableBalance = async () => { let p: bigint | undefined; for (let i = 0; i < 20; i++) { const b = await balance(); if (b === p) return b; p = b; await sleep(2000); } return p!; };

if (st.state === 'locked') {
  const height = await waitMined(st.lockTxid, 'asset lock');
  for (let i = 0; ; i++) {
    const s: any = await sdk.system.status();
    const cl = Number((s.toJSON ? s.toJSON() : s)?.chain?.coreChainLockedHeight ?? 0);
    if (cl >= height) break;
    if (i % 3 === 0) console.log(`  … lock mined at ${height}; platform chain-locked height ${cl}`);
    await sleep(8000);
  }
  const proof = w.AssetLockProof.createChainAssetLockProof(height, new w.OutPoint(st.lockTxid, 0));
  st.identityId = proof.createIdentityId().toBase58(); save();
  if (!(await sdk.identities.fetch(st.identityId))) {
    const identity = new w.Identity(proof.createIdentityId());
    for (const k of st.keys) identity.addPublicKey(new w.IdentityPublicKey({ keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, keyType: 'ecdsa_secp256k1', isReadOnly: false, data: pubKeyOf(k.hex) }));
    try {
      await sdk.identities.create({ identity, assetLockProof: proof, signer, assetLockPrivateKey: w.PrivateKey.fromBytes(Uint8Array.from(Buffer.from(st.lockHex, 'hex')), 'testnet') });
    } catch (e) { console.log(`identity create threw (checking chain): ${redact(errText(e))}`); }
  }
  let found: any;
  for (let i = 0; i < 20 && !found; i++) { found = await sdk.identities.fetch(st.identityId); if (!found) await sleep(3000); }
  if (!found) throw new Error(`identity ${st.identityId} not found after create`);
  st.balanceAfterCreate = String(await stableBalance());
  st.createFeeCredits = String(BigInt(st.creditDuffs) * 1000n - BigInt(st.balanceAfterCreate));
  st.state = 'identity'; save();
  console.log(`identity ${st.identityId}: balance ${st.balanceAfterCreate} credits, create fee ${st.createFeeCredits} credits (${dash(BigInt(st.createFeeCredits))} DASH)`);
}

// ---- 3. the bridge key file (HIGH key only) ----
const high = st.keys.find((k: any) => k.securityLevel === 'high' && k.purpose === 'authentication');
writePrivate(KEYFILE, { identityId: st.identityId, keyId: high.keyId, privateKeyHex: high.hex });
console.log(`bridge key file: ${KEYFILE} (0600, HIGH key ${high.keyId} only)`);

// ---- 4. gov contract ----
if (st.state === 'identity') {
  const identity = await sdk.identities.fetch(st.identityId);
  const schemas = JSON.parse(readFileSync(join(contractsDir, 'gov.json'), 'utf8'));
  const before = await stableBalance();
  const nonce = BigInt((await sdk.identities.nonce(st.identityId)) ?? 0n) + 1n;
  const dc = new w.DataContract({ ownerId: st.identityId, identityNonce: nonce, schemas, fullValidation: true, platformVersion: sdk.version() });
  st.govContractId = dc.id.toString(); save(); // derived from owner + nonce, known before publishing
  try {
    const published = await sdk.contracts.publish({ dataContract: dc, identityKey: identity.getPublicKeyById(1), signer });
    if (published.id.toString() !== st.govContractId) throw new Error(`published id ${published.id} != derived ${st.govContractId}`);
  } catch (e) { console.log(`contract publish threw (checking chain): ${redact(errText(e))}`); }
  let back: any;
  for (let i = 0; i < 20 && !back; i++) { back = await sdk.contracts.fetch(st.govContractId).catch(() => null); if (!back) await sleep(3000); }
  if (!back) throw new Error(`gov contract ${st.govContractId} not found after publish`);
  const same = JSON.stringify(back.toJSON(sdk.version()).documentSchemas) === JSON.stringify(dc.toJSON(sdk.version()).documentSchemas);
  if (!same) throw new Error('registered schemas differ from gov.json');
  let after = before;
  for (let i = 0; i < 30 && after === before; i++) { await sleep(2000); after = await stableBalance(); }
  st.contractFeeCredits = String(before - after); st.balanceAfterContract = String(after);
  st.state = 'done'; save();
  console.log(`gov contract ${st.govContractId}: registration ${st.contractFeeCredits} credits (${dash(before - after)} DASH); schemas match gov.json`);
}
console.log(JSON.stringify({ identityId: st.identityId, govContractId: st.govContractId, lockTxid: st.lockTxid, createFeeCredits: st.createFeeCredits, contractFeeCredits: st.contractFeeCredits, balance: String(await balance()) }));
process.exit(0);
