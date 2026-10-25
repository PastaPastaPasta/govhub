// HTTP API (openapi.json). Browsers call it cross-origin from a Worker with credentials omitted and no referrer, so: CORS for any
// origin without credentials, no cookies, no caching, and no per-request logs (only counts).
// The starter routes (/v1/starter/*) exist only when the starter is configured; their counters are prefixed `starter-`.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bytesToBase64, toHex, VARIANT, type BadgeNetwork, type EpochParams } from '@govhub/badge';
import type { EpochManager } from './epochs.ts';
import { IssueError, type TokenInput, type TokenService } from './service.ts';
import type { StarterManager } from './starter-epochs.ts';
import type { StarterService } from './starter.ts';

export interface ServerDeps {
  network: BadgeNetwork;
  params: EpochParams;
  issuerId: string;
  contractId: string;
  service: TokenService;
  epochs: Pick<EpochManager, 'status'>;
  challengeTtlSec: number;
  /** aggregate counters, logged by the caller */
  counters: Map<string, number>;
  /** starter tokens; absent or null: the /v1/starter/* routes answer 404 */
  starter?: StarterDeps | null;
}

export interface StarterDeps {
  /** the starter identity (base58) */
  issuerId: string;
  service: Pick<StarterService, 'challenge' | 'issue'>;
  manager: Pick<StarterManager, 'status' | 'keys'>;
  challengeTtlSec: number;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/**
 * POST {request, signature, blindedMsg} -> {blindSig, epoch}, or {error, message[, issuingEpoch]}. Only aggregate counters, named
 * `<prefix><outcome>`, are kept; nothing about the request.
 */
async function tokenRoute(c: Context, counters: Map<string, number>, prefix: string, issue: (i: TokenInput) => Promise<{ blindSig: Uint8Array; epoch: number; retry: boolean }>) {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object') throw new Error();
  } catch {
    bump(counters, `${prefix}bad-request`);
    return c.json({ error: 'bad-request', message: 'JSON body expected' }, 400);
  }
  try {
    const r = await issue({ request: body.request, signature: body.signature, blindedMsg: body.blindedMsg });
    bump(counters, `${prefix}${r.retry ? 'retry' : 'issued'}`);
    return c.json({ blindSig: bytesToBase64(r.blindSig), epoch: r.epoch });
  } catch (e) {
    if (e instanceof IssueError) {
      bump(counters, `${prefix}${e.code}`);
      return c.json({ error: e.code, message: e.message, ...(e.issuingEpoch !== undefined ? { issuingEpoch: e.issuingEpoch } : {}) }, e.status as 400, e.status === 503 ? { 'Retry-After': '5' } : {});
    }
    bump(counters, `${prefix}internal`);
    return c.json({ error: 'unavailable', message: 'internal error' }, 503);
  }
}

export function createApp(d: ServerDeps): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'content-type');
    c.header('Access-Control-Max-Age', '600');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
  });
  app.options('*', (c) => c.body(null, 204));
  app.use('/v1/*', bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: 'bad-request', message: 'body too large' }, 413) }));

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/v1/info', (c) => {
    const s = d.epochs.status;
    return c.json({
      variant: VARIANT,
      network: d.network,
      issuerId: d.issuerId,
      contractId: d.contractId,
      epochParams: d.params,
      height: s.height,
      issuingEpochs: s.issuingEpochs,
      keyIds: s.keyIds,
      ready: s.ready,
      problem: s.problem,
      challengeTtlSec: d.challengeTtlSec,
      note: 'Advisory only: clients derive the epoch and keyId from proved Platform data and the core height, never from this.',
    });
  });

  app.post('/v1/challenge', (c) => c.json(d.service.challenge()));

  app.post('/v1/token', (c) => tokenRoute(c, d.counters, '', (i) => d.service.issue(i)));

  const st = d.starter;
  if (st) {
    app.get('/v1/starter/info', (c) => {
      const s = st.manager.status;
      return c.json({
        variant: VARIANT,
        network: d.network,
        issuerId: st.issuerId,
        contractId: d.contractId,
        epochParams: d.params,
        height: s.height,
        issuingEpochs: s.issuingEpochs,
        ready: s.ready,
        problem: s.problem,
        keys: st.manager.keys().map((k) => ({ epoch: k.epoch, keyId: toHex(k.keyId), spki: bytesToBase64(k.spki) })),
        challengeTtlSec: st.challengeTtlSec,
        note: 'Clients blind only against the proved issuerKey of the starter identity, never against this list. `keys` are the epochs the faucet redeems (previous, current, next), each with a proved, unrevoked issuerKey.',
      });
    });
    app.post('/v1/starter/challenge', (c) => c.json(st.service.challenge()));
    app.post('/v1/starter/token', (c) => tokenRoute(c, d.counters, 'starter-', (i) => st.service.issue(i)));
  }

  app.notFound((c) => c.json({ error: 'not-found' }, 404));
  // Hono's default error handler prints the error (with request details) to stderr, which Docker keeps: answer without logging.
  app.onError((_e, c) => {
    bump(d.counters, 'internal');
    return c.json({ error: 'unavailable', message: 'internal error' }, 503);
  });
  return app;
}
