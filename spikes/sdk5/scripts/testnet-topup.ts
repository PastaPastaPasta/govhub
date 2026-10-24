// Top up a spike identity from the spike wallet with a fresh asset lock, and record the top-up fee.
//
//   npx vite-node scripts/testnet-topup.ts <owner|u3|u6> <duffs>
//
// Flow = the DAPI top-up path of PLAN 4.4 minus the browser: split -> type-8 asset lock ->
// chain asset-lock proof (mined + platform ChainLocked) -> identities.topUp.
import { dash, errText, saveResult, sleep } from './lib.ts';
import { addressOf, broadcastTx, buildAssetLockTx, buildSplitTx, fetchUtxos, freshKeyHex, readState, redact, waitMined, wifOf, writeState } from './chain.ts';

const [name, duffsArg] = process.argv.slice(2);
const duffs = Number(duffsArg);
if (!name || !Number.isInteger(duffs) || duffs < 100_000) { console.error('usage: testnet-topup.ts <identity> <duffs>'); process.exit(1); }

const st: any = readState(null);
const it = st.items.find((i: any) => i.name === name);
if (!it) throw new Error(`unknown identity ${name}`);
st.topups ??= [];
const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();

let tp = st.topups.find((t: any) => t.identity === name && t.state !== 'done');
if (!tp) {
  tp = { identity: name, duffs, lockHex: freshKeyHex(), state: 'planned' };
  tp.lockAddress = addressOf(tp.lockHex);
  st.topups.push(tp); writeState(st);
}
const retry = async <T>(label: string, fn: () => Promise<T>, tries = 12): Promise<T> => {
  for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= tries) throw e; console.log(`  … ${label}: ${redact(e).slice(0, 100)}; retry ${i + 1}`); await sleep(10_000); } }
};
if (tp.state === 'planned') {
  const utxos = await fetchUtxos(st.wallet.address);
  const split = buildSplitTx(st.wallet.hex, utxos, [{ address: tp.lockAddress, duffs: tp.duffs }]);
  tp.splitTxid = split.txid; writeState(st);
  await retry('split', () => broadcastTx(split.rawtx));
  const utxo = await retry('split output', async () => { const u = (await fetchUtxos(tp.lockAddress)).find((x: any) => x.txid === tp.splitTxid); if (!u) throw new Error('not visible'); return u; });
  const lock = buildAssetLockTx(tp.lockHex, utxo);
  tp.lockTxid = lock.txid; tp.creditDuffs = lock.creditDuffs; writeState(st);
  await retry('lock', () => broadcastTx(lock.rawtx));
  tp.state = 'locked'; writeState(st);
  console.log(`asset lock ${lock.txid}: ${lock.creditDuffs} duffs`);
}
const height = await waitMined(tp.lockTxid, 'top-up lock');
for (let i = 0; ; i++) {
  const s: any = await sdk.system.status();
  const cl = Number((s.toJSON ? s.toJSON() : s)?.chain?.coreChainLockedHeight ?? 0);
  if (cl >= height) break;
  if (i % 3 === 0) console.log(`  … lock mined at ${height}; platform chain-locked height ${cl}`);
  await sleep(8000);
}
const identity = await sdk.identities.fetch(it.identityId);
const readBal = async () => BigInt(await sdk.identities.balance(it.identityId));
const stable = async () => { let p: bigint | undefined; for (let i = 0; i < 20; i++) { const b = await readBal(); if (b === p) return b; p = b; await sleep(2000); } return p!; };
const before = await stable();
const proof = w.AssetLockProof.createChainAssetLockProof(height, new w.OutPoint(tp.lockTxid, 0));
const t0 = performance.now();
try {
  await sdk.identities.topUp({ identity, assetLockProof: proof, assetLockPrivateKey: w.PrivateKey.fromBytes(Uint8Array.from(Buffer.from(tp.lockHex, 'hex')), 'testnet') });
} catch (e) { console.log(`topUp threw (checking balance): ${redact(errText(e))}`); }
const ms = Math.round(performance.now() - t0);
let after = before;
for (let i = 0; i < 30; i++) { const b = await readBal(); if (b !== before) { await sleep(2000); after = await readBal(); break; } await sleep(2000); }
const locked = BigInt(tp.creditDuffs) * 1000n;
tp.state = 'done'; tp.feeCredits = (locked - (after - before)).toString(); writeState(st);
console.log(`top-up ${name}: locked ${locked} credits, balance ${before} -> ${after}, fee ${tp.feeCredits} credits (${dash(BigInt(tp.feeCredits))} DASH), ${ms} ms`);
saveResult('testnet-topup.json', { at: new Date().toISOString(), identity: name, identityId: it.identityId, lockedCredits: locked.toString(), balanceBefore: before.toString(), balanceAfter: after.toString(), feeCredits: tp.feeCredits, feeDash: dash(BigInt(tp.feeCredits)), ms, assetLockTxid: tp.lockTxid, note: 'testnet is protocol 14; fee indicative of PV13' });
process.exit(0);
