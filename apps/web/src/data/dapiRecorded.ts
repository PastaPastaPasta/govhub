// Replays recorded mainnet DAPI grpc-web responses (src/fixtures/dapi-recorded.json, made by
// scripts/record-dapi.mjs) for the pseudo node `recorded.dapi.invalid:443`. The bytes go through
// the real DapiCore decoder, so fixture mode exercises the same code path as live mode.
export const RECORDED_NODE = 'recorded.dapi.invalid:443';

interface Recording {
  status: number;
  contentType: string | null;
  body: string;
}
interface Recordings {
  recordedAt: string;
  bestBlockHeight: Recording;
  getTransaction: Record<string, Recording>;
}

const toResponse = (r: Recording): Response =>
  new Response(Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)), { status: r.status, headers: { 'content-type': r.contentType ?? 'application/grpc-web+proto' } });

let installed = false;

/** Wraps globalThis.fetch (in the worker or page that calls it) so requests to the recorded node are answered locally. */
export async function installRecordedDapi(): Promise<void> {
  if (installed) return;
  installed = true;
  const rec = (await import('../fixtures/dapi-recorded.json')).default as unknown as Recordings;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`https://${RECORDED_NODE}/`)) return real(input, init);
    if (url.endsWith('/getBestBlockHeight')) return toResponse(rec.bestBlockHeight);
    if (url.endsWith('/getTransaction')) {
      const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : '';
      const txid = /[0-9a-f]{64}/.exec(body)?.[0];
      const hit = txid ? rec.getTransaction[txid] : undefined;
      if (hit) return toResponse(hit);
      // What a real node answers for an unknown txid: grpc-status 5 (NOT_FOUND).
      return new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': '5', 'grpc-message': 'Transaction not found' } });
    }
    return new Response(null, { status: 404 });
  };
}
