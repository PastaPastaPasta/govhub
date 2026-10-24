// Page entry bundled for headless Chromium. Exposes timed client operations on window.govhub.
// All values cross the Playwright boundary as hex strings.

import { copy, fromHex, toHex } from './bytes.js';
import {
  bindIssuerKey,
  blind,
  finalize,
  importIssuerKey,
  prepareBadge,
  verify,
  verifyBadge,
  type BoundIssuerKey,
  type IssuerKey,
} from './client.js';
import { type BadgeFields } from './format.js';

const now = () => performance.now();

interface CtxHex {
  net: number;
  contractId: string;
  issuerId: string;
  epoch: number;
  ownerId: string;
}
const bindOf = (k: IssuerKey, c: CtxHex): BoundIssuerKey =>
  bindIssuerKey(k, { net: c.net, contractId: fromHex(c.contractId), issuerId: fromHex(c.issuerId), epoch: c.epoch });

let key: IssuerKey;
let st: { preparedMsg: Uint8Array; msgPrefix: Uint8Array; inv: Uint8Array; bound: BoundIssuerKey; ownerId: Uint8Array } | undefined;

const api = {
  async importKey(spkiHex: string) {
    const t = now();
    key = await importIssuerKey(fromHex(spkiHex));
    return { ms: now() - t, keyIdHex: toHex(key.keyId) };
  },

  /** prepare + blind. Returns blindedMsg for the (Node) issuer. */
  async start(c: CtxHex) {
    const bound = bindOf(key, c);
    const ownerId = fromHex(c.ownerId);
    let t = now();
    const p = prepareBadge(bound, ownerId);
    const prepareMs = now() - t;
    t = now();
    const b = await blind(key, p.preparedMsg);
    const blindMs = now() - t;
    st = { preparedMsg: p.preparedMsg, msgPrefix: p.msgPrefix, inv: b.inv, bound, ownerId };
    return { blindedHex: toHex(b.blindedMsg), prepareMs, blindMs };
  },

  /** finalize (library verifies) + reader-side verifyBadge. */
  async finish(blindSigHex: string) {
    if (!st) throw new Error('call start first');
    let t = now();
    const sig = await finalize(key, st.preparedMsg, fromHex(blindSigHex), st.inv);
    const finalizeMs = now() - t;
    t = now();
    const ok = await verifyBadge(st.bound, { ownerId: st.ownerId, msgPrefix: st.msgPrefix, sig });
    const verifyMs = now() - t;
    return { sigHex: toHex(sig), msgPrefixHex: toHex(st.msgPrefix), ok, finalizeMs, verifyMs };
  },

  /** Reader workload: verify many badges with an already-imported key. */
  async benchVerify(
    badges: { ctx: CtxHex; msgPrefixHex: string; sigHex: string }[],
    rounds: number,
  ) {
    const items = badges.map((b) => ({
      bound: bindOf(key, b.ctx),
      doc: { ownerId: fromHex(b.ctx.ownerId), msgPrefix: fromHex(b.msgPrefixHex), sig: fromHex(b.sigHex) },
    }));
    // cold first verify
    let t = now();
    const firstOk = await verifyBadge(items[0]!.bound, items[0]!.doc);
    const firstMs = now() - t;
    const seq: number[] = [];
    const par: number[] = [];
    let allOk = firstOk;
    for (let r = 0; r < rounds; r++) {
      t = now();
      for (const it of items) allOk &&= await verifyBadge(it.bound, it.doc);
      seq.push(now() - t);
      t = now();
      const res = await Promise.all(items.map((it) => verifyBadge(it.bound, it.doc)));
      par.push(now() - t);
      allOk &&= res.every(Boolean);
    }
    // 1000 sequential verifies (10 passes over the batch) for better resolution: performance.now() is coarsened to 0.1 ms.
    t = now();
    for (let i = 0; i < 10; i++) for (const it of items) allOk &&= await verifyBadge(it.bound, it.doc);
    const thousandMs = now() - t;
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    return {
      count: items.length,
      allOk,
      firstVerifyMs: firstMs,
      seqTotalMs: med(seq),
      seqPerVerifyMs: med(seq) / items.length,
      parTotalMs: med(par),
      thousandSeqTotalMs: thousandMs,
      seqAll: seq,
      parAll: par,
    };
  },

  /** Raw single-op medians for blind / finalize / verify over fresh random messages (needs a signer round trip). */
  async rawVerify(sigHex: string, preparedHex: string) {
    return verify(key, fromHex(sigHex), fromHex(preparedHex));
  },

  /** Probe: does raw WebCrypto in this browser accept a signature not reduced mod N (sig + N)? */
  async verifyRawVsWrapper(sigHex: string, preparedHex: string) {
    const raw = await crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 48 },
      key.cryptoKey,
      copy(fromHex(sigHex)),
      copy(fromHex(preparedHex)),
    );
    return { rawWebCryptoAccepts: raw, wrapperAccepts: await verify(key, fromHex(sigHex), fromHex(preparedHex)) };
  },

  ua: () => navigator.userAgent,
  secure: () => ({ isSecureContext, subtle: !!crypto.subtle }),
};

(globalThis as unknown as { govhub: typeof api }).govhub = api;
export type GovhubApi = typeof api;
export type { BadgeFields };
