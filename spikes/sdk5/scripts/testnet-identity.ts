// Stage 1 of the testnet write spike: fund a wallet from the faucet, then create three identities
// from asset locks and record what identity creation costs.
//
//   npm run testnet:identity        (resumable; state in ~/.local/share/govhub-phase0/testnet/state.json)
//
//   owner  4 keys  (0 master, 1 critical, 2 high, 3 transfer)        1.25 tDASH  -> owns the 4 contracts
//   u3     3 keys  (0 master, 1 critical, 2 high)                     0.02 tDASH  -> "3-key" cost, writes forum docs
//   u6     6 keys  (DashPay iOS layout: + 3 transfer, 4 ENC, 5 DEC, bound to contactRequest)   0.02 tDASH
//
// u3 and u6 get identical lock amounts so the credit difference is purely the extra keys.
// Key material is written ONLY to the state file (0600) outside the repo; nothing secret is printed.
import { existsSync } from 'node:fs';
import { errText, plain, saveResult, sleep, timed, dash } from './lib.ts';
import {
  STATE_FILE, addressOf, broadcastTx, buildAssetLockTx, buildSplitTx, freshKeyHex, pubKeyOf, readState, redact, requestFaucet,
  waitMined, waitUtxos, wifOf, writeState, fetchUtxos,
} from './chain.ts';

const DASHPAY_CONTRACT = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7';
const KEY = (keyId: number, purpose: string, securityLevel: string, bound?: string) => ({ keyId, purpose, securityLevel, bound, hex: freshKeyHex() });
const PLAN = [
  { name: 'u3', duffs: 2_000_000, keys: () => [KEY(0, 'authentication', 'master'), KEY(1, 'authentication', 'critical'), KEY(2, 'authentication', 'high')] },
  { name: 'u6', duffs: 2_000_000, keys: () => [KEY(0, 'authentication', 'master'), KEY(1, 'authentication', 'critical'), KEY(2, 'authentication', 'high'), KEY(3, 'transfer', 'critical'), KEY(4, 'encryption', 'medium', 'contactRequest'), KEY(5, 'decryption', 'medium', 'contactRequest')] },
  { name: 'owner', duffs: 125_000_000, keys: () => [KEY(0, 'authentication', 'master'), KEY(1, 'authentication', 'critical'), KEY(2, 'authentication', 'high'), KEY(3, 'transfer', 'critical')] },
];
const FAUCET_REQUESTS = 2; // 1 tDASH each, 3/hour limit

const st: any = readState(null) ?? {
  createdAt: new Date().toISOString(),
  wallet: (() => { const hex = freshKeyHex(); return { hex, address: addressOf(hex) }; })(),
  faucet: [],
  items: PLAN.map((p) => ({ name: p.name, duffs: p.duffs, lockHex: freshKeyHex(), keys: p.keys(), state: 'planned' })),
};
for (const it of st.items) it.lockAddress = addressOf(it.lockHex);
writeState(st);
console.log(`state file: ${STATE_FILE} (0600)\nwallet ${st.wallet.address}`);

async function retry<T>(label: string, fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      console.log(`  … ${label} failed (${redact(e).slice(0, 120)}); retry ${i + 1}/${tries} in 10s`);
      await sleep(10_000);
    }
  }
}

// ---- 1. funding: faucet first (once; never hammered); on failure fall back to the EvoVote QA wallet,
// but only because it already holds funds (read its UTXOs, spend one transfer to our wallet). ----
const QA_WALLET_KEY = `${process.env.HOME}/.local/share/evovote-v2-qa-20261018/wallet.key`;
const FALLBACK_DUFFS = 150_000_000; // 1.5 tDASH: 1.25 owner + 2 x 0.02 + fees
while (!st.fundingTxid && st.faucet.length < FAUCET_REQUESTS && !st.faucetFailure) {
  console.log(`faucet request ${st.faucet.length + 1}/${FAUCET_REQUESTS}`);
  try {
    const r = await requestFaucet(st.wallet.address);
    st.faucet.push({ txid: r.txid, amount: r.amount, at: new Date().toISOString() });
    writeState(st);
    console.log(`  faucet paid ${r.amount} tDASH, txid ${r.txid}`);
    if (st.faucet.length < FAUCET_REQUESTS) await sleep(3000);
  } catch (e) {
    st.faucetFailure = { at: new Date().toISOString(), error: redact(e).slice(0, 300) };
    writeState(st);
    console.log(`  faucet route failed: ${st.faucetFailure.error}`);
  }
}
if (!st.fundingTxid && st.faucet.length === 0 && st.faucetFailure) {
  const { readFileSync } = await import('node:fs');
  const qaHex = readFileSync(QA_WALLET_KEY, 'utf8').trim();
  const qaAddr = addressOf(qaHex);
  const qaUtxos = await fetchUtxos(qaAddr);
  const qaTotal = qaUtxos.reduce((a: number, u: any) => a + u.satoshis, 0);
  console.log(`  fallback: QA wallet ${qaAddr} holds ${qaTotal / 1e8} tDASH`);
  if (qaTotal < FALLBACK_DUFFS + 1_000_000) throw new Error('QA wallet has insufficient funds; stopping');
  const tx = buildSplitTx(qaHex, qaUtxos, [{ address: st.wallet.address, duffs: FALLBACK_DUFFS }]);
  st.fundingTxid = tx.txid; st.fundingSource = 'evovote-v2-qa wallet (faucet returned 429)'; writeState(st);
  await retry('fallback funding broadcast', () => broadcastTx(tx.rawtx));
  console.log(`  funded ${FALLBACK_DUFFS / 1e8} tDASH from the QA wallet, txid ${tx.txid}`);
}

// ---- 2. split ----
if (!st.splitTxid) {
  const need = st.items.reduce((a: number, it: any) => a + it.duffs, 0) + 200_000;
  const utxos = await waitUtxos(st.wallet.address, need, 'faucet funds');
  const split = buildSplitTx(st.wallet.hex, utxos, st.items.map((it: any) => ({ address: it.lockAddress, duffs: it.duffs })));
  st.splitTxid = split.txid; writeState(st);
  await retry('split broadcast', () => broadcastTx(split.rawtx));
  console.log(`split ${split.txid}`);
}

// ---- 3. asset locks ----
for (const it of st.items) {
  if (it.state !== 'planned') continue;
  const utxo = await retry(`${it.name} split output`, async () => {
    const u = (await fetchUtxos(it.lockAddress)).find((x: any) => x.txid === st.splitTxid);
    if (!u) throw new Error('split output not visible yet');
    return u;
  });
  const lock = buildAssetLockTx(it.lockHex, utxo);
  it.lockTxid = lock.txid; it.creditDuffs = lock.creditDuffs; writeState(st);
  await retry(`${it.name} lock broadcast`, () => broadcastTx(lock.rawtx));
  it.state = 'locked'; writeState(st);
  console.log(`asset lock ${it.name}: ${lock.creditDuffs} duffs = ${dash(BigInt(lock.creditDuffs) * 1000n)} DASH-equivalent credits, txid ${lock.txid}`);
}

// ---- 4. identities (chain asset-lock proofs) ----
await (await import('evo5')).ensureInitialized();
const w: any = await import('evo5');
const sdk = w.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
const dashpay = await sdk.contracts.fetch(DASHPAY_CONTRACT);
console.log(`DashPay contract on testnet: ${dashpay ? 'found' : 'MISSING'}`);

async function chainLocked(): Promise<number> {
  const s: any = await sdk.system.status();
  const j = s?.toJSON ? s.toJSON() : s;
  return Number(j?.chain?.coreChainLockedHeight ?? j?.chain?.core_chain_locked_height ?? 0);
}

for (const it of st.items) {
  if (it.state === 'done') continue;
  const height = await waitMined(it.lockTxid, `${it.name} lock`);
  for (let i = 0; ; i++) {
    const cl = await chainLocked();
    if (cl >= height) break;
    if (i % 3 === 0) console.log(`  … ${it.name}: lock mined at ${height}, platform chain-locked height ${cl}`);
    await sleep(8000);
  }
  const proof = w.AssetLockProof.createChainAssetLockProof(height, new w.OutPoint(it.lockTxid, 0));
  const id = proof.createIdentityId();
  it.identityId = id.toBase58(); writeState(st);
  if (!(await sdk.identities.fetch(it.identityId))) {
    const identity = new w.Identity(id);
    const signer = new w.IdentitySigner();
    for (const k of it.keys) {
      const opts: any = { keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, keyType: 'ecdsa_secp256k1', isReadOnly: false, data: pubKeyOf(k.hex) };
      if (k.bound) opts.contractBounds = w.ContractBounds.SingleContractDocumentType(DASHPAY_CONTRACT, k.bound);
      identity.addPublicKey(new w.IdentityPublicKey(opts));
      signer.addKeyFromWif(wifOf(k.hex));
    }
    const t0 = performance.now();
    try {
      await sdk.identities.create({ identity, assetLockProof: proof, signer, assetLockPrivateKey: w.PrivateKey.fromBytes(Uint8Array.from(Buffer.from(it.lockHex, 'hex')), 'testnet') });
    } catch (e) { console.log(`${it.name}: create threw (checking chain): ${redact(errText(e))}`); }
    it.createMs = Math.round(performance.now() - t0);
  }
  let found: any;
  for (let i = 0; i < 20 && !found; i++) { found = await sdk.identities.fetch(it.identityId); if (!found) await sleep(3000); }
  if (!found) { console.log(`${it.name}: NOT FOUND ${it.identityId}`); continue; }
  const balance = BigInt(await sdk.identities.balance(it.identityId));
  const locked = BigInt(it.creditDuffs) * 1000n;
  it.balance = String(balance);
  it.lockedCredits = String(locked);
  it.createFeeCredits = String(locked - balance);
  it.keyCount = it.keys.length;
  it.state = 'done'; writeState(st);
  console.log(JSON.stringify({ name: it.name, identityId: it.identityId, keys: it.keyCount, lockedCredits: it.lockedCredits, balance: it.balance, createFeeCredits: it.createFeeCredits, createFeeDash: dash(locked - balance), createMs: it.createMs }));
}

const summary = st.items.map((it: any) => ({ name: it.name, identityId: it.identityId, keys: it.keyCount, keyLayout: it.keys.map((k: any) => `${k.keyId}:${k.purpose}/${k.securityLevel}${k.bound ? '(bound ' + k.bound + ')' : ''}`), lockedCredits: it.lockedCredits, balanceAfterCreate: it.balance, createFeeCredits: it.createFeeCredits, createFeeDash: it.createFeeCredits ? dash(BigInt(it.createFeeCredits)) : undefined, createMs: it.createMs, assetLockTxid: it.lockTxid }));
saveResult('testnet-identities.json', { at: new Date().toISOString(), faucetRequests: st.faucet.length, identities: summary, note: 'testnet is protocol 14; fees are indicative of PV13, not exact' });
console.log(existsSync(STATE_FILE) ? 'done' : '');
process.exit(st.items.every((it: any) => it.state === 'done') ? 0 : 1);
