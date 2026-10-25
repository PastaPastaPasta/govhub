// Starter client and token store with real crypto (fakes in testkit.ts): key selection by the reader rules, request building and
// signing, issuer and faucet error mapping, the redeem body, and the encrypted token store.
import { generatePhrase, SeedWallet } from '@govhub/auth';
import { base64ToBytes, bytesToBase64, bytesToId, epochStart, idToBytes, importIssuerKey, parseStarterRequest, sha256, toHex, verifyStarterToken } from '@govhub/badge';
import { encodeWif, p2pkhAddress, recoverMessageSigner, signMessageWif } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import type { BadgeWorkerCall, FaucetAnswer, IssuerAnswer } from '../badge/protocol.ts';
import {
  checkProposalSignature, findStarterKey, fundingTarget, pickRedeemDelayMs, prepareStarterRequest, redeemStarter, REDEEM_LATER_MAX_MS, REDEEM_LATER_MIN_MS, requestMnStarter, signWithKey, signWithWif,
  StarterError, submitProposalStarter, submitStarterRequest, renewChallenge, type PendingStarter, type StarterDeps, type StarterToken,
} from './client.ts';
import { starterConfig, STARTER_ISSUERS } from './config.ts';
import { forgetStarter, loadStarter, loadStarterFor, pendingStarterKeys, saveStarter, saveStarterFor, starterStorageKey, type StoredStarter } from './store.ts';
import { E, FakePlatform, GOV, issuerSign, P, PRO, pubKeyHash, rnd, setup, spki, starterId, votingKey } from './testkit.ts';

describe('config', () => {
  it('testnet pins the starter issuer and the badge contract; mainnet has none yet', () => {
    const t = starterConfig({ platformNetwork: 'testnet', faucet: null })!;
    expect(t.issuer).toEqual({ identityId: '9Jwa6v2Bwj9TtDmgJGn3KV9qqXprYZUBEkKzkxzx3HD8', url: 'https://gov-issuer-testnet.dashhq.org' });
    expect(t.contractId).toBe('2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU');
    expect(t.faucetUrl).toBe('https://faucet.dashhq.org');
    expect(starterConfig({ platformNetwork: 'testnet', faucet: { name: 'x', url: 'https://f.example' } })!.faucetUrl).toBe('https://f.example');
    expect(STARTER_ISSUERS.mainnet).toBeNull();
    expect(starterConfig({ platformNetwork: 'mainnet', faucet: null })).toBeNull();
  });
});

describe('key selection (proved issuerKey of the starter identity only)', () => {
  it('takes the current epoch when it has a key, else the next', async () => {
    const { platform, deps } = setup();
    await platform.addKey(E + 1);
    expect((await findStarterKey(deps)).epoch).toBe(E + 1);
    await platform.addKey(E);
    const s2 = setup();
    await s2.platform.addKey(E);
    await s2.platform.addKey(E + 1);
    expect((await findStarterKey(s2.deps)).epoch).toBe(E);
  });

  it('skips a current-epoch key published after the epoch began (the label depends on the height only); a late next-epoch key is fine', async () => {
    const { platform, deps } = setup(); // core height inside E
    await platform.addKey(E, { createdAt: epochStart(P, E) + 5 });
    await platform.addKey(E + 1, { createdAt: epochStart(P, E) + 5 });
    expect((await findStarterKey(deps)).epoch).toBe(E + 1);
    const only = setup();
    await only.platform.addKey(E, { createdAt: epochStart(P, E) + 5 });
    await expect(findStarterKey(only.deps)).rejects.toMatchObject({ code: 'no-key', message: expect.stringMatching(/published after the epoch began/) });
  });

  it('skips a revoked key and an invalid one (keyId != SHA256(spki))', async () => {
    const a = setup();
    await a.platform.addKey(E);
    await a.platform.addKey(E + 1);
    await a.platform.revoke(E);
    expect((await findStarterKey(a.deps)).epoch).toBe(E + 1);
    const b = setup();
    await b.platform.addKey(E, { badKeyId: true });
    await b.platform.addKey(E + 1);
    expect((await findStarterKey(b.deps)).epoch).toBe(E + 1);
  });

  it('near the end of an epoch asks only for the next one', async () => {
    const { platform, deps } = setup();
    await platform.addKey(E);
    platform.core = epochStart(P, E + 1) - 1;
    await expect(findStarterKey(deps)).rejects.toMatchObject({ code: 'no-key' });
    await platform.addKey(E + 1);
    expect((await findStarterKey(deps)).epoch).toBe(E + 1);
  });

  it('no valid key: a clear error, nothing sent to the issuer', async () => {
    const { deps, seen } = setup();
    await expect(prepareStarterRequest(deps, { kind: 'mn', subject: PRO, pubKeyHash: pubKeyHash() })).rejects.toMatchObject({ code: 'no-key', retry: true });
    expect(seen.calls).toEqual([]);
  });
});

describe('masternode request', () => {
  it('builds the canonical request for the starter API, signs it with the voting key and gets a token that verifies for the funding key', async () => {
    const { platform, deps, seen } = setup();
    await platform.addKey(E);
    const vk = votingKey();
    const h = pubKeyHash();
    const token = await requestMnStarter(deps, { proTxHash: PRO.toUpperCase(), pubKeyHash: h, sign: (r) => signWithWif(r, vk.wif, 'testnet') });
    expect(seen.calls).toEqual(['blind', 'challenge:starter', 'token:starter', 'finalize']);
    const req = parseStarterRequest(seen.token[0]!.request);
    expect(req).toMatchObject({ net: 'testnet', epoch: E, kind: 'mn' });
    expect(toHex(req.subject)).toBe(PRO);
    expect(bytesToId(req.issuerId)).toBe(starterId);
    expect(toHex(req.keyId)).toBe(toHex(await sha256(spki)));
    expect(recoverMessageSigner(seen.token[0]!.signature, seen.token[0]!.request, 'testnet')!.address).toBe(vk.address);
    expect(token.epoch).toBe(E);
    expect(token.network).toBe('testnet');
    const key = await importIssuerKey(spki);
    expect(await verifyStarterToken(key, { net: 'testnet', issuerId: idToBytes(starterId), epoch: E, pubKeyHash: h }, base64ToBytes(token.msgPrefix), base64ToBytes(token.sig))).toBe(true);
    // bound to the funding key: another pubKeyHash does not verify
    expect(await verifyStarterToken(key, { net: 'testnet', issuerId: idToBytes(starterId), epoch: E, pubKeyHash: rnd(20) }, base64ToBytes(token.msgPrefix), base64ToBytes(token.sig))).toBe(false);
    expect(token.validUntil).toBeGreaterThan(Date.now());
  });

  it('a keyring key signs with its own compressed flag', async () => {
    const priv = secp256k1.utils.randomSecretKey();
    const req = 'govhub-starter-req:v1|x';
    expect(recoverMessageSigner(signWithKey(req, { privateKey: priv, compressed: false }), req, 'testnet')!.pubkey.length).toBe(65);
    expect(recoverMessageSigner(signWithKey(req, { privateKey: priv, compressed: true }), req, 'testnet')!.pubkey.length).toBe(33);
  });

  it('refuses a malformed WIF or another network’s key, and a bad proTxHash before anything is sent', async () => {
    const { deps, seen } = setup();
    expect(() => signWithWif('x', 'nonsense', 'testnet')).toThrow(/not a testnet private key/);
    expect(() => signWithWif('x', encodeWif(secp256k1.utils.randomSecretKey(), true, 'mainnet'), 'testnet')).toThrow(StarterError);
    await expect(prepareStarterRequest(deps, { kind: 'mn', subject: 'abc', pubKeyHash: pubKeyHash() })).rejects.toMatchObject({ code: 'input' });
    expect(seen.calls).toEqual([]);
  });
});

describe('proposal request', () => {
  it('the pasted signature is checked against the payment address before anything is sent', async () => {
    const { platform, deps, seen } = setup();
    await platform.addKey(E);
    const pay = votingKey();
    const other = votingKey();
    const p = await prepareStarterRequest(deps, { kind: 'proposal', subject: GOV, pubKeyHash: pubKeyHash() });
    const req = parseStarterRequest(p.request);
    expect(req.kind).toBe('proposal');
    expect(toHex(req.subject)).toBe(GOV);
    expect(p.expiresAt).toBeGreaterThan(Date.now() + 29 * 60_000);
    const good = signMessageWif(pay.wif, p.request, 'testnet');
    const bad = signMessageWif(other.wif, p.request, 'testnet');
    expect(checkProposalSignature(pay.address, good, p.request, 'testnet')).toBe(true);
    expect(checkProposalSignature(pay.address, bad, p.request, 'testnet')).toBe(false);
    expect(checkProposalSignature(pay.address, 'not base64!', p.request, 'testnet')).toBe(false);
    await expect(submitProposalStarter(deps, p, pay.address, bad)).rejects.toMatchObject({ code: 'bad-signature' });
    expect(seen.token).toHaveLength(0);
    const token = await submitProposalStarter(deps, p, pay.address, `  ${good}\n`);
    expect(seen.token[0]!.signature).toBe(good);
    expect(token.epoch).toBe(E);
  });

  it('an expired challenge (the issuer decides, not this clock) asks for a new message', async () => {
    const { platform, deps } = setup({ answer: () => ({ ok: false, status: 401, error: 'bad-challenge', message: 'expired' }) });
    await platform.addKey(E);
    const pay = votingKey();
    const p = await prepareStarterRequest(deps, { kind: 'proposal', subject: GOV, pubKeyHash: pubKeyHash() });
    await expect(submitProposalStarter(deps, p, pay.address, signMessageWif(pay.wif, p.request, 'testnet'))).rejects.toMatchObject({ code: 'expired', message: expect.stringMatching(/limited time/) });
  });

  it('"get a new message" keeps the blinding: only the nonce changes (the issuer re-signs a repeat of the same blinded message)', async () => {
    const { platform, deps } = setup();
    await platform.addKey(E);
    const p = await prepareStarterRequest(deps, { kind: 'proposal', subject: GOV, pubKeyHash: pubKeyHash() });
    const p2 = await renewChallenge(deps, p);
    const [a, b] = [parseStarterRequest(p.request), parseStarterRequest(p2.request)];
    expect(toHex(b.blindedMsgSha256)).toBe(toHex(a.blindedMsgSha256));
    expect(toHex(b.nonce)).not.toBe(toHex(a.nonce));
    expect(p2.blindedMsg).toBe(p.blindedMsg);
    expect(p2.inv).toBe(p.inv);
  });
});

describe('issuer errors', () => {
  const refuse = (error: string, status: number, extra: Partial<Extract<IssuerAnswer, { ok: false }>> = {}) => () => ({ ok: false as const, status, error, message: `${error} (detail)`, ...extra });
  const run = async (answer: () => IssuerAnswer) => {
    const { platform, deps } = setup({ answer });
    await platform.addKey(E);
    const vk = votingKey();
    return requestMnStarter(deps, { proTxHash: PRO, pubKeyHash: pubKeyHash(), sign: (r) => signWithWif(r, vk.wif, 'testnet') }).then(
      () => null,
      (e: unknown) => e as StarterError,
    );
  };

  it('already-issued says the starter was used, once per masternode / proposal ever', async () => {
    const e = (await run(refuse('already-issued', 409)))!;
    expect(e).toBeInstanceOf(StarterError);
    expect(e.code).toBe('already-issued');
    expect(e.retry).toBe(false);
    expect(e.message).toMatch(/already used your starter/);
    expect(e.message).toMatch(/one starter ever/);
    expect(e.message).toMatch(/pay with a little DASH/);
  });

  it('maps the other codes to plain messages', async () => {
    expect((await run(refuse('unauthorized', 403)))!).toMatchObject({ code: 'unauthorized', message: expect.stringMatching(/voting key/) });
    expect((await run(refuse('not-eligible', 403)))!).toMatchObject({ code: 'not-eligible', message: expect.stringMatching(/cannot get a starter.*detail/) });
    expect((await run(refuse('bad-challenge', 401)))!).toMatchObject({ code: 'expired', message: expect.stringMatching(/limited time/) });
    expect((await run(refuse('wrong-epoch', 409, { issuingEpoch: E - 1 })))!).toMatchObject({ code: 'issuer', retry: true, message: expect.stringMatching(new RegExp(`epoch ${E - 1}`)) });
    // the issuer has moved past the request's epoch: final for this blinding, said plainly
    expect((await run(refuse('wrong-epoch', 409, { issuingEpoch: E + 1 })))!).toMatchObject({ code: 'closed', retry: false, stale: true, message: expect.stringMatching(/can no longer be completed/) });
    expect((await run(refuse('unavailable', 503)))!).toMatchObject({ retry: true, message: expect.stringMatching(/busy/) });
    expect((await run(refuse('nope', 404)))!).toMatchObject({ message: expect.stringMatching(/does not offer starters/) });
  });

  it('an answer that does not finalize is the issuer’s fault, said so', async () => {
    const e = (await run(() => ({ ok: true, blindSig: bytesToBase64(rnd(256)) })))!;
    expect(e).toMatchObject({ code: 'bad-answer' });
    expect(e.message).toMatch(/issuer answered with something that is not a valid signature/);
  });

  it('a lost answer: the retry for the same masternode reuses the prepared blinding (no "already used")', async () => {
    let lose = true;
    const { platform, deps, seen } = setup({
      answer: (_r, _s, blinded) => {
        if (lose) {
          lose = false;
          throw new Error('timed out');
        }
        return { ok: true, blindSig: issuerSign(blinded) };
      },
    });
    await platform.addKey(E);
    const vk = votingKey();
    let pending: PendingStarter | null = null;
    const attempt = () => requestMnStarter(deps, { proTxHash: PRO, pubKeyHash: pubKeyHash(), sign: (r) => signWithWif(r, vk.wif, 'testnet'), pending, onPending: (p) => void (pending = p) });
    await expect(attempt()).rejects.toMatchObject({ code: 'unreachable', retry: true });
    const token = await attempt();
    expect(token.epoch).toBe(E);
    const [a, b] = seen.token.map((t) => parseStarterRequest(t.request));
    expect(toHex(b!.blindedMsgSha256)).toBe(toHex(a!.blindedMsgSha256));
    expect(seen.calls.filter((c) => c === 'blind')).toHaveLength(1);
  });

  it('an unreachable issuer is a retryable error', async () => {
    const { platform, deps } = setup();
    await platform.addKey(E);
    const worker = deps.worker;
    deps.worker = (async (r: BadgeWorkerCall) => {
      if (r.kind === 'challenge') throw new Error('Failed to fetch');
      return worker(r as never);
    }) as StarterDeps['worker'];
    await expect(prepareStarterRequest(deps, { kind: 'mn', subject: PRO, pubKeyHash: pubKeyHash() })).rejects.toMatchObject({ code: 'unreachable', retry: true, message: expect.stringMatching(/issuer\.test could not be reached/) });
  });
});

describe('redeem', () => {
  const wallet = () => SeedWallet.fromPhrase(generatePhrase(12), 'testnet');

  async function token(deps: StarterDeps, platform: FakePlatform, h: Uint8Array): Promise<StarterToken> {
    await platform.addKey(E);
    const vk = votingKey();
    return requestMnStarter(deps, { proTxHash: PRO, pubKeyHash: h, sign: (r) => signWithWif(r, vk.wif, 'testnet') });
  }

  it('posts exactly {network, epoch, address, msgPrefix, sig} for the funding address; a replay is a success', async () => {
    const { platform, deps, seen } = setup();
    const w = wallet();
    const t = fundingTarget(w, 0);
    expect(t.address).toBe(p2pkhAddress(t.pubKeyHash, 'testnet'));
    const tok = await token(deps, platform, t.pubKeyHash);
    const r1 = await redeemStarter(deps, tok, t.address);
    expect(Object.keys(seen.redeem[0]!).sort()).toEqual(['address', 'epoch', 'msgPrefix', 'network', 'sig']);
    expect(seen.redeem[0]).toEqual({ network: 'testnet', epoch: E, address: t.address, msgPrefix: tok.msgPrefix, sig: tok.sig });
    expect(r1).toMatchObject({ replay: false, amountSats: 600_000 });
    const r2 = await redeemStarter(deps, tok, t.address);
    expect(r2).toEqual({ ...r1, replay: true });
    // another address: the token does not verify there
    await expect(redeemStarter(deps, tok, fundingTarget(w, 1).address)).rejects.toMatchObject({ code: 'faucet-rejected', message: expect.stringMatching(/did not accept this token/) });
    w.wipe();
  });

  it('maps the faucet’s 429 / 503 / 400 codes', async () => {
    const tok: StarterToken = { network: 'testnet', epoch: E, msgPrefix: bytesToBase64(rnd(32)), sig: bytesToBase64(rnd(256)), validUntil: 0 };
    const answer = (a: FaucetAnswer) => setup({ faucet: () => a }).deps;
    await expect(redeemStarter(answer({ ok: false, status: 429, code: 'budget', message: 'x', retryAfter: 600 }), tok, 'yX')).rejects.toMatchObject({ code: 'faucet-busy', retry: true, message: expect.stringMatching(/about 10 minutes/) });
    await expect(redeemStarter(answer({ ok: false, status: 503, code: 'unavailable', message: 'x' }), tok, 'yX')).rejects.toMatchObject({ code: 'faucet-busy', retry: true });
    await expect(redeemStarter(answer({ ok: false, status: 400, code: 'unknown-key', message: 'x' }), tok, 'yX')).rejects.toMatchObject({ code: 'faucet-rejected', retry: true, message: expect.stringMatching(/right now/) });
    await expect(redeemStarter(answer({ ok: false, status: 400, code: 'bad-request', message: 'address wrong' }), tok, 'yX')).rejects.toMatchObject({ code: 'faucet', message: expect.stringMatching(/address wrong/) });
    await expect(redeemStarter(answer({ ok: false, status: 404, code: 'disabled', message: 'x' }), tok, 'yX')).rejects.toMatchObject({ code: 'faucet', message: expect.stringMatching(/does not pay starters/) });
    await expect(redeemStarter(answer({ ok: true, txid: 'aa'.repeat(32), amountSats: 1, address: 'yOther', replay: false }), tok, 'yX')).rejects.toMatchObject({ code: 'faucet' });
  });

  it('"later" draws a delay between 15 minutes and 6 hours', () => {
    for (let i = 0; i < 200; i++) {
      const d = pickRedeemDelayMs();
      expect(d).toBeGreaterThanOrEqual(REDEEM_LATER_MIN_MS);
      expect(d).toBeLessThanOrEqual(REDEEM_LATER_MAX_MS);
    }
  });
});

describe('token store', () => {
  class Mem implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> {
    m = new Map<string, string>();
    getItem = (k: string) => this.m.get(k) ?? null;
    setItem = (k: string, v: string) => void this.m.set(k, v);
    removeItem = (k: string) => void this.m.delete(k);
    key = (i: number) => [...this.m.keys()][i] ?? null;
    get length() {
      return this.m.size;
    }
  }
  const entry = (): StoredStarter => ({ v: 1, token: { network: 'testnet', epoch: E, msgPrefix: bytesToBase64(rnd(32)), sig: bytesToBase64(rnd(256)), validUntil: 123 }, dueAt: 456 });

  it('round-trips under govhub.starter.v1.<network>.<pubKeyHashHex>, encrypted', async () => {
    const s = new Mem();
    const priv = rnd(32);
    const h = rnd(20);
    const e = entry();
    await saveStarter(s, priv, 'testnet', h, e);
    const name = starterStorageKey('testnet', toHex(h));
    expect([...s.m.keys()]).toEqual([name]);
    const raw = s.getItem(name)!;
    expect(raw).not.toContain(e.token.sig);
    expect(raw).not.toContain(e.token.msgPrefix);
    expect(raw).not.toMatch(/epoch|dueAt|testnet/);
    expect(await loadStarter(s, priv, 'testnet', h)).toEqual(e);
    expect(pendingStarterKeys(s, 'testnet')).toEqual([toHex(h)]);
    expect(pendingStarterKeys(s, 'mainnet')).toEqual([]);
    forgetStarter(s, 'testnet', toHex(h));
    expect(await loadStarter(s, priv, 'testnet', h)).toBeNull();
  });

  it('another key does not open it, nor does the entry moved under another name (AAD)', async () => {
    const s = new Mem();
    const priv = rnd(32);
    const h = rnd(20);
    await saveStarter(s, priv, 'testnet', h, entry());
    await expect(loadStarter(s, rnd(32), 'testnet', h)).rejects.toThrow();
    const h2 = rnd(20);
    s.setItem(starterStorageKey('testnet', toHex(h2)), s.getItem(starterStorageKey('testnet', toHex(h)))!);
    await expect(loadStarter(s, priv, 'testnet', h2)).rejects.toThrow();
    await expect(saveStarter(s, new Uint8Array(32), 'testnet', h, entry())).rejects.toThrow(/no funding key/);
  });

  it('per account setup of a seed: only that phrase and index open it; nothing about the masternode is stored', async () => {
    const s = new Mem();
    const phrase = generatePhrase(12);
    const w = SeedWallet.fromPhrase(phrase, 'testnet');
    const e = entry();
    await saveStarterFor(s, w, 0, e);
    const t = fundingTarget(w, 0);
    expect([...s.m.keys()]).toEqual([starterStorageKey('testnet', toHex(t.pubKeyHash))]);
    expect(s.getItem([...s.m.keys()][0]!)).not.toContain(PRO);
    expect(await loadStarterFor(s, SeedWallet.fromPhrase(phrase, 'testnet'), 0)).toEqual(e);
    expect(await loadStarterFor(s, w, 1)).toBeNull();
    expect(await loadStarterFor(s, SeedWallet.fromPhrase(generatePhrase(12), 'testnet'), 0)).toBeNull();
    // the stored JSON is the token and its due time, nothing else
    expect(Object.keys(e).sort()).toEqual(['dueAt', 'token', 'v']);
    w.wipe();
  });

  it('a token request never stores a masternode field anywhere (submitStarterRequest output)', async () => {
    const { platform, deps } = setup();
    await platform.addKey(E);
    const vk = votingKey();
    const p = await prepareStarterRequest(deps, { kind: 'mn', subject: PRO, pubKeyHash: pubKeyHash() });
    const tok = await submitStarterRequest(deps, p, signWithWif(p.request, vk.wif, 'testnet'));
    expect(Object.keys(tok).sort()).toEqual(['epoch', 'msgPrefix', 'network', 'sig', 'validUntil']);
    expect(JSON.stringify(tok)).not.toContain(PRO);
  });
});
