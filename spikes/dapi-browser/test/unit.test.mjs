// Offline unit tests (no network). dashcore-lib / cbor are used only as oracles (devDependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { encode, decode, first } from '../src/pb.js';
import { FrameParser, frame } from '../src/grpcweb.js';
import { BloomFilter } from '../src/bloom.js';
import { decodeCbor } from '../src/cbor.js';
import { parseTx, classifyScript, parseMerkleBlock, hex, unhex } from '../src/dash.js';
import { stream, unary, GrpcError } from '../src/grpcweb.js';
import http from 'node:http';
import { race, mergeStreams } from '../src/race.js';

const require = createRequire(import.meta.url);
const dashcore = require('@dashevo/dashcore-lib');
const cbor = require('cbor');

test('protobuf encode/decode round trip incl. values >= 2^31', () => {
  const m = decode(encode([[1, 2560383], [2, 'abc'], [3, Uint8Array.of(1, 2, 3)], [4, 4294967295], [5, true], [6, 0]]));
  assert.equal(first(m, 1), 2560383);
  assert.equal(new TextDecoder().decode(first(m, 2)), 'abc');
  assert.deepEqual([...first(m, 3)], [1, 2, 3]);
  assert.equal(first(m, 4), 4294967295);
  assert.equal(first(m, 5), 1);
  assert.equal(m.has(6), false); // proto3 default skipped
});

test('grpc-web frame parser handles arbitrary chunking and trailers', () => {
  const trailer = new TextEncoder().encode('grpc-status: 0\r\n');
  const t = new Uint8Array(5 + trailer.length); t[0] = 0x80; new DataView(t.buffer).setUint32(1, trailer.length); t.set(trailer, 5);
  const wire = new Uint8Array([...frame(Uint8Array.of(9, 8, 7)), ...frame(Uint8Array.of(1)), ...t]);
  for (const step of [1, 2, 3, 7, wire.length]) {
    const p = new FrameParser(), out = [];
    for (let i = 0; i < wire.length; i += step) out.push(...p.push(wire.slice(i, i + step)));
    assert.equal(out.length, 3);
    assert.deepEqual([...out[0].data], [9, 8, 7]);
    assert.equal(out[2].trailer, true);
  }
});

test('bloom filter bits are identical to dashcore-lib (BIP37 murmur3)', () => {
  const f = new BloomFilter(2, 0.001, 0xdeadbeef, 1, 200);
  const items = [unhex('9c12930edd1be98a0c0752c0a4bc1f3ee65587c9'), unhex('aa'.repeat(20))];
  items.forEach((i) => f.insert(i));
  const ref = new dashcore.BloomFilter({ vData: Array.from({ length: 200 }, () => 0), nHashFuncs: f.nHashFuncs, nTweak: f.nTweak, nFlags: 1 });
  items.forEach((i) => ref.insert(Buffer.from(i)));
  assert.equal(hex(f.vData), Buffer.from(ref.vData).toString('hex'));
  assert.ok(f.vData.length >= 200);
  assert.ok(f.contains(items[0]) && !f.contains(unhex('bb'.repeat(20))));
});

test('cbor decoder matches the cbor package', () => {
  const v = { a: 1, b: [1, 2, { c: 'x' }], d: 'héllo', e: -5, f: 70000, g: 2 ** 40, h: true, i: null, j: Buffer.from([1, 2, 3]) };
  const out = decodeCbor(new Uint8Array(cbor.encode(v)));
  assert.equal(out.d, 'héllo'); assert.equal(out.e, -5); assert.equal(out.g, 2 ** 40); assert.deepEqual([...out.j], [1, 2, 3]);
  assert.deepEqual(out.b.map((x) => (typeof x === 'object' ? { ...x } : x)), [1, 2, { c: 'x' }]);
  assert.throws(() => decodeCbor(Uint8Array.of(0x83, 0x01)), /bad length|truncated/);
  assert.throws(() => decodeCbor(Uint8Array.of(0x45, 1, 2)), /truncated/);
});

test('parseTx agrees with dashcore-lib on the mainnet governance collateral tx', () => {
  const raw = unhex(readFileSync(new URL('./fixtures/collateral-tx.hex', import.meta.url), 'utf8').trim());
  const tx = parseTx(raw), ref = new dashcore.Transaction(Buffer.from(raw));
  assert.equal(tx.txid, ref.hash);
  assert.equal(tx.txid, '3451d292d461d1255007392a43d0da7b47eed938ff9a1234fb06ae19157fa365');
  assert.equal(tx.outputs.length, 2);
  const op = classifyScript(tx.outputs[1].script);
  assert.equal(op.type, 'op_return'); assert.equal(hex(op.data), 'cbc458f8a65a1f607f3acfa825b39f2f9b2748bdd0893bd5c0b911881eaf2fe9');
  assert.equal(tx.outputs[1].value, 100000000n);
});

test('race(): skips failing nodes, aborts losers, reports failures', async () => {
  const aborted = [];
  const r = await race(['bad1', 'bad2', 'slow', 'fast'], (n, signal) => new Promise((res, rej) => {
    if (n.startsWith('bad')) return rej(new Error('boom'));
    signal.addEventListener('abort', () => aborted.push(n));
    setTimeout(() => res(n), n === 'fast' ? 10 : 500);
  }), { n: 2 });
  assert.equal(r.node, 'fast'); assert.equal(r.failures.length, 2); assert.ok(aborted.includes('slow'));
  await assert.rejects(race(['x', 'y'], () => Promise.reject(new Error('no'))), /all nodes failed/);
});

test('mergeStreams(): dedupes, replaces dead streams, cancels cleanly', async () => {
  const got = [];
  const open = (node, emit) => {
    let timer; let resolve; const closed = new Promise((r) => { resolve = r; });
    if (node === 'dead') queueMicrotask(() => resolve({ reason: 'error', error: new Error('x') }));
    else { let i = 0; timer = setInterval(() => emit('k' + (i++ % 3), { node }), 5); }
    return { cancel() { clearInterval(timer); resolve({ reason: 'cancelled' }); }, closed };
  };
  const m = mergeStreams(['dead', 'a', 'b', 'c'], open, (item) => got.push(item), { n: 3 });
  await new Promise((r) => setTimeout(r, 80));
  const st = m.stats(); m.cancel(); await m.closed;
  assert.deepEqual(got.map((g) => g.node.length), [1, 1, 1]); // 3 distinct keys, each once
  assert.equal(st.failed.length, 1); assert.equal(st.opened.length, 4); assert.ok(st.dupes > 0);
});

test('protobuf: forced zero (oneof) is encoded, bad numbers rejected, truncated fixed64 rejected', () => {
  assert.equal(encode([[1, 0, true]]).length, 2);
  assert.equal(encode([[1, 0]]).length, 0);
  assert.throws(() => encode([[1, NaN]]), /non-negative integer/);
  assert.throws(() => decode(Uint8Array.of(0x09, 1, 2, 3)), /truncated fixed64/);
});

test('merkleblock: hostile tx counts are rejected instead of hanging', () => {
  const b = new Uint8Array(80 + 4 + 1 + 1); new DataView(b.buffer).setUint32(80, 0xffffffff, true);
  assert.throws(() => parseMerkleBlock(b), /bad tx count/);
  new DataView(b.buffer).setUint32(80, 0, true);
  assert.throws(() => parseMerkleBlock(b), /bad tx count/);
});

// --- grpc-web against a local fake server (foreground, closed in the test) ---
const trailerFrame = (txt) => { const t = new TextEncoder().encode(txt); const f = new Uint8Array(5 + t.length); f[0] = 0x80; new DataView(f.buffer).setUint32(1, t.length); f.set(t, 5); return f; };
async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}/`); } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
}
const GW = { 'content-type': 'application/grpc-web+proto' };

test('grpc-web unary: ok, error trailer (malformed percent-encoding survives), wrong content-type', async () => {
  await withServer((req, res) => {
    if (req.url.endsWith('/ok')) res.writeHead(200, GW).end(Buffer.concat([frame(Uint8Array.of(1, 2)), trailerFrame('grpc-status: 0\r\n')]));
    else if (req.url.endsWith('/err')) res.writeHead(200, GW).end(Buffer.concat([trailerFrame('grpc-status: 5\r\ngrpc-message: bad %zz\r\n')]));
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
  }, async (base) => {
    assert.deepEqual([...await unary(base, 'ok', new Uint8Array(0))], [1, 2]);
    await assert.rejects(unary(base, 'err', new Uint8Array(0)), (e) => e instanceof GrpcError && e.code === 5 && /bad %zz/.test(e.message));
    await assert.rejects(unary(base, 'html', new Uint8Array(0)), (e) => e instanceof GrpcError && e.code === 14);
    const ac = new AbortController(); ac.abort();
    await assert.rejects(unary(base, 'ok', new Uint8Array(0), { signal: ac.signal }), /abort/i); // already-aborted signal is honoured
  });
});

test('grpc-web stream: messages, clean end, cancel, handler throw aborts, cut-off is an error', async () => {
  await withServer((req, res) => {
    if (req.url.endsWith('/end')) { res.writeHead(200, GW); res.write(frame(Uint8Array.of(1))); res.end(Buffer.concat([frame(Uint8Array.of(2)), trailerFrame('grpc-status: 0\r\n')])); }
    else if (req.url.endsWith('/cut')) { res.writeHead(200, GW); res.write(frame(Uint8Array.of(1))); res.end(frame(Uint8Array.of(2, 3, 4)).subarray(0, 7)); }
    else { res.writeHead(200, GW); res.write(frame(Uint8Array.of(1))); /* then hang open */ }
  }, async (base) => {
    const got = []; let h = stream(base, 'end', new Uint8Array(0), { onMessage: (b) => got.push(b[0]) });
    assert.equal((await h.closed).reason, 'end'); assert.deepEqual(got, [1, 2]);
    h = stream(base, 'cut', new Uint8Array(0), { onMessage: () => {} });
    const cut = await h.closed; assert.equal(cut.reason, 'error'); assert.match(cut.error.message, /cut off/);
    const live = []; h = stream(base, 'hang', new Uint8Array(0), { onMessage: (b) => live.push(b[0]) });
    await new Promise((r) => setTimeout(r, 100)); h.cancel();
    assert.equal((await h.closed).reason, 'cancelled'); assert.deepEqual(live, [1]);
    h = stream(base, 'hang', new Uint8Array(0), { onMessage: () => { throw new Error('parse boom'); } });
    const th = await h.closed; assert.equal(th.reason, 'error'); assert.equal(th.handler, true); assert.match(th.error.message, /parse boom/);
    h = stream(base, 'hang', new Uint8Array(0), { onMessage: () => {}, idleTimeoutMs: 50 });
    const idle = await h.closed; assert.equal(idle.reason, 'error'); assert.equal(idle.error.code, 4);
  });
});
