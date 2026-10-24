// Benchmarks: Node issuer signing (OpenSSL vs library vs bigint), Node client ops, Chromium client ops, sizes.
// usage: npm run bench   (launches headless Chromium; outside the macOS Seatbelt sandbox)
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { bigIntToBytes, bytesToBigInt, copy, toHex } from '../src/bytes.js';
import { blind, finalize, importIssuerKey, prepareBadge, verifyBadge } from '../src/client.js';
import { BlindIssuer } from '../src/issuer.js';
import { launch, buildBrowserBundle } from '../test/browser-helper.js';
import { bind, ctxHex, issueBadge, randomCtx, type BadgeContext } from '../test/flow.js';

const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]!;
const stat = (a: number[]) => ({ median: +med(a).toFixed(3), p95: +p95(a).toFixed(3), n: a.length });

function modpow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

async function time<T>(n: number, f: () => T | Promise<T>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await f();
    out.push(performance.now() - t);
  }
  return out;
}

const results: Record<string, unknown> = {
  host: { cpu: os.cpus()[0]!.model, cores: os.cpus().length, node: process.version, openssl: process.versions.openssl, platform: `${os.platform()} ${os.arch()}` },
};

// ---------------------------------------------------------------- Node
for (const bits of [2048, 3072] as const) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  const issuer = new BlindIssuer(privateKey);
  const key = await importIssuerKey(spki);
  const jwk = privateKey.export({ format: 'jwk' });
  const d = bytesToBigInt(Buffer.from(jwk.d!, 'base64url'));
  const k = bits / 8;
  const samples = Array.from({ length: 200 }, () => {
    const m = crypto.getRandomValues(new Uint8Array(k));
    m[0] = 0x3f; // < n
    return m;
  });

  const rawSign = await time(200, (() => { let i = 0; return () => privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, samples[i++ % 200]!); })());
  const issuerSign = await time(200, (() => { let i = 0; return () => issuer.blindSign(samples[i++ % 200]!); })());
  const bigint = await time(20, (() => { let i = 0; return () => modpow(bytesToBigInt(samples[i++ % 200]!), d, key.n); })());

  const lib = RSABSSA.SHA384.PSS.Randomized();
  const sk = await crypto.subtle.importKey('pkcs8', copy(new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }))), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
  const libSign = await time(20, (() => { let i = 0; return () => lib.blindSign(sk, samples[i++ % 200]!); })());
  // equality of all three on a few inputs
  for (let i = 0; i < 5; i++) {
    const a = toHex(issuer.blindSign(samples[i]!));
    const b = toHex(await lib.blindSign(sk, samples[i]!));
    const c = toHex(bigIntToBytes(modpow(bytesToBigInt(samples[i]!), d, key.n), k));
    if (a !== b || a !== c) throw new Error('signature mismatch between implementations');
  }

  // Node client ops
  const blindT: number[] = [], finT: number[] = [], verT: number[] = [], prepT: number[] = [];
  const badges: { ctx: BadgeContext; msgPrefix: Uint8Array; sig: Uint8Array }[] = [];
  for (let i = 0; i < 100; i++) {
    const ctx = randomCtx();
    let t = performance.now();
    const p = prepareBadge(bind(key, ctx), ctx.ownerId);
    prepT.push(performance.now() - t);
    t = performance.now();
    const b = await blind(key, p.preparedMsg);
    blindT.push(performance.now() - t);
    const bs = issuer.blindSign(b.blindedMsg);
    t = performance.now();
    const sig = await finalize(key, p.preparedMsg, bs, b.inv);
    finT.push(performance.now() - t);
    t = performance.now();
    await verifyBadge(bind(key, ctx), { ownerId: ctx.ownerId, msgPrefix: p.msgPrefix, sig });
    verT.push(performance.now() - t);
    badges.push({ ctx, msgPrefix: p.msgPrefix, sig });
  }
  const bound = badges.map((b) => ({ key: bind(key, b.ctx), doc: { ownerId: b.ctx.ownerId, msgPrefix: b.msgPrefix, sig: b.sig } }));
  const t100 = await time(5, async () => { for (const b of bound) await verifyBadge(b.key, b.doc); });
  results[`node${bits}`] = {
    issuer: {
      openssl_privateDecrypt_raw_ms: stat(rawSign),
      issuer_blindSign_with_verify_ms: stat(issuerSign),
      bigint_noncrt_modexp_ms: stat(bigint),
      library_blindSign_sjcl_ms: stat(libSign),
    },
    client: {
      prepare_ms: stat(prepT), blind_ms: stat(blindT), finalize_ms: stat(finT), verify_ms: stat(verT),
      verify100_sequential_total_ms: +med(t100).toFixed(2),
    },
  };
  console.log(`node ${bits}`, JSON.stringify((results[`node${bits}`] as object), null, 1));
}

// ---------------------------------------------------------------- Chromium
buildBrowserBundle();
const { browser, page, call } = await launch();
const version = browser.version();
results.chromium = { version, ua: await call('ua') };
for (const bits of [2048, 3072] as const) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  const issuer = new BlindIssuer(privateKey);
  const key = await importIssuerKey(spki);
  const importMs = [];
  for (let i = 0; i < 10; i++) importMs.push((await call('importKey', toHex(spki))).ms);

  // 40 full round trips through the page (prepare/blind/finalize/verify timed in-page)
  const prep: number[] = [], bl: number[] = [], fin: number[] = [], ver: number[] = [];
  for (let i = 0; i < 40; i++) {
    const s = await call('start', ctxHex(randomCtx()));
    const bs = issuer.blindSign(new Uint8Array(Buffer.from(s.blindedHex, 'hex')));
    const f = await call('finish', toHex(bs));
    if (!f.ok) throw new Error('browser round trip failed');
    prep.push(s.prepareMs); bl.push(s.blindMs); fin.push(f.finalizeMs); ver.push(f.verifyMs);
  }
  // reader workload: 100 badges
  const badges = [];
  for (let i = 0; i < 100; i++) {
    const ctx = randomCtx();
    const b = await issueBadge(key, issuer, ctx);
    badges.push({ ctx: ctxHex(ctx), msgPrefixHex: toHex(b.msgPrefix), sigHex: toHex(b.sig) });
  }
  await call('importKey', toHex(spki));
  const r = await call('benchVerify', badges, 7);
  if (!r.allOk) throw new Error('browser verify of node badges failed');
  results[`chromium${bits}`] = {
    importKey_ms: stat(importMs), prepare_ms: stat(prep), blind_ms: stat(bl), finalize_ms: stat(fin), verifyBadge_ms: stat(ver),
    reader100: { firstVerifyColdMs: +r.firstVerifyMs.toFixed(2), sequentialTotalMs: +r.seqTotalMs.toFixed(2), sequentialPerVerifyMs: +r.seqPerVerifyMs.toFixed(3), thousandSequentialTotalMs: +r.thousandSeqTotalMs.toFixed(1), thousandPerVerifyMs: +(r.thousandSeqTotalMs / 1000).toFixed(4), parallelPromiseAllTotalMs: +r.parTotalMs.toFixed(2), seqRounds: r.seqAll.map((x) => +x.toFixed(1)), parRounds: r.parAll.map((x) => +x.toFixed(1)) },
  };
  console.log(`chromium ${bits}`, JSON.stringify(results[`chromium${bits}`], null, 1));
}

// SPKI with RSASSA-PSS OID: can Chromium / Node import it?
const sizes: Record<string, unknown> = {};
for (const bits of [2048, 3072, 4096] as const) {
  const plain = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 }).publicKey;
  const pss = (generateKeyPairSync as (t: string, o: object) => { publicKey: typeof plain })('rsa-pss', { modulusLength: bits, publicExponent: 65537, hashAlgorithm: 'sha384', mgf1HashAlgorithm: 'sha384', saltLength: 48 }).publicKey;
  const spkiPlain = new Uint8Array(plain.export({ type: 'spki', format: 'der' }));
  const spkiPss = new Uint8Array(pss.export({ type: 'spki', format: 'der' }));
  const probe = (hex: string) =>
    page.evaluate(async (h) => {
      const b = Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
      try {
        await crypto.subtle.importKey('spki', b, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
        return 'ok';
      } catch (e) { return String(e); }
    }, hex);
  sizes[bits] = {
    spki_rsaEncryption_bytes: spkiPlain.length,
    spki_rsassaPss_params_bytes: spkiPss.length,
    chromium_imports_rsaEncryption_spki: await probe(toHex(spkiPlain)),
    chromium_imports_pss_oid_spki: await probe(toHex(spkiPss)),
    mnBadge_payload_bytes: 32 + 4 + 32 + 32 + bits / 8,
  };
  let nodeImport = 'ok';
  try { await crypto.subtle.importKey('spki', copy(spkiPss), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']); } catch (e) { nodeImport = String(e); }
  (sizes[bits] as Record<string, unknown>).node_imports_pss_oid_spki = nodeImport;
}
results.sizes = sizes;
console.log('sizes', JSON.stringify(sizes, null, 1));
await browser.close();

mkdirSync(new URL('./results', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/bench.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log('wrote bench/results/bench.json');
