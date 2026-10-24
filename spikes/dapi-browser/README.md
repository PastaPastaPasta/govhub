# dapi-browser spike: Core-side data from DAPI in a real browser (PLAN §0, §4.4, §6.1)

Question: can a browser client get ALL Core data (blocks, txs, IS/chain locks, SML, bloom-filtered
tx streams) from evonodes' grpc-web DAPI, with no Insight and no third-party JSON-RPC?

**Answer: yes.** Verified 2026-10-23 against live mainnet (Dash Core 23.1.x / 24.0.0 evonodes,
tip ~2,560,390), from `http://localhost:<port>` in headless Chromium 156 (Playwright). The last full
run passed 41/41 browser checks (`test/results.json`) and 11/11 offline unit tests. Read-only: no broadcasts, no funds.

## Run

```
npm_config_cache=$TMPDIR/npm-cache npm install
npm test            # builds the page, serves it on http://localhost:<random port>, drives headless Chromium, ~2 min
npm run test:unit   # offline unit tests (pb, grpc-web framing, bloom vs dashcore-lib, cbor, tx parser, race, merge)
npm run size        # bundle-size table -> test/sizes.json
npm run smoke       # same client in Node: node scripts/smoke.mjs [host:port]
```

`test/run.mjs` starts and stops its own HTTP server and browser in the foreground. Env: `SWEEP=<n|all>`
(health-sweep size, default all nodes), `NODES=<n>` (nodes for the full flows, default 3). Needs network
(and, under the Claude sandbox, `dangerouslyDisableSandbox` for Chromium + network). The IS-lock checks
depend on mainnet activity (the run waits up to 90 s per stream for a live tx).

## Client stack decision: (b) thin hand-rolled grpc-web client (`src/`)

| Option | Verdict |
|---|---|
| (a) `@dashevo/dapi-client` 5.0.0-rc.8 in the browser | Bundles (esbuild + node polyfills) to **21 MB raw / 7.0 MB gzip** because it drags in wasm-dpp, dash-spv and dashcore-lib (1.2 MB gz alone). Not executed in the browser here; rejected on size and on needing Buffer/crypto/process polyfills. |
| (b) hand-rolled grpc-web over `fetch()` | **9.0 KB gzip** for everything except BLS (3.0 KB gz for just `DapiCore`), 33.2 KB gz with BLS verification. No codegen, no polyfills, runs identically in Node 22. The wire formats are 10 tiny protos (`@dashevo/dapi-grpc/protos/core/v0/core.proto`). |
| (b') generated `@dashevo/dapi-grpc/browser.js` | 167 KB gz (Core + Platform, protobufjs + google-protobuf + improbable grpc-web), still needs a tx/block/bloom parser (dashcore-lib, 1.2 MB gz). Fine, but ~18x bigger than (b) for what we use. |
| (c) `@dashevo/evo-sdk` 5.0.0-rc.8 | **Exposes no Core API at all** (no getTransaction, block, streams, SML, bloom; only Platform + asset-lock proof types). 12.4 MB raw / 8.9 MB gz single-file ESM with WASM. Still needed for Platform reads/writes, but cannot serve this role. |

**Recommendation:** use `src/` (promote to `packages/dapi-core` later) next to evo-sdk. Keep `src/chainlock.js`
(noble BLS) as a lazy `import()`: it is 27 KB gz and only needed to verify chain locks. The only runtime
dependency is `@noble/hashes` (sha256) plus `@noble/curves` for the optional BLS module.

## What is in `src/`

| File | Purpose |
|---|---|
| `pb.js`, `grpcweb.js` | Minimal protobuf codec; grpc-web framing, trailers, unary + server-streaming over `fetch` (AbortController cancel, connect/deadline timeouts, `GrpcError` with status code) |
| `core.js` | `DapiCore(node)`: `getBlockchainStatus`, `getBestBlockHeight`, `getBlock({height|hash})`, `getTransaction(txid)`, `subscribeToBlockHeadersWithChainLocks`, `subscribeToTransactionsWithProofs`, `subscribeToMasternodeList` |
| `dash.js` | tx / block / header / merkleblock (partial merkle tree verified) / ChainLock / ISDLOCK parsers, sha256d, OP_RETURN script classifier |
| `bloom.js` | BIP37 filter (bit-identical to dashcore-lib, unit-tested); enforces the >= 200 B DAPI minimum; `matchAllFilter()` |
| `cbor.js`, `sml.js` | 38-line CBOR decoder; SML diff parsing and summary |
| `nodes.js` | `fetchNodes()` from the quorum service, `sample(arr, k)` |
| `race.js` | **Node-race helpers (below)** |
| `chainlock.js` | optional: ChainLock BLS verification against the SML quorum key |

### Node-race helpers (`src/race.js`, 76 lines)

```js
race(nodes, (node, signal) => new DapiCore(node).getBlockchainStatus({ signal }), { n: 3, accept: s => s.chain.isSynced })
  // -> { value, node, ms, failures }  keeps n in flight, replaces failures with the next node, aborts losers

mergeStreams(nodes, (node, emit, signal) => core(node).subscribeToTransactionsWithProofs(f, {fromHeight}, ev => ... emit(key, item)),
             (item, node) => ..., { n: 3, maxReplacements: 10 })
  // -> { cancel(), stats(), closed }   n parallel streams on distinct nodes, each item delivered once (first node wins),
  //    dead/ended streams replaced from the node list, stats: firstBy per node, dupes, failed
```

Unit-tested offline and exercised live (a dead node first in the list is skipped/replaced).

## Results (browser, live mainnet)

Latencies are from this machine; one warm round trip to an evonode is ~60-175 ms depending on the node (ranges below span several runs against different random nodes). The first call
to each (node, method) costs about one extra round trip because the browser sends a CORS preflight per
URL (cached afterwards, see Findings). "3 nodes" = three random healthy evonodes, flows run in parallel.

| Method | Works in browser? | Latency / size (3 nodes) | Notes |
|---|---|---|---|
| quorum-service node list (`fetch`, cross-origin) | yes | 65-175 ms | CORS `*`; 205 usable of 362 (ENABLED + versionCheck success) |
| `getBlockchainStatus` | yes | 63-156 ms warm; cold sweep over all 205 nodes: p50 ~530, p90 670-745, p99 1.1-1.2 s, max 1.2-4.4 s (20 at a time, incl. TLS + preflight) | 0/205 failed in the final run (earlier runs: 0/174, 1/205 timeout) |
| `getBestBlockHeight` | yes | 112-303 ms (first call of method) | |
| `getBlock` by height | yes | 126-303 ms; 5.8 KB (12 tx), 19.4 KB (block 2559683, 39 tx) | parsed in-browser; merkle root recomputed and matches header |
| `getTransaction` collateral `3451d292...a365` | yes | 114-299 ms first call, 59-146 ms after | raw 234 B, height 2559683, 701 confs, IS=true, CL=true; output 1 = OP_RETURN `cbc458f8...2fe9`, value 1.00000000 DASH; txid recomputed from raw bytes matches |
| `getTransaction` recent (confirmed) | yes | 59-146 ms | confirmations 3, IS+CL true |
| `getTransaction` mempool tx | yes | ~140 ms | height 0, confirmations 0, **IS=false at rawtx time, IS=true immediately after the islock event** (same node) |
| `getTransaction` unknown | yes | 125-216 ms | `GrpcError` code 5 NOT_FOUND |
| `subscribeToBlockHeadersWithChainLocks` from tip-3 | yes | ChainLock at 118-301 ms, 4 headers at 119-348 ms | headers parse; ChainLock = 132 B (height, hash, 96 B sig); cancel => `closed: 'cancelled'` |
| `subscribeToTransactionsWithProofs`, 200 B bloom, random hash160 | yes | first merkleblock 250-290 ms | 0 raw txs / 0 matched over 4 historical blocks (4 empty merkleblocks arrive, one per block) |
| same, positive control (real P2PKH hash160, `fromHeight` = collateral block, count 1) | yes | 328-425 ms | returns the collateral tx + a merkleblock containing it, root verified: our murmur3/BIP37 implementation is accepted by the server |
| same, match-all filter | yes | first raw txs + merkleblock 250-313 ms | ~37 txs over 4 blocks (+live), 4-5 merkleblocks all with valid partial-merkle-tree roots and every matched txid delivered as a raw tx; ISDLOCK messages arrive live (v1, N inputs, 96 B sig), **1.0-3.3 s after the raw tx** |
| `subscribeToMasternodeList` (first message) | yes | **1,361,183 B**, 0.5-1.1 s typical (outliers seen: 8.8 s, 11.6 s) | CBOR diff vs zero base block; browser parse 8-19 ms (CBOR decode + counting); **3014 MNs (2254 valid), 362 evonodes, 88 quorums**; 3 nodes returned identical tip hash and counts |
| ChainLock BLS verify (optional) | yes | 21-33 ms cold, 7-9 ms warm | verifies against rank-0 quorum of LLMQ_400_60 chosen from the SML; tampered height rejected |
| `race()` with 2 dead nodes first | yes | winner in 123-218 ms | failures reported per node |
| `mergeStreams()` over 3 nodes + 1 dead | yes | 28-32 items, 56-64 duplicates suppressed; inter-node arrival spread for the same IS-lock 5-151 ms (plain txs: 2-70 ms) | dead node replaced by the 4th; every item delivered once |
| `getEstimatedTransactionFee` | not in the client | | known to fail (earlier Node research); PLAN already assumes 1 duff/byte |

Network-level (Playwright, final run): 270 DAPI requests, 0 unexpected failures (the only failures were the 3
deliberately dead nodes), 18 aborted by the client = exactly the 18 streams we cancelled, **0 requests in
flight at the end**. All streams reported `closed.reason === 'cancelled'`. Server-side stream teardown is not
observable from the browser.

Streaming works with plain `fetch()` + `response.body.getReader()` (no flags); messages arrive
incrementally (e.g. match-all: historical replay at ~300 ms, live txs/IS-locks tens of seconds later).

## Bundle size (esbuild --minify, browser; `test/sizes.json`)

| Bundle | raw KB | gzip KB | brotli KB |
|---|---|---|---|
| **govhub client without BLS** (`src/index.js`: grpc-web, pb, parsers, bloom, SML, race) | 21.5 | **9.0** | 7.9 |
| ...`DapiCore` only (grpc-web + pb + 10 RPCs) | 7.2 | 3.0 | 2.7 |
| ChainLock BLS module alone (`src/chainlock.js`, noble bls12-381) | 73.8 | 26.9 | 23.7 |
| client + BLS | 89.7 | **33.2** | 29.0 |
| baseline: `@dashevo/bls` emscripten glue + wasm (what dashcore-lib uses for ChainLock verify) | 723 | 306 | 250 |
| baseline: `@dashevo/dapi-grpc/browser.js` | 2545 | 167 | 129 |
| baseline: `@dashevo/dashcore-lib` (with node polyfills) | 4019 | 1248 | 576 |
| baseline: `@dashevo/dapi-client` (with node polyfills) | 21033 | 7049 | 4939 |
| baseline: `@dashevo/evo-sdk` 5.0.0-rc.8 `evo-sdk.module.js` | 12408 | 8885 | 8830 |

## Optional: ChainLock BLS verification in the browser: feasible, cheap

`src/chainlock.js` verifies a received CLSIG with `@noble/curves` BLS12-381 (pure JS, no WASM): Dash's
"basic" scheme is the IETF `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_` (pubkey G1 48 B, sig G2 96 B).
Steps: `requestId = sha256d("clsig" varstr || height u32le)`; rank the LLMQ_400_60 (type 2) quorums from the SML by
`sha256d(type || quorumHash(internal) || requestId)`, lowest first; `signHash = sha256d(type || quorumHash || requestId || blockHash)`;
verify against `quorumPublicKey`. Hash byte orders matter (the wire/internal order is used inside the sign hash; the
reversed variant fails). Passed on the first rank-0 quorum every run, matching dashcore-lib's result in Node.
Cost: +24 KB gz over the client, 21-33 ms cold / 7-9 ms warm. Not done: IS-lock verification (needs the rotating
LLMQ_60_75 quorum selected by `cycleHash`; same primitive, more bookkeeping) and recomputing `merkleRootMNList`
from the entries to authenticate the SML itself.

## FINDINGS (things that differ from, or add to, docs/PLAN.md)

1. **evo-sdk 5.x has no Core API.** PLAN §0 says DAPI covers all other Core data, which is true, but the SDK does
   not expose it (only Platform and asset-lock proof types). govhub needs its own Core client (this spike's
   `src/`) alongside evo-sdk. It also has to hand evo-sdk the raw tx + IS-lock bytes for asset-lock proofs.
2. **IS-lock timing is 1.0-3.3 s after the raw tx, not "about 1 s" (§4.4 step 4)** in our samples (about 6 distinct
   locks, each seen by 1-3 nodes, across several runs; per-node, measured from when this client first saw the raw tx). Budget a spinner, and keep the chain-lock fallback (step 5).
3. **IS-lock messages are never replayed.** Opening the tx stream at `tip-3` replays raw txs and merkleblocks for
   confirmed blocks but no IS-lock messages: the replay (4 blocks, ~40 txs, done in <0.5 s) contained none, and in every run the first ISDLOCK arrived 8 s or more later. If the
   stream opens after the deposit was already IS-locked (page reload, late subscribe), the IS-lock bytes are gone;
   `getTransaction` only reports the boolean `isInstantLocked`, not the lock. An instant asset-lock proof then
   cannot be built and only the chain-lock proof remains (§4.4 step 5). So: subscribe BEFORE showing the QR code and
   persist the IS-lock bytes with the draft. (`getTransaction` is still a good liveness check: it flips to
   `isInstantLocked=true` immediately when the islock event arrives, and is `false` at raw-tx time.)
4. **`getTransaction`'s `isChainLocked`/`confirmations` are node claims.** To make §6.1's "6 confirmations and a ChainLock" check
   trust-minimized, verify the ChainLock (works, see above) and tie it to the tx's block. Header hashes are X11, which
   this spike does not implement (`wasm-x11-hash` is 300 KB unpacked); without X11 you can still chain via `prevHash`
   (a ChainLocked hash is the `prevHash` of the next streamed header) and prove tx-in-header with the verified merkle
   proofs we already parse. Full chain: tx -> merkle -> header -> X11 hash -> CLSIG -> BLS -> SML quorum key.
5. **The SML is a free node directory.** 356 of 362 evonode entries carry `addresses.platform_https` (all `:443`), versus
   205 nodes that pass the quorum service's `versionCheck=success`. Once one node is reachable, the SML can replace the
   quorum service. A Node-side check showed only ~52% of the `ENABLED` + `versionCheck=fail` nodes (78 of 151) answer
   Core RPCs, so keep the service's filter as the default. 3-4 of 205 passing nodes reported `isSynced=false` and the `race()`
   `accept` hook should check `chain.isSynced` plus height within 1 of the best.
6. **CORS is wide open and cheap.** Evonodes reflect any `Origin`, allow `content-type`/`x-grpc-web`, expose
   `ratelimit-*`/`grpc-status` headers, and set `Access-Control-Max-Age: 1728000` (Chrome caps it at 2 h). Preflights are
   keyed per URL (= per RPC method), so the first call of each method per node costs one extra round trip (~130 ms),
   later calls on the same method do not (even after 8 s idle). `ratelimit-*` headers are readable in the browser (not yet
   surfaced by `DapiCore`, a TODO before enforcing the 150/min/node budget client-side).
7. **TLS/CORS/offline failures are indistinguishable in JS** (`TypeError: Failed to fetch`). Observed failure rate in
   the browser was 0-0.5% of nodes (0/174, 1/205 timeout, 0/205), lower than the ~2.5% bad-TLS rate seen from Node earlier; the
   client maps all of them to `GrpcError(14, {network: true})`. Only Playwright's `requestfailed` shows the real reason.
   Treat any network error as "try another node".
8. **Byte-order traps.** `getBlockchainStatus.chain.bestBlockHash` is internal (little-endian) order, `getTransaction.blockHash`
   is display order, CLSIG block hash is internal. `dash.js` exposes display-order hex everywhere (`hashHex`) and keeps
   `blockHashInternal` for the BLS sign hash.
9. **Bloom subscription also yields a block-progress signal.** With `count: 0` the server sends one merkleblock per block even
   with zero matches, so a deposit watcher gets a heartbeat and confirmation progress without extra calls.
10. **The SML first message is 1.36 MB** and `MasternodeListRequest` is empty (no base-block parameter), so every session that
   wants it pays 0.5-1.7 s typical (8-12 s on slow nodes). Only fetch it lazily, for ChainLock/quorum verification, not on the
   critical path of the deposit and proposal flows; cache `blockHash` + counts and cross-check across 2-3 nodes (done in
   the test: identical tips and counts).
11. **Chrome blocks "unsafe" ports** (`ERR_UNSAFE_PORT`) for fetch. All 361 SML `platform_https` entries use 443 today, but a
    manual node list entry on e.g. 6000 or 6667 will silently fail in browsers.
12. Not covered here: Firefox/WebKit (fetch response streaming is supported in current versions but was not run), HTTP 429
    behaviour at the 150/min limit (not hammered on purpose), `getEstimatedTransactionFee`, `broadcastTransaction`
    (read-only spike), SML incremental diffs after the first message, IS-lock BLS verification.
13. Known gaps in the client (found in review, left as TODOs): streams have a connect timeout but no idle timeout by default
    (pass `idleTimeoutMs`, e.g. ~4 min for the header stream which gets a block every ~2.5 min); ChainLock quorum ranking uses
    all LLMQ_400_60 quorums in the SML tip rather than Core's "newest N as of height-8" (equal today: 4 and 4); block header
    hashes (X11) are not computed.

## Layout

```
src/        client (see above)           page/   test page (window.spike flows run inside the browser)
test/       run.mjs (Playwright harness), unit.test.mjs, results.json (last run), sizes.json, fixtures/
scripts/    build.mjs, size.mjs, smoke.mjs, dump-sml.mjs, verify-cl.mjs, sweep-failed-versioncheck.mjs
```
