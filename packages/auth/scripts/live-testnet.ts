// Live TESTNET run of @govhub/auth from Node (no browser): every flow the web app uses, against real DAPI nodes and Platform.
//
//   npx vite-node scripts/live-testnet.ts [create] [voucher] [topup] [signin] [vault]     (default: all, in that order)
//
// Funding comes from the EvoVote QA wallet through scripts/qa-funder.ts (the way spikes/sdk5 used it): payments are built by
// @govhub/auth's own tx code and broadcast over DAPI; Insight is read once for the starting UTXO (tooling only, never the app). Test key material (phrases, voucher keys) and the run state live in ~/.local/share/govhub-phase2/
// (0700 / 0600), never in the repo; nothing secret is printed. Results without secrets go to scripts/results/live-testnet.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDapi } from '@govhub/dapi';
import {
  addLaterKeys, bytesToHex, CREDITS_PER_DUFF, discoverIdentities, generatePhrase, hash160, openVault, parseVoucher,
  randomBytes, redeemVoucher, registrationFundingPath, runFunding, SeedWallet, signInWithKey, signInWithSeed, storeInVault, topUpFundingPath, wifOf,
  type FundingRecord, type FundingStore, type PlatformPort,
} from '../src/index.ts';
import { createEvoPlatform } from '../src/evo.ts';
import { userHandleFor } from '../src/vault/webauthn.ts';
import { PHASE2_DIR, qaFunder, writePrivate } from './qa-funder.ts';

const NET = 'testnet' as const;
const STATE = join(PHASE2_DIR, 'live-state.json');
const FORUM = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
const here = dirname(fileURLToPath(import.meta.url));

interface State {
  phraseA?: string;
  phraseB?: string;
  fundings: Record<string, FundingRecord>;
  /** The voucher link holds its private key: this file is 0600 outside the repo. */
  voucher?: { txid: string; link: string; lockDuffs: string; burnVout: number; creditIndex: number };
  results: Record<string, unknown>;
}

function load(): State {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { fundings: {}, results: {} };
}
const save = (s: State) => writePrivate(STATE, s);
const st = load();
const dash = (credits: bigint) => (Number(credits) / 1e11).toFixed(8);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const redactErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/[0-9a-fA-F]{64,}/g, '[hex]');

const store: FundingStore = {
  load: (k) => st.fundings[k] ?? null,
  save: (r) => ((st.fundings[r.key] = { ...r, updatedAt: Date.now() }), save(st)),
  remove: (k) => (delete st.fundings[k], save(st)),
  list: () => Object.values(st.fundings),
};

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
const funder = qaFunder(dapi);
const pay = async (h: Uint8Array, duffs: bigint) => {
  const txid = await funder.pay(h, duffs);
  log(`QA wallet paid ${Number(duffs) / 1e8} tDASH in ${txid}`);
  return txid;
};
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
        void pay(hash160(wallet.derive(registrationFundingPath(NET, 0)).publicKey), 2_000_000n).catch((e) => log(`pay failed: ${redactErr(e)}`));
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
    const lockDuffs = 300_000n; // the PLAN's 0.003 DASH starter
    const v = await funder.mintVoucher(lockDuffs);
    st.voucher = { txid: v.txid, link: v.link, lockDuffs: lockDuffs.toString(), burnVout: v.burnVout, creditIndex: 0 };
    save(st);
    log(`voucher minted: ${v.txid}, burn at vout ${v.burnVout}`);
  }
  const voucher = parseVoucher(st.voucher.link, NET);
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
        void pay(hash160(wallet.derive(topUpFundingPath(NET, found.identityIndex, index)).publicKey), 100_000n).catch((e) => log(`pay failed: ${redactErr(e)}`));
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
  await storeInVault(ctx, s, { credentialId: cred, userHandle: userHandleFor(s.identityId, FORUM), prfOutput: prf });
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

const f = funder.state();
const results = { at: new Date().toISOString(), network: 'testnet', platformVersion: sdk.version(), qaWalletSinceFunderTracking: { paidDuffs: f.spentDuffs.toString(), feesDuffs: f.feesDuffs.toString() }, ...st.results };
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results/live-testnet.json'), JSON.stringify(results, null, 2) + '\n');
log(`done: QA wallet paid ${Number(f.spentDuffs) / 1e8} tDASH + ${f.feesDuffs} duffs fees (funder.json)`);
process.exit(0);
