# blindrsa spike: MN owner badge crypto (PLAN §8)

End-to-end proof and measurements for **RSABSSA-SHA384-PSS-Randomized (RFC 9474)** with
`@cloudflare/blindrsa-ts` on the client (browser and Node) and a Node 22 / OpenSSL raw-RSA issuer.

Status: all of §8.1, §8.3 (badge message and token-request string) and the reader/issuer rules that are
pure crypto work as specified. Two things in the plan need tightening (see FINDINGS, items 1 and 2).

## Layout

| Path | What |
|---|---|
| `src/format.ts` | 148-byte badge message (`"govhub-badge:v2" ‖ net ‖ contractId ‖ issuerId ‖ keyId ‖ epoch u32 BE ‖ ownerId`), `keyId = SHA256(SPKI)` |
| `src/client.ts` | wrappers: `importIssuerKey`, `prepare`, `blind`, `finalize`, `verify`; badge level `bindIssuerKey`, `prepareBadge`, `verifyBadge`. WebCrypto only, browser-safe |
| `src/issuer.ts` | `BlindIssuer`: `privateDecrypt(RSA_NO_PADDING)` + mandatory `publicEncrypt` check before returning |
| `src/request.ts` | `govhub-badge-req:v2\|net\|issuerId\|epoch\|keyIdHex\|proTxHash\|nonce\|sha256(blindedMsg)` builder, strict parser, binding check |
| `src/browser-entry.ts`, `scripts/build-browser.mjs` | esbuild bundle (46 KB min / 15 KB gzip incl. sjcl) loaded by headless Chromium from `file://dist/index.html` (no server) |
| `test/` | vitest: RFC vectors, round trips, negatives, issuer, request, format, Chromium |
| `bench/run.ts` | timings and sizes, writes `bench/results/bench.json` |
| `test/vectors/rfc9474-appendix-a.json` | Appendix A vectors extracted from the RFC text by `scripts/extract-vectors.mjs` |

## Run

```sh
export npm_config_cache=$TMPDIR/npm-cache      # the global npm cache has root-owned files here
npm install
npx playwright install chromium                # once, if ~/Library/Caches/ms-playwright lacks it
npm test            # 71 tests in 7 files, ~75 s (1000 round trips per key size dominate)
npm run typecheck
npm run bench       # Node + Chromium timings, sizes; writes bench/results/bench.json
```

The Chromium test and bench must run **outside** the macOS Seatbelt sandbox: Chromium aborts there with
`bootstrap_check_in ... MachPortRendezvousServer: Permission denied (1100)`. Everything else runs inside it.
Browser is headless only (`chromium.launch({headless:true})`, `chrome-headless-shell`); no visible window.

## Results

Machine: Apple M4 Pro (14 cores), macOS arm64, Node v22.23.2 (OpenSSL 3.5.7), Chromium 156.0.8078.4
(headless shell, Playwright 1.64.1). Medians. Run to run noise is about 10%. Chromium's `performance.now()` is
coarsened to 0.1 ms, so per-verify figures come from batch totals (100 and 1000 verifies).

### Issuer signing, Node (per blind signature)

| | 2048 | 3072 |
|---|---|---|
| **`BlindIssuer.blindSign`** (OpenSSL CRT + length/range checks + `s^e == m` check) | **0.34 ms** | **0.97 ms** |
| bare `privateDecrypt(RSA_NO_PADDING)` | 0.32 ms | 0.95 ms |
| BigInt `m^d mod n`, no CRT (reference) | 8.4 ms | 27.3 ms |
| library `BlindRSA.blindSign` (sjcl, non-CRT, pure JS) | 224 ms | 728 ms |

All three implementations give byte-identical signatures (tests compare issuer, library and BigInt on random inputs, and the
issuer and library against the RFC blind_sig). The library's own signer is about 650-750x slower than OpenSSL here,
and it is not constant-time. It is not usable as the issuer. Ratio verified-OpenSSL / BigInt is ~25x, more than CRT
alone would give (about 3.5x), so OpenSSL is also using native Montgomery code.

### Client operations (one badge)

| | Chromium 2048 | Chromium 3072 | Node 2048 | Node 3072 |
|---|---|---|---|---|
| `prepare` (build message + 32 B prefix) | <0.1 ms | <0.1 ms | 0.01 ms | 0.01 ms |
| `blind` (sjcl JS bignum, **main thread**) | 15.9 ms | 33.8 ms | 17.6 ms | 39.7 ms |
| `finalize` (mulmod in sjcl + WebCrypto verify) | 3.5 ms | 7.5 ms | 4.1 ms | 9.1 ms |
| `importIssuerKey` (SPKI parse + canonical check + keyId) | ~0.1 ms | ~0.1 ms | | |
| **`verifyBadge`, per badge, steady state** | **0.018 ms** | **0.029 ms** | 0.09 ms | 0.12 ms |
| **100 verifies, sequential** | **1.8 ms** | **2.9 ms** | 3.7 ms | 5.2 ms |
| 100 verifies, `Promise.all` | 1.9 ms | 3.0 ms | | |
| 1000 verifies, sequential | 18.3 ms | 29.1 ms | | |
| first (cold) verify | ~0.1 ms | ~0.1 ms | | |

Reading: a reader verifying every badge on a page pays about 2-3 ms per 100 badges, so verify cost is not a
concern, even at 3072 and even if a phone is 10x slower. The only perceptible cost is the one-time
`blind` (16-34 ms of JS bignum math) which should run in a Worker. Full round trip (blind, sign, finalize,
verify, one message) measured in tests: 22 ms at 2048 and 54 ms at 3072 per iteration in Node.

### Sizes

| | 2048 | 3072 |
|---|---|---|
| `mnBadge` payload: issuerId 32 + epoch 4 + keyId 32 + msgPrefix 32 + sig | **356 B** | **484 B** |
| `issuerKey.spki`, rsaEncryption OID (what WebCrypto imports and exports) | **294 B** | **422 B** |
| `issuerKey.spki`, RSASSA-PSS OID + SHA-384/MGF1/salt 48 params | 346 B | 474 B |
| (4096 for reference: rsaEncryption / PSS-OID) | 550 B / 602 B | |

The plan's `spki ≤ 600 B` holds for 2048 and 3072 in either encoding. A 4096-bit key in the PSS-OID form would not fit (602 B), but see FINDINGS 1: that form cannot be imported anyway.
The badge message itself is 148 B (15 tag + 1 net + 4x32 + 4 epoch); the prepared message is 180 B.

### Tests (all pass)

- `rfc9474.test.ts`: RFC 9474 A.1 (4096-bit key). Client verifies the RFC sig and rejects a flipped bit; `blind()` reproduces
  the RFC `blinded_msg` byte for byte when fed the RFC salt and blinding factor (random source stubbed); `finalize` reproduces `sig`;
  the Node issuer reproduces `blind_sig`; library `blindSign` matches too; end to end RFC blinded_msg to issuer to client to RFC sig.
- `roundtrip.test.ts`: 1000 random badge messages per key size (2048 and 3072): blind, sign, finalize, verify.
- `negative.test.ts` (both key sizes): wrong ownerId, epoch, keyId (document claim, other key, foreign keyId in message), net, contractId, issuerId;
  tampered prefix (all 32 positions); tampered sig; wrong-length prefix and sig; `s ≥ N` (checked with the library's verify mocked to
  always accept, so the wrapper's own check is exercised); `blindSig ≥ N` and wrong lengths in `finalize`;
  issuer rejects wrong length, `≥ n`, 0, 1; issuer refuses a simulated faulty (bit-flipped) signature; key import rejects e != 65537, 2047/3070/1024-bit, non-canonical SPKI.
- `issuer.test.ts`: key has CRT params; issuer == BigInt == library; raw OpenSSL silently left-pads a 255-byte input.
- `request.test.ts`, `format.test.ts`: string builder/parser (strictness, canonical form, bounds), message layout.
- `browser.test.ts`: in Chromium, 25 round trips per key size against the Node issuer, Node-made badges verified in Chromium and the reverse,
  tampering, `s ≥ N`.

**Blinding-factor reuse is not detectable** by the issuer (it only sees a uniform residue; a repeat looks exactly like a retry, which
PLAN §8.4 rule 4 serves idempotently). So it is a client rule: a fresh CSPRNG `r` and PSS salt per `blind()` call, never persist or
re-send `inv`/`r`, and never wrap `blind()` in a retry that reuses its output for a different message. The library satisfies this by
drawing both from `crypto.getRandomValues` inside every `blind()` call (tested: two `blind()` calls on the same message give different `blindedMsg` and `inv`).

## Library: `@cloudflare/blindrsa-ts` 0.4.6

- npm: 0.4.6 published 2026-06-19; 0.4.5 on 2026-03-09; 0.4.4 on 2025-05-07; 0.4.3 on 2025-03-10; 12 versions since 2023-08, all 0.x.
  About 31.5k downloads/week. Apache-2.0. Cloudflare-owned, many Cloudflare maintainers.
- GitHub `cloudflare/blindrsa-ts`: not archived, last push 2026-10-13 (Dependabot bumps), last functional commits June to July 2026
  (partially blind RSA fixes), 36 stars, 9 open issues, no security advisories. Actively maintained, but small.
- Open issues that matter here: **#55** `blindSign()` skips the `RSAVP1` consistency check on the `RSA-RAW` path (the exact fault-leak
  hazard the plan describes); **#60** `sjcl` is deprecated on npm and an open issue proposes replacing it (noble suggested).
- Dependency: `sjcl` 1.0.9 (deprecated on npm). The library declares `engines.node >= 24`; it works on Node 22.23.2 (everything here
  runs on 22), npm only warns.
- Other tooling: Node 22.23.2, vitest 5.0.5, playwright 1.64.1, esbuild 0.28.2, typescript 7.0.2, tsx 4.23.15.

### Security-relevant behaviour of the library (read from `lib/src/*.js`)

- `prepare(msg)`: returns `random32 ‖ msg` and exposes no separate prefix accessor: the prefix is the first 32 bytes
  (`PrepareType.Randomized = 32`). `blind()` and `verify()` take the **prepared** message. Store `msgPrefix` next to the signature.
- `finalize()` **does verify**, using WebCrypto `crypto.subtle.verify({name:'RSA-PSS', saltLength:48})`, and throws `invalid signature`. It also
  checks `len(inv) == kLen` and `len(blindSig) == kLen`.
- `finalize()` does **not** check `blindSig < n`. It computes `z * inv mod n`, so `blindSig + n` is accepted (tested). The wrapper adds the check.
- `verify()` is plain WebCrypto RSA-PSS verify. Node (OpenSSL) and Chromium (BoringSSL) both reject `s ≥ N` (`sig + N` tested) and wrong lengths, but the wrapper
  checks both itself rather than depending on that.
- `blind()`/`finalize()` need an **extractable** RSA-PSS/SHA-384 public `CryptoKey` and re-export it as JWK on each call. It does not validate the key
  (no `e` or size check): `importIssuerKey` does.
- `blind()` draws the PSS salt and `r` from `crypto.getRandomValues`, rejection-samples `r < n`, and checks `gcd(m, n) = 1`. Bignum work is sjcl (pure JS, not constant-time).
  The secret on the client is `r`; the timing exposure is local to the user's own browser and judged low, but it is the weakest part of the client path.
- `blindSign()` without `supportsRSARAW` is sjcl non-CRT `m^d mod n` followed by an `s^e == m` check. That is 224 / 728 ms here. With
  `supportsRSARAW: true` it needs a WebCrypto `RSA-RAW` algorithm that only Cloudflare Workers provide, and it skips the check (#55). Neither is used here.
- Inputs: the library does `x.slice().buffer`, which on a Node `Buffer` hands WebCrypto the whole pool. Every wrapper therefore copies inputs to a plain `Uint8Array` first (a review found valid badges failing to verify when `sig` was a `Buffer`).

## OpenSSL claim (PLAN §8.1: "CRT and constant-time with blinding")

Verified: `crypto.privateDecrypt({key, padding: RSA_NO_PADDING}, x)` returns exactly `x^d mod n` (equals BigInt and the library on random inputs and on the RFC vector), the
PKCS#8 key from `generateKeyPairSync` carries `p, q, dP, dQ, qInv`, and it is 25x faster than non-CRT BigInt. Not verifiable from outside: that OpenSSL actually takes
its CRT path with base blinding and constant-time exponentiation. That is OpenSSL's `rsa_ossl_private_decrypt` behaviour as documented in its source (this was not re-read here).
Observed edge behaviour: input `≥ n` is rejected by OpenSSL, input longer than the modulus is rejected, but **input shorter than the modulus is silently left-padded**, so the explicit length check in
`BlindIssuer` is required. `RSA_NO_PADDING` is not affected by Node's removal of PKCS#1 v1.5 decryption padding. The post-sign `s^e == blindedMsg` check is done with
`publicEncrypt(RSA_NO_PADDING)`; a test-only `rawSign` hook proves a bit-flipped signature is refused.

## FINDINGS: where this contradicts or tightens PLAN §8

1. **SPKI encoding must be pinned to the rsaEncryption OID.** RFC 9474 deployments often use the RSASSA-PSS OID with parameters; WebCrypto in both Chromium 156 and Node 22
   **cannot import** that form (`DataError: Invalid key type`) and it is 52 B larger (a 4096 key would be 602 B > the 600 B schema cap). Define `issuerKey.spki` as the `rsaEncryption`
   SPKI (294 / 422 B) and require it to be canonical DER: `importIssuerKey` re-exports and compares, otherwise a trailing `0x00` or other non-minimal encoding
   gives one key several valid keyIds (Node's WebCrypto accepts a trailing byte). Also require `e = 65537` and an exact modulus bit length (OpenSSL generates "3071-bit" keys of 3070 bits).
2. **Only the key binds a signature to an issuer and epoch.** The issuer signs blind, so `net`, `contractId`, `issuerId`, `epoch` inside the message are
   chosen by the client and are not authenticated (a review demonstrated a badge signed by key K that claims issuer B / epoch 999 and verifies if the reader trusts the document's claims).
   PLAN §8.6 therefore must say: the reader takes `issuerId` and `epoch` from the proved `issuerKey` document found by `keyId` (not from the `mnBadge` document) and rebuilds the message from those.
   The wrapper enforces it (`verifyBadge` only accepts a `BoundIssuerKey`, document-claimed issuerId/epoch/keyId must equal the bound values). It also means a key must never sign for two epochs; the "key destroyed after its window" rule (§8.4.7) is what makes `epoch` meaningful.
3. **The library's own signer is unusable on the server** (224 / 728 ms, non-constant-time, non-CRT; the `RSA-RAW` fast path exists only in Workers and skips the fault check, issue #55).
   This confirms the plan's choice of OpenSSL, and means "verify before return" must be in our code, not assumed from the library. If the issuer ever runs in a Worker, add the check there too.
4. **OpenSSL's raw RSA accepts short input** (left-pads). §8.4 says reject wrong length; it has to be explicit.
5. **Library `finalize` accepts `blindSig ≥ n`** and silently reduces. Harmless for security (the result still has to verify and is `< n`), but a malleable issuer response; reject it client-side.
6. **Unspecified encodings the plan leaves open.** This spike fixes: `net` byte 1 mainnet / 2 testnet / 3 devnet / 4 regtest, and the same names in the request string; `<issuerId>` = base58 of the 32-byte identity id; `<epoch>` decimal with no leading zeros;
   hex fields lowercase; `<nonce>` 16 to 64 bytes hex. The parser requires `build(parse(s)) == s`, rejects `net` names inherited from `Object.prototype`, and caps input at 512 chars (max legal is 407).
   Also decide what `contractId` means in the badge message (the `badge` contract id) and that v1 and v2 contracts therefore produce distinct badges.
7. **`blind()` is 16-34 ms of main-thread JS bignum.** Run it in a Worker. `sjcl` is deprecated (#60); a noble-based replacement upstream, or a small own BigInt implementation of `blind`, is the likely fix. The badge client should pin the exact lib version and bundle (§8.5 already requires a reproducible, SRI-pinned build).
8. **Reader cost is a non-issue.** 18 to 29 µs per badge in Chromium (100 badges: 2 to 3 ms). The `msgPrefix` + `sig` storage cost (356 / 484 B per badge) matters more than verification time, and 3072 costs 36% more bytes than 2048 for no reader-side penalty.
9. **Node 22 vs library `engines >= 24`.** Works and passes all tests on 22.23.2; only the client part of the library is used and Node is not needed for it in production. Not a contradiction, but pin it.
10. **Blinding-factor reuse cannot be detected server-side** (see above). §8.5 already lists this as a client rule; the issuer-side idempotent retry (same `H(blindedMsg)` returns the same signature) is exactly what a reuse looks like, so the rule can only be enforced by the audited client build.
11. **Issuer start-up check.** `BlindIssuer({expectedSpki})` refuses to start if the loaded private key does not match the SPKI published for the epoch (otherwise a wrong-epoch key only surfaces as every client failing `finalize`).
    Add this to §8.4.7.
12. **Cheap key sanity.** `importIssuerKey` also rejects even moduli and moduli with a factor below 100. This is not a primality test; a malicious issuer key (the plan's "malformed key" case) is still handled by the randomized prefix, not by key checks.

Nothing found that contradicts RFC 9474 itself, the choice of RSABSSA-SHA384-PSS-Randomized, the 32 B prefix, the 256 / 384 B signature sizes, or the field sizes in §3.1.
