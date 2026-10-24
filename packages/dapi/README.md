# @govhub/dapi

Browser-first TypeScript client for the **DAPI Core** grpc-web endpoints that Dash evonodes expose
(transactions, blocks, ChainLocked headers, the SML, bloom-filtered transaction streams with IS-locks).
It is the `packages/dapi` that docs/PLAN.md "Phase 0 results" promised, promoted from
`spikes/dapi-browser` (whose README holds the measurements this builds on: findings 1-13).

- No codegen, no polyfills, runs identically in browsers and Node >= 22 (plain `fetch`).
- Runtime dependencies: `@noble/hashes` (sha256) and, only for `@govhub/dapi/bls`, `@noble/curves`.
- Strict TypeScript, erasable syntax only (Node type stripping works on the sources, as in `@govhub/verify`).
- Every Core claim is labelled **verified** or **claimed** in the result types; see [Trust notes](#trust-notes).

```
npm install                          # from the repo root (npm workspaces)
npm test -w @govhub/dapi             # offline: 159 vitest tests on recorded mainnet data
npm run typecheck -w @govhub/dapi
npm run test:live -w @govhub/dapi    # opt-in: headless Chromium against live MAINNET nodes (read-only)
npm run size -w @govhub/dapi         # bundle sizes -> test/sizes.json
```

Under the Claude sandbox, `net.test.ts` (local socket) and `test:live` (Chromium, network) need `dangerouslyDisableSandbox`.

## Usage

```ts
import { createDapi } from '@govhub/dapi';

// X11 and BLS live in their own entry points. Load them lazily to keep them out of the first bundle.
const dapi = createDapi({
  verifiers: async () => ({
    hashHeader: (await import('@govhub/dapi/x11')).x11,
    verifyChainLock: (await import('@govhub/dapi/bls')).verifyChainLock,
  }),
});

const tx = await dapi.getVerifiedTransaction(txid);
//  tx.chainLocked: 'verified' | 'claimed' | 'no'     tx.instantLocked: 'claimed' | 'no'
//  tx.proof: { merkle, blockHash: 'verified'|'claimed', chainLock: { height, blockHash, quorumHash, exact, verifiedConfirmations } | null, notes }

// Deposit flow: subscribe BEFORE showing the QR code. The promise resolves once the streams are open.
const watcher = await dapi.watchAddressForDeposit(hash160, {
  onTx: ({ tx, matches }) => { /* a tx paying the address; matches = output indexes */ },
  onIsLock: async ({ bytes, lock }) => { await db.save(lock.txid, bytes); },   // IS-locks are NEVER replayed: persist them here
  onBlock: (mb) => { /* one call per block: confirmation progress even with no match */ },
  onError: (e, { phase }) => console.warn(phase, e),
});
// ... later
watcher.cancel();
```

### API

| Call | What it does |
|---|---|
| `createDapi(opts)` / `new Dapi(opts)` | `nodes` (static list), `nodeListUrl` (quorum-service-compatible URL, user-replaceable, per-network default), `fetchNodes` (custom source), `network` (`mainnet`/`testnet`), `verifiers`, `maxPerMinute` (150), `timeoutMs` (15 s), `attempts` (4), `smlTtlMs` (5 min) |
| `dapi.ready()` | Loads the node list once (static list: no request) |
| `dapi.call(fn, {attempts, retryable, signal})` | Runs `fn(core)` on one node with failover (below) |
| `dapi.getBestBlockHeight()` | From a node that reports `isSynced` (a claim) |
| `dapi.getBlock({height}\|{hash})` | Parsed block; its merkle root is recomputed (mismatch = lying node, next node) |
| `dapi.resolveBlockHeight(hash)` | Height from the block's coinbase, cached |
| `dapi.getVerifiedTransaction(txid, {chainLock, maxHeaderSpan, waitForChainLockMs, headerTimeoutMs})` | See [Trust notes](#trust-notes) |
| `dapi.getSml({force, nodes, minAgree, hedgeAfterMs})` | Full SML accepted only if >= 2 of 3 nodes return identical content (tip, roots, quorum keys, evonode endpoints and every masternode's voting address / type / validity, in `sml.masternodes`); cached; cancels the losers |
| `dapi.refreshNodesFromSml({mode: 'append'\|'replace'})` | Adds the agreed SML's valid `platform_https` evonodes to the pool |
| `dapi.verifyChainLock(cl)` | BLS check with Core's quorum selection (needs `verifiers.verifyChainLock`) |
| `dapi.watchAddressForDeposit(hash160, handlers, opts)` / `dapi.watchTransactions(filter, handlers, opts, match)` | Merged streams on 3 nodes; see below |
| `dapi.broadcastTransaction(raw, {allowHighFees, bypassLimits})` | Parses `raw` first, checks the node's returned txid against the local one, fails over on network errors only |
| `DapiCore(node)` | The 10 RPCs, one node, no policy: `getBlockchainStatus`, `getBestBlockHeight`, `getBlock`, `getTransaction`, `broadcastTransaction`, `subscribeToBlockHeadersWithChainLocks`, `subscribeToTransactionsWithProofs`, `subscribeToMasternodeList` |
| `parseTx/Block/Header/MerkleBlock/ChainLock/InstantLock`, `parseSml`, `decodeCbor`, `BloomFilter`, `NodePool`, `race`, `mergeStreams` | Building blocks, all exported |
| `@govhub/dapi/bls` | `verifyChainLock(cl, quorums, {network, smlHeight})`, `blsVerify` |
| `@govhub/dapi/x11` | `x11(header80)`, `blockHashHex(header80)` |

`getBlock`, `getVerifiedTransaction`, `getSml`, `refreshNodesFromSml`, `verifyChainLock`, `resolveBlockHeight` and the two watch calls load
their module on first use (`import()`), so bundlers that split dynamic imports keep them out of the initial chunk (sizes below).

### Nodes, rate limits, failover

- **Node source.** `nodes: [...]` for a static list; otherwise one `fetch` of `nodeListUrl` (default
  `https://quorums.mainnet.networks.dash.org/masternodes`, testnet equivalent for `network: 'testnet'`), keeping `ENABLED` nodes with
  `versionCheck: success` and validating every endpoint as `host:port`. `fetchNodes: () => Promise<string[]>` replaces the whole step.
  Afterwards `refreshNodesFromSml()` extends the pool from the verified-agreement SML (356 endpoints vs the service's ~200; about half of the extra ones
  answer, so the default `append` keeps the service's nodes first).
- **Budget.** `NodePool` counts every unary call and stream open per node over a rolling minute (default 150, the nodes' own limit). An exhausted node is
  not contacted; the call moves on. Live run: at most 3 requests to any host in a minute.
- **Failover.** Any error that says "try another node" (TLS, CORS, offline and DNS are indistinguishable in a browser, so every network error is
  one; HTTP 5xx; HTTP 429, which also cools the node down for the server's `ratelimit-reset`; wrong content type; unsynced; any verification
  mismatch) moves to a *different* node after full-jitter exponential backoff (`backoffMs`). NOT_FOUND is tried on one more node. INVALID_ARGUMENT and
  FAILED_PRECONDITION are not retried (every node would say the same). Failed nodes cool down for 60 s and are picked last.
- **Streams.** Every stream has a connect timeout and an idle timeout by default (10 min in `stream()`, 15 min in watchers; 0 disables), and a
  32 MiB per-message cap. An idle close is not counted against the node.

### Deposit watching

`watchAddressForDeposit(hash160, handlers, opts)`:

1. Builds a BIP37 filter of **>= 200 bytes** (smaller filters saturate and match everything on DAPI nodes) with the hash inserted, `BLOOM_UPDATE_ALL`.
2. Opens `streams` (3) subscriptions on distinct nodes starting `lookback` (3) blocks below the tip, and **resolves only after `readyStreams` (2)
   of them are open**. Show the QR code on resolve.
3. Delivers each distinct tx (only those paying the hash; `matches` lists the output indexes), IS-lock and merkleblock **once**, from whichever
   node was first; the same item from the other nodes is counted in `stats().dupes`.
4. Hands the exact IS-lock bytes to `onIsLock` (awaited; errors go to `onError`). IS-locks arrive 1-3 s after the tx and are **never replayed**: a page
   reload after the lock was sent loses it for good (only the ChainLock proof path remains), so persist inside the callback.
5. Replaces any stream that ends, errors or goes idle, from the pool, with jittered backoff and no lifetime cap. A replacement starts a few blocks
   below the blocks seen so far, not at the original height.

`watchTransactions(filter, handlers, opts, match)` is the same machinery for any filter (the live test drives it with `matchAllFilter()` to see IS-locks).

## Trust notes

What `getVerifiedTransaction` proves and what is only a node's word. Anything that fails a check is treated as a lying node and the next node is tried.

| Field | Status | How |
|---|---|---|
| `raw` | verified | Hashes to the requested txid |
| tx is in the block | verified (`proof.merkle`) | Whole block fetched by claimed hash; merkle root recomputed from every txid and compared with the header; tx must be in it |
| `height` | verified (`proof.merkle`) | The block's coinbase (DIP4 payload, which Core requires to equal the block height; BIP34 fallback) is merkle-proven into the header |
| `blockHash` | verified with the X11 verifier (`proof.blockHash`), else claimed | `X11(header)` equals the claimed hash |
| `chainLocked: 'verified'` | verified | Header chain from the tx block up to a ChainLocked block, every link X11-hashed and compared with the next `prevHash`; BLS-valid CLSIG on that block from the exact quorum Core's `SelectQuorumForSigning` picks at `height - 8` (see below) |
| `confirmations` | claimed | `proof.chainLock.verifiedConfirmations` is the proven lower bound |
| `chainLocked: 'claimed'` / `'no'` | claimed | The node's `isChainLocked`, when the proof could not be completed (reason in `proof.notes`: no verifier, newest ChainLock older than the block, block deeper than `maxHeaderSpan` (2000), signature not accepted, SML disagreement) |
| `instantLocked` | **claimed** | ISDLOCKs are parsed, not verified (needs the rotating LLMQ_60_75 by `cycleHash`); a node's IS flag also differs between nodes |

What the ChainLock proof rests on: the quorum public keys come from the SML, which is accepted when **>= 2 of 3 randomly chosen nodes return identical
content**. That is not an authenticated SML: it does not recompute `merkleRootMNList`/`merkleRootQuorums` or check proof-of-work, so an attacker who
controls the nodes you reach (eclipse) can present a consistent fake SML and a fake chain. It does stop a single lying or buggy node, which is what the
random node pool exposes you to. Header chains are checked for linkage, not for proof-of-work. Pin the quorum keys or run your own node (point
`nodes` at it) if the threat model is an eclipse.

Other claims: `getBestBlockHeight` is one synced node's word. `broadcastTransaction` returns after one node accepts (or says it already has) the tx; the
returned txid is checked against the local one, but "already in mempool" is the node's word, so confirm propagation with the watcher or a second node.

### ChainLock quorum selection (matches Dash Core)

Source tree `/Users/pasta/workspace/dash` at `f35a24cfca12`. `src/chainlock.ts` ports it; `chainLockCandidateSets` implements the part Core hides in its chain index.

| Rule | Core |
|---|---|
| Signing type per network (mainnet LLMQ_400_60, testnet LLMQ_50_60) and their params (DKG 288 / window 20..28 / 4 active; 24 / 10..18 / 24) | `chainparams.cpp:286`, `:489`; `llmq/params.h:406-425`, `:354-372` |
| A ChainLock at height h is verified against the quorums of block `h - 8` | `llmq/quorumsman.h:210` (`SIGN_HEIGHT_OFFSET`), `quorumsman.cpp:711-722` |
| `requestId = sha256d(0x05 "clsig" h_le32)` | `chainlock/clsig.cpp:27`, `:248-251` |
| Non-rotating types: scan the newest `signingActiveQuorumCount` quorums, score = `sha256d(type u8 \|\| quorumHash \|\| requestId)`, **lowest wins** (memcmp order of the raw hash) | `quorumsman.cpp:758-773` |
| Sign hash = `sha256d(type \|\| quorumHash \|\| requestId \|\| blockHash)`; all hashes in wire (internal) order | `llmq/signhash.cpp:14-24`, `clsig.cpp:259,269` |
| The scanned set is the newest N commitments **mined at or before a store block**; the store block is `h - 8` only inside a DKG mining window, otherwise the end of the previous/this cycle's window | `quorumsman.cpp:170-196`, `llmq/blockprocessor.cpp:687-730` |
| The SML's `newQuorums` are the newest N mined as of the SML tip, in `(type, hash)` order, with **no mined height** | `evo/smldiff.cpp:31-67` |

So the client resolves each signing-type quorum's base-block height (one `getBlock(hash)`, read from the coinbase, cached) and applies the window rules: a
quorum whose base block is at `c` is mined in `[c + 20, c + 28]`, which decides membership exactly except while the store block sits inside that window. Then
two candidate sets are possible (with and without the newest quorum) and each is tried: **only rank 0 of a set counts** (the spike accepted the top 3).
`exact: true` means the signing quorum is the one Core would pick. When the tip SML lacks an older quorum Core's set would include (ChainLocks at
heights `C+8 .. C+27` of a cycle, checked with an SML taken after that cycle's window), it falls back to "any known quorum of the set", still a real
quorum signature, and reports `exact: false`. A ChainLock newer than the SML triggers one forced SML refetch (`stale-sml`).
Unit tests sign synthetic locks with real BLS keys through every branch; the real mainnet CLSIG fixture verifies as `exact: true`.

## Bundle size (esbuild `--minify`, browser; `npm run size`, numbers in `test/sizes.json`)

| Bundle | raw KB | gzip KB | brotli KB |
|---|---|---|---|
| `createDapi`, **initial load** (pool, failover, budget, grpc-web, protobuf, sha256, tx parser, broadcast) | 23.8 | **9.8** | 8.6 |
| lazy: verified reads + ChainLock rules | 5.4 | 2.3 | 2.1 |
| lazy: SML agreement, SML/CBOR parsing | 5.5 | 2.6 | 2.3 |
| lazy: deposit watching, bloom, mergeStreams | 5.1 | 2.5 | 2.3 |
| `createDapi` + every lazy chunk | 39.8 | 15.8 | 14.0 |
| `DapiCore` alone | 7.9 | 3.4 | 3.0 |
| `@govhub/dapi/bls` (noble bls12-381; separate entry) | 75.0 | **27.5** | 24.1 |
| `@govhub/dapi/x11` (separate entry) | 95.2 | **40.5** | 29.9 |
| everything: barrel + bls + x11 | 207 | 82.1 | 66.0 |

The target was <= 12 KB gzipped without BLS: the initial chunk is 9.8 KB; the helpers add 6 KB when first used (15.8 KB total). The spike's 9.0 KB covered the
primitives only; verification, pool, SML agreement and watching are the difference. Dynamic imports only split if the bundler splits (Vite/Rollup/esbuild with
`splitting`). The initial figure is measured from `client.ts`; esbuild ignores `"sideEffects": false` for relative imports, so importing the barrel with
esbuild pulls every export in (17.0 KB), while Rollup/Vite honour the flag for `@govhub/dapi`. For comparison (spike): the official stack is 7.0 MB gzipped.

## X11: evaluated, vendored

`@dashevo/x11-hash-js` 1.0.2 (MIT, published by the Dash org in Jan 2026, pure JS, the implementation dashcore-lib ships) is the only maintained candidate; the
other, `wasm-x11-hash` 0.0.2, has not been updated since 2022 and is 300 KB. Evaluation:

- **Correct**: hashes the Dash mainnet genesis header to `00000ffd...ab6`; real headers at heights 1, 100000, 500000, 1000000, 1500000 and 2000000 each equal the next header's `prevHash`;
  a 41-header streamed chain links end to end; 758-header chains verify live.
- **Fast**: 0.49 ms/header in Node, 0.38 ms in headless Chromium (a 758-header proof costs ~0.3 s of hashing).
- **Large** (40.5 KB gzipped, mostly the Groestl/SIMD tables), which is why it has its own entry point rather than being in the client.
- **Broken in every ES-module bundle** (found by the live browser test): `groestl.js`, the only file without `'use strict'`, reads `this.hi` inside a plain function. In sloppy
  mode `this` is `globalThis` and the value is masked away; in strict ESM output it throws `Cannot read properties of undefined (reading 'hi')`. The fix is `x.hi`,
  which cannot change a hash.

So `src/vendor/x11/` is the package converted to ES modules by `scripts/vendor-x11.mjs` (pinned `1.0.2` as a devDependency, the script refuses to run if the buggy line is gone),
with that one fix. `test/x11-vendor.test.ts` proves the vendored copy equals the original for all ten stages and the full digest over 11 input lengths. Writing X11 from the
sphlib C sources (`/Users/pasta/workspace/dash/src/crypto/x11`) was the fallback and was not needed.

## Tests

- **Offline** (`npm test`, 159 tests, ~3 s): codecs (protobuf, grpc-web framing, CBOR against RFC 8949 vectors, BIP37 bloom against Bitcoin Core's `bloom_tests` vectors), parsers and
  X11 on **recorded mainnet data** (`test/fixtures/recorded.json`, written by `scripts/record-fixtures.mjs`: a block, a 41-header chain, a real CLSIG, a trimmed SML with its
  quorum base blocks, ISDLOCKs with their txs, a merkleblock; no secrets), grpc-web against a real local socket, and the whole client against `test/fake-dapi.ts`, a fake
  DAPI gateway installed over `fetch` that speaks real grpc-web and protobuf (lying nodes, dead nodes, slow nodes, 429/5xx, aborts, hedging, dedupe, replacement,
  the 150/min budget). `broadcastTransaction` is exercised only here, against mocks.
- **Live** (`npm run test:live`): `test/live/run.mjs` bundles `test/live/page.ts`, serves it from `http://localhost:<port>` (started and stopped by the harness, foreground),
  drives headless Chromium and checks, against live mainnet: CORS bootstrap from the quorum service, `getVerifiedTransaction` on the governance collateral tx (758+
  confirmations, `verified`, exact quorum) and on a recent tx and coinbase, NOT_FOUND, SML agreement, node-list refresh, the watcher with no deposit / a positive control / the IS-lock
  path, the request budget, and that no request is left in flight. Read-only; nothing is ever broadcast. Last run: 18/18 (`test/live/results.json`, Chromium 156).
  The IS-lock check waits for live mainnet traffic (30-120 s depending on activity).

Observed latencies (Chromium, random nodes): bootstrap + first height 0.7-1.3 s; `getVerifiedTransaction` of a 758-confirmation tx 3.5-6 s warm and up to ~20 s when the first node is
slow or the SML must be fetched cold (the first SML message is 1.4 MB and its tail is heavy: 22 s observed from slow nodes); a recent tx 3-5 s; watcher ready in 1-2.5 s.
Prefetch with `dapi.getSml()` at startup if the first verification should be fast.

## FINDINGS

Additions to the spike's findings 1-13 (README of `spikes/dapi-browser`). Items 13's gaps are closed by this package: stream idle timeouts (default on), Core-accurate quorum selection, X11.

14. **`@dashevo/x11-hash-js` throws in strict-mode/ES-module bundles** (`groestl.js` `this.hi`), so it is unusable from Vite/Rollup/esbuild output until patched. Vendored with the fix; worth an upstream issue.
15. **SML `newQuorums` carry no mined height and are ordered by `(type, hash)`**, not by age. Exact ChainLock selection needs each quorum's base-block height: `getBlock({hash})` works with the display-order hash string and the coinbase's DIP4 payload gives the height.
16. **Quorum membership is decided by mining windows**: a LLMQ_400_60 quorum's base block is a multiple of 288 and its commitment is mined in `[c+20, c+28]`; the set Core scans can only change in those blocks. From a tip SML, ChainLocks for heights in the first ~20 blocks of a cycle (+8 offset) cannot be verified *exactly* (the older quorum has left the SML) and ChainLocks inside a window are ambiguous between two sets.
17. **A claimed tx height is verifiable for free**: the coinbase is in the block you already parse for the merkle check, and Core forces its payload height to equal the block height. Only the block *hash* needs X11.
18. **The IS flag in `getTransaction` is node-local**: the governance collateral tx reported `isInstantLocked: true` in the spike run and `false` from the nodes this package asked. Treat it as a hint.
19. **SML first-message latency has a heavy tail** (1-2 s typical, 22 s seen). Agreement over 3 nodes waits for the 2nd-fastest, so `getSml` hedges two more nodes after 6 s; the SML is cached 5 min and shared between concurrent callers, and a caller's abort no longer cancels the shared fetch.
20. **Bad-certificate and dead nodes are normal in the SML node list**: 4 of 35 hosts in one run failed TLS (`ERR_CERT_DATE_INVALID`, `ERR_CERT_COMMON_NAME_INVALID`, `ERR_CONNECTION_REFUSED`), none of them fatal; the watcher replaced them without losing its 3 live streams.
21. **Block heartbeats are the only liveness signal on a bloom stream** and arrive every 2.5 min on average with exponential gaps, so the idle timeout must be generous (15 min) or healthy streams churn and burn replacements.
22. **The SML diff also carries `quorumsCLSigs`** (29 entries at the tip) and the coinbase (`cbTx`, `cbTxMerkleTree`). They would allow authenticating the quorum list against a block header, not used here (needs an anchor and PoW checks).
23. Not covered: Firefox/WebKit, IS-lock BLS verification, SML authentication (recomputing `merkleRootMNList`), proof-of-work on streamed headers, testnet (`network: 'testnet'` selects the LLMQ_50_60 parameters and the testnet node-list URL from Core's tables, but neither the tests nor the live run exercise it), and `getEstimatedTransactionFee`.

## Layout

```
src/            index.ts (client + building blocks)   bls.ts   x11.ts   vendor/x11 (generated)
                client.ts (pool, failover, broadcast)  verified.ts  agreed-sml.ts  watch.ts  (lazy modules)
                chainlock.ts (Core's rules)  dash.ts (parsers)  sml.ts  cbor.ts  bloom.ts  pb.ts  grpcweb.ts  core.ts  pool.ts  race.ts  nodes.ts
test/           *.test.ts (vitest)   fake-dapi.ts   fixtures/   live/ (Playwright harness, results.json)   sizes.json
scripts/        record-fixtures.mjs   size.mjs   vendor-x11.mjs
```
