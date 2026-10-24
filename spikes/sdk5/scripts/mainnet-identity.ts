// Mainnet PV13 write check, stage 1: wait for the deposit, then fund two identities from asset locks.
//
//   vite-node scripts/mainnet-identity.ts        (resumable; state in ~/.local/share/govhub-phase0/mainnet/state.json)
//
// The deposit UTXO (0.3 DASH at m/9'/5'/5'/1'/0') is split by chaining two asset-lock transactions:
//   tx A: burn 0.29 DASH   -> identity "main"   (contract owner, 3 keys at m/9'/5'/5'/0'/0'/0'/{0,1,2}')
//         change ~0.00999  -> back to the funding address
//   tx B: burn the change  -> identity "second" (3 keys at m/9'/5'/5'/0'/0'/1'/{0,1,2}'; a second author so that
//         `mnBadge $ownerId in [...]` and per-owner reaction queries can return rows from two owners)
// Nothing is sent anywhere else: everything not burned as a fee stays on the identities.
// Proof type: IS-lock (watchers subscribed BEFORE broadcast), chain-lock fallback (Platform's coreChainLockedHeight).
import { dash, errText, saveResult, sleep } from './lib.ts';
import {
  FUNDING_ADDRESS, FUNDING_PATH, IDENTITY_KEYS, IDENTITY_KEY_PATH, addressOf, bloomElementsFor, broadcastTx, buildAssetLockTx, fetchTx, fetchUtxos,
  keyHexAt, pubKeyOf, readState, redact, startIsLockWatcher, waitMined, wifOf, writeState,
} from './mainnet-lib.ts';

const FEE_DUFFS = 1000;           // L1 fee per asset-lock tx (~300 B, 3+ duffs/B)
const LOCK_MAIN_DUFFS = 29_000_000; // 0.29 DASH to the main identity
const HARD_BUDGET_DUFFS = 30_000_000; // 0.3 DASH

const st: any = readState({ createdAt: new Date().toISOString(), network: 'mainnet', ledger: { l1FeeDuffs: 0, platformFeeCredits: '0' }, items: [] });
writeState(st);

// ---- 1. deposit ----
const fundingKey = keyHexAt(FUNDING_PATH(0));
if (addressOf(fundingKey) !== FUNDING_ADDRESS) throw new Error('derived funding address mismatch');
if (!st.deposit) {
  let utxo: any;
  for (let i = 0; ; i++) {
    const u = (await fetchUtxos(FUNDING_ADDRESS)).filter((x: any) => x.satoshis > 0);
    const total = u.reduce((a: number, x: any) => a + x.satoshis, 0);
    if (total >= 25_000_000) {
      const best = u.slice().sort((a: any, b: any) => b.satoshis - a.satoshis)[0];
      if (best.confirmations >= 1) { utxo = best; break; }
      if (i % 3 === 0) console.log(`  ... deposit ${best.txid.slice(0, 12)} ${best.satoshis / 1e8} DASH seen, ${best.confirmations} confirmations; waiting for 1`);
    } else if (i % 3 === 0) console.log(`  ... waiting for deposit (${total / 1e8} DASH at ${FUNDING_ADDRESS})`);
    await sleep(10_000);
  }
  const tx = await fetchTx(utxo.txid);
  st.deposit = { txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis, scriptPubKey: utxo.scriptPubKey, confirmations: utxo.confirmations, blockheight: tx?.blockheight, txType: tx?.type };
  writeState(st);
}
console.log(`deposit: ${st.deposit.satoshis / 1e8} DASH, txid ${st.deposit.txid}:${st.deposit.vout}, mined at ${st.deposit.blockheight} (tx type ${st.deposit.txType})`);
if (st.deposit.satoshis > HARD_BUDGET_DUFFS) console.log(`NOTE: deposit exceeds the 0.3 DASH budget; only 0.3 is used.`);

// ---- 2. build both asset-lock txs (deterministic; stored in state so a resume re-broadcasts the same bytes) ----
if (!st.items.length) {
  const utxo = { txid: st.deposit.txid, vout: st.deposit.vout, satoshis: st.deposit.satoshis, scriptPubKey: st.deposit.scriptPubKey };
  const creditKeyA = keyHexAt(FUNDING_PATH(0));
  const creditKeyB = keyHexAt(FUNDING_PATH(1));
  const lockMain = Math.min(LOCK_MAIN_DUFFS, utxo.satoshis - 2 * FEE_DUFFS - 1_000_000);
  const A = buildAssetLockTx(fundingKey, utxo, creditKeyA, lockMain, FEE_DUFFS, FUNDING_ADDRESS);
  if (!A.change) throw new Error('expected a change output');
  const lockSecond = A.change.duffs - FEE_DUFFS;
  const B = buildAssetLockTx(fundingKey, { txid: A.txid, vout: A.change.index, satoshis: A.change.duffs, scriptPubKey: A.change.scriptPubKey }, creditKeyB, lockSecond, FEE_DUFFS);
  console.log(`tx A ${A.txid}: burn output index ${A.burnIndex}, change index ${A.change.index}, lock ${A.lockDuffs}, ${A.sizeBytes} B`);
  console.log(`tx B ${B.txid}: burn output index ${B.burnIndex}, lock ${B.lockDuffs}, ${B.sizeBytes} B`);
  st.items = [
    { name: 'main', identityIndex: 0, creditKeyPath: FUNDING_PATH(0), lock: A, lockDuffs: A.lockDuffs, txid: A.txid, burnIndex: A.burnIndex, state: 'planned' },
    { name: 'second', identityIndex: 1, creditKeyPath: FUNDING_PATH(1), lock: B, lockDuffs: B.lockDuffs, txid: B.txid, burnIndex: B.burnIndex, state: 'planned' },
  ];
  st.ledger.l1FeeDuffs = 2 * FEE_DUFFS;
  writeState(st);
}

// ---- 3. subscribe for IS-locks BEFORE broadcasting, then broadcast ----
const [A, B] = st.items;
const needBroadcast = st.items.some((i: any) => i.state === 'planned');
const watcher = await startIsLockWatcher(bloomElementsFor(fundingKey, [{ txid: st.deposit.txid, vout: st.deposit.vout }, { txid: A.txid, vout: A.lock.change.index }]));
console.log('IS-lock watchers subscribed');
await sleep(4000); // let the streams attach before the first broadcast
if (needBroadcast) {
  for (const it of st.items) {
    if (it.state !== 'planned') continue;
    for (let i = 0; ; i++) {
      try { await broadcastTx(it.lock.rawtx); break; } catch (e) {
        const m = redact(e);
        if (/already|257|known/i.test(m)) { console.log(`  ${it.name}: already known to the network`); break; }
        if (i >= 8) throw e;
        console.log(`  ... ${it.name} broadcast failed (${m.slice(0, 140)}); retry in 8s`);
        await sleep(8000);
      }
    }
    it.state = 'broadcast'; it.broadcastAt = new Date().toISOString(); writeState(st);
    console.log(`broadcast ${it.name} ${it.txid}`);
  }
}

// ---- 4. proofs ----
const sdkMod: any = await import('evo5');
await sdkMod.ensureInitialized();
const w: any = sdkMod;
const sdk = w.EvoSDK.mainnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
console.log(`connected, sdk.version() ${sdk.version()}`);

async function chainLocked(): Promise<number> {
  const s: any = await sdk.system.status();
  const j = s?.toJSON ? s.toJSON() : s;
  return Number(j?.chain?.coreChainLockedHeight ?? j?.chain?.core_chain_locked_height ?? 0);
}

for (const it of st.items) {
  if (it.state === 'done') continue;
  // IS-lock first
  let islock: Uint8Array | null = it.islockHex ? Uint8Array.from(Buffer.from(it.islockHex, 'hex')) : null;
  if (!islock) {
    console.log(`waiting up to 90 s for the IS-lock of ${it.name} ${it.txid.slice(0, 12)}`);
    const t0 = Date.now();
    islock = await watcher.wait(it.txid, 90_000);
    if (islock) { it.islockHex = Buffer.from(islock).toString('hex'); it.islockAfterMs = Date.now() - Date.parse(it.broadcastAt); writeState(st); console.log(`  IS-lock received (${islock.length} B) ${it.islockAfterMs} ms after broadcast`); }
    else console.log(`  no IS-lock after ${Math.round((Date.now() - t0) / 1000)} s; chain-lock fallback`);
  }
  const outpointIndex: number = it.burnIndex;
  const makeProofs = async (): Promise<{ kind: string; proof: any }[]> => {
    const proofs: { kind: string; proof: any }[] = [];
    if (islock) proofs.push({ kind: 'instant', proof: w.AssetLockProof.createInstantAssetLockProof(islock, Uint8Array.from(Buffer.from(it.lock.rawtx, 'hex')), outpointIndex) });
    return proofs;
  };
  let proofs = await makeProofs();
  if (!proofs.length) {
    const height = it.minedHeight ?? (it.minedHeight = await waitMined(it.txid, `${it.name} lock`));
    writeState(st);
    for (let i = 0; ; i++) {
      const cl = await chainLocked();
      if (cl >= height) break;
      if (i % 3 === 0) console.log(`  ... ${it.name}: lock mined at ${height}, platform chain-locked height ${cl}`);
      await sleep(8000);
    }
    proofs = [{ kind: 'chain', proof: w.AssetLockProof.createChainAssetLockProof(height, new w.OutPoint(it.txid, outpointIndex)) }];
  }
  const chosen = proofs[0];
  const id = chosen.proof.createIdentityId();
  it.identityId = id.toBase58(); it.proofKind = chosen.kind; writeState(st);
  console.log(`${it.name}: identity id ${it.identityId} (proof ${chosen.kind}, outpoint ${it.txid.slice(0, 12)}:${outpointIndex})`);

  if (!(await sdk.identities.fetch(it.identityId))) {
    const identity = new w.Identity(id);
    const signer = new w.IdentitySigner();
    for (const k of IDENTITY_KEYS) {
      const hex = keyHexAt(IDENTITY_KEY_PATH(it.identityIndex, k.keyId));
      identity.addPublicKey(new w.IdentityPublicKey({ keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, keyType: 'ecdsa_secp256k1', isReadOnly: false, data: pubKeyOf(hex) }));
      signer.addKeyFromWif(wifOf(hex));
    }
    const creditWif = wifOf(keyHexAt(it.creditKeyPath));
    const t0 = performance.now();
    try {
      await sdk.identities.create({ identity, assetLockProof: chosen.proof, signer, assetLockPrivateKey: w.PrivateKey.fromWIF(creditWif) });
    } catch (e) { console.log(`${it.name}: create threw (checking chain): ${redact(errText(e)).slice(0, 300)}`); }
    it.createMs = Math.round(performance.now() - t0);
  }
  let found: any;
  for (let i = 0; i < 30 && !found; i++) { found = await sdk.identities.fetch(it.identityId); if (!found) await sleep(3000); }
  if (!found) {
    console.log(`${it.name}: identity NOT FOUND ${it.identityId}; stopping (rerun to retry with the chain-lock path if no IS proof)`);
    if (chosen.kind === 'instant') { delete it.islockHex; it.islockFailed = true; writeState(st); }
    process.exit(2);
  }
  // settled balance (nodes can lag)
  let bal = 0n;
  for (let i = 0, prev = -1n; i < 20; i++) { bal = BigInt(await sdk.identities.balance(it.identityId)); if (bal === prev && bal > 0n) break; prev = bal; await sleep(2500); }
  const locked = BigInt(it.lockDuffs) * 1000n;
  it.balanceCredits = bal.toString(); it.lockedCredits = locked.toString(); it.createFeeCredits = (locked - bal).toString();
  it.state = 'done'; writeState(st);
  console.log(JSON.stringify({ name: it.name, identityId: it.identityId, proof: it.proofKind, lockedDash: dash(locked), balanceDash: dash(bal), createFeeDash: dash(locked - bal), createMs: it.createMs }));
}
watcher.stop();
console.log('IS-lock watcher stats', JSON.stringify({ ...watcher.stats(), firstBy: undefined }));

const burnedCredits = st.items.reduce((a: bigint, it: any) => a + BigInt(it.createFeeCredits), 0n);
st.ledger.platformFeeCredits = burnedCredits.toString();
writeState(st);
saveResult('mainnet-identities.json', {
  at: new Date().toISOString(), network: 'mainnet (protocol 13)',
  deposit: { txid: st.deposit.txid, vout: st.deposit.vout, amountDash: st.deposit.satoshis / 1e8, confirmationsAtUse: st.deposit.confirmations, txType: st.deposit.txType, minedHeight: st.deposit.blockheight, address: FUNDING_ADDRESS, derivationPath: FUNDING_PATH(0) },
  keyLayout: IDENTITY_KEYS.map((k) => `${k.keyId}:${k.purpose}/${k.securityLevel} (ECDSA_SECP256K1)`),
  l1FeeDuffsTotal: st.ledger.l1FeeDuffs,
  identities: st.items.map((it: any) => ({
    name: it.name, identityId: it.identityId, keyPaths: IDENTITY_KEYS.map((k) => IDENTITY_KEY_PATH(it.identityIndex, k.keyId)),
    assetLockTxid: it.txid, burnOutputIndex: it.burnIndex, changeOutputIndex: it.lock.change?.index, proofKind: it.proofKind, islockAfterBroadcastMs: it.islockAfterMs,
    lockedDash: dash(BigInt(it.lockedCredits)), balanceAfterCreateDash: dash(BigInt(it.balanceCredits)), createFeeCredits: it.createFeeCredits, createFeeDash: dash(BigInt(it.createFeeCredits)), createMs: it.createMs,
  })),
});
console.log('done');
process.exit(0);
