// MAINNET bootstrap of govhub's operations identities and contracts from one operations seed (tooling, never shipped).
//
//   node --experimental-transform-types packages/auth/scripts/mainnet-bootstrap.ts <command> [args]
//
//   status                     read-only: funding UTXO, identities, keys, balances, contracts, ledger totals
//   init-utxo <txid>           record the funding output of <txid> that pays the seed's funding address (once; IS- or chain-locked)
//   fund <idx>                 pay the plan's deposit for identity <idx> and create it (runFunding); idx 3 must be done first
//   transfer-key <idx>         add key 3 TRANSFER/CRITICAL (m/9'/5'/5'/0'/0'/idx'/3') to identity 0 or 1 (MASTER-signed update)
//   contract <name>            register gov | forum | badge | mod from packages/contracts-v1/<name>.json, CRITICAL key of its owner
//   key-files                  write the server key files (bridge HIGH key, issuer HIGH key, issuer HMAC secret) under $DIR/server
//   issuer-critical <write|remove>   the issuer's CRITICAL key file for `issuer publish-keys` (remove it right after)
//
// Inputs: GOVHUB_OPS_SEED (default $DIR/ops-seed.json: {"phrase", "fundingAddress": "<addr>" | {path, address}}, 0600) and
// GOVHUB_MAINNET_DIR (default ~/.local/share/govhub-mainnet, 0700). Secrets never leave that directory and are never printed: the
// phrase and every private key are read and derived in memory. state.json and ledger.json hold public data only (txids, signed
// transactions, ids, amounts).
//
// Fund safety:
//  - every amount comes from PLAN below; nothing else is ever paid;
//  - one process at a time ($DIR/.lock): every command rewrites state.json;
//  - a payment's signed bytes are saved before the broadcast, so a rerun re-sends the same transaction instead of paying again, and a
//    new payment is only built on a parent the network has locked;
//  - a step already done (in state.json, or found on Platform) is never repeated;
//  - a contract is registered with a transition this script builds and signs at a fixed identity nonce, saved before the broadcast:
//    a rerun only re-sends those bytes (Platform refuses a replayed nonce), so one saved entry can never make two contracts.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { classifyScript, createDapi, parseTx, type Dapi } from '@govhub/dapi';
import {
  addLaterKeys, addressOf, buildPayment, bytesToHex, CREDITS_PER_DUFF, DASHPAY_CONTRACT_ID, hash160, KeyPurpose, LATER_KEYS,
  privateKeyMatches, randomBytes, redact, registrationFundingPath, runFunding, SecurityLevel, SeedWallet, signInWithSeed, wipe,
  type FundingRecord, type FundingStore, type IdentityKeyInfo, type PlatformPort,
} from '../src/index.ts';
import { classifySend, createEvoPlatform, nonceConsumed } from '../src/evo.ts';
import { bytesEqual } from '../src/bytes.ts';

const NET = 'mainnet' as const;
const EXPECTED_PLATFORM_VERSION = Number(process.env.GOVHUB_EXPECTED_PV ?? 13);
const DIR = process.env.GOVHUB_MAINNET_DIR ?? join(homedir(), '.local/share/govhub-mainnet');
const SEED_FILE = process.env.GOVHUB_OPS_SEED ?? join(DIR, 'ops-seed.json');
const STATE = join(DIR, 'state.json');
const LEDGER = join(DIR, 'ledger.json');
const LOCK = join(DIR, '.lock');
const SERVER = join(DIR, 'server');
const ISSUER_CRITICAL = join(DIR, 'issuer-critical.json');
const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../contracts-v1');
const FUNDING_PATH = "m/44'/5'/0'/0/0";
/** rs-dpp IDENTITY_NONCE_VALUE_FILTER: the low 40 bits of a stored identity nonce are the nonce, the high 24 flag missing ones. */
const NONCE_VALUE = 0xff_ffff_ffffn;

/** The owner-approved plan. Nothing outside it is ever paid. */
const PLAN: Record<number, { role: string; depositDuffs: bigint }> = {
  0: { role: 'admin (forum + badge owner)', depositDuffs: 85_000_000n },
  1: { role: 'bridge (gov owner, publisher)', depositDuffs: 130_000_000n },
  2: { role: 'moderation (mod owner)', depositDuffs: 30_000_000n },
  3: { role: 'badge issuer', depositDuffs: 3_000_000n },
};
/** Registration fees measured offline at PV13 (pv13_contracts.rs), in DASH. */
const CONTRACTS: Record<string, { owner: number; file: string; expectedFeeDash: number }> = {
  gov: { owner: 1, file: 'gov.json', expectedFeeDash: 0.27 },
  forum: { owner: 0, file: 'forum.json', expectedFeeDash: 0.42 },
  badge: { owner: 0, file: 'badge.json', expectedFeeDash: 0.22 },
  mod: { owner: 2, file: 'mod.json', expectedFeeDash: 0.14 },
};
const TRANSFER_KEY_IDENTITIES = [0, 1];
/** A one-input payment with change is ~226 B at 1 duff/B; anything far above that is a bug, never paid. */
const MAX_L1_FEE_DUFFS = 2_000n;

// ---- files ----------------------------------------------------------------------------------------------------------------
interface Utxo { txid: string; vout: number; value: string }
interface Payment { idx: number; txid: string; raw: string; to: string; duffs: string; feeDuffs: string; spent: Utxo; change: { vout: number; value: string }; createdAt: string; broadcastAt?: string }
interface ContractEntry { id: string; ownerIdx: number; ownerId: string; nonce: string; platformVersion: number; schemaSha256: string; raw: string; status: 'publishing' | 'done'; feeCredits?: string; balanceBefore: string; at: string }
interface State {
  network: 'mainnet';
  fundingAddress: string;
  funder?: { source: string; utxo: Utxo | null };
  payments: Record<string, Payment>;
  identities: Record<string, { identityId: string; lockTxid?: string; proofKind?: string; lockDuffs?: string; balanceAfterCreate?: string; createFeeCredits?: string; existedBefore?: boolean; at: string }>;
  transferKeys: Record<string, { added: number[]; costCredits: string; at: string }>;
  contracts: Record<string, ContractEntry>;
  fundings: Record<string, FundingRecord>;
}
interface LedgerEntry { at: string; step: string; kind: string; txid?: string; id?: string; duffs?: string; feeDuffs?: string; credits?: string; note?: string }

/** A 0700 directory of ours (refuses one owned by someone else). */
function ensureDir(d: string) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (statSync(d).uid !== process.getuid!()) throw new Error(`${d} is not owned by this user`);
  chmodSync(d, 0o700);
}
/** Writes 0600 via an exclusive temp file (a leftover temp is removed first, so content never sits in a looser file). */
function writePrivate(path: string, content: string) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n';
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const dash = (credits: bigint) => (Number(credits) / 1e11).toFixed(8);
const dashDuffs = (duffs: bigint) => (Number(duffs) / 1e8).toFixed(8);
/** SDK errors can echo keys: strip hex/base58/base64 runs (redact() covers 64+ hex, 50+ base58, 80+ base64; 32 bytes in base64 is 44). */
const errText = (e: unknown) => redact(String((e as Error)?.message ?? e)).replace(/[A-Za-z0-9+/]{43}=/g, '[b64]');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exclusive for the whole run; removed on exit. A leftover lock (a crash) is removed by hand after checking the pid is gone. */
function takeLock() {
  let fd: number;
  try {
    fd = openSync(LOCK, 'wx', 0o600);
  } catch {
    const pid = (() => { try { return readFileSync(LOCK, 'utf8').trim(); } catch { return '?'; } })();
    throw new Error(`another run holds ${LOCK} (pid ${pid}); if that process is gone, remove the file`);
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  process.on('exit', () => rmSync(LOCK, { force: true }));
}

function loadSeed(): { wallet: SeedWallet; fundingAddress: string } {
  const mode = statSync(SEED_FILE).mode & 0o777;
  if (mode & 0o077) throw new Error(`${SEED_FILE} must be 0600 (is ${mode.toString(8)})`);
  let raw: { phrase?: unknown; fundingAddress?: unknown };
  try {
    raw = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
  } catch {
    throw new Error('the seed file is not valid JSON'); // JSON.parse's message quotes the text around the error
  }
  const fa = raw.fundingAddress as string | { path?: unknown; address?: unknown } | undefined;
  const expected = typeof fa === 'string' ? fa : fa?.address;
  if (typeof raw.phrase !== 'string' || typeof expected !== 'string') throw new Error('seed file needs "phrase" and "fundingAddress"');
  if (typeof fa === 'object' && fa.path !== undefined && fa.path !== FUNDING_PATH) throw new Error(`seed file's funding path is not ${FUNDING_PATH}`);
  let wallet: SeedWallet;
  try {
    wallet = SeedWallet.fromPhrase(raw.phrase, NET);
  } catch {
    throw new Error('the seed file phrase is not a valid BIP39 phrase');
  }
  raw.phrase = undefined;
  const k = wallet.derive(FUNDING_PATH);
  wipe(k.privateKey);
  const fundingAddress = addressOf(k.publicKey, NET);
  if (fundingAddress !== expected) throw new Error(`the phrase's ${FUNDING_PATH} address ${fundingAddress} is not the seed file's fundingAddress`);
  return { wallet, fundingAddress };
}

// ---- run context (set up inside main's try, so every error is redacted) ---------------------------------------------------
type Evo = typeof import('@dashevo/evo-sdk');
let wallet: SeedWallet;
let fundingAddress: string;
let st: State;
let ledger: LedgerEntry[];
let evo: Evo;
let sdk: InstanceType<Evo['EvoSDK']>;
let platform: PlatformPort;
let dapi: Dapi;
/** Protocol version from proved metadata (not only the SDK's ratchet). */
let provedPv = 0;

const save = () => writePrivate(STATE, json(st));
const record = (e: Omit<LedgerEntry, 'at'>) => {
  ledger.push({ at: new Date().toISOString(), ...e });
  writePrivate(LEDGER, json(ledger));
};
const fundingKeyHash = () => {
  const k = wallet.derive(FUNDING_PATH);
  wipe(k.privateKey);
  return hash160(k.publicKey);
};
const regAddress = (idx: number) => {
  const k = wallet.derive(registrationFundingPath(NET, idx));
  wipe(k.privateKey);
  return { address: addressOf(k.publicKey, NET), h160: hash160(k.publicKey) };
};
const masterHash = (idx: number) => {
  const k = wallet.identityKey(idx, 0);
  wipe(k.privateKey);
  return hash160(k.publicKey);
};
function planIdx(arg: string | undefined): number {
  if (!arg || !/^[0-9]$/.test(arg) || !PLAN[Number(arg)]) throw new Error(`identity index must be one of ${Object.keys(PLAN).join(', ')}`);
  return Number(arg);
}
const store: FundingStore = {
  load: (k) => st.fundings[k] ?? null,
  save: (r) => ((st.fundings[r.key] = { ...r, updatedAt: Date.now() }), save()),
  remove: (k) => (delete st.fundings[k], save()),
  list: () => Object.values(st.fundings),
};

async function setup() {
  ensureDir(DIR);
  takeLock();
  ({ wallet, fundingAddress } = loadSeed());
  st = existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, 'utf8'))
    : { network: NET, fundingAddress, payments: {}, identities: {}, transferKeys: {}, contracts: {}, fundings: {} };
  if (st.network !== NET || st.fundingAddress !== fundingAddress) throw new Error('state.json belongs to another seed or network');
  ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
  evo = await import('@dashevo/evo-sdk');
  await (evo as { ensureInitialized?: () => Promise<void> }).ensureInitialized?.();
  sdk = evo.EvoSDK.mainnetTrusted({ settings: { timeoutMs: 40_000, retries: 2 } });
  await sdk.connect();
  // One proved read first: the SDK ratchets its protocol version up from proved metadata; the metadata itself is the source of truth.
  const r = await sdk.contracts.fetchWithProof(DASHPAY_CONTRACT_ID);
  provedPv = Math.max(Number(r.metadata.protocolVersion) || 0, sdk.version());
  platform = createEvoPlatform(evo, sdk, NET);
  dapi = createDapi({ network: NET });
}

async function settledBalance(id: string): Promise<bigint> {
  let prev = -1n;
  for (let i = 0; i < 15; i++) {
    const b = (await platform.balance(id)) ?? 0n;
    if (b === prev) return b;
    prev = b;
    await sleep(2500);
  }
  return prev;
}

/** Known to some node (mempool or chain)? Only NOT_FOUND counts as "unknown"; any other failure throws. */
async function txKnown(txid: string): Promise<{ height: number; isLocked: boolean } | null> {
  try {
    const { value } = await dapi.call((core, s) => core.getTransaction(txid, { signal: s }));
    return { height: value.height, isLocked: value.isInstantLocked || value.isChainLocked };
  } catch (e) {
    if ((e as { code?: number }).code === 5) return null;
    throw e;
  }
}

// ---- commands -------------------------------------------------------------------------------------------------------------
async function initUtxo(txid: string | undefined) {
  if (!txid || !/^[0-9a-f]{64}$/.test(txid)) throw new Error('usage: init-utxo <txid>');
  if (st.funder) throw new Error(`funding UTXO already recorded (from ${st.funder.source}); not replacing it`);
  const { value } = await dapi.call((core, s) => core.getTransaction(txid, { signal: s }));
  const tx = parseTx(value.raw);
  if (tx.txid !== txid) throw new Error('node returned another transaction');
  if (!value.isInstantLocked && !value.isChainLocked) throw new Error('funding tx is neither IS-locked nor chain-locked yet');
  const mine = fundingKeyHash();
  const outs = tx.outputs.flatMap((o, vout) => {
    const c = classifyScript(o.script);
    return c.type === 'p2pkh' && bytesEqual(c.hash, mine) ? [{ vout, value: o.value }] : [];
  });
  if (outs.length !== 1) throw new Error(`expected exactly one output to ${fundingAddress}, found ${outs.length}`);
  st.funder = { source: txid, utxo: { txid, vout: outs[0]!.vout, value: outs[0]!.value.toString() } };
  save();
  log(`funding UTXO ${txid}:${outs[0]!.vout} = ${dashDuffs(outs[0]!.value)} DASH at ${fundingAddress} (IS ${value.isInstantLocked}, CL ${value.isChainLocked}, height ${value.height})`);
}

/** Pays the plan's deposit for `idx` once. The signed bytes are saved before the broadcast; a rerun re-sends exactly those bytes. */
async function pay(idx: number, expectedAddress: string): Promise<string> {
  const prior = st.payments[idx];
  if (prior) {
    if (prior.to !== expectedAddress) throw new Error(`saved payment for ${idx} goes to ${prior.to}, not ${expectedAddress}`);
    if (!ledger.some((e) => e.kind === 'l1-payment' && e.txid === prior.txid))
      record({ step: `fund ${idx}`, kind: 'l1-payment', txid: prior.txid, duffs: prior.duffs, feeDuffs: prior.feeDuffs, note: `deposit to ${prior.to} (${PLAN[idx]!.role})` });
    if (!(await txKnown(prior.txid))) await dapi.broadcastTransaction(Uint8Array.from(Buffer.from(prior.raw, 'hex')));
    prior.broadcastAt ??= new Date().toISOString();
    save();
    log(`payment for identity ${idx} already made: ${prior.txid} (re-sent if needed)`);
    return prior.txid;
  }
  const u = st.funder?.utxo;
  if (!u) throw new Error('no funding UTXO recorded (run init-utxo)');
  // Only build on a parent the network has (and has locked): never on change from a transaction that was never broadcast.
  const unsent = Object.values(st.payments).filter((p) => !p.broadcastAt);
  if (unsent.length) throw new Error(`payment(s) ${unsent.map((p) => p.idx).join(', ')} were never confirmed broadcast: rerun \`fund\` for them first`);
  const parent = await txKnown(u.txid);
  if (!parent?.isLocked) throw new Error(`the funding UTXO's transaction ${u.txid} is ${parent ? 'not IS- or chain-locked yet' : 'unknown to the network'}; wait and rerun`);
  const duffs = PLAN[idx]!.depositDuffs;
  const { h160, address } = regAddress(idx);
  if (address !== expectedAddress) throw new Error('registration address mismatch');
  const fk = wallet.derive(FUNDING_PATH);
  let p: ReturnType<typeof buildPayment>;
  try {
    p = buildPayment({ utxos: [{ txid: u.txid, vout: u.vout, value: BigInt(u.value) }], key: fk.privateKey, to: [{ pubKeyHash: h160, duffs }] });
  } finally {
    wipe(fk.privateKey);
  }
  // Check the signed transaction itself: one input (the recorded UTXO), output 0 = the deposit, output 1 = change to the funding address.
  const tx = parseTx(p.raw);
  if (tx.inputs.length !== 1 || tx.inputs[0]!.prevTxid !== u.txid || tx.inputs[0]!.vout !== u.vout) throw new Error('payment spends something else');
  const o0 = classifyScript(tx.outputs[0]!.script);
  if (o0.type !== 'p2pkh' || !bytesEqual(o0.hash, h160) || tx.outputs[0]!.value !== duffs) throw new Error('payment output 0 is not the planned deposit');
  if (p.changeVout !== 1 || tx.outputs.length !== 2) throw new Error('payment has no change output');
  const ch = classifyScript(tx.outputs[1]!.script);
  if (ch.type !== 'p2pkh' || !bytesEqual(ch.hash, fundingKeyHash())) throw new Error('change does not return to the funding address');
  const fee = BigInt(u.value) - duffs - tx.outputs[1]!.value;
  if (fee < 0n || fee > MAX_L1_FEE_DUFFS) throw new Error(`payment fee ${fee} duffs is out of bounds`);
  const change = { vout: 1, value: tx.outputs[1]!.value.toString() };
  st.payments[idx] = { idx, txid: p.txid, raw: bytesToHex(p.raw), to: address, duffs: duffs.toString(), feeDuffs: fee.toString(), spent: u, change, createdAt: new Date().toISOString() };
  st.funder!.utxo = { txid: p.txid, ...change };
  save();
  record({ step: `fund ${idx}`, kind: 'l1-payment', txid: p.txid, duffs: duffs.toString(), feeDuffs: fee.toString(), note: `deposit to ${address} (${PLAN[idx]!.role}); change ${dashDuffs(BigInt(change.value))} DASH back to ${fundingAddress}` });
  await dapi.broadcastTransaction(p.raw);
  st.payments[idx]!.broadcastAt = new Date().toISOString();
  save();
  log(`paid ${dashDuffs(duffs)} DASH to ${address} in ${p.txid} (fee ${fee} duffs)`);
  return p.txid;
}

async function fund(idx: number) {
  const done = st.identities[idx];
  if (done) {
    if (done.createFeeCredits && !ledger.some((e) => e.kind === 'identity-create' && e.id === done.identityId))
      record({ step: `fund ${idx}`, kind: 'identity-create', id: done.identityId, credits: done.createFeeCredits, note: `IdentityCreate (${done.proofKind} proof)` });
    return log(`identity ${idx} already created: ${done.identityId}`);
  }
  if (idx !== 3 && !st.identities[3]) throw new Error('identity 3 (the smallest) goes first; run `fund 3` and check it');
  const { address } = regAddress(idx);
  const rec0 = Object.values(st.fundings).find((r) => r.kind === 'create' && r.identityIndex === idx && r.address === address);
  const existing = await platform.identityByUniqueKeyHash(masterHash(idx));
  if (existing) {
    // Our own funding made it (a crash before the bookkeeping): runFunding below finds it settled and finishes.
    if (st.payments[idx] && rec0?.identityId !== existing) throw new Error(`identity ${idx} exists (${existing}) but not from the recorded funding: investigate`);
    if (!st.payments[idx]) {
      st.identities[idx] = { identityId: existing, existedBefore: true, at: new Date().toISOString() };
      save();
      return log(`identity ${idx} already exists on Platform: ${existing} (nothing paid)`);
    }
  }
  if (st.payments[idx] && !rec0) throw new Error(`a payment for ${idx} is recorded but no funding record: the watcher would start after it; investigate`);
  // IS-lock proofs only (chain-lock proofs never ran on mainnet): a lock built without its IS-lock is left for a human to decide.
  if (rec0?.lock && !rec0.isLock && rec0.state !== 'done') throw new Error(`identity ${idx}: asset lock ${rec0.lock.txid} has no IS-lock recorded; a rerun would use a chain-lock proof: stop and decide by hand`);
  const ac = new AbortController();
  let paying = false;
  let payError: unknown = null;
  log(`identity ${idx} (${PLAN[idx]!.role}): deposit ${dashDuffs(PLAN[idx]!.depositDuffs)} DASH to ${address}`);
  const t0 = Date.now();
  const { identityId, record: rec } = await runFunding({
    // IS-lock proofs only (the path proven on mainnet); onUpdate aborts at 'registering' without one instead of a chain-lock proof.
    wallet, dapi, platform, store, kind: 'create', identityIndex: idx, legacy: false, isLockWaitMs: 180_000, signal: ac.signal, log: (m) => log(`  ${m}`),
    onUpdate: (v) => {
      log(`  ${v.state}${v.note ? ` (${v.note})` : ''}`);
      if (v.state === 'registering' && !v.isLocked) {
        payError = new Error(`identity ${idx}: no IS-lock for asset lock ${v.lockTxid} within the wait; stopping instead of using a chain-lock proof`);
        return ac.abort(payError);
      }
      if (v.state !== 'awaiting-deposit' || paying) return;
      paying = true;
      if (v.address !== address) {
        payError = new Error(`runFunding watches ${v.address}, expected ${address}`);
        return ac.abort(payError);
      }
      // the deposit watcher is live now: pay (or re-send the saved payment)
      pay(idx, address).catch((e) => {
        payError = e;
        ac.abort(e);
      });
    },
  }).catch((e) => {
    throw payError ?? e;
  });
  const bal = await settledBalance(identityId);
  const lockDuffs = BigInt(rec.lock!.lockDuffs);
  const fee = lockDuffs * CREDITS_PER_DUFF - bal;
  st.identities[idx] = { identityId, lockTxid: rec.lock!.txid, proofKind: rec.proofKind, lockDuffs: lockDuffs.toString(), balanceAfterCreate: bal.toString(), createFeeCredits: fee.toString(), at: new Date().toISOString() };
  save();
  record({ step: `fund ${idx}`, kind: 'asset-lock', txid: rec.lock!.txid, duffs: lockDuffs.toString(), feeDuffs: rec.lock!.feeDuffs, note: `asset lock for identity ${idx}` });
  record({ step: `fund ${idx}`, kind: 'identity-create', id: identityId, credits: fee.toString(), note: `IdentityCreate (${rec.proofKind} proof); balance ${dash(bal)} DASH` });
  log(`identity ${idx} = ${identityId}: balance ${dash(bal)} DASH, create fee ${dash(fee)} DASH, ${Math.round((Date.now() - t0) / 1000)} s`);
}

async function transferKey(idx: number) {
  if (!TRANSFER_KEY_IDENTITIES.includes(idx)) throw new Error(`the plan adds the TRANSFER key to identities ${TRANSFER_KEY_IDENTITIES.join(', ')} only`);
  const spec = LATER_KEYS[0]!;
  if (spec.id !== 3 || spec.purpose !== KeyPurpose.TRANSFER || spec.securityLevel !== SecurityLevel.CRITICAL || spec.bound) throw new Error('LATER_KEYS[0] is not key 3 TRANSFER/CRITICAL');
  if (Object.values(st.contracts).some((c) => c.status === 'publishing' && c.ownerIdx === idx)) throw new Error(`identity ${idx} has a contract registration in flight; finish it first (it holds a fixed nonce)`);
  const id = st.identities[idx]?.identityId;
  if (!id) throw new Error(`identity ${idx} not created yet`);
  const s = await signInWithSeed(wallet, { identityIndex: idx, identityId: id }, platform);
  try {
    const before = await settledBalance(id);
    const added = await addLaterKeys(s, platform, [spec]);
    // A lagging node can serve the identity without the new key for a moment: read again before judging.
    const d = wallet.identityKey(idx, 3);
    let k3: IdentityKeyInfo | undefined;
    for (let i = 0; i < 10; i++) {
      k3 = (await platform.identityKeys(id))?.find((k) => k.id === 3);
      if (k3) break;
      await sleep(3000);
    }
    const ok = !!k3 && !k3.disabled && k3.purpose === KeyPurpose.TRANSFER && k3.securityLevel === SecurityLevel.CRITICAL && privateKeyMatches(d.privateKey, k3);
    wipe(d.privateKey);
    if (!ok) throw new Error(`key 3 of ${id} is ${k3 ? `p${k3.purpose}/l${k3.securityLevel}/t${k3.type}, not the seed's TRANSFER/CRITICAL key` : 'not visible'} after the update`);
    const after = await settledBalance(id);
    if (!st.transferKeys[idx]) {
      // Added by an earlier run that stopped before its bookkeeping: its cost is the balance change since the create, valid only while
      // nothing else has spent from this identity (no contract of this owner yet).
      const base = added.length ? before : Object.values(st.contracts).some((c) => c.ownerIdx === idx) ? null : BigInt(st.identities[idx]!.balanceAfterCreate!);
      const cost = base === null ? null : base - after;
      st.transferKeys[idx] = { added: added.length ? added : [3], costCredits: cost?.toString() ?? 'unknown', at: new Date().toISOString() };
      save();
      record({ step: `transfer-key ${idx}`, kind: 'identity-update', id, credits: cost?.toString(), note: `added key 3 TRANSFER/CRITICAL${added.length ? '' : ' (in an earlier run; cost = balance change since the create)'}` });
      log(`identity ${idx}: key 3 TRANSFER/CRITICAL added, cost ${cost === null ? 'unknown' : `${dash(cost)} DASH`}`);
    } else log(`identity ${idx}: key 3 TRANSFER/CRITICAL already present`);
  } finally {
    s.end();
  }
}

/** Key-order-independent JSON for schema comparison. */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
const isNotFound = (e: unknown) => /\bNOT_FOUND\b|contract\b.*\b(?:not found|does not exist)/i.test(String((e as Error)?.message ?? e));
async function fetchContract(id: string) {
  for (let i = 0; ; i++) {
    try {
      return (await sdk.contracts.fetch(id)) ?? null;
    } catch (e) {
      if (isNotFound(e)) return null;
      if (i >= 3) throw e;
      await sleep(5000);
    }
  }
}

async function contract(name: string | undefined) {
  const c = name ? CONTRACTS[name] : undefined;
  if (!c || !name) throw new Error(`contract must be one of ${Object.keys(CONTRACTS).join(', ')}`);
  const ownerId = st.identities[c.owner]?.identityId;
  if (!ownerId) throw new Error(`owner identity ${c.owner} not created yet`);
  const other = Object.entries(st.contracts).find(([n, x]) => n !== name && x.status === 'publishing' && x.ownerIdx === c.owner);
  if (other) throw new Error(`${other[0]} (same owner) is still in flight; finish it first`);
  const nr = await sdk.identities.nonceWithProof(ownerId);
  const pv = Math.max(provedPv, Number(nr.metadata.protocolVersion) || 0);
  if (pv !== EXPECTED_PLATFORM_VERSION || sdk.version() !== EXPECTED_PLATFORM_VERSION) throw new Error(`Platform protocol version is ${pv} (SDK ${sdk.version()}), expected ${EXPECTED_PLATFORM_VERSION}: stop`);
  const rawNonce = BigInt(nr.data ?? 0n);
  const nonceNow = rawNonce & NONCE_VALUE;
  const text = readFileSync(join(CONTRACTS_DIR, c.file), 'utf8');
  const sha = createHash('sha256').update(text).digest('hex');
  const schemas = JSON.parse(text);
  const newContract = (nonce: bigint) => new evo.DataContract({ ownerId, identityNonce: nonce, schemas, fullValidation: true, platformVersion: pv } as never);
  const wantSchemas = JSON.stringify(canon((newContract(1n).toJSON(pv) as { documentSchemas: unknown }).documentSchemas));
  /** Proved read of `id` (retried while absent): 'absent', 'same' (this file's schemas, this owner) or 'other'. Read errors throw. */
  const probe = async (id: string, tries: number): Promise<'absent' | 'same' | 'other'> => {
    let back: Awaited<ReturnType<typeof fetchContract>> = null;
    for (let i = 0; i < tries && !back; i++) {
      back = await fetchContract(id);
      if (!back && i + 1 < tries) await sleep(3000);
    }
    if (!back) return 'absent';
    const same = JSON.stringify(canon((back.toJSON(pv) as { documentSchemas: unknown }).documentSchemas)) === wantSchemas && back.ownerId.toString() === ownerId;
    return same ? 'same' : 'other';
  };
  /** True when `id` is there with this file's schemas and owner; throws when something else is at that id. */
  const verify = async (id: string, tries = 20) => {
    const r = await probe(id, tries);
    if (r === 'other') throw new Error(`${id} is a contract with other schemas or another owner than ${c.file} by ${ownerId}`);
    return r === 'same';
  };
  const finish = async (e: ContractEntry, landedEarlier: boolean) => {
    let after = await settledBalance(ownerId);
    for (let i = 0; i < 10 && !landedEarlier && after === BigInt(e.balanceBefore); i++) {
      await sleep(3000);
      after = await settledBalance(ownerId);
    }
    const fee = BigInt(e.balanceBefore) - after;
    st.contracts[name] = { ...e, status: 'done', feeCredits: fee.toString() };
    save();
    record({ step: `contract ${name}`, kind: 'contract-create', id: e.id, credits: fee.toString(), note: `${c.file} by identity ${c.owner}${landedEarlier ? ' (fee: balance difference since the saved attempt)' : ''}` });
    log(`${name}: ${e.id} registered and read back (schemas match ${c.file}); fee ${dash(fee)} DASH, owner balance ${dash(after)} DASH`);
  };

  const saved = st.contracts[name];
  if (saved && saved.ownerId !== ownerId) throw new Error(`${name}: saved attempt is owned by ${saved.ownerId}, not ${ownerId}`);
  if (saved?.status === 'done') {
    if (!(await verify(saved.id))) throw new Error(`${name}: ${saved.id} is recorded as done but cannot be read back`);
    if (!ledger.some((e) => e.kind === 'contract-create' && e.id === saved.id))
      record({ step: `contract ${name}`, kind: 'contract-create', id: saved.id, credits: saved.feeCredits, note: `${c.file} by identity ${c.owner}` });
    return log(`${name}: ${saved.id} already registered; read back and schemas match ${c.file}`);
  }
  if (saved) {
    // A saved attempt is only ever re-sent as the same signed bytes, never signed again.
    if (saved.schemaSha256 !== sha) throw new Error(`${c.file} changed since the attempt that saved ${saved.id}: investigate`);
    if (await verify(saved.id, 3)) return await finish(saved, true);
    log(`${name}: re-sending the saved transition for ${saved.id} (nonce ${saved.nonce})`);
    await sdk.stateTransitions.broadcastAndWait(evo.StateTransition.fromBytes(Uint8Array.from(Buffer.from(saved.raw, 'hex')))).catch((e) => log(`${name}: broadcast (${classifySend(e)}): ${errText(e)}`));
    if (await verify(saved.id)) return await finish(saved, false);
    // A fresh proved nonce, read after the wait (the one above may be from before the broadcast).
    const fresh = BigInt((await sdk.identities.nonceWithProof(ownerId)).data ?? 0n);
    const consumed = nonceConsumed(fresh, BigInt(saved.nonce));
    throw new Error(`${name}: ${saved.id} not visible; nonce ${saved.nonce} is ${consumed ? 'USED (something else spent it, or a node lags): stop and investigate' : 'still free: rerun re-sends the same bytes; if Platform keeps refusing them, stop and investigate (never sign again at a higher nonce)'}`);
  }

  // Lost-state guard: no contract with this file's schemas may already exist at a nonce this owner has used (the id is a hash of
  // owner and nonce only, so another contract of the same owner, e.g. forum before badge, is 'other' and fine).
  for (let n = 1n; n <= nonceNow; n++) {
    const id = newContract(n).id.toString();
    if ((await probe(id, 1)) === 'same') throw new Error(`${name}: ${id} (nonce ${n}) already holds ${c.file}: it was registered before; record it instead of registering again`);
  }
  const nonce = nonceNow + 1n;
  const dc = newContract(nonce);
  const id = dc.id.toString();
  const before = await settledBalance(ownerId);
  const need = BigInt(Math.round(c.expectedFeeDash * 1.25 * 1e11));
  if (before < need) throw new Error(`${name}: owner balance ${dash(before)} DASH is below ${dash(need)} (expected fee x1.25)`);
  const identity = await sdk.identities.fetch(ownerId);
  const pub = identity?.getPublicKeyById(1);
  if (!pub) throw new Error(`owner ${ownerId} or its key 1 not found`);
  const d = wallet.identityKey(c.owner, 1);
  let raw: string;
  try {
    const info = pub.toObject() as { purpose: number; securityLevel: number; type: number; data: Uint8Array };
    if (info.purpose !== KeyPurpose.AUTHENTICATION || info.securityLevel !== SecurityLevel.CRITICAL || !privateKeyMatches(d.privateKey, { type: info.type, data: Uint8Array.from(info.data) }))
      throw new Error(`key 1 of ${ownerId} is not the seed's AUTH/CRITICAL key`);
    const t = new evo.DataContractCreateTransition(dc, nonce, pv);
    if (t.getDataContract(pv).id.toString() !== id) throw new Error(`${name}: transition contract id differs from ${id}`);
    const stt = t.toStateTransition();
    const priv = evo.PrivateKey.fromBytes(d.privateKey, NET);
    try {
      stt.sign(priv, pub);
    } finally {
      try { priv.free(); } catch { /* consumed */ }
    }
    if (stt.signaturePublicKeyId !== 1) throw new Error(`${name}: transition signed by key ${stt.signaturePublicKeyId}, expected 1`);
    raw = bytesToHex(stt.toBytes());
  } finally {
    wipe(d.privateKey);
  }
  const entry: ContractEntry = { id, ownerIdx: c.owner, ownerId, nonce: nonce.toString(), platformVersion: pv, schemaSha256: sha, raw, status: 'publishing', balanceBefore: before.toString(), at: new Date().toISOString() };
  st.contracts[name] = entry;
  save();
  log(`${name}: registering ${id} (owner ${c.owner} ${ownerId}, nonce ${nonce}, PV ${pv}, balance ${dash(before)} DASH)`);
  await sdk.stateTransitions.broadcastAndWait(evo.StateTransition.fromBytes(Uint8Array.from(Buffer.from(raw, 'hex')))).catch((e) => log(`${name}: broadcast threw (${classifySend(e)}; checking Platform): ${errText(e)}`));
  if (!(await verify(id))) throw new Error(`${name}: ${id} not visible after the broadcast; rerun \`contract ${name}\` (it only re-sends the same transition)`);
  await finish(entry, false);
}

/** The identity's on-chain key `keyId` must be this seed's key at (idx, keyId) with the given level. Returns the private key (caller wipes). */
async function checkedKey(idx: number, keyId: number, level: number): Promise<{ identityId: string; privateKey: Uint8Array }> {
  const identityId = st.identities[idx]?.identityId;
  if (!identityId) throw new Error(`identity ${idx} not created yet`);
  const k = (await platform.identityKeys(identityId))?.find((x) => x.id === keyId);
  const d = wallet.identityKey(idx, keyId);
  if (!k || k.disabled || k.purpose !== KeyPurpose.AUTHENTICATION || k.securityLevel !== level || !privateKeyMatches(d.privateKey, k)) {
    wipe(d.privateKey);
    throw new Error(`key ${keyId} of identity ${idx} is not this seed's AUTH key at level ${level}`);
  }
  return { identityId, privateKey: d.privateKey };
}
async function writeKeyFile(path: string, idx: number, keyId: number, level: number) {
  const { identityId, privateKey } = await checkedKey(idx, keyId, level);
  try {
    writePrivate(path, json({ identityId, keyId, privateKeyHex: bytesToHex(privateKey) }));
  } finally {
    wipe(privateKey);
  }
  log(`${path} (0600): identity ${idx} ${identityId}, key ${keyId}`);
}

async function keyFiles() {
  ensureDir(SERVER);
  await writeKeyFile(join(SERVER, 'bridge_identity.json'), 1, 2, SecurityLevel.HIGH);
  await writeKeyFile(join(SERVER, 'issuer_report_key.json'), 3, 2, SecurityLevel.HIGH);
  const hmac = join(SERVER, 'issuer_hmac_secret');
  if (!existsSync(hmac)) {
    const r = randomBytes(32);
    writePrivate(hmac, bytesToHex(r) + '\n');
    wipe(r);
    log(`${hmac} (0600): new random secret`);
  } else log(`${hmac} exists; kept`);
}

async function issuerCritical(action: string | undefined) {
  if (action === 'remove') {
    rmSync(ISSUER_CRITICAL, { force: true });
    return log(`${ISSUER_CRITICAL} removed`);
  }
  if (action !== 'write') throw new Error('usage: issuer-critical write|remove');
  await writeKeyFile(ISSUER_CRITICAL, 3, 1, SecurityLevel.CRITICAL);
}

async function status() {
  log(`Platform protocol ${provedPv} (SDK ${sdk.version()}); funding address ${fundingAddress}; funding UTXO ${st.funder?.utxo ? `${st.funder.utxo.txid}:${st.funder.utxo.vout} = ${dashDuffs(BigInt(st.funder.utxo.value))} DASH` : 'none recorded'}`);
  for (const idx of Object.keys(PLAN).map(Number)) {
    const onChain = await platform.identityByUniqueKeyHash(masterHash(idx));
    const saved = st.identities[idx]?.identityId;
    const bal = onChain ? await platform.balance(onChain) : null;
    const keys = onChain ? await platform.identityKeys(onChain) : null;
    log(`identity ${idx} (${PLAN[idx]!.role}): reg address ${regAddress(idx).address}; payment ${st.payments[idx]?.txid ?? '-'}; on Platform ${onChain ?? '-'}${saved && saved !== onChain ? ` (STATE SAYS ${saved})` : ''}${bal !== null ? `; balance ${dash(bal)} DASH` : ''}${keys ? `; keys ${keys.map((k) => `${k.id}:p${k.purpose}/l${k.securityLevel}${k.disabled ? '/disabled' : ''}`).join(' ')}` : ''}`);
  }
  for (const [name, c] of Object.entries(st.contracts)) log(`contract ${name}: ${c.id} ${c.status}${c.feeCredits ? ` fee ${dash(BigInt(c.feeCredits))} DASH` : ''}`);
  const l1 = ledger.filter((e) => e.kind === 'l1-payment');
  const paid = l1.reduce((a, e) => a + BigInt(e.duffs ?? 0), 0n);
  const fees = l1.reduce((a, e) => a + BigInt(e.feeDuffs ?? 0), 0n);
  const credits = ledger.filter((e) => e.credits).reduce((a, e) => a + BigInt(e.credits!), 0n);
  log(`ledger: ${ledger.length} entries; L1 deposits ${dashDuffs(paid)} DASH + ${fees} duffs fees; Platform fees ${dash(credits)} DASH`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  await setup();
  switch (cmd) {
    case 'status': return status();
    case 'init-utxo': return initUtxo(arg);
    case 'fund': return fund(planIdx(arg));
    case 'transfer-key': return transferKey(planIdx(arg));
    case 'contract': return contract(arg);
    case 'key-files': return keyFiles();
    case 'issuer-critical': return issuerCritical(arg);
    default: throw new Error('usage: status | init-utxo <txid> | fund <idx> | transfer-key <idx> | contract <gov|forum|badge|mod> | key-files | issuer-critical write|remove');
  }
}

main().then(
  () => {
    wallet?.wipe();
    process.exit(0);
  },
  (e) => {
    console.error(`error: ${errText(e)}`);
    process.exit(1);
  },
);
