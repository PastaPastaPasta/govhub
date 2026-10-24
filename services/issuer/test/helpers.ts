import { createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bigIntToBytes, bindIssuerKey, blind, buildTokenRequestFor, bytesToBase64, bytesToId, EPOCH_PARAMS, epochStart, finalize, fromHex, idToBytes, importIssuerKey, prepareBadge, toHex, verifyBadgeSignature, type IssuerKey } from '@govhub/badge';
import { hash160, signMessage } from '@govhub/verify';
import { Challenges } from '../src/challenge.ts';
import type { CoreView, MnState } from '../src/core.ts';
import { openTokenStore, type TokenStore } from '../src/db.ts';
import { TokenService } from '../src/service.ts';
import { BlindSigner, generateIssuerKey } from '../src/signer.ts';

export const rnd = (n: number) => new Uint8Array(randomBytes(n));

export function loadVector(name = 'RSABSSA-SHA384-PSS-Randomized'): Record<string, string> {
  const all = JSON.parse(readFileSync(fileURLToPath(new URL('./vectors/rfc9474-appendix-a.json', import.meta.url)), 'utf8')) as Array<{ name: string; fields: Record<string, string> }>;
  return all.find((x) => x.name === name)!.fields;
}
function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1] = [m, ((a % m) + m) % m];
  let [t0, t1] = [0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [t0, t1] = [t1, t0 - q * t1];
  }
  return ((t0 % m) + m) % m;
}
export function vectorPrivateKey(v: Record<string, string>): KeyObject {
  const [p, q, n, e, d] = ['p', 'q', 'n', 'e', 'd'].map((k) => BigInt('0x' + v[k]!)) as [bigint, bigint, bigint, bigint, bigint];
  const nLen = v.n!.length / 2;
  const half = nLen / 2;
  const b = (x: bigint, l: number) => Buffer.from(bigIntToBytes(x, l)).toString('base64url');
  return createPrivateKey({ key: { kty: 'RSA', n: b(n, nLen), e: b(e, 3), d: b(d, nLen), p: b(p, half), q: b(q, half), dp: b(d % (p - 1n), half), dq: b(d % (q - 1n), half), qi: b(modInv(q, p), half) }, format: 'jwk' });
}

export const NET = 'testnet' as const;
export const P = EPOCH_PARAMS.testnet;
export const E = 2742;
/** a tip inside epoch E-1 (issuing for E) */
export const TIP = epochStart(P, E - 1) + 100;

export interface FakeMn {
  proTxHash: string;
  votingPriv: Uint8Array;
  now: MnState | null;
  snap: MnState | null;
}

export function votingKey() {
  const priv = secp256k1.utils.randomSecretKey();
  return { priv, keyId: hash160(secp256k1.getPublicKey(priv, true)) };
}

export function fakeMn(o: { votingPriv?: Uint8Array; collateral?: string } = {}): FakeMn {
  const priv = o.votingPriv ?? votingKey().priv;
  const keyId = hash160(secp256k1.getPublicKey(priv, true));
  const collateral = o.collateral ?? `${toHex(rnd(32))}:1`;
  const st: MnState = { collateral, votingKeyId: keyId, valid: true };
  return { proTxHash: toHex(rnd(32)), votingPriv: priv, now: { ...st }, snap: { ...st } };
}

export class FakeCore implements CoreView {
  tip = TIP;
  mns = new Map<string, FakeMn>();
  calls = 0;
  down = false;
  add(m: FakeMn) {
    this.mns.set(m.proTxHash, m);
    return m;
  }
  async tipHeight() {
    if (this.down) throw new Error('down');
    return this.tip;
  }
  async mnList(height: number | 'tip') {
    this.calls++;
    if (this.down) throw new Error('down');
    const out = new Map<string, MnState>();
    for (const [k, m] of this.mns) {
      const st = height === 'tip' ? m.now : m.snap;
      if (st) out.set(k, st);
    }
    return out;
  }
  /** What MnLists would hold after a refresh, read live (tests change MNs after creating the world). */
  liveLists() {
    const now = () => {
      const list = new Map<string, MnState>();
      for (const [k, m] of this.mns) if (m.now) list.set(k, m.now);
      return list;
    };
    const self = this;
    return {
      get now() {
        return self.down ? null : { height: self.tip, list: now() };
      },
      snapshot: (h: number) => {
        if (h !== epochStart(P, E - 1)) return null;
        const list = new Map<string, MnState>();
        for (const [k, m] of self.mns) if (m.snap) list.set(k, m.snap);
        return list;
      },
    };
  }
}

export interface World {
  issuerId: string;
  contractId: Uint8Array;
  core: FakeCore;
  store: TokenStore;
  challenges: Challenges;
  signer: BlindSigner;
  key: IssuerKey;
  service: TokenService;
  now: { sec: number };
}

let cachedKey: { priv: KeyObject; spki: Uint8Array } | undefined;
export async function world(o: { keyReady?: boolean } = {}): Promise<World> {
  cachedKey ??= (() => {
    const k = generateIssuerKey(2048);
    return { priv: k.privateKey, spki: k.spki };
  })();
  const issuerId = bytesToId(rnd(32));
  const core = new FakeCore();
  const store = openTokenStore(':memory:');
  store.markStarted(0);
  const challenges = new Challenges(rnd(32), `${NET}|${issuerId}`, 600);
  const signer = new BlindSigner(cachedKey.priv);
  const key = await importIssuerKey(cachedKey.spki);
  const now = { sec: 1_800_000_000 };
  const service = new TokenService({
    network: NET,
    params: P,
    issuerId,
    core,
    lists: core.liveLists(),
    store,
    challenges,
    activeKey: (e) => (o.keyReady === false || e !== E ? null : { epoch: E, keyId: key.keyId, signer }),
    nowSec: () => now.sec,
  });
  return { issuerId, contractId: rnd(32), core, store, challenges, signer, key, service, now };
}

/** What the browser client does: blind, build and sign the request. */
export async function clientRequest(w: World, mn: FakeMn, over: { epoch?: number; keyId?: Uint8Array; issuerId?: string; net?: 'testnet' | 'mainnet'; ownerId?: Uint8Array; nonce?: Uint8Array; signWith?: Uint8Array } = {}) {
  const ownerId = over.ownerId ?? rnd(32);
  const bound = bindIssuerKey(w.key, { net: NET, contractId: w.contractId, issuerId: idToBytes(w.issuerId), epoch: E });
  const prepared = prepareBadge(bound, ownerId);
  const { blindedMsg, inv } = await blind(w.key, prepared.preparedMsg);
  const nonce = over.nonce ?? fromHex(w.service.challenge().nonce);
  const request = await buildTokenRequestFor(
    { net: over.net ?? NET, issuerId: idToBytes(over.issuerId ?? w.issuerId), epoch: over.epoch ?? E, keyId: over.keyId ?? w.key.keyId, proTxHash: fromHex(mn.proTxHash), nonce },
    blindedMsg,
  );
  const signature = signMessage(over.signWith ?? mn.votingPriv, request);
  return { ownerId, bound, prepared, blindedMsg, inv, request, signature, body: { request, signature, blindedMsg: bytesToBase64(blindedMsg) } };
}

export async function finishBadge(w: World, r: Awaited<ReturnType<typeof clientRequest>>, blindSig: Uint8Array) {
  const sig = await finalize(w.key, r.prepared.preparedMsg, blindSig, r.inv);
  return verifyBadgeSignature(r.bound, { ownerId: r.ownerId, msgPrefix: r.prepared.msgPrefix, sig });
}

