// Live TESTNET check of the deferred Standard badge (PLAN §8.10), through the web app's own code: the badge scheduler
// (badge/scheduler.ts), the write hook every Platform write goes through (auth/runtime.ts markWrites), the encrypted job store,
// the worker operations against the deployed issuer, and the reader. Prints no keys.
//
//   npx vite-node scripts/badge-deferred-live.ts [who]     # who: a test identity in $QA_DIR/identities.json (default alice)
//
// 1. A Standard token for the current epoch, with a non-reserved testnet MN that has none yet (the issuer refuses the others).
// 2. Held: the scheduler ticks for the whole half-hour cooldown; no mnBadge for the identity appears on Platform.
// 3. A comment inside the cooldown: still no badge.
// 4. A comment after the cooldown: the badge is posted with it, and a fresh reader verifies it.
// State (the browser's localStorage stand-in, with the encrypted job store) lives in ~/.local/share/govhub-badge-deferred-live/.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EPOCH_PARAMS, epochOf, idToBytes, parseMnBadgeDoc, verifyMnBadge } from '@govhub/badge';
import { createDapi } from '@govhub/dapi';
import { createEvoPlatform } from '@govhub/auth/evo';
import { decodeWif, hash160, p2pkhAddress, signMessageWif } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { defaultRegistry, PROFILES } from '../src/config/registry.ts';
import { BADGE_NETWORKS, type TrustedIssuer } from '../src/badge/config.ts';
import { checkKeyAvailability, createJob, isHeld, type BadgeJob, type ClientDeps } from '../src/badge/client.ts';
import { badgeQuery, badgesOfAuthors } from '../src/badge/queries.ts';
import { BadgeReader } from '../src/badge/reader.ts';
import { createScheduler } from '../src/badge/scheduler.ts';
import { deriveStoreKey, encryptedJobStore } from '../src/badge/store.ts';
import { COOLDOWN_MS, onIdentityWrite, requestCooldownLeft } from '../src/badge/visit.ts';
import { handleBadgeCall } from '../src/badge/workerOps.ts';
import { RESERVED_TESTNET_MNS, testnetMnKeys } from './testnet-mn-keys.ts';

const NET = 'testnet' as const;
const P = EPOCH_PARAMS[NET];
const QA_DIR = join(homedir(), '.local/share/evovote-v2-qa-20261018');
const DIR = join(homedir(), '.local/share/govhub-badge-deferred-live');
const LS = join(DIR, 'localStorage.json');
const OUT = join(DIR, 'results.json');
const CONTRACT = BADGE_NETWORKS.testnet.contractId;
const ISSUER: TrustedIssuer = BADGE_NETWORKS.testnet.defaultIssuers[0]!;
/** MNs that already hold tokens for some epochs (other runs): not tried first */
const BUSY = new Set(['masternode-13', 'masternode-14', 'hp-masternode-9']);
const GOV_HASH = '32892957257817ac823f59813e0601b13e30aa0ba68ce9ac9795566f6bd37a84'; // a live mainnet proposal in the Dev profile

mkdirSync(DIR, { recursive: true, mode: 0o700 });
chmodSync(DIR, 0o700);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// this "browser's" localStorage, kept in a 0600 file (the job store in it is AES-GCM encrypted, as in the app)
const mem = new Map<string, string>(existsSync(LS) ? Object.entries(JSON.parse(readFileSync(LS, 'utf8')) as Record<string, string>) : []);
const persist = () => writeFileSync(LS, JSON.stringify(Object.fromEntries(mem)), { mode: 0o600 });
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => (mem.set(k, v), persist()), removeItem: (k: string) => (mem.delete(k), persist()) };
(globalThis as { localStorage?: unknown }).localStorage = storage;

const who = process.argv[2] ?? 'alice';
const ident = (JSON.parse(readFileSync(join(QA_DIR, 'identities.json'), 'utf8')) as { items: Array<{ name: string; identityId: string }> }).items.find((i) => i.name === who);
if (!ident) throw new Error(`no identity ${who}`);
const ownerId = ident.identityId;
const highWif = readFileSync(join(QA_DIR, `${who}.high.wif`), 'utf8').trim(); // never printed
const highKey = { id: 2, purpose: 0, securityLevel: 2, type: 0, privateKey: decodeWif(highWif, NET).privKey };

const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
const { markWrites } = await import('../src/auth/runtime.ts');
const port = markWrites(createEvoPlatform(evo, sdk, NET)); // every write announced first, as in the app
const registry = { ...defaultRegistry(), platformNetwork: NET } as ReturnType<typeof defaultRegistry>;
const query = (q: Parameters<typeof badgeQuery>[2]) => badgeQuery(registry, CONTRACT, q);
const coreHeight = async () => (await query(badgesOfAuthors(ISSUER.identityId, 1, [ISSUER.identityId]))).coreHeight;
const newReader = () => new BadgeReader({ net: NET, contractId: CONTRACT, issuers: [ISSUER], query });
const reader = newReader();
const badgesNow = async (epoch: number) => (await query(badgesOfAuthors(ISSUER.identityId, epoch, [ownerId]))).docs;

const deps: ClientDeps = {
  net: NET,
  contractId: CONTRACT,
  ownerId,
  issuerKey: (i, e) => reader.key(i, e),
  worker: ((call: Parameters<typeof handleBadgeCall>[0]) => handleBadgeCall(call)) as ClientDeps['worker'],
  signWithWif: (wif, m) => signMessageWif(wif, m, NET),
  externalSigner: () => undefined,
  async postBadge(data) {
    const h = await coreHeight();
    return (await port.writeDocument({ ownerId, key: highKey, op: { action: 'create', contractId: CONTRACT, type: 'mnBadge', data: { ...data, $createdAtCoreBlockHeight: h } } })).id;
  },
  hasBadge: async (iid, e) => (await query(badgesOfAuthors(iid, e, [ownerId]))).docs.length > 0,
  trusted: (id) => id === ISSUER.identityId,
  reportedTokens: (i, e) => reader.reportedTokens(i, e),
  issuerFlagged: async (i, e) => (await reader.audit({ ...i, enabled: true }, e, await coreHeight())).flagged,
  minAnonymitySet: BADGE_NETWORKS.testnet.minAnonymitySet,
};

const store = encryptedJobStore(`${ownerId}.2`, ownerId, await deriveStoreKey(highKey.privateKey, ownerId), storage);
const commit = async (m: (j: BadgeJob[]) => BadgeJob[]) => {
  const n = m(await store.load());
  await store.save(n);
  return n;
};
const sched = createScheduler({ net: NET, deps, store, commit, coreHeight, trust: () => [ISSUER], hasSigner: () => false, lock: (_n, fn) => fn(), live: () => true });
// the provider's write hook: this identity's writes carry a held badge (not awaited by the write)
const pending: Promise<unknown>[] = [];
onIdentityWrite((w) => void (w === ownerId && pending.push(sched.postHeld({ force: false }))));

const results: Record<string, unknown> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 2), { mode: 0o600 });

async function comment(text: string): Promise<{ id: string; height: number }> {
  const { forumOps } = await import('@govhub/forum');
  const dev = PROFILES.dev;
  const op = forumOps({ forum: dev.forum!.contractId, mod: dev.forum!.modContractId, gov: dev.govContractId }).comment(GOV_HASH, text);
  const r = await port.writeDocument({ ownerId, key: highKey, op: op as never });
  await Promise.all(pending.splice(0)); // the badge post the hook started alongside
  return { id: r.id, height: await coreHeight() };
}

// ---- 0. where we are
const h0 = await coreHeight();
const epoch = epochOf(P, h0);
const av = await checkKeyAvailability((i, e) => reader.key(i, e), ISSUER, NET, h0);
log(`core height ${h0}, epoch ${epoch}; Standard key: ${JSON.stringify(av.modes.find((m) => m.mode === 'standard'))}`);
if ((await badgesNow(epoch)).length) throw new Error(`${who} already has a badge for epoch ${epoch}: use another identity`);
results.identity = { who, ownerId };
results.epoch = epoch;

// ---- 1. a Standard token, held
let job = (await store.load()).find((j) => j.epoch === epoch && j.mode === 'standard' && (j.state === 'token' || j.state === 'posted'));
if (!job) {
  await sched.tick(); // the app was already open (no first-tick delay for a job made mid-visit)
  const sml = await createDapi({ network: NET }).getSml();
  const addrOf = (wif: string) => p2pkhAddress(hash160(secp256k1.getPublicKey(decodeWif(wif, NET).privKey, true)), NET);
  const keys = testnetMnKeys().filter((k) => !RESERVED_TESTNET_MNS.has(k.name));
  const candidates = [...keys.filter((k) => !BUSY.has(k.name)), ...keys.filter((k) => BUSY.has(k.name))];
  for (const k of candidates) {
    const mn = sml.masternodes.find((m) => m.isValid && m.votingAddress === addrOf(k.wif));
    if (!mn) continue;
    const j = { ...(await createJob(deps, await store.load(), k.wif, mn.proTxHash, await coreHeight(), { issuer: ISSUER, mode: 'standard' })), quietExtraMs: 0 };
    await commit((l) => [...l, j]);
    await sched.tick();
    const after = (await store.load()).find((x) => x.id === j.id)!;
    log(`${k.name}: ${after.state}${after.note ? ` (${after.note})` : ''}`);
    if (after.state === 'token') {
      results.mn = k.name;
      results.tokenAt = { ms: Date.now(), height: await coreHeight() };
      job = after;
      break;
    }
    // refused (this MN already has a token this epoch): the test harness clears the mark and tries the next MN
    storage.removeItem('govhub.badge.lastRequestMs');
  }
  if (!job) throw new Error('no MN got a token');
  save();
}
if (job.state !== 'token' || !isHeld(job)) throw new Error(`job is ${job.state}, not held`);
results.held = { state: job.state, hasSig: !!job.sig, proTxHashKept: !!job.proTxHash, inPlainStorage: [...mem.values()].some((v) => v.includes(job!.sig!)) };
log(`token held: ${JSON.stringify(results.held)}`);

// ---- 2. held for the whole cooldown: the scheduler ticks, nothing is posted
const checks: Array<{ minute: number; badges: number; state: string }> = [];
let commented = false;
while (requestCooldownLeft() > 0) {
  await sched.tick();
  const minute = Math.round((COOLDOWN_MS - requestCooldownLeft()) / 60_000);
  const n = (await badgesNow(epoch)).length;
  const state = (await store.load()).find((x) => x.id === job!.id)!.state;
  checks.push({ minute, badges: n, state });
  log(`minute ${minute}: ${n} badge(s) on Platform, job ${state}`);
  if (n) throw new Error('a badge appeared while held');
  // ---- 3. a comment inside the cooldown does not carry it
  if (!commented && minute >= 5) {
    const c = await comment('govhub badge live test (deferred Standard): a comment inside the half-hour cooldown; no badge should go with it.');
    commented = true;
    const n2 = (await badgesNow(epoch)).length;
    results.commentInsideCooldown = { ...c, minute, badgesAfter: n2 };
    log(`comment inside the cooldown ${c.id} at ${c.height}: ${n2} badge(s)`);
    if (n2) throw new Error('the badge went with a write inside the cooldown');
    save();
  }
  await sleep(Math.min(60_000, requestCooldownLeft() + 2_000));
}
results.heldChecks = checks;
save();

// ---- 4. the next comment carries it
const c = await comment('govhub badge live test (deferred Standard): the first comment after the cooldown; the MN badge goes with it.');
const docs = await badgesNow(epoch);
const after = (await store.load()).find((x) => x.id === job!.id)!;
log(`comment ${c.id} at ${c.height}: ${docs.length} badge(s); job ${after.state}`);
const doc = docs[0] ? parseMnBadgeDoc(docs[0]) : null;
const other = newReader();
const view = await other.badgesFor([ownerId]);
const key = (await other.key(ISSUER, epoch)).key;
results.afterCooldown = {
  comment: c,
  job: { state: after.state, badgeId: after.badgeId ?? null, sigKept: !!after.sig },
  badgeDoc: doc ? { createdAtCoreBlockHeight: doc.createdAtCoreBlockHeight, owner: ownerId } : null,
  readBack: view.byOwner.get(ownerId) ?? null,
  verifies: doc && key ? await verifyMnBadge({ net: NET, contractId: idToBytes(CONTRACT) }, key, doc, view.coreHeight) : null,
};
save();
log(`result: ${JSON.stringify(results.afterCooldown)}`);
process.exit(0);
