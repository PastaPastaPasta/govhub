/// <reference lib="webworker" />
// Badge worker (PLAN §8.5): the blinding math (16-40 ms of JS bignum), finalize, and every request to an issuer run here.
// The code is the portal's own pinned build (@govhub/badge), never anything served by an issuer. Issuer requests use
// credentials 'omit', no referrer, no cache, no redirects, and carry nothing but the token request itself.
import { base64ToBytes, blind, bytesToBase64, finalize, importIssuerKey } from '@govhub/badge';
import type { BadgeWorkerRequest, BadgeWorkerResponse, IssuerAnswer } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: BadgeWorkerResponse) => self.postMessage(m);

function endpoint(base: string, path: string): string {
  const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('issuer URL must be https');
  return u.toString();
}

const INIT: RequestInit = { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors', redirect: 'error', headers: { 'content-type': 'application/json' } };

async function call(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(endpoint(base, path), { ...INIT, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function handle(m: BadgeWorkerRequest): Promise<BadgeWorkerResponse> {
  switch (m.kind) {
    case 'blind': {
      const key = await importIssuerKey(base64ToBytes(m.spki));
      const out = await blind(key, base64ToBytes(m.preparedMsg));
      return { id: m.id, kind: 'blind', blindedMsg: bytesToBase64(out.blindedMsg), inv: bytesToBase64(out.inv) };
    }
    case 'challenge': {
      const r = await call(m.url, 'v1/challenge', {});
      if (r.status !== 200 || typeof r.json.nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(r.json.nonce)) throw new Error(`issuer challenge failed (HTTP ${r.status})`);
      return { id: m.id, kind: 'challenge', nonce: r.json.nonce };
    }
    case 'token': {
      const r = await call(m.url, 'v1/token', { request: m.request, signature: m.signature, blindedMsg: m.blindedMsg });
      const answer: IssuerAnswer =
        r.status === 200 && typeof r.json.blindSig === 'string'
          ? { ok: true, blindSig: r.json.blindSig }
          : { ok: false, status: r.status, error: String(r.json.error ?? 'unknown'), message: String(r.json.message ?? `HTTP ${r.status}`).slice(0, 300) };
      return { id: m.id, kind: 'token', answer };
    }
    case 'finalize': {
      // finalize verifies the signature; a failure means the issuer answered with something that is not a valid signature
      const key = await importIssuerKey(base64ToBytes(m.spki));
      const sig = await finalize(key, base64ToBytes(m.preparedMsg), base64ToBytes(m.blindSig), base64ToBytes(m.inv));
      return { id: m.id, kind: 'finalize', sig: bytesToBase64(sig) };
    }
  }
}

self.onmessage = (ev: MessageEvent<BadgeWorkerRequest>) => {
  const m = ev.data;
  handle(m).then(post, (e: unknown) => post({ id: m.id, kind: 'error', message: e instanceof Error ? e.message : String(e) }));
};
