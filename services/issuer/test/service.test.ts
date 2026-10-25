// Token issuance rules (PLAN §8.4) end to end with the real signer and the browser client code, against a fake Core.
import { describe, expect, it, vi } from 'vitest';
import { buildTokenRequestFor, bytesToBase64, bytesToId, epochStart, fromHex, idToBytes, toHex } from '@govhub/badge';
import { signMessage } from '@govhub/verify';
import { Challenges } from '../src/challenge.ts';
import { MnLists } from '../src/core.ts';
import { IssueError } from '../src/service.ts';
import { clientRequest, E, fakeMn, finishBadge, P, rnd, TIP, votingKey, world, type World } from './helpers.ts';

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

const issue = (w: World, body: Record<string, unknown>) => w.service.issue(body as never);

describe('token issuance', () => {
  it('happy path: a valid MN gets a blind signature that finalizes into a verifying badge', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const r = await clientRequest(w, mn);
    const out = await issue(w, r.body);
    expect(out.epoch).toBe(E);
    expect(out.retry).toBe(false);
    expect(await finishBadge(w, r, out.blindSig)).toBe(true);
    expect(w.store.issued(E)).toBe(1);
  });

  it('one token per MN per epoch: a second blinded message is refused, a retry of the same one gets the same signature', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const r = await clientRequest(w, mn);
    const a = await issue(w, r.body);
    // retry (new challenge, new signature, SAME blinded message): idempotent
    const req2 = await buildTokenRequestFor({ net: 'testnet', issuerId: idToBytes(w.issuerId), epoch: E, keyId: w.key.keyId, proTxHash: fromHex(mn.proTxHash), nonce: fromHex(w.service.challenge().nonce) }, r.blindedMsg);
    const b = await issue(w, { request: req2, signature: signMessage(mn.votingPriv, req2), blindedMsg: r.body.blindedMsg });
    expect(b.retry).toBe(true);
    expect(toHex(b.blindSig)).toBe(toHex(a.blindSig));
    expect(w.store.issued(E)).toBe(1);
    // a different blinded message for the same MN and epoch
    await expectError(issue(w, (await clientRequest(w, mn)).body), 'already-issued');
  });

  it('two MNs sharing one voting key each get their own token', async () => {
    const w = await world();
    const k = votingKey();
    const a = w.core.add(fakeMn({ votingPriv: k.priv }));
    const b = w.core.add(fakeMn({ votingPriv: k.priv }));
    const ra = await clientRequest(w, a);
    const rb = await clientRequest(w, b);
    expect(await finishBadge(w, ra, (await issue(w, ra.body)).blindSig)).toBe(true);
    expect(await finishBadge(w, rb, (await issue(w, rb.body)).blindSig)).toBe(true);
    expect(w.store.issued(E)).toBe(2);
    await expectError(issue(w, (await clientRequest(w, a)).body), 'already-issued');
  });

  it('a collateral already used this epoch by another proTxHash is refused (collateral churn)', async () => {
    const w = await world();
    const a = w.core.add(fakeMn());
    const b = w.core.add(fakeMn({ collateral: a.now!.collateral }));
    await issue(w, (await clientRequest(w, a)).body);
    await expectError(issue(w, (await clientRequest(w, b)).body), 'already-issued');
  });

  it('authentication: wrong key, unknown MN, and a signature over another request all give the same "unauthorized"', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const wrongKey = await expectError(issue(w, (await clientRequest(w, mn, { signWith: votingKey().priv })).body), 'unauthorized');
    const stranger = fakeMn(); // not in the list
    const unknown = await expectError(issue(w, (await clientRequest(w, stranger)).body), 'unauthorized');
    expect(unknown.message).toBe(wrongKey.message);
    const r = await clientRequest(w, mn);
    const other = await clientRequest(w, mn);
    await expectError(issue(w, { ...r.body, signature: other.signature }), 'unauthorized');
  });

  it('the OWNER or collateral key is not accepted, only the voting key', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const owner = votingKey(); // a different key the operator holds
    await expectError(issue(w, (await clientRequest(w, mn, { signWith: owner.priv })).body), 'unauthorized');
  });

  it('eligibility: valid now, registered and valid at S(E-1), same collateral', async () => {
    const w = await world();
    const banned = w.core.add(fakeMn());
    banned.now!.valid = false;
    await expectError(issue(w, (await clientRequest(w, banned)).body), 'not-eligible');
    const late = w.core.add(fakeMn());
    late.snap = null;
    expect((await expectError(issue(w, (await clientRequest(w, late)).body), 'not-eligible')).message).toMatch(/not registered at the snapshot/);
    const wasBanned = w.core.add(fakeMn());
    wasBanned.snap!.valid = false;
    await expectError(issue(w, (await clientRequest(w, wasBanned)).body), 'not-eligible');
    const moved = w.core.add(fakeMn());
    moved.snap!.collateral = `${toHex(rnd(32))}:0`;
    await expectError(issue(w, (await clientRequest(w, moved)).body), 'not-eligible');
    expect(w.store.issued(E)).toBe(0);
  });

  it('MnLists: the current list every refresh, the S(E-1) snapshot once it is settled, no RPC per request', async () => {
    const w = await world();
    w.core.add(fakeMn());
    const seen: Array<number | 'tip'> = [];
    const orig = w.core.mnList.bind(w.core);
    w.core.mnList = async (height) => (seen.push(height), orig(height));
    const lists = new MnLists(w.core);
    const snapH = epochStart(P, E - 1);
    w.core.tip = snapH + 1; // not settled (margin 3)
    await lists.refresh([snapH], P.boundaryMarginBlocks);
    expect(seen).toEqual(['tip']);
    expect(lists.snapshot(snapH)).toBeNull();
    w.core.tip = snapH + 3;
    await lists.refresh([snapH], P.boundaryMarginBlocks);
    await lists.refresh([snapH], P.boundaryMarginBlocks);
    expect(seen).toEqual(['tip', 'tip', snapH, 'tip']);
    expect(lists.snapshot(snapH)?.size).toBe(1);
    expect(lists.now?.height).toBe(snapH + 3);
  });

  it('per-MN rate limit after authentication; strangers do not consume it', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    for (let i = 0; i < 10; i++) await expectError(issue(w, (await clientRequest(w, mn, { signWith: votingKey().priv })).body), 'unauthorized');
    await issue(w, (await clientRequest(w, mn)).body);
    for (let i = 0; i < 5; i++) await expectError(issue(w, (await clientRequest(w, mn)).body), 'already-issued');
    await expectError(issue(w, (await clientRequest(w, mn)).body), 'unavailable');
  });

  it('the per-MN counts last one wall-clock minute only: nothing about a masternode is held after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2027, 0, 1, 12, 0, 50) });
    try {
      const w = await world();
      const mns = Array.from({ length: 3 }, () => w.core.add(fakeMn()));
      for (const mn of mns) await issue(w, (await clientRequest(w, mn)).body);
      expect(w.service.debugSnapshot().perMn).toHaveLength(3);
      for (let i = 0; i < 5; i++) await expectError(issue(w, (await clientRequest(w, mns[0]!)).body), 'already-issued');
      await expectError(issue(w, (await clientRequest(w, mns[0]!)).body), 'unavailable'); // the limit still holds
      vi.setSystemTime(Date.UTC(2027, 0, 1, 12, 1, 0)); // the next minute
      w.service.prune();
      expect(w.service.debugSnapshot().perMn).toEqual([]);
      // a request that fails before authentication prunes as well
      vi.setSystemTime(Date.UTC(2027, 0, 1, 12, 1, 30));
      await issue(w, (await clientRequest(w, mns[1]!)).body).catch(() => undefined);
      vi.setSystemTime(Date.UTC(2027, 0, 1, 12, 2, 0));
      await expectError(w.service.issue({ request: 'junk', signature: 'x', blindedMsg: 'x' }), 'bad-request');
      expect(w.service.debugSnapshot().perMn).toEqual([]);
      await expectError(issue(w, (await clientRequest(w, mns[0]!)).body), 'already-issued'); // limited again only by the dedup
    } finally {
      vi.useRealTimers();
    }
  });

  it('the global budget counts only requests past the cheap checks; a stale list is refused', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const { TokenService } = await import('../src/service.ts');
    const svc = new TokenService({ network: 'testnet', params: P, issuerId: w.issuerId, core: w.core, lists: w.core.liveLists(), store: w.store, challenges: w.challenges, activeKey: () => ({ epoch: E, keyId: w.key.keyId, signer: w.signer, keyCreatedAt: 1 }), nowSec: () => w.now.sec, maxRecoveriesPerSec: 1 });
    for (let i = 0; i < 5; i++) await expectError(svc.issue({ ...(await clientRequest(w, mn)).body, request: 'junk' } as never), 'bad-request');
    await svc.issue((await clientRequest(w, mn)).body as never); // junk did not use the budget
    const lists = w.core.liveLists();
    const stale = new TokenService({ network: 'testnet', params: P, issuerId: w.issuerId, core: { tipHeight: async () => w.core.tip + 6 }, lists: { get now() { return lists.now; }, snapshot: lists.snapshot }, store: w.store, challenges: w.challenges, activeKey: () => ({ epoch: E, keyId: w.key.keyId, signer: w.signer, keyCreatedAt: 1 }), nowSec: () => w.now.sec });
    const other = w.core.add(fakeMn());
    expect((await expectError(stale.issue((await clientRequest(w, other)).body as never), 'unavailable')).message).toMatch(/out of date/);
  });

  it('wrong-epoch tells the client which epoch the issuer is on', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const e = await expectError(issue(w, (await clientRequest(w, mn, { epoch: E + 1 })).body), 'wrong-epoch');
    expect(e.issuingEpoch).toBe(E - 1); // the current epoch; E (the next one) is issued too
  });

  it('the tip is re-read after authentication: a token for E is never issued once S(E+1) is reached', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const r = await clientRequest(w, mn);
    const lists = w.core.liveLists();
    const stale = { get now() { return { height: epochStart(P, E + 1) - 1, list: lists.now!.list }; }, snapshot: lists.snapshot };
    const { TokenService } = await import('../src/service.ts');
    const svc = new TokenService({ network: 'testnet', params: P, issuerId: w.issuerId, core: { tipHeight: async () => epochStart(P, E + 1) }, lists: stale, store: w.store, challenges: w.challenges, activeKey: () => ({ epoch: E, keyId: w.key.keyId, signer: w.signer, keyCreatedAt: 1 }), nowSec: () => w.now.sec });
    const err = await expectError(svc.issue(r.body as never), 'wrong-epoch');
    expect(err.issuingEpoch).toBe(E + 1);
  });

  it('request fields: network, issuer, epoch, key', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    await expectError(issue(w, (await clientRequest(w, mn, { net: 'mainnet' })).body), 'wrong-network');
    await expectError(issue(w, (await clientRequest(w, mn, { issuerId: bytesToId(rnd(32)) })).body), 'wrong-issuer');
    await expectError(issue(w, (await clientRequest(w, mn, { epoch: E + 1 })).body), 'wrong-epoch');
    await expectError(issue(w, (await clientRequest(w, mn, { epoch: E - 1 })).body), 'unavailable'); // current epoch, no key for it here
    await expectError(issue(w, (await clientRequest(w, mn, { epoch: E - 2 })).body), 'wrong-epoch');
    await expectError(issue(w, (await clientRequest(w, mn, { keyId: rnd(32) })).body), 'wrong-key');
    expect(w.core.calls).toBe(0); // none of these touched MN state
  });

  it('epoch boundaries: tokens for E during E-1 and during E (Standard mode), not from S(E+1)', async () => {
    const w = await world();
    const a = w.core.add(fakeMn());
    const b = w.core.add(fakeMn());
    w.core.tip = epochStart(P, E) + 10; // inside E: the current epoch
    expect((await issue(w, (await clientRequest(w, a)).body)).epoch).toBe(E);
    w.core.tip = epochStart(P, E + 1);
    await expectError(issue(w, (await clientRequest(w, b)).body), 'wrong-epoch');
  });

  it('one token per MN and epoch whichever mode asked: early (during E-1) then again during E is refused', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    await issue(w, (await clientRequest(w, mn)).body); // during E-1, for the next epoch E
    w.core.tip = epochStart(P, E) + 10;
    await expectError(issue(w, (await clientRequest(w, mn)).body), 'already-issued'); // during E, for the current epoch E
    expect(w.store.issued(E)).toBe(1);
  });

  it('challenges: expired, forged, or from another issuer are refused', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const r = await clientRequest(w, mn);
    w.now.sec += 601;
    await expectError(issue(w, r.body), 'bad-challenge');
    w.now.sec -= 601;
    await expectError(issue(w, (await clientRequest(w, mn, { nonce: rnd(40) })).body), 'bad-challenge');
    const other = new Challenges(rnd(32), `testnet|${w.issuerId}`, 600).issue(w.now.sec).nonce;
    await expectError(issue(w, (await clientRequest(w, mn, { nonce: other })).body), 'bad-challenge');
  });

  it('the request must bind the blinded message it is sent with', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const r = await clientRequest(w, mn);
    const other = await clientRequest(w, mn);
    await expectError(issue(w, { ...r.body, blindedMsg: other.body.blindedMsg }), 'bad-request');
  });

  it('malformed bodies are refused before anything else', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const r = await clientRequest(w, mn);
    await expectError(issue(w, { ...r.body, request: 5 }), 'bad-request');
    await expectError(issue(w, { ...r.body, signature: 'not base64!' }), 'bad-request');
    await expectError(issue(w, { ...r.body, signature: bytesToBase64(rnd(64)) }), 'bad-request');
    await expectError(issue(w, { ...r.body, blindedMsg: 'x'.repeat(5000) }), 'bad-request');
    await expectError(issue(w, { ...r.body, request: r.request + ' ' }), 'bad-request');
    expect(w.core.calls).toBe(0);
  });

  it('no key ready, or Core down: unavailable', async () => {
    const w = await world({ keyReady: false });
    const mn = w.core.add(fakeMn());
    await expectError(issue(w, (await clientRequest(w, mn)).body), 'unavailable');
    const w2 = await world();
    const mn2 = w2.core.add(fakeMn());
    const r = await clientRequest(w2, mn2);
    w2.core.down = true;
    await expectError(issue(w2, r.body), 'unavailable');
  });

  it('a token store that started inside the window issues for E only if the key was published after it (late key)', async () => {
    const S1 = epochStart(P, E - 1);
    const m = P.boundaryMarginBlocks;
    // a new issuer: store started at S(E-1)+50, the key published later (beyond the margin): no token for E can predate the store
    const late = await world({ startedAt: S1 + 50, keyCreatedAt: S1 + 51 + m });
    expect((await issue(late, (await clientRequest(late, late.core.add(fakeMn()))).body)).epoch).toBe(E);
    // the key landed within the margin of the store's start (Platform's height can run ahead of dashd): refused
    const close = await world({ startedAt: S1 + 50, keyCreatedAt: S1 + 50 + m });
    expect((await expectError(issue(close, (await clientRequest(close, close.core.add(fakeMn()))).body), 'unavailable')).message).toMatch(/token store started/);
    // a lost database: the key was out before the store started, tokens may have been issued that it does not know
    const lost = await world({ startedAt: S1 + 50, keyCreatedAt: S1 - 5 });
    await expectError(issue(lost, (await clientRequest(lost, lost.core.add(fakeMn()))).body), 'unavailable');
    // the same after a LATE key: published at S(E-1)+20, the database lost and restarted at S(E-1)+50
    const lostLate = await world({ startedAt: S1 + 50, keyCreatedAt: S1 + 20 });
    expect((await expectError(issue(lostLate, (await clientRequest(lostLate, lostLate.core.add(fakeMn()))).body), 'unavailable')).message).toMatch(/token store started/);
  });

  it('a closed epoch issues nothing more', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    w.store.closeThrough(E);
    await expectError(issue(w, (await clientRequest(w, mn)).body), 'wrong-epoch');
  });

  it('TIP sanity', () => {
    expect(TIP).toBe(epochStart(P, E - 1) + 100);
  });
});
