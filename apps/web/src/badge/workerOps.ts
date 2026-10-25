// What the badge worker does (worker.ts runs it off the main thread; the live test script runs it in Node): the blinding math,
// finalize, and every request to an issuer (MN badges and starter tokens) or to the faucet's starter endpoint. Those requests use
// credentials 'omit', no referrer, no cache, no redirects, https only (http on localhost), and carry nothing but their own body.
import { base64ToBytes, blind, bytesToBase64, finalize, importIssuerKey } from '@govhub/badge';
import type { BadgeWorkerCall, BadgeWorkerResponse, FaucetAnswer, IssuerAnswer, IssuerApi } from './protocol.ts';

function endpoint(base: string, path: string): string {
  const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('the URL must be https');
  return u.toString();
}

const INIT: RequestInit = { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors', redirect: 'error', headers: { 'content-type': 'application/json' } };

async function call(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(endpoint(base, path), { ...INIT, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** The issuer path of a call: `v1/<name>` (badges) or `v1/starter/<name>` (starter tokens). */
const issuerPath = (api: IssuerApi | undefined, name: 'challenge' | 'token'): string => (api === 'starter' ? `v1/starter/${name}` : `v1/${name}`);
const NONCE = /^(?:[0-9a-f]{2}){16,64}$/;
const TXID = /^[0-9a-fA-F]{64}$/;

const dapis = new Map<string, import('@govhub/dapi').Dapi>();

export async function handleBadgeCall(m: BadgeWorkerCall & { id?: number }): Promise<BadgeWorkerResponse> {
  const id = m.id ?? 0;
  switch (m.kind) {
    case 'blind': {
      const key = await importIssuerKey(base64ToBytes(m.spki));
      const out = await blind(key, base64ToBytes(m.preparedMsg));
      return { id, kind: 'blind', blindedMsg: bytesToBase64(out.blindedMsg), inv: bytesToBase64(out.inv) };
    }
    case 'challenge': {
      const r = await call(m.url, issuerPath(m.api, 'challenge'), {});
      if (r.status !== 200 || typeof r.json.nonce !== 'string' || !NONCE.test(r.json.nonce)) throw new Error(`issuer challenge failed (HTTP ${r.status})`);
      const expiresAt = Number.isSafeInteger(r.json.expiresAt) && (r.json.expiresAt as number) > 0 ? (r.json.expiresAt as number) : undefined;
      return { id, kind: 'challenge', nonce: r.json.nonce, ...(expiresAt ? { expiresAt } : {}) };
    }
    case 'token': {
      const r = await call(m.url, issuerPath(m.api, 'token'), { request: m.request, signature: m.signature, blindedMsg: m.blindedMsg });
      const answer: IssuerAnswer =
        r.status === 200 && typeof r.json.blindSig === 'string'
          ? { ok: true, blindSig: r.json.blindSig }
          : {
              ok: false,
              status: r.status,
              error: String(r.json.error ?? 'unknown'),
              message: String(r.json.message ?? `HTTP ${r.status}`).slice(0, 300),
              ...(Number.isInteger(r.json.issuingEpoch) ? { issuingEpoch: r.json.issuingEpoch as number } : {}),
            };
      return { id, kind: 'token', answer };
    }
    case 'starterRedeem': {
      const r = await call(m.url, 'api/starter', m.body);
      const j = r.json;
      const answer: FaucetAnswer =
        r.status === 200 && typeof j.txid === 'string' && TXID.test(j.txid)
          ? { ok: true, txid: j.txid.toLowerCase(), amountSats: Number.isSafeInteger(j.amountSats) ? (j.amountSats as number) : 0, address: String(j.address ?? ''), replay: j.replay === true }
          : {
              ok: false,
              status: r.status,
              code: typeof j.code === 'string' ? j.code.slice(0, 40) : 'unknown',
              message: String(j.message ?? j.error ?? `HTTP ${r.status}`).slice(0, 300),
              ...(Number.isFinite(j.retryAfter) ? { retryAfter: j.retryAfter as number } : {}),
            };
      return { id, kind: 'starterRedeem', answer };
    }
    case 'provenMasternodes': {
      // the same anchored chain and header cache the verification worker uses (verify/stores.ts)
      const [{ createWebDapi }, { headerStore }, { loadVerifiers }] = await Promise.all([import('../data/dapi.ts'), import('../verify/stores.ts'), import('../verify/verifiers.ts')]);
      // one client per DAPI setting, so its in-memory anchor cache and in-flight run are shared between calls
      const key = JSON.stringify(m.dapi);
      let d = dapis.get(key);
      if (!d) dapis.set(key, (d = createWebDapi(m.dapi, loadVerifiers)));
      const a = await d.anchorChain({ store: headerStore('chain') });
      return { id, kind: 'provenMasternodes', count: a.sml.mnCount, height: a.sml.proof.height, weak: a.weak };
    }
    case 'finalize': {
      // finalize verifies the signature; a failure means the issuer answered with something that is not a valid signature
      const key = await importIssuerKey(base64ToBytes(m.spki));
      const sig = await finalize(key, base64ToBytes(m.preparedMsg), base64ToBytes(m.blindSig), base64ToBytes(m.inv));
      return { id, kind: 'finalize', sig: bytesToBase64(sig) };
    }
  }
}

