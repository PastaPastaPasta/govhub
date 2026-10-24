// Token issuance rules (PLAN §8.4) end to end with the real signer and the browser client code, against a fake Core.
import { describe, expect, it } from 'vitest';
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
    await lists.refresh(snapH, P.boundaryMarginBlocks);
    expect(seen).toEqual(['tip']);
    expect(lists.snapshot(snapH)).toBeNull();
    w.core.tip = snapH + 3;
    await lists.refresh(snapH, P.boundaryMarginBlocks);
    await lists.refresh(snapH, P.boundaryMarginBlocks);
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

  it('wrong-epoch tells the client which epoch the issuer is on', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const e = await expectError(issue(w, (await clientRequest(w, mn, { epoch: E + 1 })).body), 'wrong-epoch');
    expect(e.issuingEpoch).toBe(E);
  });

  it('the tip is re-read after authentication: a token is never issued once S(E) is reached', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    const r = await clientRequest(w, mn);
    const lists = w.core.liveLists();
    const stale = { get now() { return { height: epochStart(P, E) - 1, list: lists.now!.list }; }, snapshot: lists.snapshot };
    const { TokenService } = await import('../src/service.ts');
    const svc = new TokenService({ network: 'testnet', params: P, issuerId: w.issuerId, core: { tipHeight: async () => epochStart(P, E) }, lists: stale, store: w.store, challenges: w.challenges, activeKey: () => ({ epoch: E, keyId: w.key.keyId, signer: w.signer }), nowSec: () => w.now.sec });
    const err = await expectError(svc.issue(r.body as never), 'wrong-epoch');
    expect(err.issuingEpoch).toBe(E + 1);
  });

  it('request fields: network, issuer, epoch, key', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    await expectError(issue(w, (await clientRequest(w, mn, { net: 'mainnet' })).body), 'wrong-network');
    await expectError(issue(w, (await clientRequest(w, mn, { issuerId: bytesToId(rnd(32)) })).body), 'wrong-issuer');
    await expectError(issue(w, (await clientRequest(w, mn, { epoch: E + 1 })).body), 'wrong-epoch');
    await expectError(issue(w, (await clientRequest(w, mn, { epoch: E - 1 })).body), 'wrong-epoch');
    await expectError(issue(w, (await clientRequest(w, mn, { keyId: rnd(32) })).body), 'wrong-key');
    expect(w.core.calls).toBe(0); // none of these touched MN state
  });

  it('epoch boundaries: at S(E) tokens for E are no longer issued', async () => {
    const w = await world();
    const mn = w.core.add(fakeMn());
    w.core.tip = epochStart(P, E);
    await expectError(issue(w, (await clientRequest(w, mn)).body), 'wrong-epoch');
    w.core.tip = epochStart(P, E) - 1;
    expect((await issue(w, (await clientRequest(w, mn)).body)).epoch).toBe(E);
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
