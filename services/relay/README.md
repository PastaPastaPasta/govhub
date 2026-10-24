# @govhub/relay

A queue in front of a dashd. Clients sign masternode governance **funding** votes with the voting key and hand the
fully signed vote to the relay; the relay broadcasts it with `voteraw`, either at once or at a release time the client
chose (deferred / randomized voting, docs/PLAN.md §5.2). It also submits proposals whose collateral is confirmed
(`gobject submit`). The relay never sees a key, keeps no accounts and no IP addresses at rest.

```
 browser (keyring)                    relay                                   dashd
   signVote(..., time = Tᵢ) ──POST /v1/votes──► SQLite queue (held, release_at) ──► voteraw   at release_at
   cancel (signmessage)     ──POST /v1/votes/cancel──► held -> cancelled              │
   poll                     ──GET  /v1/votes/:id ◄── confirmer: gobject getcurrentvotes (is the vote visible?)
   proposal + collateral    ──POST /v1/proposals/submit──► re-verify ──► gobject submit
```

Source map: `src/relay.ts` (request logic), `src/api/server.ts` (HTTP), `src/broadcaster.ts` (release, confirm, purge),
`src/db.ts` (SQLite), `src/mnlist.ts` (cached masternode list), `src/ratelimit.ts`, `src/core/rpc.ts` (Core JSON-RPC client,
a copy of the bridge's: services stay independent), `src/cli.ts`. Signing, hashing and parsing come from `@govhub/verify`
(`governanceVoteHash`, `voteRawParams`, `relayVoteError`, `recoverVoteSigner`, `verifyRelayCancel`, `validateProposalData`,
`governanceObjectHash`, `checkCollateralTx`). OpenAPI 3.1: `openapi.json`.

## Threat model and privacy

**Public unlinkability only.** The point of the relay is that a masternode operator's votes do not appear on chain
in one burst and, with several relays, not even from one origin. It does **not** hide anything from the relay operator:
the operator sees the IP address and the timing of every submission and which masternodes submit together. Use several
relays and/or Tor if that matters.

What the relay does to keep that exposure small:

- no accounts, no cookies, no request log table, no access log; the logs carry config at start-up and, for failures,
  only the relay id and a short error code (never an outpoint, vote hash, IP or Core's raw message);
- no IP column anywhere. The per-IP limiter is in memory only and keyed by `HMAC-SHA256(random per-process salt, ip)`;
- each vote keeps only the hour it was received (`received_hour`, rounded down), not the second. The release and the signed
  time are the client's own and are needed to broadcast;
- finished votes are deleted `RETENTION_DAYS` after they finished (default 7).

The id returned by `POST /v1/votes` (16 random bytes), not the vote hash, is the handle for status and cancel. A signed vote
is public once broadcast, so a vote hash is not a secret; cancelling needs the voting key regardless.

## Running

```sh
npm install                                    # at the repository root (npm workspaces)
node services/relay/bin/relay.mjs run          # or: npm run relay -w @govhub/relay -- run
node services/relay/bin/relay.mjs healthcheck  # exit 0 if GET /v1/status answers 200
```

Node >= 22.18 runs the TypeScript directly (built-in type stripping; the code uses erasable syntax only).

```sh
docker build -f services/relay/Dockerfile -t govhub-relay .       # from the repository root
docker run --rm -p 8788:8788 -v relay-data:/data \
  -e CORE_NETWORK=testnet -e CORE_RPC_URL=http://dashd:19998 -e CORE_RPC_USER=relay \
  -v ./rpc-password:/run/secrets/rpc-password:ro -e CORE_RPC_PASSWORD_FILE=/run/secrets/rpc-password \
  govhub-relay
```

The image runs as uid 1000, keeps state in `/data` and has a `HEALTHCHECK` on `GET /v1/status`. Behind cloudflared (the only
peer) set `CLIENT_IP_HEADER=cf-connecting-ip`, otherwise every client shares the tunnel's address. dashd needs `txindex=1`
(proposal submission reads the collateral with `getrawtransaction`) and RPC access to `protx`, `gobject`, `voteraw`,
`getrawtransaction`, `getblockcount`.

## Configuration

Environment variables; an empty value means the default.

| Variable | Default | |
|---|---|---|
| `CORE_NETWORK` | `mainnet` | `mainnet`, `testnet`, `regtest`, `devnet`. Selects address versions and the vote signature scheme (testnet signs the vote hash, everything else signs the message string; `voteSchemeFor` in verify) |
| `CORE_RPC_URL` | `http://127.0.0.1:<9998 mainnet, 19998 testnet, 19898 regtest, 19798 devnet>` | |
| `CORE_RPC_USER` | | |
| `CORE_RPC_PASSWORD_FILE` | | file holding the RPC password |
| `CORE_RPC_PASSWORD` | | the password itself, for local development only |
| `CORE_RPC_TIMEOUT_MS` | `30000` | per attempt |
| `DB_PATH` | `./data/relay.sqlite` | SQLite file (WAL); the image uses `/data/relay.sqlite` |
| `HTTP_HOST` | `127.0.0.1` | the image sets `0.0.0.0` |
| `HTTP_PORT` | `8788` | |
| `RELEASE_MARGIN_S` | `60` | default release is `max(now, time - RELEASE_MARGIN_S)` |
| `MAX_HOLD_S` | `3456000` (40 days) | how far ahead a vote's signed `time` and its release may lie |
| `MAX_HELD_PER_MN` | `64` | held votes per masternode; more is 429 `too-many-held` |
| `RATE_IP_PER_MIN` | `30` | token bucket per client IP for every POST (burst = this value); 429 `rate-limited` with `Retry-After` |
| `RATE_MN_PER_HOUR` | `24` | accepted submissions per masternode outpoint in any rolling hour (in memory: a restart resets it) |
| `CLIENT_IP_HEADER` | | header carrying the client IP (e.g. `cf-connecting-ip`); empty = the socket address |
| `PROPOSAL_SUBMIT` | `1` | `0` answers 501 on `/v1/proposals/submit` |
| `MIN_COLLATERAL_CONFS` | `6` | confirmations a proposal collateral needs before `gobject submit` |
| `RETENTION_DAYS` | `7` | finished votes (confirmed, failed, cancelled, superseded) are deleted this long after they finished |
| `CONFIRM_TIMEOUT_S` | `600` | a broadcast vote not visible in `gobject getcurrentvotes` after this long is re-broadcast (at most 3 times) |
| `MN_LIST_TTL_S` | `60` | age after which the cached `protx list registered true` is refreshed; a miss refreshes at most every 10 s |
| `RELAY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`; JSON lines on stderr |

## API

Full detail in `openapi.json`. CORS is open (origin `*`, methods GET/POST/OPTIONS, header `content-type`), every response
has `X-Content-Type-Options: nosniff`, every POST body is limited to 4096 bytes (413), errors are `{error, code}`.

| | |
|---|---|
| `POST /v1/votes` | submit a signed funding vote → 202 `{id, voteHash, status: "held", releaseAt}` (200 with the stored record if this exact vote is already known) |
| `POST /v1/votes/cancel` | `{id, sig}` → 200 `{id, status: "cancelled"}`; 409 `not-held` once it left the held state |
| `GET /v1/votes/:id` | `{id, voteHash, status, releaseAt, broadcastAt, confirmedAt, attempts, lastError}` |
| `GET /v1/status` | `{service, version, network, core: {reachable, height}, held, proposalSubmit}`, 200 whenever the process serves |
| `POST /v1/proposals/submit` | `{network, parentHash: "0", revision: 1, time, dataHex, collateralTxid}` → `{govHash, result}` |

`POST /v1/votes` body: `{network, collateralTxid, collateralIndex, govHash, signal: "funding", outcome: "yes"|"no"|"abstain",
time, sig, releaseAt?}`, where `time` is the signed nTime and `sig` the base64 of the 65-byte compact signature from
`signVote` (`@govhub/verify`). Validation order, each with its own `code`: `wrong-network`, `bad-request` (types, unknown
keys), `bad-vote` (`relayVoteError`: funding only, outcome yes/no/abstain, time positive and at most `MAX_HOLD_S` ahead),
`bad-release`, `unknown-mn` (404) / `mn-banned` (409), `bad-signature`, `unknown-proposal` (404) / `not-a-proposal`.
Then: an already stored vote hash returns 200 (idempotent); a held vote of the same masternode on the same proposal is
superseded by one with a greater `time` (409 `later-vote-held` otherwise); then the masternode limits (`rate-limited`,
`too-many-held`). A release time must satisfy `time - 3540 <= releaseAt <= time + 86400` and `releaseAt <= now + MAX_HOLD_S`.

### Cancel message

A held vote is dropped by a signature of the masternode's **current** voting key over this text, signed with Dash
`signmessage` (DarkCoin message magic; the same scheme on every network, so Dash Core, DMT or a hardware wallet can sign it):

```
govhub-relay-cancel-v1
<network>
<vote hash, lowercase display hex>
```

(lines joined with `\n`, no trailing newline). The network line stops a testnet cancel from working on mainnet.
`relayCancelMessage(network, voteHash)` builds it and `verifyRelayCancel` checks it (`packages/verify/src/mnvote.ts`).
A cancel names one vote and is idempotent.

## Core rules the relay enforces

From Dash Core `governance/object.cpp` `ProcessVote`, `governance/vote.cpp` `IsValid` and `rpc/governance.cpp` `voteraw`:

- **Only the masternode's voting key signs funding votes on proposals.** The signature is recovered the way Core does
  (any header byte, high-S allowed) and compared with `state.votingAddress` from `protx list registered true`.
- **`voteraw` uses `GetValidMNByCollateral`**: a PoSe-banned masternode cannot vote, so the relay refuses it at submit
  (409 `mn-banned`) and again just before broadcasting (`failed`, `mn-banned`; `mn-gone` if it is no longer registered).
- **No vote timed more than one hour ahead of Core's clock.** A vote whose `time` is within 30 s of that limit is rescheduled to
  `time - 3600 + 60`; the default release (`time - RELEASE_MARGIN_S`) keeps clear of it.
- **One accepted change per (masternode, proposal, signal) per hour, on Core's receive time** (`GOVERNANCE_UPDATE_MIN`).
  After each broadcast the relay remembers the time (`last_broadcast`, kept 2 h) and schedules the next vote for the same key
  `3600 + 30` s later instead of provoking "voting too often". If Core says so anyway (another relay or the operator voted),
  the vote is rescheduled the same way and that is not counted as a failure.
- **A vote older than the masternode's current one is "Obsolete"**: `failed`, `obsolete`.
- Core never rejects a vote for being old, so a late release is fine.

## Vote status lifecycle

```
            submit                 release_at reached            seen in getcurrentvotes
 (new) ───────────────► held ─────────────────────────► broadcast ─────────────────────────► confirmed
                         │  ▲                                │
          cancel (signed)│  │ not visible after              │ the MN has a later funding vote
                         ▼  └ CONFIRM_TIMEOUT_S (max 3×)     ▼
                     cancelled                           superseded        not visible after 3 re-broadcasts: failed (unconfirmed)
        a later vote for the same key replaces a held one: superseded      Core refuses for good: failed (see lastError)
```

- `held`: waiting for `releaseAt`, or for a retry. `lastError` explains a wait: `too-often`, `unknown-proposal` (Core does
  not know the proposal yet; retried 60 s doubling to 1 h, `failed` 6 h after the release), `core-error` (transport, HTTP 5xx or
  any other Core error; retried 30 s doubling to 30 min, `failed` after 50 attempts), `not-visible` (re-broadcast pending).
- `broadcast`: `voteraw` answered "Voted successfully". The confirmer checks `gobject getcurrentvotes <govHash> <txid> <n>` every 30 s.
- `confirmed`, `superseded`, `cancelled`, `failed` are final. `failed` carries `lastError`: `obsolete`, `mn-gone`, `mn-banned`,
  `mn-not-valid` (Core: "Failure to find masternode"), `bad-signature` (Core: "Failure to verify vote"), `unknown-proposal`,
  `core-error`, `unconfirmed`. `lastError` is always a short code, never a raw Core message.

## Proposal submission

`POST /v1/proposals/submit` re-verifies what a client could get wrong or fake before it asks Core: the proposal data
(`validateProposalData`, including `end_epoch` in the future), the gov hash (`governanceObjectHash`), and the collateral
transaction fetched from Core (`checkCollateralTx` against that hash and the named txid: P2PKH/OP_RETURN outputs only,
a burn of at least 1 DASH committing to the hash). With fewer than `MIN_COLLATERAL_CONFS` confirmations it answers 425
`collateral-unconfirmed` with the current `confirmations`; the client retries. Core's refusal is 409 `core-rejected` with
Core's message (proposal data is public). Only proposals (`parentHash` `0`, revision 1) are accepted.

## Tests

`npm test -w @govhub/relay` (vitest, no network, no dashd): an in-memory fake Core and a fake clock drive the API and the
broadcaster on both vote-signature schemes; `proposals.test.ts` uses the real regtest fixtures from
`packages/verify/test/fixtures`; `privacy.test.ts` checks the SQLite files for any trace of the client address.

## Not done

- No Tor/onion listener, no relay-to-relay gossip, and no mixing: the operator sees IPs and timing (see above).
- Funding votes on proposals only: no `valid`/`delete`/`endorsed` signals, no operator BLS-signed votes, no triggers.
- No Platform (EvoVote) vote relaying (PLAN §5.3); this relay speaks Dash Core only.
- No authentication or payment for the public endpoints beyond the rate limits; the per-masternode hourly limit is in memory
  and resets on restart.
- No replacement of a vote that was already broadcast (the next vote simply waits out Core's one-hour rule).
- `/v1/status` does not report queue age or per-state counts, only the number of held votes.
