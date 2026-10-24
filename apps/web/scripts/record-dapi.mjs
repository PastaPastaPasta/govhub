// Records real mainnet DAPI grpc-web responses (getTransaction for every collateral in the
// mainnet fixture, plus getBestBlockHeight) so fixture mode and the e2e tests replay byte-exact
// node answers through the real DapiCore decoder. Read-only. Usage: node scripts/record-dapi.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { fetchNodes, frame, sample } from '@govhub/dapi';

const root = new URL('../../../', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('packages/verify/test/fixtures/mainnet-proposals.json', root), 'utf8'));
const SERVICE = 'org.dash.platform.dapi.v0.Core';
const nodes = sample(await fetchNodes(), 6);

/** Protobuf for a message whose fields are all strings: tag (field << 3 | 2), length, bytes. Enough for getTransaction(txid). */
function encode(fields) {
  const parts = fields.map(([n, v]) => {
    const body = Buffer.from(v, 'utf8');
    return Buffer.concat([Buffer.from([(n << 3) | 2, body.length]), body]);
  });
  return new Uint8Array(Buffer.concat(parts));
}

async function call(method, fields) {
  for (const node of nodes) {
    try {
      const res = await fetch(`https://${node}/${SERVICE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', accept: 'application/grpc-web+proto' },
        body: frame(encode(fields)),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      return { node, status: res.status, contentType: res.headers.get('content-type'), grpcStatus: res.headers.get('grpc-status'), body: Buffer.from(body).toString('base64') };
    } catch (e) {
      console.warn(`  ${node} ${method}: ${e.message}`);
    }
  }
  throw new Error(`all nodes failed for ${method}`);
}

const out = { recordedAt: new Date().toISOString(), network: 'mainnet', service: SERVICE, bestBlockHeight: null, getTransaction: {} };
out.bestBlockHeight = await call('getBestBlockHeight', []);
for (const p of fixture.proposals) {
  out.getTransaction[p.collateralHash] = await call('getTransaction', [[1, p.collateralHash]]);
  process.stdout.write('.');
}
console.log();
const dest = new URL('src/fixtures/dapi-recorded.json', new URL('../', import.meta.url));
await writeFile(dest, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${Object.keys(out.getTransaction).length} getTransaction responses to ${dest.pathname}`);
