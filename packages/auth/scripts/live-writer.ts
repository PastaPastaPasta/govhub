// Live TESTNET check of the document writer (evo.ts writeDocument) on the forum contract: create, replace and delete, each through
// the paths that settle by proved state. testnet runs protocol 14, so creates take the hand-built path (nonce = proved
// identity-contract nonce + 1, id known up front).
//
//   npx vite-node scripts/live-writer.ts [u3|u6|owner] [cache]      (default u6; spends tDASH; `cache`: only the nonce-cache probe)
//
// Faults are injected between the writer and a real SDK; every write still goes to testnet:
//   landed-timeout  the real broadcastAndWait succeeds, then the writer is told "timeout" (an attempt that landed, error seen)
//   future          the first broadcast is answered "nonce too far in future" without sending (a lagging node): the SAME signed
//                   transition must be re-sent
//   stale-nonce     the first proved nonce read is served one lower (a lagging node): the real network answers "nonce already
//                   present", the writer must sign again with a fresh nonce (create: only after proving its own id absent)
// plus real refusals: a replace repeated after it landed (stale revision) and a delete of a deleted document. Keys come from
// ~/.local/share/govhub-phase0/testnet/state.json at run time; nothing secret is printed or written. Results without secrets:
// scripts/results/live-writer.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySend, createEvoPlatform } from '../src/evo.ts';
import { hexToBytes, randomBytes } from '../src/bytes.ts';
import type { DocumentWrite, SigningKey } from '../src/platform.ts';

const FORUM = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
const here = dirname(fileURLToPath(import.meta.url));
const who = (process.argv[2] ?? 'u6') as 'u3' | 'u6' | 'owner';
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const short = (m: string) => m.replace(/[0-9a-fA-F]{64,}/g, '[hex]').slice(0, 220);
const dash = (credits: bigint) => (Number(credits) / 1e11).toFixed(8);

const state = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase0/testnet/state.json'), 'utf8')) as { items: Array<{ name: string; identityId: string; keys: Array<{ keyId: number; purpose: string; securityLevel: string; hex: string }> }> };
const item = state.items.find((i) => i.name === who)!;
const high = item.keys.find((k) => k.purpose === 'authentication' && k.securityLevel === 'high')!;
const ownerId = item.identityId;
const key: SigningKey = { id: high.keyId, purpose: 0, securityLevel: 2, type: 0, privateKey: hexToBytes(high.hex) };

const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
log(`connected: Platform protocol ${sdk.version()}, identity ${who} ${ownerId}`);

// ---- fault injection between the writer and the SDK ----
type Fault = 'landed-timeout' | 'future';
const faults = { broadcast: [] as Fault[], staleNonce: 0 };
let events: string[] = [];
const sent: string[] = []; // transition hashes, in order
const wrapped = {
  version: () => sdk.version(),
  get wasm() {
    return sdk.wasm;
  },
  documents: sdk.documents,
  identities: new Proxy(sdk.identities, {
    get(t, p) {
      if (p === 'contractNonceWithProof')
        return async (id: string, c: string) => {
          const r = await t.contractNonceWithProof(id, c);
          const raw = BigInt(r.data ?? 0n);
          if (faults.staleNonce && raw > 0n) {
            faults.staleNonce--;
            events.push(`nonce read served stale (${raw - 1n} for ${raw})`);
            return { data: raw - 1n, metadata: r.metadata };
          }
          events.push(`nonce read ${raw} at height ${r.metadata.height}`);
          return r;
        };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }),
  stateTransitions: {
    async broadcastAndWait(st: import('@dashevo/evo-sdk').StateTransition) {
      const f = faults.broadcast.shift();
      const h = st.hash(false);
      sent.push(h);
      events.push(`send #${sent.length} nonce ${st.identityContractNonce} ${h.slice(0, 12)}${f ? ` [${f}]` : ''}`);
      if (f === 'future') throw { message: 'simulated lagging node: invalid identity nonce, error is nonce too far in future', code: 40204, name: 'StateTransitionBroadcastError' };
      try {
        const r = await sdk.stateTransitions.broadcastAndWait(st);
        if (f === 'landed-timeout') throw { message: 'simulated: timeout reached after the transition executed', code: -1, name: 'TimeoutReached' };
        return r;
      } catch (e) {
        const m = (e as { message?: string }).message ?? String(e);
        if (!m.startsWith('simulated')) events.push(`real error (${classifySend(e)}): ${short(m)}`);
        throw e;
      }
    },
  },
};
const platform = createEvoPlatform(evo, wrapped as never, 'testnet');

async function balanceSettled(): Promise<bigint> {
  let prev = -1n;
  for (let i = 0; i < 12; i++) {
    const b = (await platform.balance(ownerId)) ?? 0n;
    if (b === prev) return b;
    prev = b;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return prev;
}
const readDoc = async (id: string) => (await sdk.documents.getWithProof(FORUM, 'reaction', id)).data;
async function eventually(f: () => Promise<boolean>) {
  for (let i = 0; i < 10; i++) {
    if (await f()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

const reaction = (value: 1 | -1, target = randomBytes(32)): DocumentWrite => {
  const t = Date.now();
  return { action: 'create', contractId: FORUM, type: 'reaction', data: { $createdAt: t, $updatedAt: t, target, kind: 2, value } };
};
const flip = (id: string, revision: number, target: Uint8Array, value: 1 | -1): DocumentWrite => ({ action: 'replace', contractId: FORUM, type: 'reaction', id, revision, data: { $updatedAt: Date.now(), target, kind: 2, value } });
const del = (id: string): DocumentWrite => ({ action: 'delete', contractId: FORUM, type: 'reaction', id });

const results: Array<Record<string, unknown>> = [];
async function step(name: string, op: DocumentWrite, setup: () => void, expect: 'done' | RegExp) {
  events = [];
  const before = sent.length;
  setup();
  const t0 = Date.now();
  let outcome: string;
  let id: string | undefined;
  try {
    const r = await platform.writeDocument({ ownerId, key, op });
    id = r.id;
    outcome = `done ${r.id}${r.revision ? ` rev ${r.revision}` : ''}`;
  } catch (e) {
    outcome = `error: ${short((e as Error).message)}`;
  }
  const ok = expect === 'done' ? outcome.startsWith('done') : expect.test(outcome);
  const hashes = sent.slice(before);
  results.push({ step: name, ok, outcome, ms: Date.now() - t0, sends: hashes.length, distinctTransitions: new Set(hashes).size, events });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${outcome} (${hashes.length} sends, ${new Set(hashes).size} signed)`);
  for (const e of events) log(`     ${e}`);
  faults.broadcast = [];
  faults.staleNonce = 0;
  return id;
}

const start = await balanceSettled();
log(`balance ${dash(start)} tDASH`);
if (start < 1_500_000_000n) throw new Error('identity balance below 0.015 tDASH; top it up first');

const cacheOnly = process.argv[3] === 'cache';
if (!cacheOnly) {
  // creates (PV14 hand-built path)
  const tA = randomBytes(32);
  const a = (await step('create (plain)', reaction(1, tA), () => {}, 'done'))!;
  const b = await step('create, landed but the client saw a timeout', reaction(1), () => (faults.broadcast = ['landed-timeout']), 'done');
  const c = await step('create, "too far in future" from a lagging node: same transition re-sent', reaction(1), () => (faults.broadcast = ['future']), 'done');
  const d = await step('create, stale nonce read: real "nonce already present", signed again', reaction(1), () => (faults.staleNonce = 1), 'done');
  // every create is stored exactly once under the id the writer returned
  for (const id of [a, b, c, d]) if (id && !(await eventually(async () => !!(await readDoc(id))))) results.push({ step: `verify ${id}`, ok: false, outcome: 'missing' });

  // replace
  await step('replace, landed but the client saw a timeout', flip(a, 1, tA, -1), () => (faults.broadcast = ['landed-timeout']), 'done');
  await step('replace repeated after it landed: real stale-revision refusal, settled as done', flip(a, 1, tA, -1), () => {}, 'done');
  await step('replace, stale nonce read: real "nonce already present", signed again', flip(a, 2, tA, 1), () => (faults.staleNonce = 1), 'done');
  await step('replace with someone else\'s revision: a real refusal stays an error', flip(a, 1, tA, 1), () => {}, /error/);

  // delete
  await step('delete, landed but the client saw a timeout', del(a), () => (faults.broadcast = ['landed-timeout']), 'done');
  await step('delete of a deleted document: fails fast', del(a), () => {}, /Nothing to delete/);
  if (b) await step('delete, "too far in future": same transition re-sent', del(b), () => (faults.broadcast = ['future']), 'done');
  if (c) await step('delete, stale nonce read: signed again', del(c), () => (faults.staleNonce = 1), 'done');
  if (d) await step('delete (plain)', del(d), () => {}, 'done');
}

// ---- the SDK's nonce cache (what the facade writes use; the writer does not) ----
// A facade create caches the identity-contract nonce; a write that bypasses the cache (the writer) spends the next one; the next
// facade create then signs a spent nonce unless the cache is refreshed. Which refresh works: settings.identityNonceStaleTimeS: 0,
// or sdk.wasm.refreshIdentityNonce?
const cacheProbe: Record<string, string> = {};
{
  const identity = (await sdk.identities.fetchWithProof(ownerId)).data!;
  const idKey = identity.getPublicKeyById(key.id)!;
  const owner = Uint8Array.from(identity.id.toBytes());
  const contractBytes = evo.Identifier.fromBase58(FORUM).toBytes();
  const made: string[] = [];
  const facadeCreate = async (label: string, settings?: Record<string, unknown>) => {
    const signer = new evo.IdentitySigner();
    signer.addKey(evo.PrivateKey.fromBytes(key.privateKey, 'testnet'));
    const t = Date.now();
    const document = evo.Document.fromObject(
      { $formatVersion: '0', $id: new Uint8Array(32), $ownerId: owner, $dataContractId: contractBytes, $type: 'reaction', $revision: 1n, $entropy: randomBytes(32), $createdAt: BigInt(t), $updatedAt: BigInt(t), target: randomBytes(32), kind: 2n, value: 1n } as never,
      evo.PlatformVersion.latest(),
    );
    try {
      const doc = await sdk.documents.create({ document, identityKey: idKey, signer, ...(settings ? { settings } : {}) } as never);
      made.push(doc.id.toString());
      cacheProbe[label] = 'ok';
    } catch (e) {
      cacheProbe[label] = `error (${classifySend(e)}): ${short((e as { message?: string }).message ?? String(e))}`;
    }
    log(`nonce cache: ${label}: ${cacheProbe[label]}`);
  };
  // A write that bypasses the cache, then a pause so every node has it: a facade nonce fetch right after it can come from a node
  // that lags (and max(cached, platform) then keeps the spent value), which would blur what the refresh did.
  const bypass = async (label: string) => {
    events = [];
    const r = await platform.writeDocument({ ownerId, key, op: reaction(1) });
    made.push(r.id);
    cacheProbe[label] = events.join('; ');
    await new Promise((res) => setTimeout(res, 10_000));
  };
  // the control (no refresh) runs last: the SDK may refresh the cache itself after a failed broadcast
  await facadeCreate('1 facade create (fills the cache)');
  await bypass(`bypass ${Object.keys(cacheProbe).length}`);
  await facadeCreate('2 facade create with identityNonceStaleTimeS: 0 (cache last fetched seconds ago)', { identityNonceStaleTimeS: 0 });
  await bypass(`bypass ${Object.keys(cacheProbe).length}`);
  await sdk.wasm.refreshIdentityNonce(evo.Identifier.fromBase58(ownerId));
  await facadeCreate('3 facade create after refreshIdentityNonce');
  await bypass(`bypass ${Object.keys(cacheProbe).length}`);
  await facadeCreate('4 control: facade create after a cache-bypassing write, no refresh');
  for (const id of made) await step(`cleanup delete ${id.slice(0, 8)}`, del(id), () => {}, 'done');
}

const end = await balanceSettled();
const spent = start - end;
log(`spent ${dash(spent)} tDASH over ${sent.length} broadcasts; ${results.filter((r) => !r.ok).length} failed checks`);
writeFileSync(
  join(here, cacheOnly ? 'results/live-writer-cache.json' : 'results/live-writer.json'),
  `${JSON.stringify({ at: new Date().toISOString(), network: 'testnet', protocol: sdk.version(), identity: who, ownerId, contract: FORUM, spentCredits: String(spent), spentTDash: dash(spent), broadcasts: sent.length, results, nonceCache: cacheProbe }, null, 1)}\n`,
);
key.privateKey.fill(0);
process.exit(results.every((r) => r.ok) ? 0 : 1);
