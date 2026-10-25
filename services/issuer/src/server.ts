// HTTP API (openapi.json). Browsers call it cross-origin from a Worker with credentials omitted and no referrer, so: CORS for any
// origin without credentials, no cookies, no caching, and no per-request logs (only counts).
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bytesToBase64, VARIANT, type BadgeNetwork, type EpochParams } from '@govhub/badge';
import type { EpochManager } from './epochs.ts';
import { IssueError, type TokenService } from './service.ts';

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
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

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

  app.post('/v1/token', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
      if (!body || typeof body !== 'object') throw new Error();
    } catch {
      bump(d.counters, 'bad-request');
      return c.json({ error: 'bad-request', message: 'JSON body expected' }, 400);
    }
    try {
      const r = await d.service.issue({ request: body.request, signature: body.signature, blindedMsg: body.blindedMsg });
      bump(d.counters, r.retry ? 'retry' : 'issued');
      return c.json({ blindSig: bytesToBase64(r.blindSig), epoch: r.epoch });
    } catch (e) {
      if (e instanceof IssueError) {
        bump(d.counters, e.code);
        return c.json({ error: e.code, message: e.message, ...(e.issuingEpoch !== undefined ? { issuingEpoch: e.issuingEpoch } : {}) }, e.status as 400, e.status === 503 ? { 'Retry-After': '5' } : {});
      }
      bump(d.counters, 'internal');
      return c.json({ error: 'unavailable', message: 'internal error' }, 503);
    }
  });

  app.notFound((c) => c.json({ error: 'not-found' }, 404));
  // Hono's default error handler prints the error (with request details) to stderr, which Docker keeps: answer without logging.
  app.onError((_e, c) => {
    bump(d.counters, 'internal');
    return c.json({ error: 'unavailable', message: 'internal error' }, 503);
  });
  return app;
}
