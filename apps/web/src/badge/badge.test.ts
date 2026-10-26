// Badge client, reader and store with real crypto: a raw RSA signer stands in for the issuer, a fake query for Platform.
import { constants, createPublicKey, generateKeyPairSync, privateDecrypt, randomBytes, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  blind,
  bytesToBase64,
  bytesToId,
  privateRequestWindow,
  displayWindow,
  EPOCH_PARAMS,
  epochStart,
  finalize,
  fromHex,
  importIssuerKey,
  keyDeadline,
  parseTokenRequest,
  sha256,
  toHex,
  VARIANT,
} from '@govhub/badge';
import { hash160, recoverMessageSigner, signMessageWif, encodeWif } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { DocQuery } from '@govhub/contracts-v1/queryLint';
import { checkKeyAvailability, createJob, issuerErrorText, renewal, step, type BadgeJob, type ClientDeps } from './client.ts';
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
  /** more issuerKey documents returned with the real one (the unique index makes this impossible on Platform) */
  extraKeyDocs: Record<string, unknown>[] = [];
  async query(q: DocQuery) {
    const w = Object.fromEntries(q.where.map(([k, , v]) => [k, v]));
    let docs: Record<string, unknown>[] = [];
    if (q.documentTypeName === 'issuerRevocation') docs = this.revocation && w.epoch === this.revocation.epoch ? [this.revocation] : [];
    if (q.documentTypeName === 'issuerKey') docs = w.$ownerId === issuer.identityId && this.keys.has(w.epoch as number) ? [this.keys.get(w.epoch as number)!, ...this.extraKeyDocs] : [];
    if (q.documentTypeName === 'issuerReport' && this.reports.has(w.epoch as number)) docs = [{ $ownerId: issuer.identityId, $createdAtCoreBlockHeight: this.reportHeight ?? epochStart(P, (w.epoch as number) + 1) + 4, epoch: w.epoch, tokensIssued: this.reports.get(w.epoch as number) }];
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
      case 'provenMasternodes':
        return { id: 0, kind: 'provenMasternodes', count: 150, height: 1, weak: null };
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
    issuerFlagged: async (i, e) => (await reader.audit({ ...i, enabled: true }, e, platform.core)).flagged,
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
    const job = await createJob(t.deps, [], v.wif, pt, h, { issuer, mode: 'private' });
    expect(job.epoch).toBe(E);
    const w = privateRequestWindow(P, E);
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
    const waiting = await step(t.deps, got, got.postAt!);
    expect(waiting.note).toMatch(/Waiting for test's token count/);
    expect(waiting.retryAt! - Date.now()).toBeGreaterThan(3_500_000); // backs off, so it does not mark a write every tick
    t.platform.reports.set(E - 1, 3) // the crowd check reads the previous epoch's report;
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

  it('Standard mode (the default): a token for the CURRENT epoch, then posted at once, no crowd check; readers accept it', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const h = epochStart(P, E) + 10;
    t.platform.core = h;
    const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer });
    expect(job).toMatchObject({ mode: 'standard', epoch: E, requestAt: h });
    const tok = await step(t.deps, job, h);
    expect(tok).toMatchObject({ state: 'token', postAt: h });
    const posted = await step(t.deps, tok, h); // no report exists for E-1: Standard does not wait for one
    expect(posted.state).toBe('posted');
    const view = await new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => t.platform.query(q) }).badgesFor([t.ownerId]);
    expect(view.byOwner.get(t.ownerId)).toEqual(['test']);
  });

  it('Standard mode works as soon as the current epoch\'s key lands, even mid-epoch; readers accept the badge', async () => {
    const t = setup();
    const h = epochStart(P, E) + 100;
    t.platform.core = h;
    const before = await checkKeyAvailability(t.deps.issuerKey, issuer, 'testnet', h);
    expect(before.modes.find((m) => m.mode === 'standard')).toMatchObject({ epoch: E, ok: false });
    await expect(createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer })).rejects.toThrow(/hasn’t published this period’s key yet/);
    // the issuer publishes E's key now, during E (the old rule wanted it before S(E-1))
    await t.platform.addKey(E);
    t.platform.keys.get(E)!.$createdAtCoreBlockHeight = h - 2;
    const after = await checkKeyAvailability(t.deps.issuerKey, issuer, 'testnet', h);
    expect(after.modes.find((m) => m.mode === 'standard')).toMatchObject({ epoch: E, ok: true });
    const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer });
    const posted = await step(t.deps, await step(t.deps, job, h), h);
    expect(posted.state).toBe('posted');
    const view = await new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => t.platform.query(q) }).badgesFor([t.ownerId]);
    expect(view.byOwner.get(t.ownerId)).toEqual(['test']);
  });

  it('the reader refuses an epoch for which the query returns two issuerKey documents', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const other = new Uint8Array(createPublicKey(generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 }).privateKey).export({ type: 'spki', format: 'der' }));
    t.platform.extraKeyDocs = [{ ...t.platform.keys.get(E)!, spki: bytesToBase64(other), keyId: bytesToBase64(await sha256(other)) }];
    expect(await t.reader.key(issuer, E)).toEqual({ key: null, problem: 'more than one issuerKey for this epoch' });
  });

  it('Standard mode in the last blocks of an epoch asks for the next one and posts from its start', async () => {
    const t = setup();
    await t.platform.addKey(E + 1);
    const h = epochStart(P, E + 1) - 1;
    const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'standard' });
    expect(job).toMatchObject({ epoch: E + 1, requestAt: epochStart(P, E + 1) });
    expect((await step(t.deps, job, h)).state).toBe('scheduled');
  });

  it('issuer not ready: a Standard request is scheduled for its first key\'s epoch, sent from that epoch\'s start, and the voting key is wiped once sent', async () => {
    const t = setup();
    await t.platform.addKey(E); // none for E-1, the current epoch
    const h = epochStart(P, E - 1) + 50;
    const v = votingKey();
    await expect(createJob(t.deps, [], v.wif, proTx(), h, { issuer, mode: 'standard' })).rejects.toThrow(/current epoch/);
    const job = await createJob(t.deps, [], v.wif, proTx(), h, { issuer, mode: 'standard', epoch: E });
    expect(job).toMatchObject({ mode: 'standard', epoch: E, requestAt: epochStart(P, E), state: 'scheduled', keepKey: false, signer: { kind: 'wif', wif: v.wif } });
    expect(await step(t.deps, job, h)).toEqual(job); // nothing happens before S(E)
    await expect(createJob(t.deps, [job], votingKey().wif, proTx(), h, { issuer, mode: 'standard', epoch: E })).rejects.toThrow(/already have a badge request/);
    // out of reach, or earlier than the mode asks for now
    await expect(createJob(t.deps, [], v.wif, proTx(), h, { issuer, mode: 'standard', epoch: E + 3 })).rejects.toThrow(/cannot be requested now/);
    await expect(createJob(t.deps, [], v.wif, proTx(), h, { issuer, mode: 'standard', epoch: E - 2 })).rejects.toThrow(/cannot be requested now/);
    const tok = await step(t.deps, job, epochStart(P, E));
    expect(tok.state).toBe('token');
    expect(tok.signer).toEqual({ kind: 'external' }); // the voting key is gone once the request is sent
    expect(JSON.stringify(tok)).not.toContain(v.wif);
    const posted = await step(t.deps, tok, epochStart(P, E));
    expect(posted).toMatchObject({ state: 'posted', proTxHash: '' });
  });

  it('a badge among too few tokens is not posted, and the MN link is forgotten', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const tok = await step(t.deps, await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', immediate: true }), h);
    t.platform.reports.set(E - 1, 2);
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
    const late = privateRequestWindow(P, E).to - 20; // less than a quarter of 576 blocks left
    expect((await createJob(t.deps, [], votingKey().wif, proTx(), late, { issuer, mode: 'private' })).epoch).toBe(E + 1);
    expect((await createJob(t.deps, [], votingKey().wif, proTx(), epochStart(P, E - 1) + 50, { issuer, mode: 'private' })).epoch).toBe(E);
    const j = await createJob(t.deps, [], votingKey().wif, proTx(), epochStart(P, E - 1) + 50, { issuer, mode: 'private', immediate: true });
    const untrusted = await step({ ...t.deps, trusted: () => false }, j, j.requestAt);
    expect(untrusted.state).toBe('scheduled');
    expect(untrusted.note).toMatch(/not on your trust list/);
    const t2 = setup();
    await t2.platform.addKey(E);
    t2.platform.revocation = { $ownerId: issuer.identityId, $createdAtCoreBlockHeight: 1, epoch: E, keyId: t2.platform.keys.get(E)!.keyId, effectiveCoreHeight: 5 };
    await expect(createJob(t2.deps, [], votingKey().wif, proTx(), epochStart(P, E - 1) + 50, { issuer, mode: 'private' })).rejects.toThrow(/revoked/);
  });

  it('a lagging issuer (still on an earlier epoch) does not expire the job', async () => {
    const t = setup({ answer: () => ({ ok: false, status: 409, error: 'wrong-epoch', message: 'x', issuingEpoch: E - 1 }) });
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const out = await step(t.deps, await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', immediate: true }), h);
    expect(out.state).toBe('scheduled');
    expect(out.note).toMatch(/still on epoch/);
  });

  it('one request per issuer and epoch; the voting key is dropped when not kept', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', keepKey: false, immediate: true });
    await expect(createJob(t.deps, [job], votingKey().wif, proTx(), h, { issuer, mode: 'private' })).rejects.toThrow(/already have a badge request/);
    const done = await step(t.deps, job, h);
    expect(done.state).toBe('token');
    expect(done.signer.kind).toBe('external');
    expect(job.keepKey).toBe(false);
    expect((await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private' })).keepKey).toBe(false); // default: not kept
  });

  it('refuses without a valid proved issuerKey, a bad proTxHash, or a WIF of another network', async () => {
    const t = setup();
    const h = epochStart(P, E - 1) + 50;
    await expect(createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private' })).rejects.toThrow(/no valid key/);
    await t.platform.addKey(E);
    await expect(createJob(t.deps, [], votingKey().wif, 'abc', h, { issuer, mode: 'private' })).rejects.toThrow(/64 hex/);
    const mainnetWif = encodeWif(secp256k1.utils.randomSecretKey(), true, 'mainnet');
    await expect(createJob(t.deps, [], mainnetWif, proTx(), h, { issuer, mode: 'private' })).rejects.toThrow(/WIF/);
    // a key published too late (at or after S(E+1) - margin) is not accepted
    t.platform.keys.get(E)!.$createdAtCoreBlockHeight = keyDeadline(P, E);
    const t2 = setup();
    t2.platform.keys = t.platform.keys;
    await expect(createJob(t2.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private' })).rejects.toThrow(/too late/);
  });

  it('issuer refusals end the job; transient errors keep it; a non-verifying answer flags the issuer', async () => {
    const h = epochStart(P, E - 1) + 50;
    for (const [answer, state] of [
      [{ ok: false, status: 409, error: 'already-issued', message: 'x' }, 'failed'],
      [{ ok: false, status: 403, error: 'unauthorized', message: 'x' }, 'failed'],
      [{ ok: false, status: 409, error: 'wrong-epoch', message: 'x' }, 'expired'],
      [{ ok: false, status: 503, error: 'unavailable', message: 'x' }, 'scheduled'], // with a 1-3 h backoff (checked below)
      [{ ok: false, status: 401, error: 'bad-challenge', message: 'x' }, 'scheduled'],
    ] as const) {
      const t = setup({ answer: () => answer });
      await t.platform.addKey(E);
      const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', immediate: true });
      const out = await step(t.deps, job, h);
      expect(out.state, answer.error).toBe(state);
      if (state !== 'scheduled') expect(out.inv).toBeUndefined();
      else expect(out.retryAt! - Date.now()).toBeGreaterThan(3_500_000);
    }
    const evil = setup({ answer: () => ({ ok: true, blindSig: bytesToBase64(rnd(256)) }) });
    await evil.platform.addKey(E);
    const job = await createJob(evil.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', immediate: true });
    const out = await step(evil.deps, job, h);
    expect(out).toMatchObject({ state: 'failed', issuerFlagged: true });
  });

  it('expires when the window closes before the request, and when the display window ends before posting', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private' });
    expect((await step(t.deps, job, privateRequestWindow(P, E).to)).state).toBe('expired');
    const tok = await step(t.deps, { ...job, requestAt: h }, h);
    expect((await step(t.deps, tok, displayWindow(P, E).to + 1)).state).toBe('expired');
  });

  it('renews for the next epoch inside its window when the key is kept', async () => {
    const t = setup();
    await t.platform.addKey(E);
    await t.platform.addKey(E + 1);
    const h = epochStart(P, E - 1) + 50;
    const job = await step(t.deps, await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', immediate: true, keepKey: true }), h);
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

  it('an unflagged audit is not frozen: badges posted after the report are counted after the TTL', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    await issued(p, bytesToId(rnd(32)));
    p.reports.set(E, 1);
    const r = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q), ttlMs: 0 });
    expect((await r.audit(issuer, E, p.core)).flagged).toBe(false);
    await issued(p, bytesToId(rnd(32)));
    expect(await r.audit(issuer, E, p.core)).toMatchObject({ badges: 2, flagged: true });
  });

  it('the plausible bound comes from the proven masternode list when it can be proven, the pinned value otherwise', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    await issued(p, bytesToId(rnd(32)));
    p.reports.set(E, 200);
    const proven = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q), maxPlausibleTokens: 500, provenMasternodes: async () => 150 });
    expect(await proven.audit(issuer, E, p.core)).toMatchObject({ flagged: true, flagReason: 'reported 200 tokens, more than there are masternodes (proven list of 150)' });
    const unproven = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q), maxPlausibleTokens: 500, provenMasternodes: async () => null });
    expect((await unproven.audit(issuer, E, p.core)).flagged).toBe(false);
  });

  it('an issuer flagged on the previous epoch stays hidden in this one (its report for this epoch comes only as it ends)', async () => {
    const p = new FakePlatform();
    await p.addKey(E - 1);
    await p.addKey(E);
    const a = bytesToId(rnd(32));
    const b = bytesToId(rnd(32));
    await issued(p, a, E - 1, { $createdAtCoreBlockHeight: epochStart(P, E - 1) + 5 });
    await issued(p, b, E - 1, { $createdAtCoreBlockHeight: epochStart(P, E - 1) + 6 });
    await issued(p, a, E);
    p.reports.set(E - 1, 1); // two badges for E-1, one token reported
    p.core = epochStart(P, E) + P.graceBlocks + 10;
    const r = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q) });
    expect((await r.audit(issuer, E - 1, p.core)).flagged).toBe(true);
    expect((await r.badgesFor([a])).byOwner.size).toBe(0);
  });

  it('before E\'s report can exist the badge count must stay plausible; a later revocation does not shrink the count', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    for (let i = 0; i < 3; i++) await issued(p, bytesToId(rnd(32)));
    const r = () => new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q), maxPlausibleTokens: 2 });
    expect(await r().audit(issuer, E, p.core)).toMatchObject({ flagged: true, tokensIssued: null }); // 3 badges > 2 masternodes, no report yet
    p.reports.set(E, 1);
    p.core = epochStart(P, E + 1) + 10;
    p.revocation = { $ownerId: issuer.identityId, $createdAtCoreBlockHeight: p.core, epoch: E, keyId: p.keys.get(E)!.keyId, effectiveCoreHeight: 0 };
    const wide = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q) });
    expect(await wide.audit(issuer, E, p.core)).toMatchObject({ badges: 3, flagged: true }); // revoking after the fact does not clear it
  });

  it('a report counts only if created in [S(E+1), S(E+1)+W] and plausible; none after S(E+1)+W flags the issuer', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    const o = bytesToId(rnd(32));
    await issued(p, o);
    const fresh = () => new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q), maxPlausibleTokens: 2000 });
    p.reports.set(E, 5);
    p.reportHeight = epochStart(P, E + 1) - 1; // published before E's issuance window closed: a pre-set count
    expect(await fresh().reportedTokens(issuer, E)).toBeNull();
    expect((await fresh().audit(issuer, E, p.core)).flagged).toBe(false); // not due yet
    p.core = epochStart(P, E + 1) + P.graceBlocks + 1;
    expect(await fresh().audit(issuer, E, p.core)).toMatchObject({ flagged: true, flagReason: 'no valid issuerReport for this epoch' });
    p.reportHeight = null;
    p.reports.set(E, 4294967295);
    expect((await fresh().audit(issuer, E, p.core)).flagReason).toMatch(/more than there are masternodes/);
    p.reports.set(E, 1);
    expect((await fresh().audit(issuer, E, p.core)).flagged).toBe(false);
  });
});

describe('trust list and storage', () => {
  it('activity separation is browser-wide and time-based: requests need a quiet half hour, posts wait for the request cooldown', async () => {
    const { mayPost, mayRequest, noteIdentityWrite, noteRequestSent, requestCooldownLeft, COOLDOWN_MS } = await import('./visit.ts');
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const t0 = 1_800_000_000_000;
    expect(mayRequest(st, t0)).toBe(true);
    noteRequestSent(st, t0);
    expect(mayRequest(st, t0 + 1000)).toBe(false); // another tab, another identity: same browser
    expect(mayPost(st, t0 + 1000)).toBe(false);
    expect(requestCooldownLeft(st, t0 + 1000)).toBe(COOLDOWN_MS - 1000);
    expect(mayPost(st, t0 + COOLDOWN_MS)).toBe(true);
    noteIdentityWrite(st, t0 + COOLDOWN_MS);
    expect(mayRequest(st, t0 + COOLDOWN_MS + 1)).toBe(false); // a reload does not reset it
    expect(mayRequest(st, t0 + 2 * COOLDOWN_MS)).toBe(true);
    // Standard waits only for a PRIVATE request's cooldown
    const { mayStandard, notePrivateRequest } = await import('./visit.ts');
    expect(mayStandard(st, t0 + 1000)).toBe(true); // the request above was not private
    notePrivateRequest(st, t0 + 3 * COOLDOWN_MS);
    expect(mayStandard(st, t0 + 3 * COOLDOWN_MS + 1000)).toBe(false);
    expect(mayStandard(st, t0 + 4 * COOLDOWN_MS)).toBe(true);
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
      { name: 'govhub' + ' '.repeat(34) + 'x', identityId: bytesToId(rnd(32)), url: 'https://a.b' },
      { name: 'gоvhub', identityId: bytesToId(rnd(32)), url: 'https://a.b' },
    ]);
    expect(issuers.map((i) => i.name)).toEqual(['test', 'govhub x']); // padding collapses: what is shown is what is compared
    expect(errors).toHaveLength(8);
    expect(errors.join(' ')).toMatch(/already has this name|another issuer on the list has this name/);
    expect(errors.join(' ')).toMatch(/belongs to a default issuer/);
  });

  it('jobs are encrypted at rest, padded, bound to the identity, and unreadable with another key', async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const id = bytesToId(rnd(32));
    const secret = rnd(32);
    const s = encryptedJobStore(`${id}.2`, id, await deriveStoreKey(secret, id), storage);
    const job = { v: 1, id: 'j', ownerId: id, inv: 'SECRET-INV', signer: { kind: 'wif', wif: 'cSECRETWIF' } } as unknown as BadgeJob;
    await s.save([job]);
    const raw = [...mem.values()][0]!;
    expect(raw).not.toContain('SECRET');
    const one = JSON.parse(raw).ct.length;
    await s.save([job, { ...job, id: 'k' }]);
    expect(JSON.parse([...mem.values()][0]!).ct.length).toBe(one); // same 16 KiB bucket
    expect(await s.load()).toHaveLength(2);
    // the same slot with another key (another sign-in key of the identity) fails closed: load throws, nothing is overwritten
    const other = encryptedJobStore(`${id}.2`, id, await deriveStoreKey(rnd(32), id), storage);
    await expect(other.load()).rejects.toThrow();
    expect(await s.load()).toHaveLength(2);
    expect((await s.load()).every((j) => j.mode === 'private')).toBe(true); // jobs from before privacy modes
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

describe('QA fixes (D-044 .. D-047)', () => {
  it('D-044: key availability per mode is checked from proved keys before the form; Standard without a current key says when and that Private works', async () => {
    const t = setup();
    await t.platform.addKey(E); // the issuer's first key: none for E-1
    const h = epochStart(P, E - 1) + 50;
    const av = await checkKeyAvailability(t.deps.issuerKey, issuer, 'testnet', h);
    expect(av.modes).toEqual([
      { mode: 'standard', epoch: E - 1, ok: false, problem: 'no issuerKey for this epoch' },
      { mode: 'private', epoch: E, ok: true, problem: null },
      { mode: 'extra', epoch: E, ok: true, problem: null },
    ]);
    expect(av.firstKeyEpoch).toBe(E);
    const err = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'standard' }).catch((e: Error) => e.message);
    expect(err).toMatch(new RegExp(`current epoch, ${E - 1}`));
    expect(err).toMatch(/Private may work now/);
    const { availabilityText } = await import('./flow.ts');
    const text = availabilityText(av, 'test', P)!;
    expect(text).toMatch(/Standard is not available yet/);
    expect(text).toMatch(new RegExp(`first key is for epoch ${E}`));
    expect(text).toMatch(/Private works now/);
    expect(text).toMatch(/posted without that check/); // the first key epoch has no earlier count (no crowd check)
    // Settings says it plainly, no reader jargon
    const { issuingText } = await import('./BadgeSettings.tsx');
    expect(issuingText(av, P)).toBe(`Not issuing yet: Standard starts at block ${epochStart(P, E).toLocaleString('en-US')} (in about ${Math.round(((epochStart(P, E) - h) * 157.5) / 3600)} hours); Private requests work now`);
    // a key that is there but unusable is named, not passed off as "not published yet"
    expect(issuingText({ ...av, modes: [{ mode: 'standard', epoch: E - 1, ok: false, problem: 'the issuer revoked this key' }] }, P)).toBe(`Not issuing: its key for epoch ${E - 1} is not valid (the issuer revoked this key)`);
    // a key for this period that the reader's timing rule does not accept yet reads as "not issuing yet", as on testnet for epoch 2741
    const late = { ...av, modes: [{ mode: 'standard' as const, epoch: E - 1, ok: false, problem: 'issuerKey published too late (must precede S(E-1))' }] };
    expect(issuingText(late, P)).toMatch(/^Not issuing yet: Standard starts at block /);
    // the unified flow: Standard is scheduled for epoch E, from its first block
    const { readiness } = await import('./flow.ts');
    expect(readiness(av, 'standard', P)).toEqual({ kind: 'later', epoch: E, from: epochStart(P, E) });
    expect(readiness(av, 'private', P)).toEqual({ kind: 'now', epoch: E });
    // no key at all in reach
    const none = await checkKeyAvailability(setup().deps.issuerKey, issuer, 'testnet', h);
    expect(none.firstKeyEpoch).toBeNull();
    expect(none.modes.every((m) => !m.ok)).toBe(true);
    expect(issuingText(none, P)).toBe('Not issuing yet: its key for this period is not on Platform yet');
    expect(readiness(none, 'standard', P)).toEqual({ kind: 'blocked', noKeys: true });
    const now = await checkKeyAvailability(t.deps.issuerKey, issuer, 'testnet', epochStart(P, E) + 5);
    expect(issuingText(now, P)).toBe(`Issuing now (epoch ${E})`);
  });

  it('D-046: an unreachable issuer gives the host and the browser error, and a backoff; no token request was sent', async () => {
    const t = setup();
    await t.platform.addKey(E);
    const calls: string[] = [];
    t.deps.worker = (async (req: BadgeWorkerCall) => {
      calls.push(req.kind);
      if (req.kind === 'challenge') throw new TypeError('Failed to fetch');
      return fakeWorker()(req);
    }) as ClientDeps['worker'];
    const h = epochStart(P, E - 1) + 50;
    const job = await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', immediate: true });
    const out = await step(t.deps, job, h);
    expect(out.state).toBe('scheduled');
    expect(out.note).toMatch(/issuer\.test could not be reached/);
    expect(out.note).toMatch(/Failed to fetch/);
    expect(out.retryAt! - Date.now()).toBeGreaterThan(3_500_000);
    expect(calls).toEqual(['blind', 'challenge']); // the token request (it names the MN) never went out
    expect(issuerErrorText('https://x.example/', new Error('The operation was aborted due to timeout'))).toMatch(/did not answer in time/);
  });

  it('the cooldown note is for Private and Extra-private requests only: none after a Standard request, which waits for nothing', async () => {
    const { noteRequestSent, notePrivateRequest, privateCooldownLeft, privateCooldownNote, mayPost, mayRequest, requestCooldownLeft, COOLDOWN_MS } = await import('./visit.ts');
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const t0 = 1_800_000_000_000;
    // a Standard request (noteRequestSent alone): the scheduler's spacing still holds, but there is nothing to tell the user
    noteRequestSent(st, t0);
    expect(privateCooldownLeft(st, t0 + 60_000)).toBe(0);
    expect(requestCooldownLeft(st, t0 + 60_000)).toBeGreaterThan(0);
    expect(mayRequest(st, t0 + 60_000)).toBe(false);
    expect(mayPost(st, t0 + 60_000)).toBe(false);
    // a Private or Extra-private request: the note runs for the cooldown, and the same scheduler rules apply
    const t1 = t0 + 2 * COOLDOWN_MS;
    notePrivateRequest(st, t1);
    expect(privateCooldownLeft(st, t1 + 60_000)).toBe(COOLDOWN_MS - 60_000);
    expect(mayRequest(st, t1 + 60_000)).toBe(false);
    expect(mayPost(st, t1 + 60_000)).toBe(false);
    expect(privateCooldownLeft(st, t1 + COOLDOWN_MS)).toBe(0);
    // a Standard request afterwards does not extend or start the note
    noteRequestSent(st, t1 + COOLDOWN_MS + 1000);
    expect(privateCooldownLeft(st, t1 + COOLDOWN_MS + 2000)).toBe(0);
    // unreadable storage: no request can have been sent, so no note (the scheduler's own checks still fail closed)
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
    expect(privateCooldownLeft(blocked, t1)).toBe(0);
    expect(mayRequest(blocked, t1)).toBe(false);
    // the words
    expect(privateCooldownNote(COOLDOWN_MS - 5 * 60_000)).toBe(
      "You asked for a Private badge 5 min ago. To keep govhub's issuer from matching that request to this account by timing, avoid posting, commenting or reacting from this browser for 25 more min. Standard badges don't need this.",
    );
    expect(privateCooldownNote(COOLDOWN_MS - 1000)).toContain('a moment ago');
    expect(privateCooldownNote(COOLDOWN_MS - 1000)).toContain('for 30 more min');
  });

  it('D-046: a private attempt that sent no token request undoes its cooldown mark; a newer mark is kept', async () => {
    const { mayRequest, notePrivateRequest, requestCooldownLeft, noteRequestSent } = await import('./visit.ts');
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const t0 = 1_800_000_000_000;
    const undo = notePrivateRequest(st, t0);
    expect(mayRequest(st, t0 + 1)).toBe(false);
    undo();
    expect(mayRequest(st, t0 + 1)).toBe(true);
    expect(requestCooldownLeft(st, t0 + 1)).toBe(0);
    const undo2 = notePrivateRequest(st, t0 + 10);
    noteRequestSent(st, t0 + 20); // another tab's real request meanwhile
    undo2();
    expect(requestCooldownLeft(st, t0 + 20)).toBeGreaterThan(0);
  });

  it('D-047: no token count after its window from an issuer that served E-1: the private badge is not posted', async () => {
    const t = setup();
    await t.platform.addKey(E - 1);
    await t.platform.addKey(E);
    const h = epochStart(P, E - 1) + 50;
    const tok = await step(t.deps, await createJob(t.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', immediate: true }), h);
    expect(tok.state).toBe('token');
    // past E-1's report window, no report; the audit of E-1 is cached from before the deadline (not flagged then)
    const before = epochStart(P, E) + 5;
    expect((await t.reader.audit({ ...issuer }, E - 1, before)).flagged).toBe(false);
    const late = epochStart(P, E) + P.graceBlocks + 1;
    t.platform.core = late;
    const out = await step(t.deps, { ...tok, postAt: late }, late);
    expect(out.state).toBe('expired');
    expect(out.note).toMatch(/no token count for epoch|failed the audit/);
    expect(t.posted).toHaveLength(0);
    // the gate itself, without the audit: an issuer that served E-1 and published no report
    const t2 = setup();
    await t2.platform.addKey(E - 1);
    await t2.platform.addKey(E);
    const tok2 = await step(t2.deps, await createJob(t2.deps, [], votingKey().wif, proTx(), h, { issuer, mode: 'private', immediate: true }), h);
    const out2 = await step({ ...t2.deps, issuerFlagged: async () => false }, { ...tok2, postAt: late }, late);
    expect(out2).toMatchObject({ state: 'expired', note: expect.stringMatching(/published no token count/) });
    expect(t2.posted).toHaveLength(0);
  });

  it('SR-34: an unflagged audit cached before the report deadline is not reused after it', async () => {
    const p = new FakePlatform();
    await p.addKey(E);
    const r = new BadgeReader({ net: 'testnet', contractId, issuers: [issuer], query: (q) => p.query(q), maxPlausibleTokens: 2000 });
    const due = epochStart(P, E + 1) + P.graceBlocks;
    expect((await r.audit(issuer, E, due)).flagged).toBe(false); // the last height of the report window: not due yet
    expect(await r.audit(issuer, E, due + 1)).toMatchObject({ flagged: true, flagReason: 'no valid issuerReport for this epoch' });
  });

  it('D-047: the Private crowd minimum is above the old values, since the report also counts Standard tokens', async () => {
    const { BADGE_NETWORKS } = await import('./config.ts');
    expect(BADGE_NETWORKS.testnet.minAnonymitySet).toBeGreaterThan(3);
    expect(BADGE_NETWORKS.mainnet.minAnonymitySet).toBeGreaterThan(10);
  });
});
