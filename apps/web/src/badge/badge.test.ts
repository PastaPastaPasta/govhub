// Badge client, reader and store with real crypto: a raw RSA signer stands in for the issuer, a fake query for Platform.
import { constants, createPublicKey, generateKeyPairSync, privateDecrypt, randomBytes, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  blind,
  bytesToBase64,
  bytesToId,
  clientIssuanceWindow,
  displayWindow,
  EPOCH_PARAMS,
  epochStart,
  finalize,
  fromHex,
  importIssuerKey,
  parseTokenRequest,
  sha256,
  toHex,
  VARIANT,
} from '@govhub/badge';
import { hash160, recoverMessageSigner, signMessageWif, encodeWif } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { DocQuery } from '@govhub/contracts-v1/queryLint';
import { createJob, renewal, step, type BadgeJob, type ClientDeps } from './client.ts';
import { parseTrustList, type TrustedIssuer } from './config.ts';
import type { BadgeWorkerCall, BadgeWorkerResponse, IssuerAnswer } from './protocol.ts';
import { allBadges, badgesOfAuthors, issuerKeyQuery, reportQuery, revocationQuery } from './queries.ts';
import { BadgeReader } from './reader.ts';
import { deriveStoreKey, encryptedJobStore } from './store.ts';

const P = EPOCH_PARAMS.testnet;
const E = 2742;
const rnd = (n: number) => new Uint8Array(randomBytes(n));
const contractId = bytesToId(rnd(32));
const issuer: TrustedIssuer = { name: 'test', identityId: bytesToId(rnd(32)), url: 'https://issuer.test', enabled: true };

const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
const spki = new Uint8Array(createPublicKey(rsa).export({ type: 'spki', format: 'der' }));
const rawSign = (k: KeyObject, m: Uint8Array) => new Uint8Array(privateDecrypt({ key: k, padding: constants.RSA_NO_PADDING }, m));

/** Platform as the reader sees it: documents per (type, where), the current core height. */
class FakePlatform {
  core = epochStart(P, E) + 10;
  keys = new Map<number, Record<string, unknown>>();
  badges: Record<string, unknown>[] = [];
  reports = new Map<number, number>();
  reportHeight: number | null = null;
  revocation: Record<string, unknown> | null = null;
  async query(q: DocQuery) {
    const w = Object.fromEntries(q.where.map(([k, , v]) => [k, v]));
    let docs: Record<string, unknown>[] = [];
    if (q.documentTypeName === 'issuerRevocation') docs = this.revocation && w.epoch === this.revocation.epoch ? [this.revocation] : [];
    if (q.documentTypeName === 'issuerKey') docs = w.$ownerId === issuer.identityId && this.keys.has(w.epoch as number) ? [this.keys.get(w.epoch as number)!] : [];
    if (q.documentTypeName === 'issuerReport' && this.reports.has(w.epoch as number)) docs = [{ $ownerId: issuer.identityId, $createdAtCoreBlockHeight: this.reportHeight ?? epochStart(P, w.epoch as number) + 4, epoch: w.epoch, tokensIssued: this.reports.get(w.epoch as number) }];
    if (q.documentTypeName === 'mnBadge') {
      const inList = (w.$ownerId as string[] | undefined) ?? null;
      docs = this.badges.filter((b) => b.issuerId === w.issuerId && b.epoch === w.epoch && (!inList || inList.includes(b.$ownerId as string)));
    }
    return { docs, coreHeight: this.core };
  }
  async addKey(epoch: number) {
    this.keys.set(epoch, { $ownerId: issuer.identityId, $createdAtCoreBlockHeight: epochStart(P, epoch - 1) - 5, epoch, spki: bytesToBase64(spki), keyId: bytesToBase64(await sha256(spki)), variant: VARIANT });
  }
}

/** An honest issuer behind the worker protocol (what the real worker would get over HTTP). */
function fakeWorker(o: { answer?: (req: string, sig: string) => IssuerAnswer; seen?: string[] } = {}) {
  return async (req: BadgeWorkerCall): Promise<BadgeWorkerResponse> => {
    const key = await importIssuerKey(spki);
    switch (req.kind) {
      case 'blind': {
        const out = await blind(key, base64ToBytes(req.preparedMsg));
        return { id: 0, kind: 'blind', blindedMsg: bytesToBase64(out.blindedMsg), inv: bytesToBase64(out.inv) };
      }
      case 'challenge':
        o.seen?.push(`challenge ${req.url}`);
        return { id: 0, kind: 'challenge', nonce: toHex(rnd(40)) };
      case 'token': {
        o.seen?.push(`token ${req.url}`);
        const answer = o.answer?.(req.request, req.signature) ?? { ok: true, blindSig: bytesToBase64(rawSign(rsa, base64ToBytes(req.blindedMsg))) };
        return { id: 0, kind: 'token', answer };
      }
      case 'finalize': {
        const sig = await finalize(key, base64ToBytes(req.preparedMsg), base64ToBytes(req.blindSig), base64ToBytes(req.inv));
        return { id: 0, kind: 'finalize', sig: bytesToBase64(sig) };
      }
    }
  };
}

function setup(o: Parameters<typeof fakeWorker>[0] = {}) {
  const platform = new FakePlatform();
  const ownerId = bytesToId(rnd(32));
  const reader = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => platform.query(q) });
  const posted: Record<string, unknown>[] = [];
  const deps: ClientDeps = {
    net: 'testnet',
    contractId,
    ownerId,
    issuerKey: (i, e) => reader.key(i, e),
    worker: fakeWorker(o) as ClientDeps['worker'],
    signWithWif: (wif, m) => signMessageWif(wif, m, 'testnet'),
    externalSigner: () => undefined,
    async postBadge(data) {
      const doc = { ...data, $ownerId: ownerId, $createdAtCoreBlockHeight: platform.core, issuerId: bytesToId(data.issuerId as Uint8Array), keyId: bytesToBase64(data.keyId as Uint8Array), msgPrefix: bytesToBase64(data.msgPrefix as Uint8Array), sig: bytesToBase64(data.sig as Uint8Array) };
      posted.push(doc);
      platform.badges.push(doc);
      return 'doc1';
    },
    hasBadge: async (iid, e) => platform.badges.some((b) => b.$ownerId === ownerId && b.issuerId === iid && b.epoch === e),
    trusted: (id) => id === issuer.identityId,
    reportedTokens: (i, e) => reader.reportedTokens(i, e),
    minAnonymitySet: 3,
  };
  return { platform, reader, deps, ownerId, posted };
}

const votingKey = () => {
  const priv = secp256k1.utils.randomSecretKey();
  return { wif: encodeWif(priv, true, 'testnet'), keyId: hash160(secp256k1.getPublicKey(priv, true)) };
};
const proTx = () => toHex(rnd(32));

describe('badge client', () => {
  it('schedules inside the issuance window, requests with the voting key, finalizes, posts in [S(E), S(E)+W]; readers verify it', async () => {
    const seen: string[] = [];
    let request = '';
    let signature = '';
    const t = setup({ seen });
    const honest = t.deps.worker;
    t.deps.worker = (async (req: BadgeWorkerCall) => {
      if (req.kind === 'token') {
        request = req.request;
        signature = req.signature;
      }
      return honest(req as never);
    }) as ClientDeps['worker'];
    await t.platform.addKey(E);
    const v = votingKey();
    const pt = proTx();
    const h = epochStart(P, E - 1) + 50;
    const job = await createJob(t.deps, [], v.wif, pt, h, { issuer });
    expect(job.epoch).toBe(E);
    const w = clientIssuanceWindow(P, E);
    expect(job.requestAt >= h && job.requestAt < w.to).toBe(true);
    expect(job.inv && job.blindedMsg && job.preparedMsg).toBeTruthy();
    // not due yet
    expect((await step(t.deps, job, job.requestAt - 1)).state).toBe('scheduled');
    const got = await step(t.deps, job, job.requestAt);
    expect(got.state).toBe('token');
    expect(seen).toEqual(['challenge https://issuer.test', 'token https://issuer.test']);
    // the request names this issuer, epoch, key, MN, and is signed by the voting key
    const req = parseTokenRequest(request);
    expect(req.epoch).toBe(E);
    expect(toHex(req.proTxHash)).toBe(pt);
    expect(bytesToId(req.issuerId)).toBe(issuer.identityId);
    expect(toHex(recoverMessageSigner(signature, request, 'testnet', { strict: true })!.keyId)).toBe(toHex(v.keyId));
    // secrets dropped after finalize; the voting key is not kept unless asked
    expect(got.inv).toBeUndefined();
    expect(got.blindedMsg).toBeUndefined();
    expect(got.signer.kind).toBe('external');
    expect(got.postAt! >= epochStart(P, E) + P.boundaryMarginBlocks && got.postAt! <= epochStart(P, E) + P.graceBlocks).toBe(true);
    // post at postAt, once the issuer reported enough tokens
    t.platform.core = got.postAt!;
    expect((await step(t.deps, got, got.postAt!)).note).toMatch(/Waiting for test's token count/);
    t.platform.reports.set(E, 3);
    expect((await step(t.deps, got, got.postAt! - 1)).state).toBe('token');
    const posted = await step(t.deps, got, got.postAt!);
    expect(posted.state).toBe('posted');
    // a second reader sees exactly one badge from this issuer
    const reader2 = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => t.platform.query(q) });
    const view = await reader2.badgesFor([t.ownerId, bytesToId(rnd(32))]);
    expect(view.byOwner.get(t.ownerId)).toEqual(['test']);
    expect(view.byOwner.size).toBe(1);
    expect(await reader2.live()).toBe(true);
  });

  it('a badge among too few tokens is not posted, and the MN link is forgotten', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const tok = await step(t.deps, await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, immediate: true }), h);
    t.platform.reports.set(E, 2);
    const out = await step(t.deps, tok, tok.postAt!);
    expect(out.state).toBe('expired');
    expect(out.note).toMatch(/would stand out/);
    expect(out.proTxHash).toBe('');
    expect(t.posted).toHaveLength(0);
  });

  it('with little of the window left, the request is for the next epoch; a revoked key or an untrusted issuer is refused or waits', async () => {
    const t = setup();
    await t.platform.addKey(E);
    await t.platform.addKey(E + 1);
    const late = clientIssuanceWindow(P, E).to - 20; // less than a quarter of 576 blocks left
    expect((await createJob(t.deps, [], votingKey().wif, proTx(), late, { issuer })).epoch).toBe(E + 1);
    expect((await createJob(t.deps, [], votingKey().wif, proTx(), epochStart(P, E - 1) + 50, { issuer })).epoch).toBe(E);
    const j = await createJob(t.deps, [], votingKey().wif, proTx(), epochStart(P, E - 1) + 50, { issuer, immediate: true });
    const untrusted = await step({ ...t.deps, trusted: () => false }, j, j.requestAt);
    expect(untrusted.state).toBe('scheduled');
    expect(untrusted.note).toMatch(/not on your trust list/);
    const t2 = setup();
    await t2.platform.addKey(E);
    t2.platform.revocation = { $ownerId: issuer.identityId, $createdAtCoreBlockHeight: 1, epoch: E, keyId: t2.platform.keys.get(E)!.keyId, effectiveCoreHeight: 5 };
    await expect(createJob(t2.deps, [], votingKey().wif, proTx(), epochStart(P, E - 1) + 50, { issuer })).rejects.toThrow(/revoked/);
  });

  it('a lagging issuer (still on an earlier epoch) does not expire the job', async () => {
    const t = setup({ answer: () => ({ ok: false, status: 409, error: 'wrong-epoch', message: 'x', issuingEpoch: E - 1 }) });
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const out = await step(t.deps, await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, immediate: true }), h);
    expect(out.state).toBe('scheduled');
    expect(out.note).toMatch(/still on epoch/);
  });

  it('one request per issuer and epoch; the voting key is dropped when not kept', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, keepKey: false, immediate: true });
    await expect(createJob(t.deps, [job], votingKey().wif, proTx(), h, { issuer })).rejects.toThrow(/already have a badge request/);
    const done = await step(t.deps, job, h);
    expect(done.state).toBe('token');
    expect(done.signer.kind).toBe('external');
    expect(job.keepKey).toBe(false);
    expect((await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer })).keepKey).toBe(false); // default: not kept
  });

  it('refuses without a valid proved issuerKey, a bad proTxHash, or a WIF of another network', async () => {
    const t = setup();
    const h = epochStart(P, E - 1) + 50;
    await expect(createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer })).rejects.toThrow(/no valid key/);
    await t.platform.addKey(E);
    await expect(createJob(t.deps, [], votingKey().wif, 'abc', h, { issuer })).rejects.toThrow(/64 hex/);
    const mainnetWif = encodeWif(secp256k1.utils.randomSecretKey(), true, 'mainnet');
    await expect(createJob(t.deps, [], mainnetWif, proTx(), h, { issuer })).rejects.toThrow(/WIF/);
    // a key published too late (at or after S(E-1)) is not accepted
    t.platform.keys.get(E)!.$createdAtCoreBlockHeight = epochStart(P, E - 1);
    const t2 = setup();
    t2.platform.keys = t.platform.keys;
    await expect(createJob(t2.deps, [], votingKey().wif, proTx(), h, { issuer })).rejects.toThrow(/too late/);
  });

  it('issuer refusals end the job; transient errors keep it; a non-verifying answer flags the issuer', async () => {
    const h = epochStart(P, E - 1) + 50;
    for (const [answer, state] of [
      [{ ok: false, status: 409, error: 'already-issued', message: 'x' }, 'failed'],
      [{ ok: false, status: 403, error: 'unauthorized', message: 'x' }, 'failed'],
      [{ ok: false, status: 409, error: 'wrong-epoch', message: 'x' }, 'expired'],
      [{ ok: false, status: 503, error: 'unavailable', message: 'x' }, 'scheduled'],
      [{ ok: false, status: 401, error: 'bad-challenge', message: 'x' }, 'scheduled'],
    ] as const) {
      const t = setup({ answer: () => answer });
      await t.platform.addKey(E);
      const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, immediate: true });
      const out = await step(t.deps, job, h);
      expect(out.state, answer.error).toBe(state);
      if (state !== 'scheduled') expect(out.inv).toBeUndefined();
    }
    const evil = setup({ answer: () => ({ ok: true, blindSig: bytesToBase64(rnd(256)) }) });
    await evil.platform.addKey(E);
    const job = await createJob(evil.deps, [], votingKey().wif, proTx(), h, { issuer, immediate: true });
    const out = await step(evil.deps, job, h);
    expect(out).toMatchObject({ state: 'failed', issuerFlagged: true });
  });

  it('expires when the window closes before the request, and when the display window ends before posting', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer });
    expect((await step(t.deps, job, clientIssuanceWindow(P, E).to)).state).toBe('expired');
    const tok = await step(t.deps, { ...job, requestAt: h }, h);
    expect((await step(t.deps, tok, displayWindow(P, E).to + 1)).state).toBe('expired');
  });

  it('renews for the next epoch inside its window when the key is kept', async () => {
    const t = setup();
    await t.platform.addKey(E);
    await t.platform.addKey(E + 1);
    const h = epochStart(P, E - 1) + 50;
    const job = await step(t.deps, await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, immediate: true, keepKey: true }), h);
    expect(job.signer.kind).toBe('wif');
    expect(await renewal(t.deps, [job], job, h, issuer)).toBeNull(); // E+1's window is not open yet
    const r = await renewal(t.deps, [job], job, epochStart(P, E) + 10, issuer);
    expect(r?.epoch).toBe(E + 1);
    expect(await renewal(t.deps, [job, r!], job, epochStart(P, E) + 10, issuer)).toBeNull();
  });
});

describe('badge reader', () => {
  async function issued(platform: FakePlatform, owner: string, epoch = E, over: Partial<Record<string, unknown>> = {}) {
    const key = await importIssuerKey(spki);
    const { bindIssuerKey, prepareBadge, idToBytes } = await import('@govhub/badge');
    const bound = bindIssuerKey(key, { net: 'testnet', contractId: idToBytes(contractId), issuerId: idToBytes(issuer.identityId), epoch });
    const pr = prepareBadge(bound, idToBytes(owner));
    const b = await blind(key, pr.preparedMsg);
    const sig = await finalize(key, pr.preparedMsg, rawSign(rsa, b.blindedMsg), b.inv);
    const doc = { $id: bytesToId(rnd(32)), $ownerId: owner, $createdAtCoreBlockHeight: epochStart(P, epoch) + 5, issuerId: issuer.identityId, epoch, keyId: bytesToBase64(key.keyId), msgPrefix: bytesToBase64(pr.msgPrefix), sig: bytesToBase64(sig), ...over };
    platform.badges.push(doc);
    return doc;
  }

  it('shows each owner at most once per issuer, across the current and the grace epoch', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    await p.addKey(E - 1);
    const a = bytesToId(rnd(32));
    await issued(p, a, E);
    await issued(p, a, E - 1, { $createdAtCoreBlockHeight: epochStart(P, E - 1) + 5 });
    p.core = epochStart(P, E) + 10; // inside E-1's grace
    const r = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q) });
    expect((await r.badgesFor([a])).byOwner.get(a)).toEqual(['test']);
  });

  it('ignores badges copied to another identity, tampered, posted before S(E), or from untrusted / disabled issuers', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    const a = bytesToId(rnd(32));
    const b = bytesToId(rnd(32));
    const c = bytesToId(rnd(32));
    const d = bytesToId(rnd(32));
    const good = await issued(p, a);
    p.badges.push({ ...good, $ownerId: b }); // copied
    const t = await issued(p, c);
    const sig = base64ToBytes(t.sig as string);
    sig[3]! ^= 1;
    t.sig = bytesToBase64(sig);
    await issued(p, d, E, { $createdAtCoreBlockHeight: epochStart(P, E) - 1 });
    const r = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q) });
    const view = await r.badgesFor([a, b, c, d]);
    expect([...view.byOwner.keys()]).toEqual([a]);
    const off = new BadgeReader({ net: 'testnet', contractId, issuers: [{ ...issuer, enabled: false }], query: (q) => p.query(q) });
    expect((await off.badgesFor([a])).byOwner.size).toBe(0);
    const other = new BadgeReader({ net: 'testnet', contractId: bytesToId(rnd(32)), issuers: [issuer], query: (q) => p.query(q) });
    expect((await other.badgesFor([a])).byOwner.size).toBe(0); // message commits to the contract id
  });

  it('flags an issuer whose badges exceed its reported tokensIssued and hides its badges for that epoch', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    const owners = [0, 1, 2].map(() => bytesToId(rnd(32)));
    for (const o of owners) await issued(p, o);
    p.reports.set(E, 3);
    const ok = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q) });
    expect((await ok.audit(issuer, E, p.core)).flagged).toBe(false);
    expect((await ok.badgesFor(owners)).byOwner.size).toBe(3);
    p.reports.set(E, 2);
    const strict = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q) });
    expect(await strict.audit(issuer, E, p.core)).toMatchObject({ badges: 3, tokensIssued: 2, flagged: true });
    expect((await strict.badgesFor(owners)).byOwner.size).toBe(0);
    expect(await strict.live()).toBe(false);
  });

  it('a report counts only if created in [S(E), S(E)+W] and plausible; none after S(E)+W flags the issuer', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    const o = bytesToId(rnd(32));
    await issued(p, o);
    const fresh = () => new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q), maxPlausibleTokens: 2000 });
    p.reports.set(E, 5);
    p.reportHeight = epochStart(P, E) - 1; // published before the epoch: a pre-set count
    expect(await fresh().reportedTokens(issuer, E)).toBeNull();
    expect((await fresh().audit(issuer, E, p.core)).flagged).toBe(false); // not due yet
    p.core = epochStart(P, E) + P.graceBlocks + 1;
    expect(await fresh().audit(issuer, E, p.core)).toMatchObject({ flagged: true, flagReason: 'no valid issuerReport for this epoch' });
    p.reportHeight = null;
    p.reports.set(E, 4294967295);
    expect((await fresh().audit(issuer, E, p.core)).flagReason).toMatch(/more than there are masternodes/);
    p.reports.set(E, 1);
    expect((await fresh().audit(issuer, E, p.core)).flagged).toBe(false);
  });
});

describe('trust list and storage', () => {
  it('visit separation: one request per visit, none after an identity write, a cooldown across tabs, no posts after a request', async () => {
    const { mayPost, mayRequest, noteIdentityWrite, noteRequestSent, resetVisit, COOLDOWN_MS } = await import('./visit.ts');
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    resetVisit();
    expect(mayRequest(st)).toBe(true);
    expect(mayPost()).toBe(true);
    noteRequestSent(st);
    expect(mayRequest(st)).toBe(false);
    expect(mayPost()).toBe(false);
    resetVisit(); // a new visit, but within the cooldown
    expect(mayRequest(st)).toBe(false);
    expect(mayRequest(st, Date.now() + COOLDOWN_MS + 1)).toBe(true);
    noteIdentityWrite();
    expect(mayRequest(st, Date.now() + COOLDOWN_MS + 1)).toBe(false);
    expect(mayPost()).toBe(true);
    resetVisit();
  });

  it('validates issuers', () => {
    const { issuers, errors } = parseTrustList([
      issuer,
      { ...issuer, name: 'dup' },
      { name: 'bad id', identityId: 'xyz', url: 'https://a.b' },
      { name: 'http', identityId: bytesToId(rnd(32)), url: 'http://evil.example' },
      { name: 'creds', identityId: bytesToId(rnd(32)), url: 'https://u:p@a.b' },
      { name: '', identityId: bytesToId(rnd(32)), url: 'https://a.b' },
      { name: 'TEST', identityId: bytesToId(rnd(32)), url: 'https://a.b' },
      { name: 'govhub', identityId: bytesToId(rnd(32)), url: 'https://a.b' },
    ]);
    expect(issuers).toHaveLength(1);
    expect(errors).toHaveLength(7);
    expect(errors.join(' ')).toMatch(/already has this name|another issuer on the list has this name/);
    expect(errors.join(' ')).toMatch(/belongs to a default issuer/);
  });

  it('jobs are encrypted at rest, padded, bound to the identity, and unreadable with another key', async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const id = bytesToId(rnd(32));
    const secret = rnd(32);
    const s = encryptedJobStore(id, await deriveStoreKey(secret, id), storage);
    const job = { v: 1, id: 'j', ownerId: id, inv: 'SECRET-INV', signer: { kind: 'wif', wif: 'cSECRETWIF' } } as unknown as BadgeJob;
    await s.save([job]);
    const raw = [...mem.values()][0]!;
    expect(raw).not.toContain('SECRET');
    const one = JSON.parse(raw).ct.length;
    await s.save([job, { ...job, id: 'k' }]);
    expect(JSON.parse([...mem.values()][0]!).ct.length).toBe(one); // same 16 KiB bucket
    expect(await s.load()).toHaveLength(2);
    const other = encryptedJobStore(id, await deriveStoreKey(rnd(32), id), storage);
    expect(await other.load()).toEqual([]);
    await expect(deriveStoreKey(new Uint8Array(32), id)).rejects.toThrow();
  });

  it('every badge query passes the PV13 lint', () => {
    const id = issuer.identityId;
    expect(() => [issuerKeyQuery(id, 1), revocationQuery(id, 1), reportQuery(id, 1), badgesOfAuthors(id, 1, [id]), allBadges(id, 1), allBadges(id, 1, id)]).not.toThrow();
  });

  it('fromHex sanity for proTxHash display order', () => {
    expect(toHex(fromHex('00ff'))).toBe('00ff');
  });
});
