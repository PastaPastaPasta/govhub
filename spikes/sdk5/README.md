# Phase 0 spike: evo-sdk 5.x, v1 contracts, costs

Everything below was produced by the scripts in `scripts/` on 2026-10-23/24 and is stored in
`results/*.json`. Nothing secret is in this directory: spike key material lives in
`~/.local/share/govhub-phase0/testnet/state.json` (mode 0600, outside the repo).

**Testnet runs protocol 14, mainnet protocol 13.** Every testnet fee below is therefore *indicative* of
PV13, not exact. Contract-registration fees are identical in the PV13 and PV14 fee schedules (checked in
`rs-platform-version`: `data_contract_registration` v2 vs v3 differ only in a token-distribution fee).

## Run it

```bash
npm install                      # npm_config_cache=$TMPDIR/npm-cache in the agent sandbox
npm run validate                 # contracts: wasm-dpp 4.1.1@13, rc.8@13, rc.8@14 + evo-sdk, negative controls (offline)
npm run validate:docs            # every document type: max / min / over-limit / state-transition round trip (offline)
npm run mainnet-read             # evo-sdk 5.0.0-rc.8, read-only, mainnet (network)
npm run testnet-read             # same on testnet
npm run bundle-size              # 4.1.1 vs 5.0.0-rc.8 browser chunk sizes
npm run estimate                 # offline SDK fee estimates (PV14)
npm run testnet:identity         # fund wallet + create the owner / u3 / u6 identities (resumable)
npm run testnet:topup -- owner 20000000
npm run testnet:keys-add         # add keys 3-5 to the 3-key identity with one update
npm run testnet:costs            # register contracts, every document type, replace + delete, cost per op
npm run testnet:badge-r2         # re-register `badge` after the mnBadge index change
npm run testnet:queries          # every documented query shape, with proofs
```

(`vite-node` instead of `tsx`: tsx cannot open its IPC socket in the sandbox, and evo-sdk has no CJS
exports.) Packages are installed twice under aliases: `evo4`/`dpp4` = 4.1.1, `evo5`/`dpp5` = 5.0.0-rc.8.

## 1. Validation results

### 1.1 Contracts (`npm run validate`)

All four contracts pass on all six engine/version combinations. Cells show the size of the
`DataContractCreate` state transition.

Two engines are used because **the evo-sdk `new DataContract({ fullValidation: true })` does NOT run the
meta-schema or the index limits** (it accepted an indexed string with `maxLength: 100`, a `refersTo` keyword at
PV13 and a `-` in a property name at PV14 in both 4.1.1 and 5.0.0-rc.8). The real checks live in
`@dashevo/wasm-dpp` (`dataContract.create`, `createFromObject`, `stateTransition.createFromBuffer`), so
that is what `npm run validate` treats as authoritative; evo-sdk (the engine the app ships) must additionally accept the contracts.

| contract | wasm-dpp 4.1.1 @PV13 | wasm-dpp rc.8 @PV13 | wasm-dpp rc.8 @PV14 | evo-sdk 4.1.1 @PV13 | evo-sdk rc.8 @PV13 | evo-sdk rc.8 @PV14 |
|---|---|---|---|---|---|---|
| gov | PASS (4267 B) | PASS (4267 B) | PASS (4270 B) | PASS (4266 B) | PASS (4266 B) | PASS (4269 B) |
| forum | PASS (5959 B) | PASS (5959 B) | PASS (5962 B) | PASS (5958 B) | PASS (5958 B) | PASS (5961 B) |
| badge | PASS (2530 B) | PASS (2530 B) | PASS (2533 B) | PASS (2529 B) | PASS (2529 B) | PASS (2532 B) |
| mod | PASS (720 B) | PASS (720 B) | PASS (723 B) | PASS (719 B) | PASS (719 B) | PASS (722 B) |

Negative controls (all behave as expected on wasm-dpp): indexed string `maxLength` 100 (rejected,
"should be less or equal 63"), indexed byteArray `maxItems` 300 (rejected, "<= 255"), 11 indexes in one type
(rejected, meta-schema max 10), `refersTo` (rejected at PV13, accepted at PV14), typed array (rejected at PV13,
accepted at PV14), `-` in a property name (accepted at PV13, rejected at PV14), unknown keyword (rejected).
A lint in the same script re-checks the brief's rules (<=10 indexes, indexed string <= 63 / byteArray <= 255,
field <= 5120, no PV14-only keywords, contiguous `position`s, indexed properties required).

Yappr's published passkey-vault contract is *not* valid on PV13 as shipped (`type: "bytes"`, `refersTo`,
doctype `immutable`); the `vault` type here is its PV13 translation.

### 1.2 Documents (`npm run validate:docs`)

For each of the 19 types a MAX document (every field at its bound), a MIN document (required fields only), one
over-limit variant per bounded field (must be rejected), and a batch-state-transition round trip with full validation, on
wasm-dpp 4.1.1@PV13, rc.8@PV13 and rc.8@PV14: **all pass**. Largest transition: `forum.proposalPost` with
`b0+b1+b2` = 15,360 B, 16,795 B (limit 20,480). (`$createdAtCoreBlockHeight` cannot be set through the legacy
wasm-dpp document API, so the badge types are validated without that required system field; the testnet round
created them with it.)

## 2. Mainnet read results (evo-sdk 5.0.0-rc.8, `EvoSDK.mainnetTrusted()`, PV13)

Chain: Drive/DAPI 4.1.1, Tenderdash 1.7.0, `protocol.drive.current = 13`, height 457,606, epoch 86
(`results/mainnet-read.json`). Every step succeeded (`problems: none`); every read used the `*WithProof` variants.

| Item | Result |
|---|---|
| `sdk.version()` before `connect()` | throws "SDK is not connected" (use after `connect()`) |
| `sdk.version()` after `connect()` | **13** |
| `sdk.version()` after the first proven query | **13** (response metadata `protocolVersion` 13, so it stays at 13) |
| `import('evo5')` / `ensureInitialized()` | 78 ms / 70 ms (Node, warm disk cache) |
| `connect()` | 143 ms (stored run; 63-115 ms in earlier runs, console only) |
| first proven query (DPNS contract, 4,391 B GroveDB proof, 96 B BLS signature, quorum type 4) | 505 ms (stored run; 934 and 522 ms in earlier runs, console only); second identical query 384 ms |
| DPNS contract | `GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec`: types `domain`, `preorder`; contested unique index `parentNameAndLabel`; also `identityId` |
| domain documents (`normalizedParentDomainName == dash`, `normalizedLabel startsWith a`, limit 5) | 5 docs, 433 ms, 3,676 B proof |
| identity by DPNS name | `resolveName('a-i.dash')` -> `3oMtyUvy...CcTg` in 139 ms; `identities.fetchWithProof` 168 ms (6 keys, balance 2,710,690,340 credits = 0.0271 DASH), 2,945 B proof; reverse `username(id)` = `six.dash` |
| active contested polls | `votePollsByEndDate(startTimeMs: now, orderAscending)` -> 20 buckets, 179 ms |
| one active contest | `d1manger` (ends 2026-10-25): 1 contender (`FT4zisiU...DE7Ss`), `voteTally` 44, abstain 0, lock 0, no winner; state 168 ms with a 2,647 B proof |
| voters | `contestedResourceVotersForIdentity` returned ProTxHashes (5 of the first page), 167 ms |

No 5.x-on-PV13 read problems. Quirks found (details in section 6): `dpns.getUsernameByName` does not homograph-convert
its input; `sdk.version()` throws before connect.

## 3. Testnet read results (same script, PV14)

Drive/DAPI 5.0.0-rc.8, `protocol.drive.current = 14`, height 641,457 (`results/testnet-read.json`). Every step succeeded (`problems: none`).

| Item | Result |
|---|---|
| `sdk.version()` after `connect()` -> after first proven query | **13 -> 14** (ratchets up from the proof metadata; on mainnet the same sequence stays at 13) |
| import / init / connect / first proven query / warm | 77 / 71 / 122 / 246 / 188 ms |
| contests | no active DPNS contest on testnet (the only poll is an `electedCharter`); the finished contest `000` (winner `9idHpqmf...`, decided 2025-03-07) was read instead |

## 4. Bundle size (`npm run bundle-size`, vite/rollup, lazy `import()` of the SDK, minified)

| | raw | gzip -9 | brotli -11 | wasm inside |
|---|---:|---:|---:|---:|
| evo-sdk 4.1.1 | 9,974,495 B (9.51 MiB) | 7,169,532 B (6.84 MiB) | 7,123,749 B | 20,319,523 B |
| evo-sdk 5.0.0-rc.8 | 12,649,283 B (12.06 MiB) | 9,096,314 B (8.67 MiB) | 9,039,813 B | 26,513,399 B |

The 5.x chunk is +27% over 4.1.1 (PLAN section 10's "~12.6 MB" is exact in decimal MB). The WASM is stored compressed inside the JS
and inflated at start-up, so the wire size is the gzip/brotli figure.

## 5. Testnet writes (costs)

Funding: `faucet.thepasta.org` answered **HTTP 429 `Rate limit exceeded`, `retryAfter` ~1,380 s,
`requiresHardCaptcha: true`** to the first request of this run (CAP solved in 4-9 s, then 429), so the documented
fallback was used: 1.5 tDASH moved from the EvoVote QA wallet (an Insight UTXO query showed it held 91.99999 tDASH; not stored in `results/`) to the spike wallet. The faucet was
not retried and the hard-CAP route was not used.

Method note: balance reads come from a random DAPI node and a node can lag a block, so a naive before/after read
attributed fees to the wrong operation in the first pass (round 1, discarded; `results/testnet-costs.json` `round1`). The reported round 2
takes each op's *settled* balance as the next op's "before", polls until the balance moved and two consecutive reads agree, and retries
a lagging node's `40101 not found`. Delete rows are *negative* because the storage refund exceeds the processing fee.

### 5.1 Identities: 3 vs 4 vs 6 keys

| identity | keys | layout | locked (credits) | create fee (credits) | create fee (DASH) | id |
|---|---:|---|---:|---:|---:|---|
| u3 | 3 | 0:authentication/master, 1:authentication/critical, 2:authentication/high | 1,999,500,000 | 106,495,300 | 0.00106495 | `4eYvJ1QzRxFy82CRK3tP5QHmdRcgkG8xdbGBQMqSroif` |
| u6 | 6 | 0:authentication/master, 1:authentication/critical, 2:authentication/high, 3:transfer/critical, 4:encryption/medium(bound contactRequest), 5:decryption/medium(bound contactRequest) | 1,999,500,000 | 181,740,860 | 0.00181740 | `4TEp8FeD7iMD9nKMGBK492ZnbESdwFPPXtvjRA6Zrxhv` |
| owner | 4 | 0:authentication/master, 1:authentication/critical, 2:authentication/high, 3:transfer/critical | 124,999,500,000 | 122,046,520 | 0.00122046 | `9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv` |


`u3` and `u6` were locked with the same 0.019995 DASH, so the difference is purely keys: **6 keys cost 75,245,560 credits
(0.00075246 DASH, +71%) more than 3**. The DashPay-layout extras (transfer + the two contactRequest-bound ENC/DEC keys)
are the whole delta. Adding the same three keys to `u3` *afterwards* with one identity update cost **73,997,220 credits
(0.00073997 DASH)**: deferring them postpones the payment, it does not reduce it.

| Other identity operations | credits | DASH |
|---|---:|---:|
| top-up from a fresh asset lock (owner, 0.19999500 DASH locked) | 8,003,660 | 0.00008004 |
| credit transfer owner -> u6 (net fee, amount excluded) | 2,970,340 | 0.00002970 |
| add 3 keys to a 3-key identity (one update) | 73,997,220 | 0.00073997 |

Create-identity wall time 1.6-2.0 s once the asset lock is ChainLocked (chain proofs; the lock itself needed one block, ~1.5-2 min).

**Starter credit (PLAN 4.3, 0.003 DASH = 300,000,000 credits):** after a 3-key identity (106.5 M) 193.5 M remain = ~3 comments of 280
characters or ~3 first-time reactions; after the 6-key layout (181.7 M) only 118.3 M remain = ~2 comments. "An identity plus a few documents" holds
for <= 4 keys; with the DashPay 6-key layout it is "plus two".

### 5.2 Contracts registered on testnet (owner `9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv`)

| contract | testnet id | types | indexes | fee formula (DASH) | measured total (DASH) | read-back identical |
|---|---|---:|---:|---:|---:|---|
| `gov` | `3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ` | 4 | 6 | 0.24000000 | 0.00000000 | yes |
| `forum` | `HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw` | 10 | 13 | 0.43000000 | 0.43299794 | yes |
| `badge` | `3SrZbofJnMgWNiHFzpHc5u7wSRgCFJykZwKq3haqyMfc` | 4 | 4 | 0.22000000 | 0.22138244 | yes |
| `mod` | `CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY` | 1 | 2 | 0.14000000 | 0.14058642 | yes |


Fee formula = 0.1 DASH + 0.02 per document type + 0.01 per index (unique or not); the measured totals are the formula plus a small
storage/processing charge that scales with the contract size (forum +0.00300, mod +0.00059, badge +0.00138). The `gov` registration
delta (and the first `badge`, which was superseded by the re-ordered `mnBadge` index) came from a lagging node and read 0; modelling the
overhead from the other three gives `gov` ~0.2422 DASH. **Mainnet registration of all four v1 contracts is therefore ~1.04 DASH** (0.24 + 0.43 + 0.22 +
0.14 + ~0.007 storage), and every later document type costs 0.02 + 0.01 per index. The `badge` row is the second registration (nonce 7). Round 2 of the cost script repeated the credit transfer (nonce 6) before it, so the nonces run 1 (transfer), 2-5 (four contracts), 6 (second transfer), 7 (badge re-registration); one earlier attempt of the badge re-registration crashed with an unhandled `WasmSdkError` (message not captured) and charged nothing. The first `badge` contract
`38xNhUdbPSzFgpUA8JjLd6xcqqRo2e8K3BkqiVXqzRy3` (old `mnBadge` index) is superseded and kept only for the cost round.

### 5.3 Document operations (round 2, one op at a time, signed with a HIGH key unless noted)

SDK estimate = `documentCreateCost(..., 14)` total credits for "every index value new" / "every index value already stored". **The estimate is not a bound**: across the 29 measured creates the
actual/"new" ratio is 0.60-1.30 (median 0.83) and actual/"known" 0.74-1.54; 2 creates cost more than "new" (`profile`, 384 B `mnBadge`) and 14 cost less than "known". The estimator **throws at platform version 13** in 5.0.0-rc.8 (`drive unknown version on document_create_cost`), so there is no
client-side fee estimate for PV13 mainnet.

| contract.type | op | doc / detail | credits | DASH | SDK estimate PV14 (new / known index values) |
|---|---|---|---:|---:|---|
| gov.proposal | create | A | 79,233,280 | 0.00079233 | 0.00084026 / 0.00065769 |
| gov.proposal | create | B | 79,768,020 | 0.00079768 | 0.00084026 / 0.00065769 |
| gov.tally | create | A | 25,056,460 | 0.00025056 | 0.00026326 / 0.00026326 |
| gov.tally | replace | A - (tally refresh) | 2,557,440 | 0.00002557 | - |
| gov.tally | create | B | 25,210,460 | 0.00025210 | 0.00026326 / 0.00026326 |
| gov.cycle | create | A | 21,929,240 | 0.00021929 | 0.00022778 / 0.00022778 |
| gov.cycle | replace | A | 2,486,740 | 0.00002487 | - |
| gov.claimAttestation | create | A | 28,873,660 | 0.00028874 | 0.00030054 / 0.00023018 |
| gov.proposal | delete | B | -46,724,900 | -0.00046725 | - |
| gov.tally | delete | B | -19,650,700 | -0.00019651 | - |
| forum.profile | create | A | 33,121,580 | 0.00033122 | 0.00025536 / 0.00025536 |
| forum.profile | replace | A | 2,940,860 | 0.00002941 | - |
| forum.comment | create | A - 280 chars | 56,175,700 | 0.00056176 | 0.00066688 / 0.00039381 |
| forum.comment | create | B - 50 chars, reply | 42,925,560 | 0.00042926 | 0.00060336 / 0.00033029 |
| forum.comment | create | C - 1000 chars | 68,134,040 | 0.00068134 | 0.00089440 / 0.00062133 |
| forum.comment | create | D - 5000 chars (max) | 178,395,000 | 0.00178395 | 0.00215840 / 0.00188533 |
| forum.reaction | create | A - community up-vote on proposal | 50,109,000 | 0.00050109 | 0.00061584 / 0.00034102 |
| forum.reaction | replace | A - flip to down | 3,207,060 | 0.00003207 | - |
| forum.reaction | create | B - second target | 50,242,940 | 0.00050243 | 0.00061584 / 0.00034102 |
| forum.claim | create | A | 35,775,120 | 0.00035775 | 0.00036889 / 0.00023235 |
| forum.proposalPost | create | A - b0 1500 B | 79,229,560 | 0.00079230 | 0.00084879 / 0.00075023 |
| forum.proposalPost | replace | A - add b1 2500 B | 73,999,400 | 0.00073999 | - |
| forum.proposalPost | create | MAX - MAX: b0+b1+b2 = 15360 B + title/links | 491,364,200 | 0.00491364 | 0.00557994 / 0.00548138 |
| forum.proposalDraft | create | A | 63,253,360 | 0.00063253 | 0.00076642 / 0.00051038 |
| forum.proposalDraft | replace | A - stage 1 -> 2, + collateralTxid | -3,211,103 | -0.00003211 | - |
| forum.blockSubs | create | A - 3 lists | 25,187,660 | 0.00025188 | 0.00026263 / 0.00026263 |
| forum.blockSubs | replace | A - 5 lists | 4,525,580 | 0.00004526 | - |
| forum.settings | create | A - 600 B deflated JSON | 39,318,280 | 0.00039318 | 0.00042221 / 0.00042221 |
| forum.settings | replace | A - 900 B | 11,507,700 | 0.00011508 | - |
| forum.vault | create | A | 29,693,500 | 0.00029694 | 0.00049220 / 0.00040101 |
| forum.vault | replace | A | 3,338,620 | 0.00003339 | - |
| forum.comment | delete | B | -22,129,275 | -0.00022129 | - |
| forum.comment | delete | C | -45,118,132 | -0.00045118 | - |
| forum.comment | delete | D | -153,454,092 | -0.00153454 | - |
| forum.reaction | delete | B | -43,185,272 | -0.00043185 | - |
| forum.proposalPost | delete | MAX | -464,960,217 | -0.00464960 | - |
| forum.block | create | A | 22,541,040 | 0.00022541 | 0.00031175 / 0.00023371 |
| badge.issuerKey | create | A - RSA-2048 SPKI 294 B, CRITICAL key | 30,532,980 | 0.00030533 | 0.00039981 / 0.00031973 |
| badge.issuerKey | create | B - RSA-4096 SPKI 550 B | 37,554,100 | 0.00037554 | 0.00048071 / 0.00040063 |
| badge.issuerRevocation | create | A - CRITICAL key | 21,015,200 | 0.00021015 | 0.00029743 / 0.00021735 |
| badge.issuerReport | create | A | 20,169,600 | 0.00020170 | 0.00028731 / 0.00020724 |
| badge.mnBadge | create | A - RSA-2048 sig 256 B | 30,124,180 | 0.00030124 | 0.00047927 / 0.00033799 |
| badge.mnBadge | create | B - sig 384 B (u6) | 58,261,980 | 0.00058262 | 0.00051972 / 0.00037844 |
| mod.block | create | B | 37,914,380 | 0.00037914 | 0.00048751 / 0.00031908 |
| mod.block | delete | B | -19,574,449 | -0.00019574 | - |
| mod.block | create | A | 36,779,740 | 0.00036780 | 0.00048751 / 0.00031908 |


Doc letters: A/B are the first/second document of that type created in the round (`MAX` = maximum-size post). A replace that moves a document between index values can be net-negative (`proposalDraft` stage 1 -> 2: the now-empty `stage = 1` tree is refunded, plausibly more than the processing fee).

Notes: `badge.issuerKey`/`issuerRevocation` are signed with the CRITICAL key (key 1); gov, mod and the badge issuer documents were created by `owner`; forum documents by `u3`
except the one-per-owner types (`profile`, `blockSubs`, `settings`), which `u6` created because `u3` already held its singletons from round 1; `mnBadge` A by `u3`, B by `u6`.
Each op took 1.4-3.6 s end to end; 4 of 46 took 5-10 s. In the fresh `badge` contract the first documents cost more (new trees):
`issuerKey` 37.6 M, `issuerRevocation` 28.6 M, `issuerReport` 27.8 M, `mnBadge` 54.2 M / 43.8 M (384 B sig) / 37.9 M credits.

Cost per byte is visible in `comment`: 50 / 280 / 1,000 / 5,000 characters = 0.00043 / 0.00056 / 0.00068 / 0.00178 DASH (~27 k credits per stored byte, 
as the SDK states). A reaction costs as much as a comment on its first use of a target (0.0005 DASH), but flipping it is 0.00003. A `tally` refresh
(replace) is 2.56 M credits = 0.0000256 DASH: hourly for 30 active proposals is 0.018 DASH/day, in line with PLAN 6.2's 0.015 DASH/day estimate.

### 5.4 Query shapes (`npm run testnet:queries`)

46 of 46 documented shapes return documents with proofs (56 probes in total, `results/testnet-queries.json`). The check is `count > 0` (G3, F10b, M1c are marked `any`),
plus an explicit ordering assertion on the 4 probes that returned >= 2 documents (G2, F3, F3a, M1b: `order ... verified`); the 6 negative probes
(`reject: true`: X0, X1, X2, X2c, X2d, X3) assert a rejection and all were rejected. Weak spots: most shapes only return one document, so they prove the query is accepted and
selects the right row, not ordering; `desc` ordering on `comment` by proposal (F2c) and paging beyond one document were checked only on `$ownerId` queries (F3p1/p2). All shapes and the rules behind them are in `packages/contracts-v1/README.md`.

## 6. FINDINGS that contradict or refine PLAN

1. **PLAN 3.1 `mnBadge` index `unique [$ownerId, issuerId, epoch]` cannot serve the reader flow.** Drive allows an `in` clause only on the last (or
   second-to-last) index property (`Index::matches`, identical in 4.1.1 and rc.8); `$ownerId in [...]` on the first of three properties fails ("query must be
   for valid indexes"; probed as `X2d` on the superseded testnet contract `38xN...` that still has the PLAN order). Changed to `unique [issuerId, epoch, $ownerId]` (same uniqueness), which makes "which of these 100 authors hold a badge from
   issuer I in epoch E" a legal equality-prefix + `in` query. Re-registered on testnet and verified (B4). PLAN 8.6 and 11 should use this order.
2. **Contract registration is ~1.04 DASH for the four v1 contracts** (formula above) and a similar amount again for v2 on PV14. Not in the plan; budget it, and note that
   adding a type later costs 0.02 + 0.01 per index plus an update fee.
3. **Per-action costs are 0.0002-0.0008 DASH for small documents** (0.0049 for a maximum-size `proposalPost`; a first reaction ~0.0005, same as a comment; a proposal publish ~0.0008). Community up/down voting on 30 proposals = ~0.015 DASH
   for a user, i.e. five times the 0.003 DASH starter credit. Reactions are not "cheap" until PV14 `indexOnly` reactions; consider whether v1 should offer them at all or only
   as "a few votes per starter".
4. **evo-sdk `fullValidation` is not a validator** (no meta-schema, no index limits) in 4.1.1 and 5.0.0-rc.8. PLAN section 0's "lint in CI" needs wasm-dpp (as `npm run validate`
   does) or a Rust test; the query linter must additionally encode the Drive rules in the contracts README. Also: wasm-dpp rc.8 `createFromObject` validates against the PV14 meta-schema even when
   constructed for PV13 (a `-` in a name passes `create` but fails `createFromObject`).
5. **`documentCreateCost` does not work at PV13** in 5.0.0-rc.8, so the client cannot show a fee estimate on mainnet until PV14 (use the measured table or a constant).
6. **Lagging nodes**: a balance read after an op can still show the old value (11 of 46 round-1 operations and 2 of 4 contract registrations read as a zero fee), and a follow-up transition
   broadcast through a lagging node can fail with `40101 document not found` right after the create. UI fee displays must not rely on one balance read, and
   write paths need a retry on 40101 / nonce errors (the 5.x SDK does not).
7. **`where` values for byteArray properties must be base64 strings**; a `Uint8Array` throws "invalid type: byte array, expected any valid JSON value". Identifier properties take base58.
8. `dpns.getUsernameByName` matches `normalizedLabel` without homograph conversion, so `six.dash` (normalized `s1x`) returns `undefined` while `resolveName('six.dash')` works; convert with `convertToHomographSafe` first.
9. `sdk.version()` throws before `connect()`; after `connect()` it is the network floor (13). On mainnet it stays 13 after the first proven query; on testnet it moves to 14. No PV13 read problems found with 5.0.0-rc.8.
10. **Faucet capacity**: the first request of this run got 429/`requiresHardCaptcha` with a ~23 min retry. If other agents or users share the egress IP, the PLAN's "existing limits" onboarding (3 per hour per IP) is the bottleneck, not DASH.
11. The field-size cap is in *bytes* (5,120) while `maxLength` counts characters: `comment.body` of 1,707 euro signs (5,121 B, under `maxLength` 5000) is rejected by `ExtendedDocument.validate` but `stateTransition.createFromBuffer` accepted it (wasm-dpp 4.1.1 @PV13, `validate-documents.ts`), so clients must check UTF-8 byte length themselves.
12. PLAN 8.3/8.4 is internally inconsistent: `issuerKey.spki <= 600 B` admits RSA-4096 but `mnBadge.sig` is 256 or 384 B (RSA-2048 / 3072). The contract follows the plan literally (`sig` 256..384), so a 4096-bit issuer key cannot produce a storable badge. **Decide before mainnet** (schemas are frozen): cap `spki` at 422 or raise `sig` to 512.
13. Yappr's vault `immutable: [credentialId, recipientKey]` has no PV13 equivalent; PV13 cannot prevent a replace from changing them.
14. System timestamps are overwritten by Drive with block time / core height on creation (`document_create_transition_action`), so `$createdAt` and `$createdAtCoreBlockHeight` cannot be back-dated by a client; PLAN 8.6's "readers enforce this using `$createdAtCoreBlockHeight`" is sound. The client still has to send a value for a required field.
15. **Hash byte order is undecided** (`govHash` etc.): see `packages/contracts-v1/README.md`; fix it with the gov-hash vector before the bridge publishes anything.
16. PV13 query planning breaks ties between candidate indexes by *index name*, so `reaction` `target == X` alone silently selects the gapped `byOwnerTarget` index; every query shape here therefore carries an `orderBy` that ends at the intended index's last property (contracts README, rule 1).

## 7. What was not done / blockers

- **No PV13 write network was available**: all writes ran on testnet (PV14). The phase-0 exit checks "write on mainnet PV13 with a throwaway contract" and "v1 contracts on local dashmate 4.1.1" (including the PV13 gapped-index behaviour) remain open; offline PV13 validation (section 1) is what supports the contracts until then.
- Registration cost of `gov` and of the first `badge` was not measured (stale read, see 5.2); the other three were.
- The 0.003 DASH faucet voucher, Android seed restore and browser DAPI flows are outside this task.
- Remaining testnet state: owner identity ~0.0619 DASH, u3 ~0.105, u6 ~0.036; spike wallet ~0.009 tDASH. Key material: `~/.local/share/govhub-phase0/testnet/state.json` (0600).

## Files

`scripts/validate-contracts.ts`, `validate-documents.ts` (offline) - `read-network.ts`, `bundle-size.mjs` - `chain.ts` (Insight/dashcore-lib/faucet helpers),
`testnet-identity.ts`, `testnet-topup.ts`, `testnet-keys-add.ts`, `testnet-costs.ts`, `testnet-badge-r2.ts`, `testnet-queries.ts`, `estimate-costs.ts` - `lib.ts`.
