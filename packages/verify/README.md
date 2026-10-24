# @govhub/verify

Pure, network-free TypeScript (ESM, Node >= 22, browser-safe) verification primitives shared by the
browser, bridge, relay and audit CLI (docs/PLAN.md §2, §5.1, §6.1, §11). No I/O, no `fetch`, no timers.
Crypto: `@noble/curves` (secp256k1), `@noble/hashes` (sha256, ripemd160), `@scure/base` (base58check, base64).

Every byte format below was checked against the Dash Core source **and** against a real `dashd`
(regtest, built from this tree) and the mainnet chain. Source citations are `file:line` in
`/Users/pasta/workspace/dash`, commit `f35a24cfca12` (develop, "Merge #7807 ... evo_shares").
The `dashd` used to generate vectors was an older build of the same tree (binary dated 2026-09-22); none of the
governance code paths touched here changed in between.

```
npm install
npm test            # offline: 317 tests against the committed Core / mainnet fixtures
npx tsc --noEmit
# optional live cross-check against a running regtest node (hundreds of dash-cli calls, incl. fuzzing):
DASH_CLI="dash-cli -datadir=... -regtest -rpcport=... -rpcuser=... -rpcpassword=..." npx vitest run test/live-core.test.ts
```

## API (all exported from `src/index.ts`)

| Area | Functions |
|---|---|
| Gov hash | `governanceObjectHash({parentHash, revision, time, dataHex}) -> {raw, display}`, `governanceObjectPreimage(...)` |
| Proposal data | `parseProposalData(dataHex)`, `validateProposal(fields, network, {now?})`, `validateProposalData(dataHex, network, {now?})`, `buildProposalDataHex(fields)`, `checkUrl(url)` |
| Collateral | `checkCollateralTx(rawTx, govHashRaw, {expectedTxid?, minFeeDuffs?}) -> {valid, failure?, opReturnIndex?, tx, ...}`, `collateralScript(hashRaw)`, `parseTransaction(raw)` |
| Votes | `voteFieldsError(v)`, `voteSignatureString(v)`, `voteSignatureHash(v)`, `voteSigningHash(v, network)`, `signVote({privKey, vote, network, compressed?})`, `recoverVoteSigner(sig, vote, network, {strict?})`, `verifyVoteSignature(sig, vote, keyId, network)` |
| Messages | `dashMessageHash(msg)`, `signMessage(priv, msg)` (base64), `signMessageRaw`, `verifyMessage(addr, sig, msg, network)`, `recoverMessageSigner(sig, msg, network)` |
| Tally | `tallyVotes(votes, weights, {now?}) -> {weighted, unweighted, absoluteYes, current, unknownMasternodes, rejected}`, `normalizeMnId` |
| Vote set | `countVotes(votes, weights, {now?}) -> tallyVotes result + {counted, voteSetHash}` (the one counting rule, used by the bridge and the web app), `voteSetHash(entries)`, `voteSetPreimage(entries)`, `VOTE_SET_DOMAIN` (govhub-voteset-v1, section 7) |
| Superblocks | `superblockSchedule(height, network) -> {last, next, votingDeadline, inMaturityWindow}`, `superblocksBetween`, `isSuperblockHeight`, `superblockPaymentsLimit(height, network)` (duffs, bigint), `superblockShareOfBlock`, `fundingThreshold(validWeighted, network)`, `payeeScript`, `findPayment(outputs, address, amount, network)`, `GOV_CHAIN_PARAMS` |
| Addresses | `decodeAddress`, `encodeAddress`, `p2pkhAddress`, `decodeWif`, `encodeWif`; `Network = 'mainnet' \| 'testnet' \| 'regtest'` |
| MN voting (phase 3) | `governanceVoteHash(v)` (Core's vote id), `voteRawParams(v, sigB64)`, `relayVoteError(v, now, maxHoldS)`, `VOTE_MAX_FUTURE_S`, `VOTE_UPDATE_MIN_S`, `relayCancelMessage(network, voteHash)`, `verifyRelayCancel(...)`, `parseProRegTx(raw)`, `payoutScriptAddress(script, network)` (section 9) |

Conventions: **hashes cross the API in two forms**. `display` hex is what RPCs/explorers print (and what goes in
vote strings); `raw` is the internal byte order (reverse of display) that is hashed, serialized and committed in the
collateral OP_RETURN. Names say which (`govHashDisplay`, `govHashRaw`, `txidRaw`).

## Exact byte formats

### 1. Governance object hash — `Governance::Object::GetHash()`, `src/governance/common.cpp:23-37`

SHA256d (`CHashWriter`, double SHA-256) over, all integers little endian:

| bytes | field | source line |
|---|---|---|
| 32 | `hashParent`, raw byte order (`"0"` for proposals = 32 zero bytes) | common.cpp:30 |
| 4 | `revision` int32 | :31 |
| 8 | `time` int64 (the `time` given to `gobject prepare`; `CreationTime`/`createdAt` in RPCs) | :32 |
| 1+n | `HexStr(vchData)`: **the lowercase hex text of the data** as an ASCII `std::string` = CompactSize(len) + chars | :33 |
| 36 | `masternodeOutpoint` of a proposal = null outpoint: 32 x `00` + `ffffffff` | :34 |
| 1 | `uint8_t{}` = `00` | :34 |
| 4 | `0xffffffff` (unsigned int literal) = `ffffffff` | :34 |
| 1 | `vchSig` (empty vector) = CompactSize 0 = `00` | :35 |

`collateralHash` and the object type are not hashed ("fee_tx is left out on purpose"). The earlier research summary
"null outpoint | 0x00 | 0xffffffff | empty vchSig" was right; the string part is the hex *text*, not the bytes.
`raw = sha256d(preimage)`; `display = hex(reverse(raw))`.

### 2. Collateral — `CGovernanceObject::IsCollateralValid`, `src/governance/object.cpp:790-880`

* expected script `CScript() << OP_RETURN << ToByteVector(hash)` (object.cpp:824-825) = `6a 20 <32 bytes of the RAW hash>`;
  **raw = internal byte order = reverse of what `gobject list` prints** (confirmed: Core rejects the reversed hash).
* minimum value `GOVERNANCE_PROPOSAL_FEE_TX` = 1 DASH = 100,000,000 duffs (object.h:87); more is fine.
* every output must satisfy `IsPayToPublicKeyHash() || IsUnspendable()` (object.cpp:836); `IsUnspendable` = first byte is
  `OP_RETURN` **or** script longer than 10,000 bytes (script.h:534). Any P2SH / P2PK / other output fails the whole tx, even
  with a correct OP_RETURN present, and the check happens for each output in order.
* at least one output must equal the script with value >= 1 DASH (position does not matter, object.cpp:841).
* `GOVERNANCE_FEE_CONFIRMATIONS` = 6 (object.cpp:863) is chain state: **the caller** must check confirmations / ChainLock.
* Transaction wire format (`primitives/transaction.h:354-365`): `int32 = nVersion(int16) | nType << 16`, vin, vout, nLockTime,
  and `CompactSize payload` only if `nVersion >= 3 && nType != 0`. txid = SHA256d of everything incl. the payload.
  No segwit marker exists in Dash. The parser rejects trailing bytes and non-canonical CompactSizes.

### 3. Proposal data — `governance::ValidateProposal`, `object.cpp:999-1034`

`dataHex` -> bytes (<= 512, object.cpp:33) -> JSON object (Core's parser, see Findings) -> rules:
`type` integer 1 (:81); `name` 1..40 bytes, ASCII-lowercased, only `-_a-z0-9` (:97); `start_epoch`/`end_epoch` integers,
`end > start`, and `end > now` only when `fCheckExpiration` (:127; `gobject check/prepare` use true, relayed objects false);
`payment_amount` number `> 0` (:156); `payment_address` no whitespace, Base58 P2PKH **or P2SH** for the network (:177);
`url` no whitespace, **>= 4 bytes**, and `CheckURL` (:212, balanced `[`/`]` in the `//netloc` part). "Whitespace" is
exactly `' ' \f \n \r \t \v` (util/strencodings.h:168), so U+00A0 is allowed.

`buildProposalDataHex(fields)` emits `JSON.stringify` of the keys sorted alphabetically
(`end_epoch, name, payment_address, payment_amount, start_epoch, type, url`), no whitespace, UTF-8, hex. This matches
proposal.dash.org/DashCentral; Core itself only needs *some* JSON object with these fields (Dash-Qt emits
`name, payment_address, payment_amount, url, start_epoch, end_epoch, type`, qt/proposalcreate.cpp:125-133). The gov hash
depends on the exact bytes, so the builder is deterministic and refuses > 512 bytes.

### 4. Message signing — `src/util/message.cpp:25,74-79`, `src/messagesigner.cpp:25-50,91-103`, `key.cpp:254-275`, `pubkey.cpp:199-217`

`hash = SHA256d( 0x19 || "DarkCoin Signed Message:\n" || CompactSize(len(msg)) || msg )` (both strings are `std::string`
serializations, i.e. CompactSize-prefixed; msg is UTF-8). Signature: 65 bytes `header || r || s`, `header = 27 + recid + (compressed ? 4 : 0)`,
RFC 6979 nonce, low-S. Recovery honours the compression flag, so an "uncompressed" header yields a 65-byte pubkey and a *different* key id.

### 5. Governance vote signatures — `src/governance/vote.h:166-172,183-186,196`, `vote.cpp:164-190`

* **Mainnet (and regtest/devnet) - message scheme.** Signed message
  `"<collateral txid display hex>-<index>|<proposal hash display hex>|<signal int>|<outcome int>|<time>"`
  (e.g. `ab..ab-0|cd..cd|1|1|1760000000`; signal FUNDING = 1; outcome YES=1, NO=2, ABSTAIN=3), hashed as in section 4.
* **Testnet - hash scheme.** `vote.cpp:176` (`NetworkIDString() == TESTNET`) verifies the *binary* `GetSignatureHash()`
  with `CHashSigner::VerifyHash` instead: `SHA256d( outpoint.hash (32 raw) | outpoint.n u32 | parentHash (32 raw) | outcome i32 | signal i32 | time i64 )`.
  Note **outcome comes before signal** (vote.h:196). No magic prefix; `signmessage` cannot produce this signature.
  Checked against real testnet votes (`test/testnet-votes.test.ts`).
* The signing key is the MN **voting key**: `hash160(recovered compressed pubkey)` must equal the `keyIDVoting` of the
  masternode whose *collateral outpoint* is in the vote (`GetMNByCollateral`, vote.cpp:231). `voteraw` takes
  `<txid> <index> <proposal hash> funding yes|no|abstain <time> <base64 sig>` (rpc/governance.cpp:861) and Core rejects votes whose
  time is more than 1 hour in the future (vote.cpp:213).

### 6. Tally — `object.cpp:421-440` (latest vote), `:880-893` (weights)

Per masternode the vote with the greater `time` wins; at **equal time the higher outcome value wins** (Core rejects the lower one,
object.cpp:427-440). Weight is `GetMnType(type).voting_weight` (regular 1, evonode 4; `evo/dmn_types.h:26-44`, the "Invalid" type is 0).
`absoluteYes = weighted yes - weighted no`, which is the number Core compares with the funding threshold.

**PoSe-banned masternodes count.** CountMatchingVotes (object.cpp:880-893) looks every voter up with
`tip_mn_list.GetMNByCollateral`, which returns banned masternodes too (evo/deterministicmns.cpp:104-107; only
`GetValidMNByCollateral`, :109-116, filters bans), and `CGovernanceVote::IsValid` accepts their votes the same way (vote.cpp:231).
So the weight map passed to `tallyVotes` must contain every *registered* masternode (`protx list registered`), banned or not.
Validity only enters the funding threshold `max(nGovernanceMinQuorum, m_valid_weighted / 10)` (governance.cpp:1208-1209). Votes
of masternodes that left the list, or whose voting key changed, are dropped by Core (`RemoveInvalidVotes`, governance.cpp:1150-1195,
votedb.cpp:81-101). Checked live: the bridge's tallies built this way equal Core's `FundingResult` for all 28 mainnet proposals
(2026-10-24, height 2,560,434), vote for vote.

### 7. Vote set commitment: `voteSetHash` (govhub-voteset-v1)

A tally document carries `voteSetHash` so a reader who re-verifies the signed votes can check that its recount used exactly the
bridge's vote set.

```
lines = for every COUNTED masternode (its current funding vote per section 6, and present in the weight map),
        sorted by the id string ascending (JS / ASCII order: "...-10" < "...-9"):
          "<collateral txid, display hex lowercase>-<index>|<outcome 1|2|3 (0 if that is the current vote)>|<nTime>\n"
hash  = SHA-256( "govhub-voteset-v1\n" || lines )      (UTF-8; 32 bytes, hex in natural byte order, no reversal)
```

Signal, proposal hash and signatures are not in the line: the set is per proposal, only funding votes are tallied, and each
signature is verified on its own. `voteSetHash(entries)` normalises ids (`normalizeMnId`), rejects a masternode listed twice,
and is order-independent. Use `countVotes(votes, weights, {now})` rather than composing `tallyVotes` and `voteSetHash` by hand: it is the single
definition of "counted" (current vote per masternode by Core's rules, masternodes in the weight map only, PoSe-banned ones included) that the bridge
publishes and a client recounts.
Vectors: `test/voteset.test.ts` (pinned with coreutils `shasum`) and the bridge's recorded mainnet fixture
(`services/bridge/test/fixtures`).

### 8. Superblocks: schedule, limit, payments (`superblock.ts`)

Pure functions of chain parameters and a height (feed them a verified height):

* **Schedule**: `CSuperblock::GetNearestSuperblocksHeights` (governance/superblock.cpp:126-143), `IsValidBlockHeight` (:119-124); the trigger is
  built from the first block of the maturity window, `next - nSuperblockMaturityWindow` (governance/signing.cpp:41-43). Parameters: mainnet
  start 614,820, cycle 16,616, maturity 1,662 (chainparams.cpp:171-175); testnet 4,200 / 24 / 8 (:380-384).
* **Payments limit**: `CSuperblock::GetPaymentsLimit` (superblock.cpp:145-162) feeds a fixed nBits (1, or powLimit's compact form on
  min-difficulty networks) into `GetBlockSubsidyHelper` (validation.cpp:1809-1870): base 5 DASH from V20 (mainnet 1,987,776; testnet 905,100), a
  1/14 cut per 210,240 blocks of the previous height, 20% treasury from V20 (10% before), times the cycle. Mainnet 2,575,480: 682,826,378,160 duffs,
  equal to `getgovernanceinfo.governancebudget` (6828.2637816) on 2026-10-24.
* **Payment found**: `CSuperblock::IsValid` requires every trigger payment as a coinbase output with the same script and amount
  (superblock.cpp:303-310), so `findPayment` matching P2PKH/P2SH script + exact duffs is the check; it cannot tell two proposals with the same
  address and amount apart. The recorded mainnet superblock 2,558,864 pays 6 proposals, 5,393 DASH in total, what the bridge recorded as paid.
* **Threshold**: `max(nGovernanceMinQuorum, m_valid_weighted / 10)` (governance.cpp:1208-1209).

### 9. Masternode voting helpers (`mnvote.ts`)

* **Vote hash** (`governanceVoteHash`) = `CGovernanceVote::UpdateHash`, vote.cpp:145-156: SHA256d of `outpoint.hash (32 raw) | n u32 | 0x00 |
  ffffffff | parentHash (32 raw) | SIGNAL i32 | OUTCOME i32 | time i64` (signal before outcome, the reverse of the signature hash), shown
  in display order. It is the key of `gobject getcurrentvotes` and the bridge's `votes.hash`; checked against 300 recorded mainnet votes.
* **Core rules a relay enforces** (`relayVoteError`, constants): funding signal only, outcome yes/no/abstain (`voteraw` refuses NONE),
  `time <= now + maxHold`; at broadcast, `time <= now + VOTE_MAX_FUTURE_S` (3,600, vote.cpp:213) and one accepted change per hour per
  (masternode, object, signal) on the receiving node's clock (`VOTE_UPDATE_MIN_S`, object.cpp:443-456, GOVERNANCE_UPDATE_MIN).
* **Relay cancel** (govhub-relay-cancel-v1): the voting key signs, with Dash `signmessage` (message magic, section 4) on **every**
  network (so Core and hardware wallets can sign it, unlike a testnet vote),
  ```
  "govhub-relay-cancel-v1\n<network>\n<vote hash, display hex lowercase>"
  ```
  The first line keeps it apart from any vote string; the network line stops cross-network replay. `verifyRelayCancel` checks it.
* **ProRegTx** (`parseProRegTx`, evo/providertx.h:162-183): the proTxHash is recomputed from the bytes and the collateral outpoint read
  from the payload (a null hash means "output n of the ProRegTx itself"). A masternode's collateral never changes, so comparing the
  proTxHash with a verified SML entry proves the outpoint a vote must name (the SML does not carry it). For ProTx v1/v2 the registered
  payout script and voting key are read too; a ProUpRegTx can change both later (one of the 4 testnet vectors has a changed payout).
  v3 (extended addresses) has a variable-length NetInfo and payout list and is parsed only up to the outpoint (no real v3 vector yet).

## Fixtures (`test/fixtures/`)

| file | content | produced by |
|---|---|---|
| `proposals.regtest.json` | 4 proposals (P2PKH payout, P2SH payout, non-ASCII url + extra field + mixed-case name, non-zero parent hash + revision 258), Core's `Hash/DataHex/createdAt`, the raw collateral tx from `gobject prepare`, Core's `gobject submit` result | `scripts/gen-regtest-vectors.mjs` |
| `collateral.regtest.json` | 10 hand-built collateral txs (4 good, 6 bad) each judged by Core's own `gobject submit` | same |
| `check.regtest.json` | 52 `gobject check` verdicts (valid/invalid incl. parser quirks) | same |
| `messages.regtest.json` | 4 regtest keys x 7 messages: Core `signmessagewithprivkey` signatures + `verifymessage` | same |
| `plaintx.regtest.json` | an ordinary wallet tx (negative collateral case) | same |
| `superblock-mainnet.json`, `superblock-testnet.json` | the coinbase of the newest superblock (mainnet 2,558,864; testnet 1,578,672) | `packages/dapi/scripts/record-anchor-fixtures.mjs` |
| `protx.testnet.json` | 4 raw testnet ProRegTxs (regular and evo; external collateral and collateral inside the ProRegTx; ProTx v1 and v2: testnet has no v3 ProRegTx yet) with `protx list registered` facts | testnet dashd 24.0.0-rc.4 `getrawtransaction` (2026-10-24) |
| `mainnet-proposals.json` | all 28 proposals in mainnet Core (height 2,560,391) with the raw collateral txs | `scripts/fetch-mainnet-vectors.mjs` (public JSON-RPC, read-only) |

The generator talks only to `dash-cli`, never to this package, so fixtures are "what Core says". Regtest keys are worthless.
Regtest needs `-txindex=1 -acceptnonstdtxn=1` (the multi-OP_RETURN variant is non-standard) and `dash-cli mnsync next` x2 before
`gobject submit` works on a peerless node.

## Test status

* 359 offline tests pass (+5 live-Core tests, skipped unless DASH_CLI is set) (`npm test`), `tsc --noEmit` clean, and the package imports under plain Node 22 type stripping (`test/node-strip.test.ts`; no enums or parameter properties anywhere).
* Hash: 4 + 10 regtest objects and 28 mainnet proposals reproduce Core's hash exactly; 4 more built by `buildProposalDataHex` in the live test.
* Collateral: 4 Core-prepared txs + 28 real mainnet txs accepted; all 10 `gobject submit` verdicts reproduced (reversed hash, 0.99999999 DASH,
  extra P2SH / P2PK output, hash+1 byte, missing OP_RETURN rejected; 1.5 DASH, extra OP_RETURN, hash output not first accepted).
* Validation: 52/52 `gobject check` parity cases; live test adds 150 random proposals and **4,000 randomly mutated JSON byte strings with 0 disagreements** (run with `FUZZ_N=4000`).
* Messages/votes: our signatures are **byte-identical** to Core's for 28 (key, message) pairs; recovery returns the signing address; `signVote`
  output verifies in Core's `verifymessage` (compressed and uncompressed keys, plus high-S twins which Core also accepts).

## FINDINGS (differences from, or sharper than, the plan)

1. **OP_RETURN hash byte order: raw/internal, confirmed.** The plan (§2) is right. The `display` hash printed by RPCs is its reverse; Core rejects a collateral
   containing the display-order hash (`bad-reversed-hash` fixture). Vote strings, in contrast, use *display* hex for both txid and proposal hash.
2. **Collateral's output rule is not quite "every output P2PKH or OP_RETURN"**: "unspendable" means *any* output whose script starts with `0x6a` (or is > 10 kB), so extra
   OP_RETURN outputs (even with data) are fine for this check, while a P2PK or P2SH change output fails it. (Relay policy rejects 2+ OP_RETURN outputs,
   `multi-op-return`, so those only appear if mined by a cooperating miner.) The matching output may be at any index; > 1 DASH is accepted.
3. **Testnet votes do not use message signing** (plan §5.1 only mentions the DarkCoin magic). On testnet Core verifies the binary vote hash
   (`vote.cpp:176`), so (a) the browser/relay must pick the scheme from the network (`voteSchemeFor`), (b) the "offline-sign with `signmessage`" mode in §5.1 cannot work on testnet,
   (c) outcome precedes signal in the binary preimage. **Verified against a live testnet node (2026-10-24), both directions:** 34 signed votes on 3
   proposals from 23 masternodes, as dashd v24.0.0-rc.4 published them on ZMQ, all recover to the `votingAddress` Core lists for their masternode
   and none verify with the message scheme; one of them is an ABSTAIN signed with `signVote` and submitted with `voteraw`, which Core accepted
   (`test/testnet-votes.test.ts`, fixture `test/fixtures/testnet-votes.json`).
4. **Core's signatures are deterministic (RFC 6979) like noble's**, so signatures are byte-identical, not just verifiable. Useful for golden tests.
5. **Core accepts more signature encodings than SignCompact emits**: any header byte (only `(h-27)&3` and `&4` matter) and high-S, because governance votes are checked with `CHashSigner::VerifyHash`,
   not `VerifyHashCanonical` (which only the evo shares code uses). `recoverVoteSigner` mirrors Core by default (relays/verifiers must not reject votes Core accepts); pass `{strict:true}` to require canonical headers 27..34 + low-S
   (we always *produce* canonical signatures). The compression flag changes the recovered key id; a voting key registered from an uncompressed pubkey would only verify with a flag-0 header.
6. **Proposal JSON is parsed by Core in a lenient, non-standard way** (`ParseProposalJSON` ignores `UniValue::read()`'s return value): trailing garbage after the object, a truncated document, and
   a duplicate key (first occurrence wins; `JSON.parse` keeps the last!) are all accepted exactly as the parser left them. `JSON.parse` therefore cannot be used to judge on-chain proposals;
   `corejson.ts` ports the UniValue state machine. Integers must be integer lexemes (`1.0`, `1e0`, `"1"` are rejected for `type`/epochs; `payment_amount` may be any double > 0 including `1e2`).
7. **Name rule**: case-insensitive but ASCII only and counted in bytes (`é` is invalid even though 1 char); empty and 41-byte names rejected. **URL**: `abc` (3) rejected, `a:bc` accepted; ` ` accepted; `http://[::1/` rejected.
8. **Expiry is a creation-time rule only** (`gobject prepare/check/submit` pass `fCheckExpiration=true`; objects received over P2P are validated with `false`), so verifiers of existing proposals must not pass `now`.
9. **P2SH payouts are valid** (`fAllowScript=true`), DIP-18 Platform bech32m addresses are not (`DecodeDestination` refuses them as L1 destinations). `testnet`/`regtest` share version bytes 0x8c/0x13; mainnet 0x4c/0x10.
10. **`gobject list` does not return the revision.** All 28 mainnet proposals hash correctly with revision 1; the bridge must store the revision from the P2P `govobj` message (or probe).
11. **Time sanity**: Core rejects a vote with `time > now + 1h` (vote.cpp:213) and, because a masternode's initial state has creation time 0, a negative time. Nothing in the signature code enforces this (it has no clock); `tallyVotes` does when you pass `now`, and **you must**, otherwise a far-future vote signed once with a voting key pins that masternode's vote forever. Equal-timestamp conflicts are resolved by outcome value (see Tally), not arrival order.
12. **Tx ids**: `checkCollateralTx` binds the raw bytes to a txid only if you pass `expectedTxid` (an empty string fails, it never disables the check). Asset-unlock transactions with payload version >= 2 have a *stable txid* that zeroes the trailing 132 bytes of quorum signing info (primitives/transaction.cpp:76-94, `DashTx.txid` vs `instanceHashRaw`); covered by synthetic tests only (no regtest vector). Devnets share testnet address prefixes but sign votes with the message scheme (`Network` has a separate `'devnet'`).
13. noble-curves v2 `sign(..., {format:'recovered'})` puts the recovery id **first**, not last; the code reorders it to Bitcoin's compact layout. Don't "simplify" that.
14. Environment: `dash-cli` against a peerless regtest node needs `mnsync next`; `gobject prepare` needs `-txindex`; the Dash wallet default is a descriptor wallet, so `dumpprivkey` needs a legacy wallet (`createwallet leg false false "" false false false`).

## Not covered

SML parsing, BLS ChainLock verification and badge verification (also listed for this package in PLAN §11) are separate work. Real mainnet vote signatures are covered by the bridge's recorded fixtures (`services/bridge/test/fixtures`): Core exposes votes
without signatures over RPC, so they were captured from ZMQ `rawgovernancevote` during a governance re-sync (5,133 votes, all verify).
