import { AllNodesFailedError, createDapi, GrpcError, VerificationError, type Dapi } from '@govhub/dapi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allRateLimited, backoffDelay, createGate, DAPI_CONCURRENCY, isRateLimited, retryAfterMs, retryRateLimited, throttleDapi } from './throttle.ts';

const r429 = (reset: string | null = null) => new GrpcError(8, 'HTTP 429', { http: 429, rate: { limit: '150', remaining: '0', reset } });
const budget = () => new GrpcError(8, 'client-side budget of 150 req/min exhausted for n:443', { budget: true });
const down = () => new GrpcError(14, 'network error: Failed to fetch', { network: true });
const all = (...errors: unknown[]) => new AllNodesFailedError(errors.map((error, i) => ({ node: `n${i}:443`, error })));

describe('which failures are the nodes asking to slow down', () => {
  it('a 429, RESOURCE_EXHAUSTED and our own spent budget are; other failures and lies are not', () => {
    expect(isRateLimited(r429())).toBe(true);
    expect(isRateLimited(budget())).toBe(true);
    expect(isRateLimited(down())).toBe(false);
    expect(isRateLimited(new GrpcError(5, 'NOT_FOUND'))).toBe(false);
    expect(isRateLimited(new Error('HTTP 429'))).toBe(false);
    expect(isRateLimited(all(r429(), down(), r429()))).toBe(true);
    expect(isRateLimited(all(down(), down()))).toBe(false);
    expect(isRateLimited(all(r429(), new VerificationError('txid', 'node returned a different transaction')))).toBe(false);
    expect(isRateLimited(all())).toBe(true);
    expect(isRateLimited(new GrpcError(8, 'grpc: received message larger than max'))).toBe(false);
    expect(isRateLimited(new GrpcError(8, 'rate limit exceeded'))).toBe(true);
  });

  it('a refusal counts only when every other attempt went unanswered: an unreadable answer or another status beside a 429 does not', () => {
    expect(isRateLimited(all(r429(), new GrpcError(4, 'deadline exceeded'), new GrpcError(14, 'HTTP 503', { http: 503 })))).toBe(true);
    expect(isRateLimited(all(new Error('protobuf: truncated message'), r429()))).toBe(false);
    expect(isRateLimited(all(new GrpcError(13, 'internal'), r429()))).toBe(false);
    expect(isRateLimited(all(new GrpcError(5, 'NOT_FOUND'), r429()))).toBe(false);
  });

  it('a step tried several times is held up only when every failure was a refusal (anchoring: a lie, then a 429, is not)', () => {
    expect(allRateLimited([all(r429()), r429()])).toBe(true);
    expect(allRateLimited([new VerificationError('pow', 'header chain does not check out'), all(r429())])).toBe(false);
    expect(allRateLimited([])).toBe(false);
  });

  it('a lie among the attempts is never a refusal, even when a 429 came last', () => {
    const mixed = all(new VerificationError('txid', 'node returned a different transaction'), r429());
    expect(mixed.message).toMatch(/HTTP 429$/);
    expect(isRateLimited(mixed)).toBe(false);
  });

  it("honours the longest reset a refusing node sent, in ms", () => {
    expect(retryAfterMs(r429('7'))).toBe(7_000);
    expect(retryAfterMs(all(r429('3'), down(), r429('12')))).toBe(12_000);
    expect(retryAfterMs(r429())).toBe(0);
    expect(retryAfterMs(Object.assign(r429(), { retryAfter: '4' }))).toBe(4_000);
    expect(retryAfterMs(down())).toBe(0);
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter in the upper half, is capped, and never undercuts the hint', () => {
    expect(backoffDelay(0, 0, { random: () => 0 })).toBe(500);
    expect(backoffDelay(0, 0, { random: () => 1 })).toBe(1_000);
    expect(backoffDelay(3, 0, { random: () => 0 })).toBe(4_000);
    expect(backoffDelay(20, 0, { random: () => 1 })).toBe(30_000);
    expect(backoffDelay(0, 9_000, { random: () => 0 })).toBe(9_000);
    expect(backoffDelay(0, 600_000, { random: () => 0 })).toBe(30_000);
  });

  it('retries only rate refusals, up to the limit, and waits each time', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    let n = 0;
    const flaky = () => (++n < 3 ? Promise.reject(all(r429('2'))) : Promise.resolve('ok'));
    await expect(retryRateLimited(flaky, { sleep, random: () => 0 })).resolves.toBe('ok');
    expect(n).toBe(3);
    expect(waits).toEqual([2_000, 2_000]);

    n = 0;
    const lie = new VerificationError('txid', 'bad');
    await expect(retryRateLimited(() => (n++, Promise.reject(lie)), { sleep })).rejects.toBe(lie);
    expect(n).toBe(1);

    n = 0;
    const refusal = r429();
    await expect(retryRateLimited(() => (n++, Promise.reject(refusal)), { sleep, retries: 2 })).rejects.toBe(refusal);
    expect(n).toBe(3);
  });
});

describe('the gate', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());
  const now = () => Date.now();

  it('starts up to the limit at once with no spacing, the rest as slots free, and pauses every caller together', async () => {
    const gate = createGate({ max: 2, now });
    let inFlight = 0, peak = 0;
    const starts: number[] = [];
    const job = () => gate.run(async () => {
      starts.push(Date.now());
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1_000));
      inFlight--;
    });
    const jobs = Array.from({ length: 5 }, job);
    await vi.runAllTimersAsync();
    await Promise.all(jobs);
    expect(peak).toBe(2);
    expect(starts).toEqual([0, 0, 1_000, 1_000, 2_000]);

    gate.pause(5_000);
    const t0 = Date.now();
    const later = gate.run(async () => Date.now());
    await vi.runAllTimersAsync();
    expect((await later) - t0).toBe(5_000);
  });

  it('halves on a refusal (once per cool-down, never under the minimum) and grows back by one per run of successes', () => {
    const gate = createGate({ max: 10, min: 2, recoverAfter: 3, coolMs: 1_000, now });
    gate.slowDown();
    gate.slowDown();
    expect(gate.limit).toBe(5);
    vi.advanceTimersByTime(1_000);
    gate.slowDown();
    expect(gate.limit).toBe(2);
    vi.advanceTimersByTime(1_000);
    gate.slowDown();
    expect(gate.limit).toBe(2);
    for (let i = 0; i < 2; i++) gate.succeeded();
    expect(gate.limit).toBe(2);
    gate.succeeded();
    expect(gate.limit).toBe(3);
    for (let i = 0; i < 100; i++) gate.succeeded();
    expect(gate.limit).toBe(10);
  });

  it('a job holding its slot past the lease gives it up, so a call nested in another can never deadlock the gate', async () => {
    const gate = createGate({ max: 1, holdMs: 1_000, now });
    let inner: Promise<string> | undefined;
    const outer = gate.run(async () => {
      inner = gate.run(async () => 'inner');
      return `outer+${await inner}`;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(await Promise.race([outer, Promise.resolve('waiting')])).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(await outer).toBe('outer+inner');
  });

  it('a failing job frees its slot', async () => {
    const gate = createGate({ max: 1, now });
    await expect(gate.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });
});

describe('a throttled client', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());
  const now = () => Date.now();

  it('bounds the burst of a ProRegTx-style fan-out, slows down on refusals and retries them after the reset instead of failing', async () => {
    let inFlight = 0, peak = 0, refusals = 0;
    const fake = {
      async call<T>(fn: (core: unknown) => Promise<T>) {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        if (refusals < 3) {
          refusals++;
          throw all(r429('1'));
        }
        return { value: await fn({}), node: 'n:443' };
      },
    };
    const gate = createGate({ max: 8, now });
    const dapi = throttleDapi(fake as unknown as Dapi, gate, { random: () => 0 });
    const calls = Array.from({ length: 24 }, (_, i) => dapi.call(async () => i));
    await vi.runAllTimersAsync();
    const values = (await Promise.all(calls)).map((r) => r.value);
    expect(values).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(peak).toBeLessThanOrEqual(8);
    expect(refusals).toBe(3);
  });

  it('a node refusing one attempt slows the gate even when another node then answers', async () => {
    const gate = createGate({ max: 8, now });
    const fake = {
      async call<T>(fn: (core: unknown) => Promise<T>) {
        await fn({ refuse: true }).catch(() => {});
        return { value: await fn({}), node: 'b:443' };
      },
    };
    const dapi = throttleDapi(fake as unknown as Dapi, gate);
    const r = dapi.call(async (core) => {
      if ((core as unknown as { refuse?: boolean }).refuse) throw r429();
      return 'ok';
    });
    await vi.runAllTimersAsync();
    expect((await r).value).toBe('ok');
    expect(gate.limit).toBe(4);
  });

  it('gives up with the refusal after the retries, so the page can say "not yet checked"', async () => {
    const fake = { call: () => Promise.reject(all(r429())) };
    const dapi = throttleDapi(fake as unknown as Dapi, createGate({ max: 4, now }), { retries: 2, random: () => 0 });
    const p = dapi.call(async () => 1);
    const settled = expect(p).rejects.toBeInstanceOf(AllNodesFailedError);
    await vi.runAllTimersAsync();
    await settled;
  });
});

describe('under the e2e replay clock (Date runs 1000 times slower, answers are instant)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a real client fans out hundreds of calls through the gate in well under a second of real time', async () => {
    const t0 = Date.now(), real = performance.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + Math.floor((performance.now() - real) / 1000));
    const dapi = throttleDapi(createDapi({ nodes: ['a:443', 'b:443', 'c:443', 'd:443'] }), createGate({ max: DAPI_CONCURRENCY }));
    dapi.core = () => ({ getTransaction: async (txid: string) => ({ raw: new Uint8Array([txid.length]) }) }) as never;
    const started = performance.now();
    const out = await Promise.all(Array.from({ length: 300 }, (_, i) => dapi.call((core) => core.getTransaction(`tx${i}`))));
    expect(out).toHaveLength(300);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
