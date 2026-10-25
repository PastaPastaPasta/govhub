// HTTP API. Spec: services/relay/openapi.json (OpenAPI 3.1). CORS open (origin *, GET/POST/OPTIONS, content-type).
// Every POST: per-IP token bucket first, then a 4096-byte body limit (413 before anything is parsed), then JSON.
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { ipBucket, peerTrust, resolveClientIp } from '../clientip.ts';
import { log } from '../log.ts';
import { IpLimiter } from '../ratelimit.ts';
import { RelayError, type Relay } from '../relay.ts';

export const MAX_BODY_BYTES = 4096;

/** Allowed methods per path; null = not a relay path. (GET also answers HEAD, hono does that.) */
function allowedMethods(path: string): string[] | null {
  if (path === '/v1/votes' || path === '/v1/votes/cancel' || path === '/v1/proposals' || path === '/v1/proposals/submit') return ['POST', 'OPTIONS'];
  if (path === '/v1/status' || /^\/v1\/(votes|proposals)\/[^/]+$/.test(path)) return ['GET', 'HEAD', 'OPTIONS'];
  return null;
}

function socketPeer(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address ?? undefined;
  } catch {
    return undefined; // no socket (tests): everyone shares one bucket
  }
}

function errorBody(e: RelayError): Record<string, unknown> {
  return { error: e.message, code: e.code, ...e.extra };
}

export function createApp(relay: Relay): Hono {
  const app = new Hono();
  const ipLimiter = new IpLimiter(relay.cfg.rateIpPerMin, relay.clock);
  const trusted = peerTrust(relay.cfg.trustedProxyCidrs);

  const fail = (c: Context, e: RelayError) => {
    if (e.retryAfter !== undefined) c.header('Retry-After', String(e.retryAfter));
    return c.json(errorBody(e), e.status as 400);
  };

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['content-type'], exposeHeaders: ['Retry-After'], maxAge: 86400 }));
  app.use('*', async (c, next) => {
    const allowed = allowedMethods(c.req.path);
    if (allowed && !allowed.includes(c.req.method)) {
      c.header('Allow', allowed.join(', '));
      return c.json({ error: 'method not allowed', code: 'method-not-allowed' }, 405);
    }
    return next();
  });
  app.onError((e, c) => {
    if (e instanceof RelayError) return fail(c, e);
    log.error('api error', { path: c.req.path, error: String((e as Error)?.stack ?? e) });
    return c.json({ error: 'internal error', code: 'internal' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found', code: 'not-found' }, 404));

  // POST guard: IP rate limit, then body size. Runs before any body is read.
  const ipGuard: MiddlewareHandler = async (c, next) => {
    const ip = resolveClientIp({ header: relay.cfg.clientIpHeader, get: (n) => c.req.header(n), peer: socketPeer(c), trusted });
    const wait = ipLimiter.take(ipBucket(ip));
    if (wait > 0) return fail(c, new RelayError(429, 'rate-limited', 'too many requests, slow down', {}, wait));
    return next();
  };
  const sizeGuard = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: `body is larger than ${MAX_BODY_BYTES} bytes`, code: 'too-large' }, 413) });

  async function readJson(c: Context): Promise<unknown> {
    try {
      return JSON.parse(await c.req.text());
    } catch {
      throw new RelayError(400, 'bad-request', 'body is not valid JSON');
    }
  }

  app.get('/v1/status', async (c) => c.json(await relay.status()));

  app.post('/v1/votes', ipGuard, sizeGuard, async (c) => {
    const { httpStatus, receipt } = await relay.submitVote(await readJson(c));
    return c.json(receipt, httpStatus);
  });

  app.post('/v1/votes/cancel', ipGuard, sizeGuard, async (c) => c.json(await relay.cancelVote(await readJson(c))));

  app.get('/v1/votes/:id', (c) => c.json(relay.getVote(c.req.param('id'))));

  app.post('/v1/proposals/submit', ipGuard, sizeGuard, async (c) => c.json(await relay.submitProposal(await readJson(c))));

  app.post('/v1/proposals', ipGuard, sizeGuard, async (c) => {
    const { httpStatus, view } = await relay.holdProposal(await readJson(c));
    return c.json(view, httpStatus);
  });

  app.get('/v1/proposals/:id', (c) => c.json(relay.getProposal(c.req.param('id'))));

  return app;
}
