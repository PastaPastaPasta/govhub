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
npm test -w @govhub/dapi             # offline: 214 vitest tests on recorded mainnet and testnet data
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
  verifiers: async () => {
    const { x11, x11Many } = await import('@govhub/dapi/x11');
    return { hashHeader: x11, hashHeaders: x11Many, verifyChainLock: (await import('@govhub/dapi/bls')).verifyChainLock };
  },
});

// The chain this client verifies itself (see "Anchored chain" below), cached per network through `store`:
const anchor = await dapi.anchorChain({ from: collateralHeight, store });
const tx2 = await dapi.getVerifiedTransaction(txid, { anchor });   // inclusion + depth against the verified chain
const sb = await dapi.getAnchoredBlock(anchor, 2_558_864);          // a block proven to be the one at that height

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
| `dapi.anchorChain({from, store, onProgress})` | Header chain from the pinned checkpoint (and down to `from`) to the tip with every header rule checked, SML proven into one of its blocks, newest ChainLock verified with a proven quorum; cached and extended incrementally (see [Anchored chain](#anchored-chain)) |
| `dapi.getAnchoredBlock(anchor, height)` | A block fetched by its verified hash; merkle root recomputed, header X11-hashed to that hash |
| `dapi.getProRegInfo(hashes, {cache})` | Type and collateral outpoint of masternodes, each proven by its ProRegTx (fetched by proTxHash, checked by hashing) |
| `dapi.watchAddressForDeposit(hash160, handlers, opts)` / `dapi.watchTransactions(filter, handlers, opts, match)` | Merged streams on 3 nodes; see below |
| `dapi.broadcastTransaction(raw, {allowHighFees, bypassLimits})` | Parses `raw` first, checks the node's returned txid against the local one, fails over on network errors only |
| `DapiCore(node)` | The 10 RPCs, one node, no policy: `getBlockchainStatus`, `getBestBlockHeight`, `getBlock`, `getTransaction`, `broadcastTransaction`, `subscribeToBlockHeadersWithChainLocks`, `subscribeToTransactionsWithProofs`, `subscribeToMasternodeList` |
| `parseTx/Block/Header/MerkleBlock/ChainLock/InstantLock`, `parseSml`, `decodeCbor`, `BloomFilter`, `NodePool`, `race`, `mergeStreams` | Building blocks, all exported |
| `@govhub/dapi/bls` | `verifyChainLock(cl, quorums, {network, smlHeight})`, `blsVerify` |
| `@govhub/dapi/x11` | `x11(header80)`, `x11Many(n * 80 bytes)`, `blockHashHex(header80)` (WebAssembly) |
| Pure building blocks | `HeaderChain`, `CHECKPOINTS`, `checkProofOfWork`, `nextWorkRequired`/`darkGravityWave`, `proveSml`, `smlEntryBytes`, `commitmentBytes`, `parseCbTx`, `readPartialMerkleTree`, `parseProRegTx` |

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

Without `options.anchor`, the ChainLock proof rests on quorum public keys from the SML that **>= 2 of 3 random nodes return identically**: that
stops one lying node but not an eclipse (an attacker who controls every node you reach can serve a consistent fake SML, ChainLock and chain).
With an [anchored chain](#anchored-chain) it rests on the checkpoint and proof of work instead, and `proof.anchor` says so.

### Anchored chain

`anchorChain` builds, in this order, so that nothing a node says is used before it is tied to the pinned checkpoint:

1. **Headers** from `min(from, checkpoint - 24)` to the tip (parallel chunks of 2,000 on up to 16 nodes, slow chunks hedged on a second node,
   bad chunks refetched elsewhere), hashed with X11 (WebAssembly). Below the checkpoint each header must hash to the next one's prevHash up to
   the pinned hash. Above it each header must also pass Core's header rules: nBits equals Dark Gravity Wave's value
   (`pow.cpp:81-132`, testnet's minimum-difficulty rules `pow.cpp:191-204`; `validation.cpp:4487`), the hash meets the target (`pow.cpp:239-256`;
   `validation.cpp:4310`), the time is above the median of the previous 11 (`chain.h:281-295`; `validation.cpp:4505`) and at most 2 h ahead
   (`chain.h:24`; `validation.cpp:4509`). So a node can only present a chain above the checkpoint by mining it at full network difficulty.
2. **SML**: one node's full list (no agreement round). Every entry is re-serialized to Core's consensus bytes and hashed
   (`evo/simplifiedmns.h:72-101`, `simplifiedmns.cpp:45-50`, sorted by proRegTxHash `:78-80`; legacy CService for versions 1-2, ExtNetInfo in BIP155
   form for version 3, `evo/netinfo.h:226-240, 325-333, 411-419`), every quorum commitment too (`llmq/commitment.h:95-115`, sorted hashes
   `evo/cbtx.cpp:65-150`); both roots must equal the coinbase's CbTx (`evo/cbtx.h:32-70`, versions 1-4), the coinbase must be leaf 0 of the diff's
   partial merkle tree, and that tree must hash to the merkle root of the verified header at the CbTx height. A list that fails is replaced by
   another node's.
3. **ChainLock**: the newest CLSIG, verified with Core's quorum selection against quorums from the proven SML (base heights read from the verified
   chain), on a block that is in the verified chain.
4. **Store**: hashes from `lo` to the ChainLock (never above it: a ChainLocked block is final), the last 24 headers' bits/times for DGW, and the
   checkpoint they were verified from (a different pin discards the cache). Later calls download only the missing heights, up or down.

| Fact | Status with `anchor` |
|---|---|
| a block at height h is on the chain | verified: its X11 hash equals the verified hash at h |
| confirmations | verified lower bound: verified tip - h + 1 (a node can withhold newer blocks, not invent them) |
| final | verified: h <= the BLS-verified ChainLock height |
| SML entries (voting key, validity, operator key, addresses) and quorum keys | verified against the CbTx roots |
| a version-1 entry's type | **not** in Core's SML hash (`simplifiedmns.h:89-99` serializes nType from version 2 only): prove it with `getProRegInfo` |
| collateral outpoint of a masternode | not in the SML; `getProRegInfo` proves it from the ProRegTx (type and collateral never change, `evo/specialtxman.cpp:483-485`) |

Trust assumptions that remain: the pinned checkpoint (checked by `scripts/checkpoint.mjs` to descend from Dash Core's own newest checkpoint,
`chainparams.cpp:345` mainnet / `:528` testnet, through 72,500 / 198,000 headers that pass every rule, and returned by 8 of 8 random nodes),
honest-majority hash power above it (testnet allows minimum-difficulty blocks, so its anchor is much weaker), and that the nodes you reach
show you the newest blocks at all (withholding makes heights look older, never different).

Why not the cheaper ChainLock-in-coinbase path: CbTx v3 carries `bestCLSignature` for an ancestor, but verifying it needs the quorum set active
at that height. Those keys are in `merkleRootQuorums` of blocks near it, which would themselves need anchoring first, and DAPI has no historical
quorum-list call. Walking headers is the only sound route from a recent anchor to an old block over DAPI, and with WebAssembly X11 and parallel
download it is network-bound (below).

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
| `createDapi`, **initial load** (pool, failover, budget, grpc-web, protobuf, sha256, tx parser, broadcast) | 24.5 | **9.9** | 8.7 |
| lazy: verified reads + ChainLock rules | 6.4 | 2.6 | 2.4 |
| lazy: anchoring (headers, PoW/DGW, SML proof) | 22.1 | 8.7 | 7.9 |
| lazy: SML agreement, SML/CBOR parsing | 6.0 | 2.8 | 2.7 |
| lazy: ProRegTx proofs | 1.1 | 0.7 | 0.6 |
| lazy: deposit watching, bloom, mergeStreams | 5.2 | 2.5 | 2.3 |
| `createDapi` + every lazy chunk | 65.7 | 24.6 | 21.7 |
| `@govhub/dapi/bls` (noble bls12-381; separate entry) | 75.0 | **27.5** | 24.1 |
| `@govhub/dapi/x11` (WebAssembly as inline base64 + loader; separate entry) | 140.1 | **58.9** | 47.4 |
| ...the `.wasm` alone (a separate asset would cost this) | 103.8 | 45.1 | 33.3 |
| everything: barrel + bls + x11 | 277.3 | 109.4 | 89.5 |

The initial chunk is unchanged by anchoring (9.9 KB gzipped). X11 moved from 40.5 KB of JavaScript to 58.9 KB of inline WebAssembly: +18 KB
gzipped for ~40x the speed; serving the `.wasm` as its own asset would make it 45.1 KB (not done: inline works unchanged in Node, Vite workers and
esbuild). Dynamic imports only split if the bundler splits (Vite/Rollup/esbuild with `splitting`). The initial figure is measured from
`client.ts`; esbuild ignores `"sideEffects": false` for relative imports, so importing the barrel with esbuild pulls every export in, while
Rollup/Vite honour the flag for `@govhub/dapi`. For comparison (spike): the official stack is 7.0 MB gzipped.

## X11: WebAssembly from Core's sphlib sources

`x11-wasm/` holds the sphlib C files Dash Core ships (`src/crypto/x11` at `f35a24cfca12`; `echo.c`/`shavite.c` from before Core moved them to
C++, `7e8607e1cbfd^` / `386742b5fcaa^`) and `x11.c`, the chain in Core's `HashX11` order (`hash_x11.h:44-87`). `build.sh` compiles them with
Homebrew clang (`--target=wasm32`, no libc, `-Oz`), links with rustup's `wasm-ld` and writes `src/vendor/x11-wasm.ts` (reproducible: it prints
the sha256, `0670c33c...`). The module has no imports. `src/x11.ts` instantiates it synchronously on first use (fine in workers and Node) and
offers `x11Many` for batches.

- **Correct**: equals the pure-JS `@dashevo/x11-hash-js` (kept vendored in `src/vendor/x11` as the test oracle) on 1,000 random inputs and per stage,
  hashes Core's three genesis blocks, links the recorded header chains, and drives 270,500 real headers through `scripts/checkpoint.mjs`.
  sphlib's small-footprint Groestl gave wrong digests in this build, so Groestl is always compiled unrolled (`build.sh`).
- **Fast**: 50,000 headers in 0.39 s in a headless Chromium worker (~128k headers/s, 7.8 us each), 0.43 s in Node; the JS was ~3,000/s
  (`test/x11-bench.json`, `scripts/bench-x11.mjs`).

## Tests

- **Anchoring, offline** (`chainproof.test.ts`, `anchor.test.ts`): recorded **mainnet and testnet** snapshots (`test/fixtures/anchor-*.json.gz`, written by
  `scripts/record-anchor-fixtures.mjs`: ~1,600-1,940 consecutive headers, the full SML at the tip, the newest CLSIG, the newest superblock). DGW,
  proof of work and MTP hold for every recorded header (the testnet run includes minimum-difficulty blocks); tampered bits, work, times, links and
  pins fail at the right height; both SMLs (mainnet entry versions 1-2, testnet 1-3 with ExtNetInfo, CbTx v3 and v4) reproduce their coinbase's
  roots and any changed voting key, validity, version-2 type, operator key, dropped entry or quorum key breaks them; `anchorChain` against fake nodes
  that serve this data (cold, resumed from a store, extended downward, with a lying header node and a lying SML node, and refusing when all lie).
- **Offline** (`npm test`, 214 tests, ~4 s): codecs (protobuf, grpc-web framing, CBOR against RFC 8949 vectors, BIP37 bloom against Bitcoin Core's `bloom_tests` vectors), parsers and
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
22. **The SML diff also carries `quorumsCLSigs`** (29 entries at the tip) and the coinbase (`cbTx`, `cbTxMerkleTree`): the latter two are what `anchorChain` proves the list with.
23. Not covered: Firefox/WebKit, IS-lock BLS verification, and `getEstimatedTransactionFee`. (SML authentication, proof of work on headers and testnet are covered since findings 24-31.)
24. **The SML's JSON is enough to rebuild Core's hashes exactly**, on both networks: every entry version (1-3), legacy and ExtNetInfo addresses, platform fields, CbTx v3 and v4. Core prints a version-1 entry's operator key in the legacy encoding it serializes with, and commitments' keys and signatures in their own version's encoding, so hex is used as printed. `platformHTTPPort` is printed only with `-deprecatedrpc=service`; without it the port is read from the synthesized `addresses.platform_https`.
25. **A version-1 SML entry's type is not committed**: Core serializes `nType` only from version 2 (`simplifiedmns.h:89-99`). Mainnet has 1,048 valid version-1 entries (2026-10-24), so the funding threshold's weighted count cannot be proven from the SML alone; their ProRegTxs (hash-checked) prove the type, and the collateral outpoint as a bonus.
26. **DAPI header streams run at ~1-2k headers/s per node with a heavy tail** (2 s to 30 s for the same 5,000 headers). Chunks of 2,000 on 16 nodes with a 3 s hedge bring 45,000 headers to 8.5-13 s and 72,500 to ~11 s from Node; hashing them is 0.4 s.
27. **Node's `fetch` does not end a pending body read when the request's signal aborts after the body started** (browsers do), so a stream cancelled from its own message handler hung until the idle timeout and Node exited with "unsettled top-level await". `stream()` now cancels the body reader on every abort.
28. **Testnet DAPI nodes report `isSynced: false` / status ERROR while Platform is halted**, although their Core is current: `anchorChain` falls back to a node's block count as the tip hint (everything up to it is verified anyway).
29. **Testnet runs v24**: CbTx version 4 (asset-unlock merkle root) and version-3 entries with ExtNetInfo are live there; mainnet still has CbTx v3 and versions 1-2.
30. **The pins**: mainnet 2,560,000 descends from Core's checkpoint 2,487,500 through 72,500 headers that pass every rule (10.7 s), testnet 1,578,000 from 1,380,000 through 198,000 (24.3 s); 8 of 8 random nodes returned each pinned hash.
31. **A ChainLock in a later block's CbTx (`bestCLSignature`) does not help anchor an old block**: verifying it needs that era's quorum keys, which are only provable from blocks near it. The header walk is the sound route.

## Layout

```
src/            index.ts (client + building blocks)   bls.ts   x11.ts (WebAssembly)   vendor/x11-wasm.ts (generated)   vendor/x11 (JS oracle)
                client.ts (pool, failover, broadcast)  verified.ts  anchor.ts  protx.ts  agreed-sml.ts  watch.ts  (lazy modules)
                headerchain.ts (checkpoint, verified run)  pow.ts (PoW, DGW, MTP)  smlproof.ts (SML/commitment/CbTx serialization)
                chainlock.ts (Core's rules)  dash.ts (parsers)  sml.ts  cbor.ts  bloom.ts  pb.ts  grpcweb.ts  core.ts  pool.ts  race.ts  nodes.ts
x11-wasm/       sphlib C sources, x11.c, build.sh
test/           *.test.ts (vitest)   fake-dapi.ts   fixtures/   live/ (Playwright harness, results.json)   sizes.json   x11-bench.json
scripts/        record-fixtures.mjs   record-anchor-fixtures.mjs   checkpoint.mjs   bench-x11.mjs   size.mjs   vendor-x11.mjs
```
