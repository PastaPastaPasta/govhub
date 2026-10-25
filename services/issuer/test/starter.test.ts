// Starter tokens end to end with the real signer and the browser/faucet code from @govhub/badge, against a fake Core and Platform:
// the order of checks and every error code for both kinds, lifetime dedup, idempotent retries, the store, and the key manager.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64, bytesToId, epochStart, finalize, fromHex, idToBytes, keyDeadline, sha256, toHex, VARIANT, verifyStarterToken, type IssuerKeyDoc, type IssuerRevocationDoc } from '@govhub/badge';
import { Challenges } from '../src/challenge.ts';
import { createCoreView, ProposalCache } from '../src/core.ts';
import { keyFileName, keygen, manifestSpki } from '../src/keys.ts';
import type { IssuerPlatform } from '../src/platform.ts';
import { IssueError, RecoveryBudget } from '../src/service.ts';
import { openStarterStore } from '../src/starter-db.ts';
import { StarterManager } from '../src/starter-epochs.ts';
import { E, FakeCore, fakeMn, keysFrom, fakeProposal, finishStarter, mnSubject, NET, NOW_SEC, P, proposalSubject, rnd, starterRequest, starterService, starterWorld, votingKey, type StarterWorld } from './helpers.ts';

async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IssueError);
    expect((e as IssueError).code, (e as Error).message).toBe(code);
    return e as IssueError;
  }
  throw new Error(`expected ${code}`);
}
const issue = (w: StarterWorld, body: Record<string, unknown>) => w.service.issue(body as never);

afterEach(() => void vi.useRealTimers());

describe('starter issuance', () => {
  it('a masternode: blind signature -> finalized token the faucet verifies for exactly this funding key', async () => {
    const w = await starterWorld();
    const mn = w.core.add(fakeMn());
    const r = await starterRequest(w, mnSubject(mn));
    const out = await issue(w, r.body);
    expect(out).toMatchObject({ epoch: E, retry: false });
    expect(await finishStarter(w, r, out.blindSig)).toBe(true);
    // the faucet rebuilds the message from the address it pays: another pubKeyHash does not verify
    const sig = await finalize(w.key, r.prepared.preparedMsg, out.blindSig, r.inv);
    expect(await verifyStarterToken(w.key, { ...r.fields, pubKeyHash: rnd(20) }, r.prepared.msgPrefix, sig)).toBe(false);
  });

  it('a proposal, proved with its payment address', async () => {
    const w = await starterWorld();
    const p = w.core.addProposal(fakeProposal());
    const r = await starterRequest(w, proposalSubject(p));
    const out = await issue(w, r.body);
    expect(await finishStarter(w, r, out.blindSig)).toBe(true);
  });

  it('a retry with the same epoch and blinded message gets the same signature; anything else for the subject is already-issued', async () => {
    const w = await starterWorld();
    const mn = w.core.add(fakeMn());
    const p = w.core.addProposal(fakeProposal());
    for (const subject of [mnSubject(mn), proposalSubject(p)]) {
      const r = await starterRequest(w, subject);
      const a = await issue(w, r.body);
      const again = await starterRequest(w, subject, { blindedMsg: r.blindedMsg }); // new challenge and signature, same blinded message
      const b = await issue(w, again.body);
      expect(b.retry).toBe(true);
      expect(toHex(b.blindSig)).toBe(toHex(a.blindSig));
      const dup = await expectError(issue(w, (await starterRequest(w, subject)).body), 'already-issued');
      expect(dup.message).toMatch(subject.kind === 'mn' ? /this masternode already received its starter \(one per masternode, ever\)/ : /this proposal already received its starter \(one per proposal\)/);
    }
  });

  it('lifetime dedup: after the window closes the retry data is gone but the masternode, its collateral and the proposal stay used', async () => {
    const w = await starterWorld();
    const mn = w.core.add(fakeMn());
    const p = w.core.addProposal(fakeProposal());
    const rm = await starterRequest(w, mnSubject(mn));
    const rp = await starterRequest(w, proposalSubject(p));
    await issue(w, rm.body);
    await issue(w, rp.body);
    expect(w.store.closeThrough(E)).toBe(2);
    // the same blinded message is no longer a retry: nothing about the issuance is left to match it
    await expectError(issue(w, (await starterRequest(w, mnSubject(mn), { blindedMsg: rm.blindedMsg })).body), 'already-issued');
    await expectError(issue(w, (await starterRequest(w, proposalSubject(p), { blindedMsg: rp.blindedMsg })).body), 'already-issued');
    // a new proTxHash on the same collateral (re-registration)
    const again = w.core.add(fakeMn({ collateral: mn.now!.collateral }));
    expect((await expectError(issue(w, (await starterRequest(w, mnSubject(again))).body), 'already-issued')).message).toMatch(/this collateral already received its starter/);
  });

  it('two MNs sharing a voting key each get one; a proposal and an MN never collide', async () => {
    const w = await starterWorld();
    const k = votingKey();
    const a = w.core.add(fakeMn({ votingPriv: k.priv }));
    const b = w.core.add(fakeMn({ votingPriv: k.priv }));
    await issue(w, (await starterRequest(w, mnSubject(a))).body);
    await issue(w, (await starterRequest(w, mnSubject(b))).body);
    // a proposal whose govHash equals a proTxHash is another subject (kind is part of the key)
    const p = fakeProposal();
    p.govHash = a.proTxHash;
    w.core.addProposal(p);
    await issue(w, (await starterRequest(w, proposalSubject(p))).body);
  });

  it('authentication: every failure is the same "unauthorized", for both kinds', async () => {
    const w = await starterWorld();
    const mn = w.core.add(fakeMn());
    const p = w.core.addProposal(fakeProposal());
    const msgs = new Set<string>();
    const fail = async (r: Promise<{ body: Record<string, unknown> }>) => msgs.add((await expectError(issue(w, (await r).body), 'unauthorized')).message);
    await fail(starterRequest(w, mnSubject(mn), { signWith: votingKey().priv })); // wrong key
    await fail(starterRequest(w, mnSubject(fakeMn()))); // not in the list
    await fail(starterRequest(w, proposalSubject(p), { signWith: votingKey().priv }));
    await fail(starterRequest(w, proposalSubject(fakeProposal()))); // not a valid proposal
    await fail(starterRequest(w, { kind: 'proposal', id: mn.proTxHash, priv: mn.votingPriv })); // an MN is not a proposal
    await fail(starterRequest(w, { kind: 'mn', id: p.govHash, priv: p.payPriv! })); // nor the reverse
    const r = await starterRequest(w, mnSubject(mn));
    const other = await starterRequest(w, mnSubject(mn));
    msgs.add((await expectError(issue(w, { ...r.body, signature: other.signature }), 'unauthorized')).message); // signs another request
    expect(msgs.size).toBe(1);
  });

  it('a proposal paid to a P2SH address cannot prove ownership: unauthorized', async () => {
    const w = await starterWorld();
    const p = w.core.addProposal(fakeProposal({ p2sh: true }));
    await expectError(issue(w, (await starterRequest(w, proposalSubject(p))).body), 'unauthorized');
  });

  it('eligibility: a PoSe-banned MN, a proposal that ended more than the grace ago', async () => {
    const w = await starterWorld({ graceDays: 30 });
    const banned = w.core.add(fakeMn());
    banned.now!.valid = false;
    expect((await expectError(issue(w, (await starterRequest(w, mnSubject(banned))).body), 'not-eligible')).message).toMatch(/PoSe/);
    const old = w.core.addProposal(fakeProposal({ endEpoch: NOW_SEC - 31 * 86_400 }));
    expect((await expectError(issue(w, (await starterRequest(w, proposalSubject(old))).body), 'not-eligible')).message).toBe('the proposal ended more than 30 days ago');
    const recent = w.core.addProposal(fakeProposal({ endEpoch: NOW_SEC - 29 * 86_400 }));
    await issue(w, (await starterRequest(w, proposalSubject(recent))).body);
    // nothing was used up by the refusals
    banned.now!.valid = true;
    await issue(w, (await starterRequest(w, mnSubject(banned))).body);
  });

  it('minimum MN age: registered with the same collateral at the epoch start (a re-registered collateral cannot farm starters)', async () => {
    const w = await starterWorld();
    const fresh = w.core.add(fakeMn());
    fresh.snap = null; // registered after S(current)
    expect((await expectError(issue(w, (await starterRequest(w, mnSubject(fresh))).body), 'not-eligible')).message).toMatch(/too new/);
    const moved = w.core.add(fakeMn());
    moved.snap!.collateral = `${toHex(rnd(32))}:0`; // same proTxHash, other collateral at the epoch start
    await expectError(issue(w, (await starterRequest(w, mnSubject(moved))).body), 'not-eligible');
    // a snapshot that is not loaded yet is "unavailable", not a refusal
    const lists = w.core.liveLists();
    const svc = starterService(w, { lists: { get now() { return lists.now; }, snapshot: () => null } });
    const ok = w.core.add(fakeMn());
    await expectError(svc.issue((await starterRequest(w, mnSubject(ok))).body as never), 'unavailable');
    // with the snapshot loaded, the same MN gets its starter
    expect(await issue(w, (await starterRequest(w, mnSubject(ok))).body)).toMatchObject({ epoch: E });
  });

  it('request fields: network, issuer, epoch, key; none of them touch Core', async () => {
    const w = await starterWorld();
    const mn = w.core.add(fakeMn());
    const s = mnSubject(mn);
    await expectError(issue(w, (await starterRequest(w, s, { net: 'mainnet' })).body), 'wrong-network');
    await expectError(issue(w, (await starterRequest(w, s, { issuerId: bytesToId(rnd(32)) })).body), 'wrong-issuer');
    const e = await expectError(issue(w, (await starterRequest(w, s, { epoch: E + 1 })).body), 'wrong-epoch');
    expect(e.issuingEpoch).toBe(E - 1);
    await expectError(issue(w, (await starterRequest(w, s, { epoch: E - 1 })).body), 'unavailable'); // current epoch, no key here
    await expectError(issue(w, (await starterRequest(w, s, { epoch: E - 2 })).body), 'wrong-epoch');
    await expectError(issue(w, (await starterRequest(w, s, { keyId: rnd(32) })).body), 'wrong-key');
    expect(w.core.calls).toBe(0);
  });

  it('challenges: expired, forged, or a badge challenge (other domain) are refused; the TTL suits signing by hand', async () => {
    const w = await starterWorld();
    const p = w.core.addProposal(fakeProposal());
    const r = await starterRequest(w, proposalSubject(p));
    w.now.sec += 1801;
    await expectError(issue(w, r.body), 'bad-challenge');
    w.now.sec -= 1801;
    await expectError(issue(w, (await starterRequest(w, proposalSubject(p), { nonce: rnd(40) })).body), 'bad-challenge');
    const badgeDomain = new Challenges(rnd(32), `${NET}|${w.issuerId}`, 1800).issue(w.now.sec).nonce;
    await expectError(issue(w, (await starterRequest(w, proposalSubject(p), { nonce: badgeDomain })).body), 'bad-challenge');
    w.now.sec += 1700; // a proposal owner who took 28 minutes to sign in Dash Core
    await issue(w, r.body);
  });

  it('malformed bodies and an unbound or short blinded message are bad-request, before any MN state', async () => {
    const w = await starterWorld();
    const mn = w.core.add(fakeMn());
    const r = await starterRequest(w, mnSubject(mn));
    await expectError(issue(w, { ...r.body, request: 5 }), 'bad-request');
    await expectError(issue(w, { ...r.body, signature: 'not base64!' }), 'bad-request');
    await expectError(issue(w, { ...r.body, signature: bytesToBase64(rnd(64)) }), 'bad-request');
    await expectError(issue(w, { ...r.body, blindedMsg: 'x'.repeat(701) }), 'bad-request');
    await expectError(issue(w, { ...r.body, request: r.request + ' ' }), 'bad-request');
    await expectError(issue(w, { ...r.body, request: r.request.replace('govhub-starter-req:v1', 'govhub-req:v2') }), 'bad-request');
    const other = await starterRequest(w, mnSubject(mn));
    await expectError(issue(w, { ...r.body, blindedMsg: other.body.blindedMsg }), 'bad-request');
    await expectError(issue(w, (await starterRequest(w, mnSubject(mn), { blindedMsg: rnd(255) })).body), 'bad-request');
    expect(w.core.calls).toBe(0);
  });

  it('unavailable: no key, lists not loaded, Core down after authentication, a stale list', async () => {
    const noKey = await starterWorld({ keyReady: false });
    await expectError(issue(noKey, (await starterRequest(noKey, mnSubject(noKey.core.add(fakeMn())))).body), 'unavailable');
    const w = await starterWorld();
    const mn = w.core.add(fakeMn());
    const r = await starterRequest(w, mnSubject(mn));
    w.core.down = true;
    expect((await expectError(issue(w, r.body), 'unavailable')).message).toMatch(/not loaded/);
    w.core.down = false;
    const svc = (tipHeight: () => Promise<number>) => starterService(w, { core: { tipHeight } });
    expect((await expectError(svc(async () => Promise.reject(new Error('down'))).issue(r.body as never), 'unavailable')).message).toMatch(/Core/);
    const p = w.core.addProposal(fakeProposal());
    expect((await expectError(svc(async () => w.core.tip + 6).issue((await starterRequest(w, proposalSubject(p))).body as never), 'unavailable')).message).toMatch(/proposal list is out of date/);
  });

  it('the tip is re-read after authentication: nothing for E once S(E+1) is reached', async () => {
    const w = await starterWorld();
    const mn = w.core.add(fakeMn());
    const lists = w.core.liveLists();
    const svc = starterService(w, { core: { tipHeight: async () => epochStart(P, E + 1) }, lists: { get now() { return { height: epochStart(P, E + 1) - 1, list: lists.now!.list }; }, snapshot: lists.snapshot } });
    expect((await expectError(svc.issue((await starterRequest(w, mnSubject(mn))).body as never), 'wrong-epoch')).issuingEpoch).toBe(E + 1);
  });

  it('per-subject limit after authentication (strangers do not consume it); the counts last one wall-clock minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2027, 0, 1, 12, 0, 10) });
    const w = await starterWorld();
    const p = w.core.addProposal(fakeProposal());
    for (let i = 0; i < 10; i++) await expectError(issue(w, (await starterRequest(w, proposalSubject(p), { signWith: votingKey().priv })).body), 'unauthorized');
    await issue(w, (await starterRequest(w, proposalSubject(p))).body);
    for (let i = 0; i < 5; i++) await expectError(issue(w, (await starterRequest(w, proposalSubject(p))).body), 'already-issued');
    await expectError(issue(w, (await starterRequest(w, proposalSubject(p))).body), 'unavailable');
    expect(w.service.debugSnapshot().perSubject).toEqual([[`proposal:${p.govHash}`, 6]]);
    vi.setSystemTime(Date.UTC(2027, 0, 1, 12, 1, 0));
    w.service.prune();
    expect(w.service.debugSnapshot().perSubject).toEqual([]);
  });

  it('the recovery budget is shared with the badge service', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2027, 0, 1, 12, 0, 0, 100) });
    const budget = new RecoveryBudget(1);
    const w = await starterWorld({ budget });
    const mn = w.core.add(fakeMn());
    budget.take(); // the badge service used this second's budget
    expect((await expectError(issue(w, (await starterRequest(w, mnSubject(mn))).body), 'unavailable')).message).toMatch(/busy/);
    vi.setSystemTime(Date.UTC(2027, 0, 1, 12, 0, 1, 100));
    await issue(w, (await starterRequest(w, mnSubject(mn))).body);
  });
});

describe('starter store', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'starter-db-')), 's.sqlite');

  it('lifetime dedup keys, a collateral per MN, NULL collateral for proposals; a failed signature stores nothing', () => {
    const s = openStarterStore(file());
    const sig = () => rnd(256);
    const h = rnd(32);
    expect(s.reserve({ kind: 'mn', subject: 'aa', collateral: 'c:0', epoch: 5, blindedHash: h }, sig).kind).toBe('signed');
    expect(s.reserve({ kind: 'mn', subject: 'aa', collateral: 'c:0', epoch: 5, blindedHash: h }, sig)).toMatchObject({ kind: 'signed', retry: true });
    expect(s.reserve({ kind: 'mn', subject: 'aa', collateral: 'c:0', epoch: 6, blindedHash: h }, sig)).toEqual({ kind: 'conflict', reason: 'subject' });
    expect(s.reserve({ kind: 'mn', subject: 'bb', collateral: 'c:0', epoch: 5, blindedHash: rnd(32) }, sig)).toEqual({ kind: 'conflict', reason: 'collateral' });
    expect(s.reserve({ kind: 'proposal', subject: 'p1', collateral: null, epoch: 5, blindedHash: rnd(32) }, sig).kind).toBe('signed');
    expect(s.reserve({ kind: 'proposal', subject: 'p2', collateral: null, epoch: 5, blindedHash: rnd(32) }, sig).kind).toBe('signed');
    expect(() => s.reserve({ kind: 'mn', subject: 'cc', collateral: 'd:0', epoch: 5, blindedHash: rnd(32) }, () => { throw new Error('fault'); })).toThrow('fault');
    expect(s.reserve({ kind: 'mn', subject: 'cc', collateral: 'd:0', epoch: 5, blindedHash: rnd(32) }, sig)).toMatchObject({ kind: 'signed', retry: false });
    expect(() => s.reserve({ kind: 'proposal', subject: 'p3', collateral: 'x:0', epoch: 5, blindedHash: rnd(32) }, sig)).toThrow();
    s.close();
  });

  it('closeThrough clears epoch and blinded hash of closed windows only, and keeps the dedup keys', () => {
    const path = file();
    const s = openStarterStore(path);
    const sig = () => rnd(256);
    s.reserve({ kind: 'mn', subject: 'aa', collateral: 'c:0', epoch: 5, blindedHash: rnd(32) }, sig);
    s.reserve({ kind: 'proposal', subject: 'p1', collateral: null, epoch: 6, blindedHash: rnd(32) }, sig);
    expect(s.closeThrough(5)).toBe(1);
    const db = new Database(path, { readonly: true });
    expect(db.prepare('SELECT kind, subject, collateral, epoch, blinded_hash FROM starters ORDER BY kind').all()).toEqual([
      { kind: 'mn', subject: 'aa', collateral: 'c:0', epoch: null, blinded_hash: null },
      { kind: 'proposal', subject: 'p1', collateral: null, epoch: 6, blinded_hash: expect.any(Buffer) },
    ]);
    db.close();
    expect(s.reserve({ kind: 'mn', subject: 'aa', collateral: 'c:0', epoch: 5, blindedHash: rnd(32) }, sig)).toEqual({ kind: 'conflict', reason: 'subject' });
    expect(s.reserve({ kind: 'mn', subject: 'zz', collateral: 'c:0', epoch: 7, blindedHash: rnd(32) }, sig)).toEqual({ kind: 'conflict', reason: 'collateral' });
    s.close();
  });
});

describe('core: valid proposals', () => {
  it('parses `gobject list valid proposals`: P2PKH payment key, end_epoch, skips other types, invalid and unparsable entries', async () => {
    const pay = votingKey();
    const hex = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('hex');
    const { encodeAddress } = await import('@govhub/verify');
    const data = (addr: string) => hex({ end_epoch: 1_900_000_000, name: 'x', payment_address: addr, payment_amount: 5, start_epoch: 1_800_000_000, type: 1, url: 'https://x.org' });
    const a = 'A'.repeat(64);
    const b = 'b'.repeat(64);
    const list = {
      [a]: { DataHex: data(encodeAddress('p2pkh', pay.keyId, 'testnet')), ObjectType: 1, fCachedValid: true },
      [b]: { DataHex: data(encodeAddress('p2sh', rnd(20), 'testnet')), ObjectType: 1, fCachedValid: true },
      ['c'.repeat(64)]: { DataHex: data(encodeAddress('p2pkh', pay.keyId, 'testnet')), ObjectType: 1, fCachedValid: false },
      ['d'.repeat(64)]: { DataHex: data(encodeAddress('p2pkh', pay.keyId, 'testnet')), ObjectType: 2, fCachedValid: true },
      ['e'.repeat(64)]: { DataHex: 'zz', ObjectType: 1, fCachedValid: true },
    };
    const calls: unknown[] = [];
    let synced = false;
    const core = createCoreView((async (method: string, params?: unknown[]) => (calls.push([method, params ?? []]), method === 'getblockcount' ? 1000 : method === 'mnsync' ? { IsSynced: synced } : list)) as never, 'testnet');
    const cache = new ProposalCache(core);
    expect(cache.now).toBeNull();
    // governance still syncing: the partial list is refused, the cache stays empty (requests get "unavailable")
    await expect(cache.refresh()).rejects.toThrow(/governance is not synced/);
    expect(cache.now).toBeNull();
    synced = true;
    calls.length = 0;
    await cache.refresh();
    expect(calls).toEqual([['getblockcount', []], ['mnsync', ['status']], ['gobject', ['list', 'valid', 'proposals']]]);
    expect(cache.now!.height).toBe(1000);
    expect([...cache.now!.list.keys()]).toEqual([a.toLowerCase(), b]);
    expect(cache.now!.list.get(a.toLowerCase())).toEqual({ paymentKeyId: pay.keyId, endEpoch: 1_900_000_000 });
    expect(cache.now!.list.get(b)!.paymentKeyId).toBeNull();
  });
});

// ---- the starter key manager -----------------------------------------------------------------------------------------------------

const STARTER = bytesToId(rnd(32));
const BADGE = bytesToId(rnd(32));

async function manager(epochs: number[], o: { owner?: string; lateDoc?: boolean; maxStaged?: number; badgeKeyIds?: () => Uint8Array[]; badgeDown?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'starter-keys-'));
  const manifest = await keygen(dir, Math.min(...epochs), Math.max(...epochs) - Math.min(...epochs) + 1, 2048, 'starter');
  const docs = new Map<string, IssuerKeyDoc>();
  const owner = o.owner ?? STARTER;
  const doc = async (spki: Uint8Array, epoch: number, by = owner): Promise<IssuerKeyDoc> => ({ ownerId: idToBytes(by), epoch, spki, keyId: await sha256(spki), variant: VARIANT, createdAtCoreBlockHeight: o.lateDoc ? keyDeadline(P, epoch) : 1 });
  for (const m of manifest) docs.set(`${owner}:${m.epoch}`, await doc(manifestSpki(m), m.epoch));
  const revocations = new Map<string, IssuerRevocationDoc>();
  const reads: string[] = [];
  const platform: IssuerPlatform = {
    issuerKey: async (i, e) => {
      if (o.badgeDown && i === BADGE) throw new Error('platform timeout');
      reads.push(`key:${e}`);
      return docs.get(`${i}:${e}`) ?? null;
    },
    issuerKeysFrom: async (i, from) => {
      if (o.badgeDown && i === BADGE) throw new Error('platform timeout');
      return keysFrom(async (id, e) => docs.get(`${id}:${e}`) ?? null)(i, from);
    },
    issuerRevocation: async (i, e) => revocations.get(`${i}:${e}`) ?? null,
    issuerReport: async () => null,
    coreHeight: async () => 0,
    publishIssuerKey: async () => 'x',
    publishIssuerReport: async () => 'x',
    publishIssuerRevocation: async () => 'x',
  };
  const core = new FakeCore();
  const proposals = new ProposalCache(core);
  const store = openStarterStore(':memory:');
  const m = new StarterManager({ network: NET, params: P, contractId: bytesToId(rnd(32)), issuerId: STARTER, keyDir: dir, maxStagedKeys: o.maxStaged ?? 1, core, proposals, store, platform: () => platform, other: () => ({ label: 'badge', issuerId: BADGE, activeKeyIds: o.badgeKeyIds ?? (() => []) }) });
  return { dir, manifest, docs, doc, revocations, reads, core, proposals, store, m };
}

describe('starter key manager', () => {
  it('loads only the starter identity\'s proved key, refreshes proposals, and lists the redeemable keys', async () => {
    const t = await manager([E, E + 1]);
    t.core.addProposal(fakeProposal());
    await t.m.tick();
    // at TIP (inside E-1): issuing E-1 (no key here) and E; E+1 is staged
    expect(t.m.status).toMatchObject({ issuingEpochs: [E - 1, E], ready: true });
    expect(t.m.activeKey(E)?.epoch).toBe(E);
    expect(t.m.activeKey(E + 1)).toBeNull();
    expect(t.proposals.now?.list.size).toBe(1);
    // redeem window [E-2, E-1, E]: only E has a key
    expect(t.m.keys().map((k) => k.epoch)).toEqual([E]);
    expect(toHex(t.m.keys()[0]!.keyId)).toBe(t.manifest[0]!.keyId);
    expect(toHex(t.m.keys()[0]!.spki)).toBe(toHex(manifestSpki(t.manifest[0]!)));
  });

  it('a key published by another identity (the badge issuer) is neither loaded nor listed', async () => {
    const t = await manager([E], { owner: BADGE });
    await t.m.tick();
    expect(t.m.status.ready).toBe(false);
    expect(t.m.status.problem).toMatch(/no issuerKey document for epoch/);
    expect(t.m.activeKey(E)).toBeNull();
    expect(t.m.keys()).toEqual([]);
  });

  it('never loads or lists a starter key that is also the badge issuer\'s key (published for a nearby epoch, or loaded)', async () => {
    // the badge identity published the same RSA key for epoch E+1: blind signatures are separated by key only
    const pub = await manager([E]);
    pub.docs.set(`${BADGE}:${E + 1}`, await pub.doc(manifestSpki(pub.manifest[0]!), E + 1, BADGE));
    await pub.m.tick();
    expect(pub.m.activeKey(E)).toBeNull();
    expect(pub.m.keys()).toEqual([]);
    expect(pub.m.status.problem).toMatch(/also a badge key/);
    // ... or for a distant later epoch (not only E-1..E+1)
    const far = await manager([E]);
    far.docs.set(`${BADGE}:${E + 40}`, await far.doc(manifestSpki(far.manifest[0]!), E + 40, BADGE));
    await far.m.tick();
    expect(far.m.activeKey(E)).toBeNull();
    expect(far.m.status.problem).toMatch(/also a badge key/);
    // the badge side has the same key loaded right now
    let keyId: Uint8Array = new Uint8Array(32);
    const loaded = await manager([E], { badgeKeyIds: () => [keyId] });
    keyId = fromHex(loaded.manifest[0]!.keyId);
    await loaded.m.tick();
    expect(loaded.m.activeKey(E)).toBeNull();
    expect(loaded.m.keys()).toEqual([]);
    // fails closed when the badge identity's keys cannot be read
    const down = await manager([E], { badgeDown: true });
    await down.m.tick();
    expect(down.m.activeKey(E)).toBeNull();
    expect(down.m.status.problem).toMatch(/could not check/);
    // distinct keys: loaded and listed as before
    const fine = await manager([E]);
    await fine.m.tick();
    expect(fine.m.activeKey(E)?.epoch).toBe(E);
  });

  it('refuses a late issuerKey and a key file that does not match the published SPKI', async () => {
    const late = await manager([E], { lateDoc: true });
    await late.m.tick();
    expect(late.m.status.problem).toMatch(/too late/);
    expect(late.m.keys()).toEqual([]); // the reader rules refuse it too
    const other = await manager([E]);
    const spki = manifestSpki((await keygen(mkdtempSync(join(tmpdir(), 'k-')), 1, 1, 2048, 'starter'))[0]!);
    other.docs.set(`${STARTER}:${E}`, await other.doc(spki, E));
    await other.m.tick();
    expect(other.m.status.problem).toMatch(/published SPKI/);
    expect(other.m.activeKey(E)).toBeNull();
  });

  it('refuses to sign while more later keys are staged than allowed', async () => {
    const t = await manager([E, E + 1, E + 2]);
    await t.m.tick();
    expect(t.m.status.problem).toMatch(/later epochs/);
    expect(t.m.activeKey(E)).toBeNull();
  });

  it('roll-over: destroys the closed key, clears the retry data, keeps listing current-1 from a proved read', async () => {
    const t = await manager([E, E + 1]);
    await t.m.tick();
    t.store.reserve({ kind: 'mn', subject: 'aa', collateral: 'c:0', epoch: E, blindedHash: rnd(32) }, () => rnd(256));
    t.core.tip = epochStart(P, E + 1) + P.boundaryMarginBlocks - 1; // inside the margin: nothing destroyed yet
    await t.m.tick();
    expect(existsSync(join(t.dir, keyFileName(E)))).toBe(true);
    expect(t.store.closeThrough(E - 1)).toBe(0);
    t.core.tip = epochStart(P, E + 1) + P.boundaryMarginBlocks;
    await t.m.tick();
    expect(existsSync(join(t.dir, keyFileName(E)))).toBe(false);
    expect(t.store.closeThrough(E)).toBe(0); // already cleared by the tick
    expect(t.m.activeKey(E)).toBeNull();
    expect(t.m.activeKey(E + 1)?.epoch).toBe(E + 1);
    // redeem window [E, E+1, E+2]: E's private key is gone, its tokens are still redeemable
    expect(t.m.keys().map((k) => k.epoch)).toEqual([E, E + 1]);
    // a fresh manager (restart) finds E by a proved read
    const fresh = new StarterManager({ network: NET, params: P, contractId: bytesToId(rnd(32)), issuerId: STARTER, keyDir: t.dir, maxStagedKeys: 1, core: t.core, proposals: t.proposals, store: t.store, platform: () => ({ ...platformOf(t) }) });
    await fresh.tick();
    expect(fresh.keys().map((k) => k.epoch)).toEqual([E, E + 1]);
    // two epochs later E leaves the window
    t.core.tip = epochStart(P, E + 2) + 1;
    await t.m.tick();
    expect(t.m.keys().map((k) => k.epoch)).not.toContain(E);
  });

  it('a revoked epoch is no longer signed for or listed', async () => {
    const t = await manager([E]);
    await t.m.tick();
    expect(t.m.activeKey(E)).not.toBeNull();
    t.revocations.set(`${STARTER}:${E}`, { ownerId: idToBytes(STARTER), epoch: E, keyId: new Uint8Array(32), effectiveCoreHeight: 0, createdAtCoreBlockHeight: 1 });
    await t.m.tick();
    expect(t.m.activeKey(E)).toBeNull();
    expect(t.m.keys()).toEqual([]);
    expect(t.m.status.ready).toBe(false);
    expect(t.m.status.problem).toMatch(/revoked/);
  });

  it('a syncing dashd: nothing signs', async () => {
    const t = await manager([E]);
    await t.m.tick();
    t.core.isSynced = false;
    await t.m.tick();
    expect(t.m.status).toMatchObject({ ready: false, problem: 'dashd is not synced' });
    expect(t.m.activeKey(E)).toBeNull();
  });
});

function platformOf(t: Awaited<ReturnType<typeof manager>>): IssuerPlatform {
  return {
    issuerKey: async (i, e) => t.docs.get(`${i}:${e}`) ?? null,
    issuerKeysFrom: keysFrom(async (i, e) => t.docs.get(`${i}:${e}`) ?? null),
    issuerRevocation: async () => null,
    issuerReport: async () => null,
    coreHeight: async () => 0,
    publishIssuerKey: async () => 'x',
    publishIssuerReport: async () => 'x',
    publishIssuerRevocation: async () => 'x',
  };
}

describe('starter config', () => {
  it('enabled only by STARTER_ISSUER_IDENTITY_ID, with its own identity, directory and store', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const base = { NETWORK: 'testnet', ISSUER_IDENTITY_ID: BADGE, BADGE_CONTRACT_ID: STARTER };
    expect(loadConfig(base).starter).toBeNull();
    expect(loadConfig({ ...base, STARTER_ISSUER_IDENTITY_ID: STARTER }).starter).toEqual({ issuerId: STARTER, keyDir: './starter-keys', maxStagedKeys: 1, dbPath: './data/starter.sqlite', challengeTtlSec: 1800, proposalGraceDays: 30 });
    expect(() => loadConfig({ ...base, STARTER_ISSUER_IDENTITY_ID: BADGE })).toThrow(/its own identity/);
    expect(() => loadConfig({ ...base, STARTER_ISSUER_IDENTITY_ID: '0OIl' })).toThrow(/base58/);
    expect(() => loadConfig({ ...base, STARTER_ISSUER_IDENTITY_ID: STARTER, STARTER_CHALLENGE_TTL_S: '10' })).toThrow(/>= 30/);
    expect(() => loadConfig({ ...base, STARTER_ISSUER_IDENTITY_ID: STARTER, STARTER_KEY_DIR: './keys/' })).toThrow(/STARTER_KEY_DIR/);
    expect(() => loadConfig({ ...base, STARTER_ISSUER_IDENTITY_ID: STARTER, DB_PATH: '/data/x.sqlite', STARTER_DB_PATH: '/data/x.sqlite' })).toThrow(/STARTER_DB_PATH/);
  });
});
