import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { fromBase58, hash160, toBase58 } from '../src/bytes.ts';
import {
  compareIds,
  listCandidates,
  makeLoginRequest,
  pollDelay,
  sealPayload,
  sessionFromGrant,
  startPolling,
  verifyCandidate,
  type AppConnectPort,
  type Candidate,
  type ChainKey,
  type ConnectRequest,
  type PollEvent,
} from '../src/appconnect/index.ts';

const FORUM = '4EcYtwedNjTm4iGmx47GkLX2uNkCUWS4tt1KHhgGkjR3';
const OTHER = 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ';
const ALICE = 'AsDve9GcVemmG7hRFkVMpX2UVQupcoFo7EAg33m8PcTA';
const BOB = 'Hj6B9qRVHcVB97LZGEQvKm7zFsCP85cuSkEAssc1XWL7';
const NOW = 1_794_850_000_000;
const DAY = 86_400_000;

/** A fake Platform: identities' keys, budgets, and the responses to requests. */
function fakePort() {
  const keys = new Map<string, ChainKey[]>();
  const budgets = new Map<string, Map<number, bigint>>();
  let responses: Candidate[] = [];
  const port: AppConnectPort & { calls: number } = {
    calls: 0,
    async responses(_h, o) {
      port.calls++;
      const sorted = [...responses].sort((a, b) => compareIds(a.ownerId, b.ownerId));
      return sorted.filter((c) => (o.hint ? c.ownerId === o.hint : !o.startAfter || compareIds(c.ownerId, o.startAfter) > 0)).slice(0, o.limit);
    },
    async identityKeys(id) {
      const k = keys.get(id);
      return k ? { keys: k, blockTimeMs: NOW } : null;
    },
    async remainingBudgets(id, ids) {
      const b = budgets.get(id) ?? new Map();
      return new Map([...b].filter(([k]) => ids.includes(k)));
    },
    async contractKeys() {
      return [];
    },
  };
  return { port, keys, budgets, setResponses: (r: Candidate[]) => (responses = r) };
}

function goodKey(priv: Uint8Array, over: Partial<ChainKey> = {}): ChainKey {
  return {
    id: 7,
    type: 0,
    purpose: 0,
    securityLevel: 2,
    data: secp256k1.getPublicKey(priv, true),
    disabled: false,
    bounds: { kind: 'singleContract', contractId: FORUM },
    totalBudget: 10_000_000_000n,
    expiresAt: NOW + 90 * DAY,
    ...over,
  };
}

function setup(o: { key?: (priv: Uint8Array) => ChainKey | null; owner?: string; sealOwner?: string; slots?: Uint8Array[]; budget?: bigint | null; request?: ConnectRequest } = {}) {
  const login = makeLoginRequest({ contractId: FORUM, network: 'mainnet', connectionId: new Uint8Array(16), now: NOW });
  const request = o.request ?? login.request;
  const priv = secp256k1.utils.randomSecretKey();
  const owner = o.owner ?? ALICE;
  const f = fakePort();
  const k = o.key ? o.key(priv) : goodKey(priv);
  f.keys.set(owner, k ? [k] : []);
  if (o.budget !== null && k) f.budgets.set(owner, new Map([[k.id, o.budget ?? 9_000_000_000n]]));
  const sealed = sealPayload({ appEphemeralPubKey: request.appEphemeralPubKey, ownerId: fromBase58(o.sealOwner ?? owner), slots: o.slots ?? [priv.slice()] });
  const candidate: Candidate = { ownerId: owner, ...sealed };
  const verify = () => verifyCandidate({ request, appEphemeralPrivateKey: login.appEphemeralPrivateKey, candidate, port: f.port });
  return { login, request, priv, f, candidate, verify };
}

describe('verifyCandidate', () => {
  it('accepts a key that matches the binding, with its remaining budget', async () => {
    const s = setup();
    const v = await s.verify();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.grant.identityId).toBe(ALICE);
    expect(v.grant.authKeys).toHaveLength(1);
    expect(v.grant.authKeys[0]!.privateKey).toEqual(s.priv);
    expect(v.grant.authKeys[0]!.remainingBudget).toBe(9_000_000_000n);
    const session = sessionFromGrant(v.grant, 'mainnet');
    expect(session).toMatchObject({ source: 'wallet', identityId: ALICE, keyId: 7, securityLevel: 2, boundContractId: FORUM, wallet: null, identityIndex: null });
    session.end();
    expect(s.priv.some((b) => b !== 0)).toBe(true); // the session owns its own bytes; the test's copy is untouched
  });

  it('accepts an ECDSA_HASH160 session key', async () => {
    const v = await setup({ key: (p) => goodKey(p, { type: 2, data: hash160(secp256k1.getPublicKey(p, true)) }) }).verify();
    expect(v.ok).toBe(true);
  });

  it('accepts a wallet that changed the budget and expiry values', async () => {
    const v = await setup({ key: (p) => goodKey(p, { totalBudget: 50_000_000_000n, expiresAt: NOW + 30 * DAY }) }).verify();
    expect(v.ok).toBe(true);
  });

  const cases: Array<[string, Parameters<typeof setup>[0], string, boolean]> = [
    ['a copy under another identity', { sealOwner: BOB }, 'decrypt', false],
    ['a key the identity does not have (yet)', { key: () => null }, 'key-not-found', true],
    ['an identity that does not exist', { owner: BOB, key: () => null }, 'key-not-found', true],
    ['a disabled key', { key: (p) => goodKey(p, { disabled: true }) }, 'key-disabled', false],
    ['a MASTER key', { key: (p) => goodKey(p, { securityLevel: 0, bounds: undefined }) }, 'key-master', false],
    ['an unbound key', { key: (p) => goodKey(p, { bounds: undefined }) }, 'key-unbound', false],
    ['bounds this code cannot read', { key: (p) => goodKey(p, { bounds: 'unreadable' }) }, 'key-unmatched', false],
    ['a key bound to another contract', { key: (p) => goodKey(p, { bounds: { kind: 'singleContract', contractId: OTHER } }) }, 'key-unmatched', false],
    ['a document-type key on the contract', { key: (p) => goodKey(p, { bounds: { kind: 'documentType', contractId: FORUM, documentTypeName: 'comment' } }) }, 'key-unmatched', false],
    ['a CRITICAL key where HIGH was asked', { key: (p) => goodKey(p, { securityLevel: 1 }) }, 'key-level', false],
    ['a TRANSFER key', { key: (p) => goodKey(p, { purpose: 3 }) }, 'key-purpose', false],
    ['an encryption key nobody asked for', { key: (p) => goodKey(p, { purpose: 1, securityLevel: 3 }) }, 'key-unmatched', false],
    ['a BLS key type', { key: (p) => goodKey(p, { type: 1 }) }, 'key-not-found', true],
    ['a key with no budget', { key: (p) => goodKey(p, { totalBudget: undefined }) }, 'key-limits', false],
    ['a key with no expiry', { key: (p) => goodKey(p, { expiresAt: undefined }) }, 'key-limits', false],
    ['a key expiring within the hour', { key: (p) => goodKey(p, { expiresAt: NOW + 59 * 60_000 }) }, 'key-expired', false],
    ['a spent budget', { budget: 0n }, 'budget-exhausted', false],
    ['a budget Platform does not report', { budget: null }, 'budget-unknown', true],
    ['more slots than bindings', { slots: [secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey()] }, 'framing', false],
    ['a slot that is not a private key', { slots: [new Uint8Array(32)] }, 'invalid-key', false],
  ];
  it.each(cases)('rejects %s', async (_name, o, reason, retryable) => {
    const v = await setup(o).verify();
    expect(v).toEqual({ ok: false, reason, retryable });
  });

  it('rejects an answer from someone other than the IDENTITY_HINT', async () => {
    const s0 = setup();
    const request = { ...s0.request, identityHint: fromBase58(BOB) };
    const v = await verifyCandidate({ request, appEphemeralPrivateKey: s0.login.appEphemeralPrivateKey, candidate: s0.candidate, port: s0.f.port });
    expect(v).toEqual({ ok: false, reason: 'hint-mismatch', retryable: false });
  });

  it('rejects two slots for one binding, and a grant without the primary binding', async () => {
    const login = makeLoginRequest({ contractId: FORUM, network: 'mainnet', connectionId: new Uint8Array(16), now: NOW });
    const request: ConnectRequest = { ...login.request, authBindings: [login.request.authBindings[0]!, { kind: 'singleContract', securityLevel: 2, id: fromBase58(OTHER), totalBudget: 1n, expiresAt: NOW + DAY }] };
    const a = secp256k1.utils.randomSecretKey();
    const b = secp256k1.utils.randomSecretKey();
    const f = fakePort();
    const run = async (keys: ChainKey[], slots: Uint8Array[]) => {
      f.keys.set(ALICE, keys);
      f.budgets.set(ALICE, new Map(keys.map((k) => [k.id, 1n])));
      const sealed = sealPayload({ appEphemeralPubKey: request.appEphemeralPubKey, ownerId: fromBase58(ALICE), slots: slots.map((s) => s.slice()) });
      return verifyCandidate({ request, appEphemeralPrivateKey: login.appEphemeralPrivateKey, candidate: { ownerId: ALICE, ...sealed }, port: f.port });
    };
    expect(await run([goodKey(a, { id: 1 }), goodKey(b, { id: 2 })], [a, b])).toMatchObject({ ok: false, reason: 'duplicate-binding' });
    expect(await run([goodKey(b, { id: 2, bounds: { kind: 'singleContract', contractId: OTHER } })], [b])).toMatchObject({ ok: false, reason: 'primary-missing' });
    expect(await run([goodKey(a, { id: 1 }), goodKey(b, { id: 2, bounds: { kind: 'singleContract', contractId: OTHER } })], [b, a])).toMatchObject({ ok: true });
  });
});

describe('listCandidates', () => {
  const cand = (ownerId: string): Candidate => ({ ownerId, walletEphemeralPubKey: new Uint8Array(33), encryptedPayload: new Uint8Array(60) });
  const ids = Array.from({ length: 25 }, (_, i) => toBase58(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i + 1 : 7))));

  it('pages after the last owner and flags more than 20 candidates', async () => {
    const f = fakePort();
    f.setResponses(ids.slice(0, 15).map(cand));
    const a = await listCandidates(f.port, new Uint8Array(20));
    expect(a.candidates.map((c) => c.ownerId)).toEqual([...ids.slice(0, 15)].sort(compareIds));
    expect(a.truncated).toBe(false);
    f.setResponses(ids.map(cand));
    const b = await listCandidates(f.port, new Uint8Array(20));
    expect(b.candidates).toHaveLength(20);
    expect(b.truncated).toBe(true);
  });

  it('stops when a node ignores the cursor, and drops other owners when a hint is given', async () => {
    const page = ids.slice(0, 10).map(cand);
    const stuck: AppConnectPort = { ...fakePort().port, responses: async () => page };
    expect((await listCandidates(stuck, new Uint8Array(20))).candidates).toHaveLength(10);
    const liar: AppConnectPort = { ...fakePort().port, responses: async () => [cand(ids[0]!), cand(ids[1]!)] };
    expect((await listCandidates(liar, new Uint8Array(20), { hint: ids[1] })).candidates.map((c) => c.ownerId)).toEqual([ids[1]]);
  });
});

describe('startPolling', () => {
  /** Lets the poller's awaited reads (all immediate here) run to the end. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Manual clock and timers. */
  function clock(start: number) {
    let t = start;
    const timers: Array<{ at: number; f: () => void }> = [];
    return {
      now: () => t,
      setTimer: (f: () => void, ms: number) => {
        const x = { at: t + ms, f };
        timers.push(x);
        return x;
      },
      clearTimer: (x: unknown) => {
        const i = timers.indexOf(x as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
      async advance(ms: number) {
        const end = t + ms;
        await settle();
        for (;;) {
          timers.sort((a, b) => a.at - b.at);
          const next = timers[0];
          if (!next || next.at > end) break;
          timers.shift();
          t = next.at;
          next.f();
          await settle();
        }
        t = end;
      },
      pending: () => timers.length,
    };
  }

  it('polls every 2 s, then 4 s, and gives up after 10 minutes', async () => {
    expect([pollDelay(0), pollDelay(59_999), pollDelay(60_000), pollDelay(599_999), pollDelay(600_000)]).toEqual([2000, 2000, 4000, 4000, null]);
    const s = setup();
    s.f.setResponses([]);
    const c = clock(NOW);
    const events: PollEvent[] = [];
    startPolling({ request: s.request, appEphemeralPrivateKey: s.login.appEphemeralPrivateKey, port: s.f.port, onEvent: (e) => events.push(e), ...c });
    await c.advance(0);
    await c.advance(60_000);
    expect(s.f.port.calls).toBe(31); // the first look, then every 2 s
    await c.advance(10 * 60_000);
    expect(events).toEqual([{ type: 'gave-up', why: 'expired' }]);
    expect(c.pending()).toBe(0);
    const calls = s.f.port.calls;
    await c.advance(60_000);
    expect(s.f.port.calls).toBe(calls);
  });

  it('gives up when more than 20 candidates answer', async () => {
    const s = setup();
    const many = Array.from({ length: 21 }, (_, i) => ({ ...s.candidate, ownerId: toBase58(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i + 1 : 3))) }));
    s.f.setResponses(many);
    const c = clock(NOW);
    const events: PollEvent[] = [];
    startPolling({ request: s.request, appEphemeralPrivateKey: s.login.appEphemeralPrivateKey, port: s.f.port, onEvent: (e) => events.push(e), ...c });
    await c.advance(0);
    expect(events.at(-1)).toEqual({ type: 'gave-up', why: 'too-many' });
    expect(events.filter((e) => e.type === 'rejected')).toHaveLength(20);
  });

  it('waits for a lagging node, reports the grant once, and keeps polling for other answers', async () => {
    const s = setup();
    const key = s.f.keys.get(ALICE)!;
    s.f.keys.set(ALICE, []);
    s.f.setResponses([s.candidate]);
    const c = clock(NOW);
    const events: PollEvent[] = [];
    startPolling({ request: s.request, appEphemeralPrivateKey: s.login.appEphemeralPrivateKey, port: s.f.port, onEvent: (e) => events.push(e), ...c });
    await c.advance(10_000);
    expect(events).toEqual([]);
    s.f.keys.set(ALICE, key);
    await c.advance(10_000);
    expect(events.map((e) => e.type)).toEqual(['grant']);
    expect(c.pending()).toBe(1);
  });

  it('reports a final rejection once, and a lagging one after the retry window', async () => {
    const bad = setup({ key: (p) => goodKey(p, { disabled: true }) });
    bad.f.setResponses([bad.candidate]);
    const c = clock(NOW);
    const events: PollEvent[] = [];
    startPolling({ request: bad.request, appEphemeralPrivateKey: bad.login.appEphemeralPrivateKey, port: bad.f.port, onEvent: (e) => events.push(e), ...c });
    await c.advance(20_000);
    expect(events).toEqual([{ type: 'rejected', ownerId: ALICE, reason: 'key-disabled' }]);

    const lag = setup({ key: () => null });
    lag.f.setResponses([lag.candidate]);
    const c2 = clock(NOW);
    const ev2: PollEvent[] = [];
    startPolling({ request: lag.request, appEphemeralPrivateKey: lag.login.appEphemeralPrivateKey, port: lag.f.port, onEvent: (e) => ev2.push(e), ...c2 });
    await c2.advance(25_000);
    expect(ev2).toEqual([]);
    await c2.advance(10_000);
    expect(ev2).toEqual([{ type: 'rejected', ownerId: ALICE, reason: 'key-not-found' }]);
  });

  it('reports read errors and keeps polling; stop() ends it', async () => {
    const s = setup();
    let fail = true;
    const port: AppConnectPort = { ...s.f.port, responses: async (h, o) => (fail ? Promise.reject(new Error('timed out')) : s.f.port.responses(h, o)) };
    s.f.setResponses([s.candidate]);
    const c = clock(NOW);
    const events: PollEvent[] = [];
    const p = startPolling({ request: s.request, appEphemeralPrivateKey: s.login.appEphemeralPrivateKey, port, onEvent: (e) => events.push(e), ...c });
    await c.advance(0);
    expect(events.map((e) => e.type)).toEqual(['error']);
    fail = false;
    await c.advance(2_000);
    expect(events.map((e) => e.type)).toEqual(['error', 'grant']);
    p.stop();
    expect(c.pending()).toBe(0);
  });
});
