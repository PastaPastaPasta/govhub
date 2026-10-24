// Live TESTNET run of the MN badge, end to end, through the web app's own badge code (apps/web/src/badge: createJob/step, the
// worker operations, the reader) against the deployed issuer and Platform. Resumable; prints no keys.
//
//   npx vite-node scripts/badge-live.ts setup     # two test identities (QA wallet vouchers), pick testnet MNs
//   npx vite-node scripts/badge-live.ts request   # during the issuance window of the target epoch: tokens, refusals
//   npx vite-node scripts/badge-live.ts post      # from S(E)+margin: post, read back as another reader, tamper checks, audit
//   npx vite-node scripts/badge-live.ts comment   # A comments on a Dev-profile proposal (for the UI check: e2e/badge-live.spec.ts)
//   npx vite-node scripts/badge-live.ts standard  # Standard mode, any time an epoch with a key is current: token for the current
//                                                 # epoch, posted at once, read back, duplicate refused, tamper rejected
//   npx vite-node scripts/badge-live.ts status
//
// MN voting keys come from ~/workspace/dash-network-configs/testnet.yml (the owner key doubles as the voting key on these MNs; the
// script only uses MNs whose SML voting address matches). Test identities and the run state live in ~/.local/share/govhub-badge-live/
// (0700 / 0600). The issuer is reached at $ISSUER_URL, or through an SSH tunnel to CT 185's loopback port when unset.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToId,
  privateRequestWindow,
  EPOCH_PARAMS,
  epochOf,
  epochStart,
  idToBytes,
  parseMnBadgeDoc,
  verifyMnBadge,
} from '@govhub/badge';
import { createDapi } from '@govhub/dapi';
import { generatePhrase, parseVoucher, redeemVoucher, SeedWallet } from '@govhub/auth';
import { createEvoPlatform } from '@govhub/auth/evo';
import { signMessageWif } from '@govhub/verify';
import { qaFunder } from '../../../packages/auth/scripts/qa-funder.ts';
import { defaultRegistry } from '../src/config/registry.ts';
import { BADGE_NETWORKS, type TrustedIssuer } from '../src/badge/config.ts';
import { createJob, step, type BadgeJob, type ClientDeps } from '../src/badge/client.ts';
import { badgeQuery, badgesOfAuthors } from '../src/badge/queries.ts';
import { BadgeReader } from '../src/badge/reader.ts';
import { handleBadgeCall } from '../src/badge/workerOps.ts';

const NET = 'testnet' as const;
const P = EPOCH_PARAMS[NET];
const DIR = join(homedir(), '.local/share/govhub-badge-live');
const STATE = join(DIR, 'state.json');
const YML = join(homedir(), 'workspace/dash-network-configs/testnet.yml');
const CONTRACT = BADGE_NETWORKS.testnet.contractId;
const ISSUER: TrustedIssuer = { ...BADGE_NETWORKS.testnet.defaultIssuers[0]!, url: process.env.ISSUER_URL ?? 'http://127.0.0.1:18789' };
const FUND_DUFFS = 2_000_000n; // 0.02 tDASH per test identity

interface Ident {
  phrase: string;
  voucher?: string;
  identityId?: string;
}
interface State {
  ids: Record<'A' | 'B', Ident>;
  /** chosen MNs: yml entry name and proTxHash (keys are read from the yml at run time, never stored here) */
  mns?: { main: { name: string; proTxHash: string }; shared: Array<{ name: string; proTxHash: string }>; sharedNote: string; extra?: Array<{ name: string; proTxHash: string }> };
  epoch?: number;
  jobA?: BadgeJob;
  standardA?: BadgeJob;
  /** A's comment, where the e2e check looks for the chip */
  comment?: { govHash: string; id: string };
  results: Record<string, unknown>;
  timeline: Array<{ at: string; height: number; what: string }>;
}

mkdirSync(DIR, { recursive: true, mode: 0o700 });
chmodSync(DIR, 0o700);
const st: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { ids: { A: { phrase: generatePhrase(12) }, B: { phrase: generatePhrase(12) } }, results: {}, timeline: [] };
const save = () => {
  writeFileSync(`${STATE}.tmp`, JSON.stringify(st, null, 2), { mode: 0o600 });
  renameSync(`${STATE}.tmp`, STATE);
};
save();
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/** owner WIF and address per yml entry (the owner key is the voting key on these testnet MNs) */
function ymlKeys(): Map<string, string> {
  const out = new Map<string, string>();
  let mn: string | null = null;
  let sec: string | null = null;
  for (const l of readFileSync(YML, 'utf8').split('\n')) {
    let m = /^ {2}((?:hp-)?masternode-\d+):\s*$/.exec(l);
    if (m) {
      mn = m[1]!;
      sec = null;
      continue;
    }
    m = /^ {4}(\w+):\s*$/.exec(l);
    if (m) {
      sec = m[1]!;
      continue;
    }
    m = /^ {6}private_key:\s*(\S+)/.exec(l);
    if (m && mn && sec === 'owner') out.set(mn, m[1]!);
  }
  return out;
}

const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
const port = createEvoPlatform(evo, sdk, NET);
const registry = { ...defaultRegistry(), platformNetwork: NET } as ReturnType<typeof defaultRegistry>;
const query = (q: Parameters<typeof badgeQuery>[2]) => badgeQuery(registry, CONTRACT, q);
const coreHeight = async () => (await query(badgesOfAuthors(ISSUER.identityId, 1, [ISSUER.identityId]))).coreHeight;
const mark = async (what: string) => {
  const h = await coreHeight();
  st.timeline.push({ at: new Date().toISOString(), height: h, what });
  save();
  log(`${what} (core height ${h})`);
  return h;
};

function highKey(who: 'A' | 'B') {
  const w = SeedWallet.fromPhrase(st.ids[who].phrase, NET);
  return { id: 2, purpose: 0, securityLevel: 2, type: 0, privateKey: w.identityKey(0, 2).privateKey };
}

function deps(who: 'A' | 'B', reader: BadgeReader): ClientDeps {
  const ownerId = st.ids[who].identityId!;
  return {
    net: NET,
    contractId: CONTRACT,
    ownerId,
    issuerKey: (i, e) => reader.key(i, e),
    worker: ((call: Parameters<typeof handleBadgeCall>[0]) => handleBadgeCall(call)) as ClientDeps['worker'],
    signWithWif: (wif, m) => signMessageWif(wif, m, NET),
    externalSigner: () => undefined,
    async postBadge(data) {
      const h = await coreHeight();
      const r = await port.writeDocument({ ownerId, key: highKey(who), op: { action: 'create', contractId: CONTRACT, type: 'mnBadge', data: { ...data, $createdAtCoreBlockHeight: h } } });
      return r.id;
    },
    hasBadge: async (iid, e) => (await query(badgesOfAuthors(iid, e, [ownerId]))).docs.length > 0,
    trusted: (id) => id === ISSUER.identityId,
    reportedTokens: (i, e) => reader.reportedTokens(i, e),
    minAnonymitySet: BADGE_NETWORKS.testnet.minAnonymitySet,
  };
}
const newReader = () => new BadgeReader({ net: NET, contractId: CONTRACT, issuers: [ISSUER], query });

/** An SSH tunnel to the issuer's loopback port on CT 185, unless ISSUER_URL is set. */
async function tunnel(): Promise<() => void> {
  if (process.env.ISSUER_URL) return () => undefined;
  const p = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', '18789:127.0.0.1:8789', 'root@192.168.1.185'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await fetch('http://127.0.0.1:18789/healthz').then((r) => r.ok, () => false)) return () => p.kill();
  }
  p.kill();
  throw new Error('SSH tunnel to the issuer did not come up');
}

const cmd = process.argv[2] ?? 'status';

if (cmd === 'setup') {
  const dapi = createDapi({ network: NET });
  for (const who of ['A', 'B'] as const) {
    const it = st.ids[who];
    if (it.identityId) continue;
    if (!it.voucher) {
      it.voucher = (await qaFunder(dapi).mintVoucher(FUND_DUFFS)).link;
      save();
    }
    const r = await redeemVoucher({ voucher: parseVoucher(it.voucher, NET), wallet: SeedWallet.fromPhrase(it.phrase, NET), identityIndex: 0, dapi, platform: port, onUpdate: (n) => log(`${who}: ${n}`) });
    it.identityId = r.identityId;
    save();
    log(`identity ${who}: ${r.identityId}`);
  }
  // MNs from the yml whose SML voting address is the yml owner address; prefer a voting address shared by >= 2 MNs.
  const keys = ymlKeys();
  const { p2pkhAddress, decodeWif, hash160 } = await import('@govhub/verify');
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const addrOf = (wif: string) => p2pkhAddress(hash160(secp256k1.getPublicKey(decodeWif(wif, NET).privKey, true)), NET);
  const byAddr = new Map<string, string>();
  for (const [name, wif] of keys) byAddr.set(addrOf(wif), name);
  const sml = await dapi.getSml();
  const valid = sml.masternodes.filter((m) => m.isValid && byAddr.has(m.votingAddress));
  const groups = new Map<string, typeof valid>();
  for (const m of valid) groups.set(m.votingAddress, [...(groups.get(m.votingAddress) ?? []), m]);
  const shared = [...groups.values()].find((g) => g.length >= 2);
  const singles = valid.filter((m) => !shared?.some((s) => s.proTxHash === m.proTxHash));
  if (!singles.length) throw new Error('no valid testnet MN with a known voting key');
  const main = singles[0]!;
  st.mns = {
    main: { name: byAddr.get(main.votingAddress)!, proTxHash: main.proTxHash },
    // two more MNs, so the epoch reaches the client's minimum anonymity set (3 tokens on testnet) and A's badge is posted
    extra: singles.slice(1, 3).map((m) => ({ name: byAddr.get(m.votingAddress)!, proTxHash: m.proTxHash })),
    shared: (shared ?? []).slice(0, 2).map((m) => ({ name: byAddr.get(m.votingAddress)!, proTxHash: m.proTxHash })),
    sharedNote: shared ? `${shared.length} valid MNs share one voting key` : 'no two valid MNs in testnet.yml share a voting key',
  };
  save();
  log(`MNs: ${valid.length} valid with known voting keys; main ${st.mns.main.name}; ${st.mns.sharedNote}`);
}

if (cmd === 'request' || cmd === 'pick') {
  if (!st.ids.A.identityId || !st.mns) throw new Error('run setup first');
  if (!st.mns.extra) {
    const keys = ymlKeys();
    const { p2pkhAddress, decodeWif, hash160 } = await import('@govhub/verify');
    const { secp256k1 } = await import('@noble/curves/secp256k1.js');
    const byAddr = new Map<string, string>();
    for (const [name, wif] of keys) byAddr.set(p2pkhAddress(hash160(secp256k1.getPublicKey(decodeWif(wif, NET).privKey, true)), NET), name);
    const sml = await createDapi({ network: NET }).getSml();
    const taken = new Set([st.mns.main.proTxHash, ...st.mns.shared.map((m) => m.proTxHash)]);
    st.mns.extra = sml.masternodes
      .filter((m) => m.isValid && byAddr.has(m.votingAddress) && !taken.has(m.proTxHash))
      .slice(0, 2)
      .map((m) => ({ name: byAddr.get(m.votingAddress)!, proTxHash: m.proTxHash }));
    save();
    log(`extra MNs: ${st.mns.extra.map((m) => m.name).join(', ')}`);
  }
}

if (cmd === 'request') {
  if (!st.ids.A.identityId || !st.mns) throw new Error('run setup first');
  const close = await tunnel();
  try {
    const keys = ymlKeys();
    const h = await mark('request phase start');
    const epoch = epochOf(P, h) + 1;
    const w = privateRequestWindow(P, epoch);
    if (h < w.from || h >= w.to) throw new Error(`not inside the client issuance window of epoch ${epoch} (${w.from}..${w.to})`);
    st.epoch = epoch;
    const reader = newReader();
    // 1. A + main MN: the real client path (createJob blinds, step requests, finalizes, verifies)
    let job = st.jobA && st.jobA.epoch === epoch ? st.jobA : await createJob(deps('A', reader), [], keys.get(st.mns.main.name)!, st.mns.main.proTxHash, h, { issuer: ISSUER, keepKey: false, immediate: true, mode: 'private' });
    job = await step(deps('A', reader), job, h);
    st.jobA = job;
    save();
    st.results.tokenA = { state: job.state, note: job.note ?? null };
    await mark(`token for A from ${st.mns.main.name}: ${job.state}${job.note ? ` (${job.note})` : ''}`);
    // 2. the same MN again in the same epoch (B, a fresh blinded message): must be refused
    let dup = await createJob(deps('B', reader), [], keys.get(st.mns.main.name)!, st.mns.main.proTxHash, h, { issuer: ISSUER, keepKey: false, immediate: true, mode: 'private' });
    dup = await step(deps('B', reader), dup, h);
    st.results.secondRequestSameMn = { state: dup.state, note: dup.note ?? null, refused: dup.state === 'failed' && /already got a token/.test(dup.note ?? '') };
    await mark(`second request, same MN, same epoch: ${dup.state} (${dup.note ?? ''})`);
    // 3. two MNs that share one voting key: each gets its own token (used by B; B can post only one badge)
    const shared: unknown[] = [];
    for (const m of st.mns.shared) {
      let j = await createJob(deps('B', reader), [], keys.get(m.name)!, m.proTxHash, h, { issuer: ISSUER, keepKey: false, immediate: true, mode: 'private' });
      j = await step(deps('B', reader), j, h);
      shared.push({ mn: m.name, state: j.state, note: j.note ?? null });
      await mark(`shared-voting-key MN ${m.name}: ${j.state}${j.note ? ` (${j.note})` : ''}`);
    }
    st.results.sharedVotingKey = { note: st.mns.sharedNote, results: shared };
    // 4. two more MNs (B), so the epoch has at least the 3 tokens a badge needs before it is posted
    const extra: unknown[] = [];
    for (const m of st.mns.extra ?? []) {
      let j = await createJob(deps('B', reader), [], keys.get(m.name)!, m.proTxHash, h, { issuer: ISSUER, keepKey: false, immediate: true, mode: 'private' });
      j = await step(deps('B', reader), j, h);
      extra.push({ mn: m.name, state: j.state, note: j.note ?? null });
      await mark(`extra MN ${m.name}: ${j.state}${j.note ? ` (${j.note})` : ''}`);
    }
    st.results.extraTokens = extra;
    save();
  } finally {
    close();
  }
}

if (cmd === 'standard') {
  if (!st.ids.A.identityId || !st.mns) throw new Error('run setup first');
  const close = await tunnel();
  try {
    const keys = ymlKeys();
    const h = await mark('standard phase start');
    const reader = newReader();
    const dA = deps('A', reader);
    let job = st.standardA && st.standardA.state !== 'failed' && st.standardA.state !== 'expired' ? st.standardA : await createJob(dA, [], keys.get(st.mns.main.name)!, st.mns.main.proTxHash, h, { issuer: ISSUER, keepKey: false, mode: 'standard' });
    for (let i = 0; i < 3 && (job.state === 'scheduled' || job.state === 'token'); i++) {
      const now = await coreHeight();
      job = await step(dA, job, now);
      st.standardA = job;
      save();
      await mark(`standard A (${st.mns.main.name}, epoch ${job.epoch}): ${job.state}${job.note ? ` (${job.note})` : ''}`);
    }
    // the same MN again in the same epoch (B, a fresh blinded message): must be refused
    let dup = await createJob(deps('B', reader), [], keys.get(st.mns.main.name)!, st.mns.main.proTxHash, h, { issuer: ISSUER, keepKey: false, mode: 'standard' });
    dup = await step(deps('B', reader), dup, await coreHeight());
    st.results.standardDuplicate = { state: dup.state, note: dup.note ?? null, refused: dup.state === 'failed' && /already got a token/.test(dup.note ?? '') };
    await mark(`standard duplicate, same MN, same epoch: ${dup.state} (${dup.note ?? ''})`);
    // read back as another reader; a tampered copy is rejected
    const other = newReader();
    const A = st.ids.A.identityId!;
    const view = await other.badgesFor([A]);
    const docs = (await query(badgesOfAuthors(ISSUER.identityId, job.epoch, [A]))).docs;
    const doc = parseMnBadgeDoc(docs[0]!);
    const key = (await other.key(ISSUER, job.epoch)).key!;
    const cfg = { net: NET, contractId: idToBytes(CONTRACT) };
    const bad = doc.sig.slice();
    bad[17]! ^= 1;
    st.results.standard = {
      epoch: job.epoch,
      state: job.state,
      readBack: view.byOwner.get(A) ?? null,
      original: await verifyMnBadge(cfg, key, doc, view.coreHeight),
      tamperedSig: await verifyMnBadge(cfg, key, { ...doc, sig: bad }, view.coreHeight),
      copiedToB: await verifyMnBadge(cfg, key, { ...doc, ownerId: idToBytes(st.ids.B.identityId!) }, view.coreHeight),
      badgeHeight: doc.createdAtCoreBlockHeight,
    };
    save();
    await mark(`standard read back: ${JSON.stringify(st.results.standard)}`);
  } finally {
    close();
  }
}

if (cmd === 'post') {
  if (!st.jobA || st.jobA.state === 'scheduled') throw new Error('no token yet: run request during the issuance window');
  const epoch = st.jobA.epoch;
  const h = await coreHeight();
  const from = epochStart(P, epoch) + P.boundaryMarginBlocks;
  if (h < from) throw new Error(`badges for epoch ${epoch} may be posted from core height ${from}; now ${h} (${from - h} blocks to go)`);
  const reader = newReader();
  // the client posts only once the issuer's report shows enough tokens; the issuer publishes it when the window closes
  for (let i = 0; st.jobA.state === 'token' && i < 60; i++) {
    const now = await coreHeight();
    st.jobA = await step(deps('A', reader), { ...st.jobA, postAt: Math.min(st.jobA.postAt ?? now, now) }, now);
    save();
    await mark(`A posting step: ${st.jobA.state}${st.jobA.note ? ` (${st.jobA.note})` : ''}`);
    if (st.jobA.state === 'token') await new Promise((r) => setTimeout(r, 60_000));
  }
  // tamper 1: B posts an exact copy of A's badge under its own identity (copy to another identity)
  if (!st.results.copyPosted) {
    const d = deps('B', reader);
    if (!(await d.hasBadge(ISSUER.identityId, epoch))) {
      const j = st.jobA;
      await d.postBadge({ issuerId: idToBytes(ISSUER.identityId), epoch, keyId: Buffer.from(j.keyId, 'hex'), msgPrefix: base64ToBytes(j.msgPrefix), sig: base64ToBytes(j.sig!) });
    }
    st.results.copyPosted = true;
    save();
    await mark('B posted a copy of A’s badge');
  }
  // read back as another reader (fresh SDK connection inside badgeQuery's cache is the app's; a new BadgeReader has no state)
  const other = newReader();
  const A = st.ids.A.identityId!;
  const B = st.ids.B.identityId!;
  const view = await other.badgesFor([A, B]);
  st.results.readBack = { A: view.byOwner.get(A) ?? null, B: view.byOwner.get(B) ?? null, coreHeight: view.coreHeight };
  // tamper 2: flip one bit of A's signature locally
  const docs = (await query(badgesOfAuthors(ISSUER.identityId, epoch, [A]))).docs;
  const doc = parseMnBadgeDoc(docs[0]!);
  const key = (await other.key(ISSUER, epoch)).key!;
  const cfg = { net: NET, contractId: idToBytes(CONTRACT) };
  const okA = await verifyMnBadge(cfg, key, doc, view.coreHeight);
  const bad = doc.sig.slice();
  bad[17]! ^= 1;
  const tampered = await verifyMnBadge(cfg, key, { ...doc, sig: bad }, view.coreHeight);
  const copied = await verifyMnBadge(cfg, key, { ...doc, ownerId: idToBytes(B) }, view.coreHeight);
  st.results.verify = { original: okA, tamperedSig: tampered, copiedToB: copied };
  st.results.audit = await other.audit(ISSUER, epoch, view.coreHeight).then((a) => ({ badges: a.badges, tokensIssued: a.tokensIssued, flagged: a.flagged, keyProblem: a.keyProblem }));
  st.results.badgeDoc = { id: st.jobA.badgeId ?? null, owner: bytesToId(doc.ownerId), createdAtCoreBlockHeight: doc.createdAtCoreBlockHeight, sigBytes: doc.sig.length, msgPrefix: bytesToBase64(doc.msgPrefix).length };
  save();
  await mark(`read back: A=${JSON.stringify(st.results.readBack)} verify=${JSON.stringify(st.results.verify)} audit=${JSON.stringify(st.results.audit)}`);
}

if (cmd === 'keys') {
  // the published issuerKey documents, as a fresh reader accepts them (proved queries, reader rules)
  const r = newReader();
  const out: Record<number, string> = {};
  for (let e = 2741; e <= 2756; e++) {
    const k = await r.key(ISSUER, e);
    out[e] = k.key ? `ok ${Buffer.from(k.key.key.keyId).toString('hex').slice(0, 16)}… ${k.key.key.modulusBytes * 8}-bit` : `no: ${k.problem}`;
  }
  st.results.issuerKeys = out;
  save();
  console.log(JSON.stringify(out, null, 2));
}

if (cmd === 'comment' && !st.comment) {
  const { forumOps } = await import('@govhub/forum');
  const { PROFILES } = await import('../src/config/registry.ts');
  const dev = PROFILES.dev;
  const govHash = '32892957257817ac823f59813e0601b13e30aa0ba68ce9ac9795566f6bd37a84'; // a live mainnet proposal in the Dev profile
  const op = forumOps({ forum: dev.forum!.contractId, mod: dev.forum!.modContractId, gov: dev.govContractId }).comment(govHash, 'govhub badge live test: this comment should carry "MN · vouched by govhub" once the epoch-2742 badge is posted.');
  const r = await port.writeDocument({ ownerId: st.ids.A.identityId!, key: highKey('A'), op: op as never });
  st.comment = { govHash, id: r.id };
  save();
  await mark(`A commented on ${govHash.slice(0, 12)}…: ${r.id}`);
}

if (cmd === 'status' || cmd === 'post' || cmd === 'request') {
  const h = await coreHeight();
  const e = st.epoch ?? epochOf(P, h) + 1;
  console.log(
    JSON.stringify(
      {
        coreHeight: h,
        targetEpoch: e,
        privateRequestWindow: privateRequestWindow(P, e),
        postFrom: epochStart(P, e) + P.boundaryMarginBlocks,
        identities: { A: st.ids.A.identityId ?? null, B: st.ids.B.identityId ?? null },
        mns: st.mns ? { main: st.mns.main.name, shared: st.mns.shared.map((m) => m.name), note: st.mns.sharedNote } : null,
        jobA: st.jobA ? { state: st.jobA.state, note: st.jobA.note ?? null, epoch: st.jobA.epoch } : null,
        comment: st.comment ?? null,
        results: st.results,
        timeline: st.timeline,
      },
      null,
      2,
    ),
  );
}
process.exit(0);
