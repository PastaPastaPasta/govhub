# @govhub/bridge

The only govhub component that talks to Dash Core. It archives every governance object and every **signed** vote
Core relays, verifies them, recomputes the tallies with Core's own rules (and checks them against Core), publishes
`proposal` / `tally` / `cycle` documents to the Platform `gov` contract, and serves a read-only HTTP API
(plus a DashCentral-compatible subset). PLAN.md §1, §2, §3.1 `gov`, §6.2.

```
 dashd (txindex=1, governance on)
   │ ZMQ: rawgovernanceobject, rawgovernancevote, hashblock, hashchainlock   (one endpoint)
   │ RPC: gobject list/get/getcurrentvotes, getrawtransaction, protx list, getgovernanceinfo, getsuperblockbudget, getblock
   ▼
 ingest ── parse raw bytes ──► SQLite archive (append-only: objects, signed votes, MN lists, budgets, superblocks, tallies)
   │         verify: gov hash, proposal data, collateral tx, vote signature vs voting key
   ▼
 tally ── latest vote per MN, weights 1/4, Core's budget fill ──► compare with Core (FundingResult + current vote set)
   │                                                                   │ mismatch → held + logged
   ▼                                                                   ▼
 publisher (evo-sdk 5.0.0-rc.8) ──► Platform gov contract: proposal (once), tally (replace, throttled), cycle
 HTTP API (hono) ──► /v1/*, /api/v1/* (DashCentral)          OpenAPI 3.1: openapi.json
```

Source map: `src/core/` (RPC client, ZMQ subscriber, raw parsers, governance.dat reader), `src/ingest.ts`,
`src/mnlist.ts`, `src/tally.ts`, `src/publish/`, `src/api/`, `src/bridge.ts` (the loop), `src/cli.ts`.
Shared verification is `@govhub/verify` (packages/verify).

## Running

```sh
npm install                                   # at the repository root (npm workspaces)
node services/bridge/bin/bridge.mjs run       # or: npm run bridge -w @govhub/bridge -- run
```

Node >= 22.18 runs the TypeScript directly (built-in type stripping; the code uses erasable syntax only). Production runs
the Docker image as part of the compose stack in `deploy/` (dashd + bridge + optional caddy):

```sh
docker build -f services/bridge/Dockerfile -t govhub-bridge .     # from the repository root
deploy/scripts/smoke-regtest.sh                                   # end-to-end on an isolated regtest chain
```

The image runs as uid 1000 (`node`), keeps state in `/data` (owned by that user), and has a `HEALTHCHECK` on
`GET /v1/status`, which answers 200 whenever the process serves HTTP (Core state is in the body).

| Command | |
|---|---|
| `bridge run` | ZMQ listener + reconcile + tallies + publishing (unless `PUBLISH=0`) + HTTP API, until SIGTERM. Retries Core with backoff forever: it may start before dashd is up or synced |
| `bridge backfill [--govdat FILE]` | one RPC reconciliation pass (objects, collateral, MN list, budget, tallies vs Core); `--govdat` imports objects and signed votes from a **copy** of dashd's `governance.dat` |
| `bridge publish --once [--force]` | one refresh + publish pass; `--force` ignores the replace throttle |
| `bridge verify [--no-core]` | recompute hashes, signatures, collateral and tallies from the archive; diff against the stored verdicts and Core; exit 1 on any difference |
| `bridge backup FILE` | online SQLite backup (consistent while `run` writes) |
| `bridge healthcheck` | exit 0 if `GET /v1/status` on `HTTP_PORT` answers 200 |

## Configuration

Environment variables plus mounted secret files. An empty value means the default.

| Variable | Default | |
|---|---|---|
| `CORE_NETWORK` | `mainnet` | `mainnet`, `testnet`, `regtest`, `devnet`: address versions and the vote-signature scheme |
| `PLATFORM_NETWORK` | `mainnet` if Core is mainnet, else `testnet` | where documents are published. **Kept separate from `CORE_NETWORK`**: dev publishes mainnet governance into testnet Platform; production uses the same network |
| `CORE_RPC_URL` | `http://127.0.0.1:<network port>` | |
| `CORE_RPC_USER` | | |
| `CORE_RPC_PASSWORD_FILE` | | file holding the RPC password (`CORE_RPC_PASSWORD` also works, for local development only) |
| `CORE_RPC_TIMEOUT_MS` / `CORE_RPC_RETRIES` | `60000` / `3` | per attempt; retries cover transport errors, HTTP 5xx and RPC_IN_WARMUP (-28) |
| `CORE_ZMQ_URL` | `tcp://127.0.0.1:29998` | ONE endpoint carrying the four topics. Empty disables ZMQ (then no signed votes are archived) |
| `DB_PATH` | `./data/bridge.sqlite` | the archive |
| `HTTP_HOST` / `HTTP_PORT` | `127.0.0.1` / `8787` | the image sets `0.0.0.0` |
| `PUBLISH` | `1` | `0` = archive, verify and serve only: no Platform access, `GOV_CONTRACT_ID` and the key file are not needed (the file may be absent) |
| `GOV_CONTRACT_ID` | | required when `PUBLISH=1` |
| `BRIDGE_IDENTITY_KEY_FILE` | | required when `PUBLISH=1`: `{"identityId": "<base58>", "keyId": 2, "privateKeyHex": "<64 hex>"}` (or `"wif"`), an AUTHENTICATION/HIGH key of the identity that owns the gov contract |
| `TALLY_PUBLISH_INTERVAL_S` | `3600` | minimum time between replaces of one tally document (first create is immediate) |
| `CYCLE_PUBLISH_INTERVAL_S` | `3600` | same for cycle documents |
| `MIN_COLLATERAL_CONFS` | `6` | a proposal is published only when its collateral is this deep (archiving is never gated) |
| `PLATFORM_MAX_CONCURRENT_WRITES` | `4` | capped at 12 (DIP-30 nonce window, see the evo-sdk notes) |
| `PUBLISH_ON_MISMATCH` | `0` | publish a tally even when it disagrees with Core (default: hold it and log) |
| `RECONCILE_INTERVAL_S` | `600` | `gobject list` reconciliation period (min 10) |
| `PORTAL_PROPOSAL_URL` | `https://gov.dashhq.org/p/{hash}` | DashCentral `dw_url`; `{hash}`, `{name}` substituted |
| `BRIDGE_LOG_LEVEL` | `info` | JSON lines on stderr |

Core must run with `txindex=1` (collateral lookups; without it Core accepts **no** proposals at all, see Findings),
governance enabled, the four `zmqpub*` topics on one endpoint, and `zmqpub*hwm=200000` on **all** four topics (they share
one socket; deploy/dashd/dash.conf has the exact lines).

## What the bridge stores and checks

**Archive** (`src/archive/db.ts`; nothing is ever deleted):

| Table | |
|---|---|
| `gov_objects` | every proposal and trigger: SER_NETWORK bytes (`raw_hex`), parsed fields, first-seen height/time, hash/data/collateral verdicts, raw collateral tx, whether Core still lists it |
| `votes` | every signed vote: SER_NETWORK bytes (signature included), parsed fields, first-seen height/time, signature status, recovered signer key id |
| `mn_lists`, `mn_list_entries`, `mn_snapshots` | `protx list registered true <height>` reduced to proTxHash, collateral outpoint, type/weight, voting address + key id, PoSe ban; content-addressed, with the list in force per height |
| `budget_snapshots`, `superblocks` | `getgovernanceinfo` + `getsuperblockbudget`; per past superblock what its coinbase actually paid against the winning trigger |
| `tallies`, `vote_sets` | every distinct tally with its Core comparison; each distinct counted vote set once, keyed by `voteSetHash` |
| `platform_docs`, `publish_log` | what was published (id, revision, content) and every write attempt |
| `events`, `bad_messages` | ZMQ gaps, mismatches, invalid signatures; unparseable ZMQ bodies verbatim |

**At ingest** (`src/ingest.ts`):
- objects: the gov hash is recomputed from the raw bytes (general form incl. trigger outpoint + signature,
  `src/core/govparse.ts`), proposal data is validated with Core's rules (no expiry check, as Core does for relayed objects),
  the collateral is fetched with `getrawtransaction` and checked with `checkCollateralTx` (OP_RETURN = raw-order hash,
  >= 1 DASH, only P2PKH/unspendable outputs, txid bound to the bytes). Publishing additionally needs >= 6 confirmations.
- votes: 65-byte signatures are recovered with the network's scheme (`voteSchemeFor`: mainnet/regtest/devnet message
  signing, testnet binary hash) and compared with `keyIDVoting` of the masternode owning the vote's collateral outpoint, in
  the MN list in force when the vote was first seen (then in the latest list). A vote is judged only once a list read
  *after* it arrived exists, and `invalid` / `unknown-mn` votes are re-checked whenever the list changes (a key change in
  the block before a vote must not leave the vote rejected). A later copy of a vote with a valid signature replaces a stored
  copy whose signature failed (the old copy is kept in `events`). 96-byte operator (BLS) votes, used for
  trigger/valid/delete signals, are archived as `bls-unverified`.

**Tally** (`src/tally.ts`), mirroring Core:
- one current vote per masternode: newest `nTime`, ties by higher outcome (object.cpp:420-440); future votes (> now + 1 h)
  ignored;
- a vote counts only if its signer is the masternode's **current** voting key and the masternode is still registered
  (Core's `RemoveInvalidVotes`, governance.cpp:1150-1195);
- weights from the **tip** list: regular 1, evo 4, **PoSe-banned masternodes included**, because `CountMatchingVotes`
  (object.cpp:880-893) uses `GetMNByCollateral`, which does not filter bans (deterministicmns.cpp:104-116);
- threshold `max(nGovernanceMinQuorum, m_valid_weighted / 10)` (governance.cpp:1208-1209), checked against
  `getgovernanceinfo.fundingthreshold`;
- `rank` / `inNextBudget` from Core's superblock candidate: absolute yes desc, ties by hash desc
  (governance.cpp:1221-1226), fill the budget skipping what does not fit, payment window `[start - 2 h, end + 2 h]` around
  an SB time estimated at 2.62 min/block (signing.cpp:23, :58-104); `margin` = absolute yes - threshold.

Every tally is compared with Core's `gobject get` FundingResult **and** with `gobject getcurrentvotes` (whose keys are vote
hashes): `match` requires equal weighted counts and the identical vote set. Mismatches are logged at error level, stored
(`tallies.mismatch`, `events`), shown in `/v1/status` and `/v1/tallies`, and the tally is not published. Publishing
**fails closed**: a tally is held when Core disagrees, when the comparison could not be made (RPC error), or when the
bridge's funding threshold differs from `getgovernanceinfo` (margin/inNextBudget would be wrong); nothing is published
while Core reports itself unsynced (`mnsync`). `PUBLISH_ON_MISMATCH=1` overrides the tally holds.

**voteSetHash** = govhub-voteset-v1, defined in `@govhub/verify` (`voteSetHash`, packages/verify/README.md section 7):
SHA-256 of `"govhub-voteset-v1\n"` followed by one line `<txid>-<n>|<outcome>|<time>\n` per counted masternode, sorted by
the `txid-n` string. `GET /v1/proposals/{hash}/votes?height=<asOfHeight>` returns exactly the set behind a published tally.

## Backfill of signed votes

`gobject getcurrentvotes` does **not** return signatures: it rebuilds each vote from the `vote_rec_t` instance
(`CGovernanceVote vote{outpoint, nParentHash, signal, outcome}; vote.SetTime(...)`, governance/governance.cpp:577-578;
RPC rpc/governance.cpp:817-819). Signed votes leave Core only on ZMQ (`rawgovernancevote`, published when a vote is
accepted: object.cpp:476-478) and on disk in `governance.dat`. So:

1. **Run the listener from day one** (`bridge run`, or `PUBLISH=0` until the identity exists). Core discards expired
   proposals and superseded votes; ZMQ is the only way to keep them.
2. **Backfill what Core holds now** by making it re-accept every vote while the listener runs:
   start `bridge run` → stop dashd → back up `governance.dat`, move it aside → start dashd. During the governance sync Core
   re-requests every object and vote from peers and publishes each accepted one on ZMQ. Raise the publisher HWM first
   (`zmqpub*hwm`, all four topics). The listener reports every ZMQ sequence gap (a restart resets Core's counters, which
   also shows as a gap).
3. Or import a copy of `governance.dat` (`bridge backfill --govdat FILE`): its vote files hold the signed votes Core
   counts (read-only parser, `src/core/govdat.ts`, format CGovernanceManager-Version-16). Never point it at the live file.

`bridge verify` re-checks everything afterwards.

## Publishing

`proposal` (immutable): once hash, data and collateral verify and the collateral has `MIN_COLLATERAL_CONFS`. `tally`
(one per proposal): created on first sight, then replaced when anything but `asOfHeight` changes, at most once per
`TALLY_PUBLISH_INTERVAL_S`; when its proposal leaves the active set the last tally is retired once (`rank` 0,
`inNextBudget` false) so Platform does not keep showing "will be funded". `cycle` (per superblock height): the next superblock (live, replaced as it fills, `estTime`
ignored for change detection) and the last one with `paid` = trigger payments found in its coinbase. Hashes are stored in
RPC/display byte order (contracts-v1 README). Restart-safe: without a local record the document is looked up on its
unique index (G1/G5b/G6b, base64 `where` values, PV13 query rules) and adopted; a failed create re-queries before
retrying, so a write that landed is never duplicated. Writes run at most `PLATFORM_MAX_CONCURRENT_WRITES` at a time and
retry lagging-node / nonce errors (refreshing the SDK nonce cache on "nonce already present in past"). Document ids:
PV13 `sha256d(contractId‖ownerId‖type‖entropy)`, PV14 derived by the SDK.

## HTTP API

`openapi.json` (OpenAPI 3.1). CORS `*`, GET/HEAD/OPTIONS only. Proposal, tally and cycle objects use the gov document
field names; amounts are duffs. `GET /v1/status`, `/v1/proposals?state=active|past|all`, `/v1/proposals/{hash}` (raw
object hex, parsed fields, raw collateral tx), `/v1/proposals/{hash}/votes[?height=|?all=1]` (raw vote bytes, base64
signature, MN proTxHash and weight), `/v1/tallies`, `/v1/mnlist[/{height}]`, `/v1/cycle`, and DashCentral-compatible
`/api/v1/budget`, `/api/v1/proposal?hash=` (DashCentral field names; `title`, `owner_username`, `comment_amount` are null
until those come from Platform; payment counts are schedule estimates).

## Trust notes: what a bridge can and cannot lie about

A client that verifies (`@govhub/verify`, PLAN §2) cannot be fooled about:
- **proposal content**: the gov hash commits to every field and the collateral OP_RETURN commits to the hash; the client
  checks the collateral tx over DAPI;
- **any vote it is shown**: each signature recovers to a key that must equal `keyIDVoting` in the SML for that collateral
  outpoint; a forged or altered vote fails;
- **the arithmetic**: tallies are recomputed from the verified votes; `voteSetHash` binds a published tally to an exact set.

A bridge **can**:
- **omit** proposals or votes (a tally that silently leaves out signed votes still verifies). Mitigations: Core cross-check
  in the bridge itself, several independent bridges, `bridge verify`/audit attestations;
- **misreport MN-list membership or weight** if the client trusts `/v1/mnlist` instead of the SML from DAPI;
- **be late or selective about publishing** (tallies are snapshots, hourly by default), and report `rank`/`inNextBudget`,
  which depend on Core's estimate of the superblock time;
- **lie about history**: votes Core no longer holds exist only in archives like this one; a vote is checked against the
  *current* voting key for counting, so an archived vote from a key that was since rotated cannot be proven by the SML of
  today.

The bridge cannot publish into someone else's contract, and all its documents are signed by its identity.

## Development against the temporary CT 164 node

`scripts/dev-ct164.sh` opens an SSH tunnel to the mainnet dashd on R730 CT 164 (temporary dev source) for the duration of
one command: `backfill`, `run` (bounded by `BRIDGE_RUN_SECONDS`), `exec <cmd>`. Secrets stay in `~/.local/share/govhub-dev`
(RPC password, key file made by `scripts/dev-keyfile.ts`). `scripts/dev-ct164-resync.sh` is the one-time governance re-sync
(above). `scripts/readback.ts` reads every published document back from Platform **with proofs** and checks it against the
archive (gov hash recomputed from the document, collateral re-checked, tallies matched to Core-matched archive rows).
`scripts/record-fixtures.ts` regenerates `test/fixtures` from the archive and Core.

## Tests

`npm test` (vitest) runs on recorded mainnet data only: 28 proposals as published on ZMQ with their collateral txs, 633
signed votes on three proposals with the MN entries of their voters, and a trimmed real `governance.dat`
(`scripts/record-fixtures.ts` can also record Core RPC responses into `test/fixtures/rpc/`; the API/RPC shapes are covered by
the fixture-backed tests and the regtest smoke test). They check parser round trips and hashes, every signature, tallies and `voteSetHash` equal to Core's numbers
and vote set, a full client-side recount from the HTTP API alone, budget ordering/fill/window, publisher idempotency,
throttling, restart adoption and the mismatch hold (against a fake Platform), RPC retry rules, ZMQ framing over a real
socket (needs local TCP binding), config rules and that `openapi.json` covers every route.

## Live run (2026-10-24, mainnet Core on CT 164 → testnet Platform contract `3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ`)

- **Re-sync backfill:** dashd v23.1.8 restarted once with `governance.dat` moved aside (backed up first) while the bridge
  listened. Core was ready again within seconds; **28 proposals and 5,133 signed funding votes arrived on ZMQ within 36 s**
  (plus 1 operator vote), no sequence gaps. All 28 proposals' hashes, data and collateral verified; **all 5,133 vote
  signatures verified** (mainnet message scheme against `keyIDVoting`).
- **Core parity:** bridge tallies equal Core's FundingResult **and** its current vote set for **28/28** proposals at height
  2,560,434 (and again at every later comparison). No mismatches. Threshold 332 equals `getgovernanceinfo`.
- **Superblock 2,558,864:** all 6 trigger payments found in the coinbase, paid 5,393 of 6,828.26 DASH budget.
- **Published:** 58 documents (28 `proposal`, 28 `tally`, 2 `cycle`) in one pass, 0 failures, 0 retries;
  **2,974,665,120 credits = 0.0297 tDASH** (identity balance 6,186,379,736 → 3,211,714,616), ~0.00051 DASH per document.
- **Read-back:** `scripts/readback.ts` read all 58 back with proofs: 58/58 match the archive (every proposal's gov hash
  recomputes from the document, collateral re-checks, tallies equal Core-matched archive rows). The contract also holds two
  synthetic proposals written by the phase-0 cost spike; the script lists them as not from this archive.
- **Caveat:** those 28 `tally` documents were published before `voteSetHash` was aligned with the web app on
  govhub-voteset-v1, so their `voteSetHash` uses the bridge's first definition (SHA-256 over the raw vote bytes). The counts,
  rank, margin and inNextBudget are correct. The next publish pass replaces them (content changed); a forced re-publish
  needs Core: `PUBLISH=1 TALLY_PUBLISH_INTERVAL_S=0 BRIDGE_RUN_SECONDS=300 scripts/dev-ct164.sh run`, then
  `scripts/readback.ts`. It was not run because SSH to CT 164 started failing (agent refused the key) after the change.

## FINDINGS

1. **Signed votes are not available over RPC.** `gobject getcurrentvotes` rebuilds votes without signatures
   (governance.cpp:577-578, rpc/governance.cpp:817-819). The archive must capture them from ZMQ; a governance re-sync is
   the backfill, `governance.dat` is a second source (it holds the signed vote files).
2. **Core counts votes of PoSe-banned masternodes** (CountMatchingVotes → `GetMNByCollateral`, object.cpp:880-893,
   deterministicmns.cpp:104-116; votes are accepted the same way, vote.cpp:231). Only the threshold uses valid (unbanned)
   weight. A tally over "valid MNs only" would not match Core. `@govhub/verify`'s tally docs said otherwise and are fixed.
3. **Without `txindex` Core accepts no proposals at all** (collateral lookup fails): CT 164 held 0 proposals and only a
   trigger until txindex finished; a later governance sync was needed to get them, because Core does not re-request objects
   it rejected. The compose `dash.conf` sets `txindex=1`.
4. **Votes are verified against the current (tip) voting key**, and a key change removes the masternode's votes
   (governance.cpp:1150-1195). Archived votes signed by a rotated key therefore stop counting; the bridge mirrors this.
5. **ZMQ topics on one endpoint share one socket and its HWM** (the first-initialized topic's); set the same `zmqpub*hwm`
   on all four. The 5,133-vote burst arrived at ~140 votes/s.
6. **`@hono/node-server` replaces the global Request/Response by default, which breaks evo-sdk's DAPI fetches** ("Failed to
   prefetch quorums"). The server is started with `overrideGlobalObjects: false`.
7. **Regtest signs votes with the message scheme**, like mainnet: only `NetworkIDString() == "test"` uses the binary hash
   (vote.cpp:176). `@govhub/verify`'s `voteSchemeFor` already encodes this; the bridge uses it for every network.
8. **`gobject list` has no revision**: RPC-only proposals are rebuilt as revision 1 and accepted only if the rebuilt hash
   equals Core's (all 28 mainnet proposals do).
9. A dev bridge that does not run continuously loses every vote cast while it is down (until the next re-sync); production
   must run the listener permanently. No vote was cast on mainnet between the dev runs here (the tallies never changed).
   Related edge: if a masternode's voting key goes A → B → A, Core has already dropped the A-signed votes for good, while the
   bridge would count them again; the Core comparison catches it and the tally is held.
10. Core publishes `hashblock` for every block during initial sync; the bridge ignores it until the chain is synced and
    polls `getblockcount` instead, so it does not hammer RPC (or take an MN snapshot) per IBD block.
11. Two bridge processes on one archive (`publish --once` next to `run`) are not locked against each other; unique indexes
    prevent duplicate documents, but one of them may lose a replace race and resync its revision. Run one writer.
