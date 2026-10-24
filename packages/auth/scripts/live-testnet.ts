// Live TESTNET run of @govhub/auth from Node (no browser): every flow the web app uses, against real DAPI nodes and Platform.
//
//   npx vite-node scripts/live-testnet.ts [create] [voucher] [topup] [signin] [vault]     (default: all, in that order)
//
// Funding comes from the EvoVote QA wallet (~/.local/share/evovote-v2-qa-20261018/wallet.key), the way spikes/sdk5 used it: its UTXO
// is read from testnet Insight (tooling only; the app itself never uses Insight), payments are built by @govhub/auth's own tx code
// and broadcast over DAPI. Test key material (phrases, voucher keys) and the run state live in ~/.local/share/govhub-phase2/
// (0700 / 0600), never in the repo; nothing secret is printed. Results without secrets go to scripts/results/live-testnet.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDapi, parseTx, type Dapi } from '@govhub/dapi';
import {
  addLaterKeys, addressOf, buildAssetLock, buildPayment, bytesToHex, CREDITS_PER_DUFF, discoverIdentities, generatePhrase, hash160, hexToBytes, openVault, p2pkhScript, parseVoucher,
  publicKeyOf, randomBytes, recipientFromPrf, redeemVoucher, runFunding, SeedWallet, signInWithKey, signInWithSeed, storeInVault, wifOf,
  type FundingRecord, type FundingStore, type PlatformPort,
} from '../src/index.ts';
import { createEvoPlatform } from '../src/evo.ts';
import { userHandleFor } from '../src/vault/webauthn.ts';

const NET = 'testnet' as const;
const DIR = join(homedir(), '.local/share/govhub-phase2');
const STATE = join(DIR, 'live-state.json');
const QA = join(homedir(), '.local/share/evovote-v2-qa-20261018');
const FORUM = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
const INSIGHT = 'https://insight.testnet.networks.dash.org/insight-api';
const here = dirname(fileURLToPath(import.meta.url));

interface State {
  phraseA?: string;
  phraseB?: string;
  funder?: { txid: string; vout: number; value: string };
  fundings: Record<string, FundingRecord>;
  voucher?: { txid: string; wif: string; lockDuffs: string; burnVout: number; creditIndex: number };
  ledger: { paidFromQaDuffs: string; l1FeesDuffs: string };
  results: Record<string, unknown>;
}

function load(): State {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { fundings: {}, ledger: { paidFromQaDuffs: '0', l1FeesDuffs: '0' }, results: {} };
}
function save(s: State) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  writeFileSync(`${STATE}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(`${STATE}.tmp`, STATE);
}
const st = load();
const ledgerAdd = (k: keyof State['ledger'], d: bigint) => (st.ledger[k] = (BigInt(st.ledger[k]) + d).toString());
const dash = (credits: bigint) => (Number(credits) / 1e11).toFixed(8);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const redactErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/[0-9a-fA-F]{64,}/g, '[hex]');

const store: FundingStore = {
  load: (k) => st.fundings[k] ?? null,
  save: (r) => ((st.fundings[r.key] = { ...r, updatedAt: Date.now() }), save(st)),
  remove: (k) => (delete st.fundings[k], save(st)),
  list: () => Object.values(st.fundings),
};

// ---- the QA-wallet funder ------------------------------------------------------------------------------------------------
const qaKey = hexToBytes(readFileSync(join(QA, 'wallet.key'), 'utf8').trim());
const qaAddress = readFileSync(join(QA, 'wallet-address.txt'), 'utf8').trim();
if (addressOf(publicKeyOf(qaKey), NET) !== qaAddress) throw new Error('QA wallet key/address mismatch');

async function funderUtxo(): Promise<{ txid: string; vout: number; value: bigint }> {
  if (st.funder) return { ...st.funder, value: BigInt(st.funder.value) };
  const r = await fetch(`${INSIGHT}/addr/${qaAddress}/utxo`, { headers: { 'user-agent': 'curl/8.7.1' } });
  const u = ((await r.json()) as Array<{ txid: string; vout: number; satoshis: number }>).sort((a, b) => b.satoshis - a.satoshis)[0];
  if (!u) throw new Error('QA wallet is empty');
  return { txid: u.txid, vout: u.vout, value: BigInt(u.satoshis) };
}

async function pay(dapi: Dapi, toHash160: Uint8Array, duffs: bigint): Promise<string> {
  const utxo = await funderUtxo();
  const p = buildPayment({ utxos: [utxo], key: qaKey, to: [{ pubKeyHash: toHash160, duffs }] });
  await dapi.broadcastTransaction(p.raw);
  const parsedChange = p.changeVout === null ? null : { txid: p.txid, vout: p.changeVout, value: parseTx(p.raw).outputs[p.changeVout]!.value.toString() };
  const fee = utxo.value - duffs - (parsedChange ? BigInt(parsedChange.value) : 0n);
  st.funder = parsedChange ?? undefined;
  ledgerAdd('paidFromQaDuffs', duffs);
  ledgerAdd('l1FeesDuffs', fee);
  save(st);
  log(`QA wallet paid ${Number(duffs) / 1e8} tDASH in ${p.txid} (fee ${fee} duffs)`);
  return p.txid;
}

// ---- setup ---------------------------------------------------------------------------------------------------------------
const steps = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['create', 'voucher', 'topup', 'signin', 'vault']);
st.phraseA ??= generatePhrase(12);
st.phraseB ??= generatePhrase(24);
save(st);

const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
const platform: PlatformPort = createEvoPlatform(evo, sdk, NET);
const dapi = createDapi({ network: NET });
log(`connected: Platform protocol ${sdk.version()}, DAPI ${(await dapi.ready()).length} nodes`);

async function balanceSettled(id: string): Promise<bigint> {
  let prev = -1n;
  for (let i = 0; i < 12; i++) {
    const b = (await platform.balance(id)) ?? 0n;
    if (b === prev) return b;
    prev = b;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return prev;
}

// ---- 1. create from external DASH (QR address flow) -----------------------------------------------------------------------
if (steps.has('create')) {
  const wallet = SeedWallet.fromPhrase(st.phraseA!, NET);
  let paid = !!st.fundings[`${NET}.create.0`]?.deposits.length;
  const t0 = Date.now();
  const { identityId, record } = await runFunding({
    wallet, dapi, platform, store, kind: 'create', identityIndex: 0, log,
    onUpdate: (v) => {
      log(`create: ${v.state}${v.note ? ` (${v.note})` : ''}`);
      if (v.state === 'awaiting-deposit' && !paid) {
        paid = true;
        // the watcher is live: now "scan the QR" (pay the address)
        void pay(dapi, hash160(wallet.derive(`m/9'/1'/5'/1'/0'`).publicKey), 2_000_000n).catch((e) => log(`pay failed: ${redactErr(e)}`));
      }
    },
  });
  const bal = await balanceSettled(identityId);
  const locked = BigInt(record.lock!.lockDuffs) * CREDITS_PER_DUFF;
  st.results.create = {
    identityId, proofKind: record.proofKind, isLockAfterMs: record.isLockAfterMs, lockTxid: record.lock!.txid, burnVout: record.lock!.burnVout, creditIndex: record.lock!.creditIndex,
    lockedDash: dash(locked), balanceDash: dash(bal), createFeeCredits: (locked - bal).toString(), createFeeDash: dash(locked - bal), seconds: Math.round((Date.now() - t0) / 1000),
  };
  save(st);
  log(`create: identity ${identityId} via ${record.proofKind} proof; fee ${dash(locked - bal)} DASH`);
}

// ---- 2. voucher: mint one ourselves (burn NOT at vout 0), redeem into a new identity of phrase B --------------------------
if (steps.has('voucher')) {
  if (!st.voucher) {
    const vkey = randomBytes(32);
    const utxo = await funderUtxo();
    const lockDuffs = 300_000n; // the PLAN's 0.003 DASH starter
    const built = buildAssetLock({
      utxos: [utxo], fundingKey: qaKey, creditPubKeyHash: hash160(publicKeyOf(vkey)), lockDuffs,
      change: { script: p2pkhScript(hash160(publicKeyOf(qaKey))), duffs: utxo.value - lockDuffs - 1000n },
    });
    st.voucher = { txid: built.txid, wif: wifOf(vkey, NET), lockDuffs: lockDuffs.toString(), burnVout: built.burnVout, creditIndex: built.creditIndex };
    save(st);
    await dapi.broadcastTransaction(built.raw);
    const changeValue = utxo.value - lockDuffs - built.feeDuffs;
    st.funder = { txid: built.txid, vout: 0, value: changeValue.toString() };
    ledgerAdd('paidFromQaDuffs', lockDuffs);
    ledgerAdd('l1FeesDuffs', built.feeDuffs);
    save(st);
    log(`voucher minted: ${built.txid}, burn at vout ${built.burnVout}, credit index ${built.creditIndex}`);
  }
  const link = `dashpay://invite?assetlocktx=${st.voucher.txid}&pk=${st.voucher.wif}&islock=null`;
  const voucher = parseVoucher(link, NET);
  const wallet = SeedWallet.fromPhrase(st.phraseB!, NET);
  const t0 = Date.now();
  const r = await redeemVoucher({ voucher, wallet, identityIndex: 0, dapi, platform, onUpdate: (n) => log(`voucher: ${n}`) });
  const bal = await balanceSettled(r.identityId);
  const locked = BigInt(st.voucher.lockDuffs) * CREDITS_PER_DUFF;
  st.results.voucher = { identityId: r.identityId, proofKind: r.proofKind, voucherTxid: st.voucher.txid, burnVout: st.voucher.burnVout, creditIndex: st.voucher.creditIndex, lockedDash: dash(locked), balanceDash: dash(bal), createFeeDash: dash(locked - bal), seconds: Math.round((Date.now() - t0) / 1000) };
  save(st);
  log(`voucher: identity ${r.identityId} (${r.proofKind} proof), balance ${dash(bal)} DASH`);
}

// ---- 3. top-up identity A from external DASH -----------------------------------------------------------------------------
if (steps.has('topup')) {
  const wallet = SeedWallet.fromPhrase(st.phraseA!, NET);
  const [found] = await discoverIdentities(wallet, platform);
  if (!found) throw new Error('identity A not found; run create first');
  const index = Object.values(st.fundings).filter((f) => f.kind === 'topup' && f.state === 'done').length;
  const before = await balanceSettled(found.identityId);
  let paid = !!st.fundings[`${NET}.topup.0.${index}`]?.deposits.length;
  const t0 = Date.now();
  const { record } = await runFunding({
    wallet, dapi, platform, store, kind: 'topup', identityIndex: found.identityIndex, topUp: { identityId: found.identityId, index }, log,
    onUpdate: (v) => {
      log(`topup: ${v.state}${v.note ? ` (${v.note})` : ''}`);
      if (v.state === 'awaiting-deposit' && !paid) {
        paid = true;
        void pay(dapi, hash160(wallet.derive(`m/9'/1'/5'/2'/${found.identityIndex}'/${index}`).publicKey), 100_000n).catch((e) => log(`pay failed: ${redactErr(e)}`));
      }
    },
  });
  const after = await balanceSettled(found.identityId);
  const locked = BigInt(record.lock!.lockDuffs) * CREDITS_PER_DUFF;
  st.results.topup = { identityId: found.identityId, index, proofKind: record.proofKind, lockedDash: dash(locked), balanceBeforeDash: dash(before), balanceAfterDash: dash(after), topUpFeeCredits: (locked - (after - before)).toString(), seconds: Math.round((Date.now() - t0) / 1000) };
  save(st);
  log(`topup: +${dash(after - before)} DASH (fee ${dash(locked - (after - before))})`);
}

// ---- 4. sign in: seed discovery and key paste ----------------------------------------------------------------------------
if (steps.has('signin')) {
  const wallet = SeedWallet.fromPhrase(st.phraseA!, NET);
  const found = await discoverIdentities(wallet, platform);
  const s = await signInWithSeed(wallet, found[0]!, platform);
  const wif = wifOf(s.privateKey, NET);
  const k = await signInWithKey(wif, platform);
  st.results.signin = { discovered: found, seedSessionKeyId: s.keyId, seedSessionLevel: s.securityLevel, keySessionIdentity: k.identityId, keySessionKeyId: k.keyId };
  save(st);
  log(`signin: seed -> ${found.map((f) => `${f.identityIndex}:${f.identityId}`).join(', ')} key ${s.keyId}; key paste -> ${k.identityId} key ${k.keyId}`);
  s.end();
  k.end();
}

// ---- 5. passkey vault entry on forum.vault (PRF simulated: Node has no WebAuthn; the browser e2e covers the real ceremony) ---
if (steps.has('vault')) {
  const wallet = SeedWallet.fromPhrase(st.phraseA!, NET);
  const [found] = await discoverIdentities(wallet, platform);
  const s = await signInWithSeed(wallet, found!, platform);
  const ctx = { platform, contractId: FORUM };
  const cred = randomBytes(16);
  const prf = randomBytes(32);
  const before = await balanceSettled(s.identityId);
  await storeInVault(ctx, s, cred, recipientFromPrf(prf).publicKey);
  let opened = null;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = await openVault(ctx, { credentialId: cred, userHandle: userHandleFor(s.identityId, FORUM), prfOutput: prf }).catch((e) => (log(`vault open: ${redactErr(e)}`), null));
    if (!opened) await new Promise((r) => setTimeout(r, 3000));
  }
  const after = await balanceSettled(s.identityId);
  st.results.vault = { identityId: s.identityId, opened: !!opened, sameKey: opened ? bytesToHex(opened.privateKey) === bytesToHex(s.privateKey) : false, writeCostCredits: (before - after).toString(), writeCostDash: dash(before - after) };
  save(st);
  log(`vault: entry written and opened=${!!opened}; cost ${dash(before - after)} DASH`);
}

// ---- 6. add the on-demand keys 3..5 with a MASTER-signed IdentityUpdate (id = index, DashPay ENC/DEC bound to contactRequest) -
if (steps.has('addkeys')) {
  const wallet = SeedWallet.fromPhrase(st.phraseA!, NET);
  const [found] = await discoverIdentities(wallet, platform);
  const s = await signInWithSeed(wallet, found!, platform);
  const before = await balanceSettled(s.identityId);
  const added = await addLaterKeys(s, platform);
  let keys = await platform.identityKeys(s.identityId);
  for (let i = 0; i < 10 && (keys?.length ?? 0) < 6; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    keys = await platform.identityKeys(s.identityId);
  }
  const after = await balanceSettled(s.identityId);
  st.results.addkeys = { identityId: s.identityId, added, keys: keys?.map((k) => `${k.id}:p${k.purpose}/l${k.securityLevel}${k.bound ? '/bound' : ''}`), costCredits: (before - after).toString(), costDash: dash(before - after) };
  save(st);
  log(`addkeys: added ${added.join(',') || 'none'}; identity has ${keys?.length} keys; cost ${dash(before - after)} DASH`);
}

const results = { at: new Date().toISOString(), network: 'testnet', platformVersion: sdk.version(), ledger: st.ledger, ...st.results };
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results/live-testnet.json'), JSON.stringify(results, null, 2) + '\n');
log(`done: QA wallet paid ${Number(st.ledger.paidFromQaDuffs) / 1e8} tDASH + ${st.ledger.l1FeesDuffs} duffs fees`);
process.exit(0);
