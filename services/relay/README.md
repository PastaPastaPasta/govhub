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
- finished votes are deleted `RETENTION_DAYS` after they finished (default 7);
- the database keeps neither the order votes arrived in nor deleted rows: the tables are `WITHOUT ROWID` (a rowid table
  numbers rows in arrival order; here they sit in the order of their random id), the journal is a rollback journal
  (`journal_mode = DELETE`, removed after each transaction; a WAL would keep every committed page in order until a
  checkpoint), and `secure_delete` zeroes purged rows. A database from an earlier version is rebuilt on start-up (rows copied in
  id order, then `VACUUM`), and its `-wal` file goes away.

The id returned by `POST /v1/votes` (16 random bytes), not the vote hash, is the handle for status and cancel. A signed vote
is public once broadcast, so a vote hash is not a secret; cancelling needs the voting key regardless. There is deliberately no
lookup by vote hash: a vote hash can be computed from public data (masternode, proposal, outcome, a guessed time), so such a
lookup would let anyone confirm that a vote is held. A client whose `POST /v1/votes` timed out re-sends the same signed vote
instead: a vote whose hash is already stored returns 200 with the stored receipt (`id`, `status`), in any state.

### Abuse resistance

Signed votes are public on the Dash P2P network, so anyone can submit a masternode's *old* votes to the relay: that needs no
key. What stops it from using up a masternode's limits or the queue:

- `stale-vote`: a vote older than `MAX_PAST_S` (24 h) is refused outright.
- A vote Core already has (`already-current`) or has superseded (`newer-vote-in-core`) is refused before it is stored and
  without touching the per-masternode hourly limit or the held caps. Those limits count only votes that are really queued.
  If Core cannot answer, the vote is accepted: the broadcaster and the confirmer sort it out.
- `MAX_HELD_TOTAL` bounds the queue as a whole (503 `relay-full`).
- When `voteraw` answers that Core already has the vote (an empty "Error voting : ", or "Already known valid vote") the relay
  does not treat it as an error: the vote becomes `broadcast` and the confirmer decides `confirmed` / `superseded`. (Core
  answers with the same empty message for a vote on an expired or deleted proposal; such a vote is never `confirmed`, it is
  re-broadcast up to 3 times and ends `failed` / `unconfirmed`.)
- Each replayed vote that passes the signature check costs one `getcurrentvotes` call; only the per-IP limiter bounds that.
- Due votes are picked by `next_attempt_at`, then `release_at`, in batches of 50, so a masternode whose votes keep failing
  (and are pushed into the future by their backoff) cannot starve the others.
- The per-IP limiter uses the client address from `CLIENT_IP_HEADER` only from trusted peers (`TRUSTED_PROXY_CIDRS`), takes the
  rightmost `x-forwarded-for` entry, and buckets IPv6 by /64, so neither a forged header nor a rotating IPv6 address within
  one prefix gets a fresh bucket.

**Cancels need an honest relay.** A cancel asks the relay to drop the vote; a relay that ignores it can still broadcast the
signed vote at its release time, and its nTime then beats any newer vote with an earlier nTime. The web client therefore
cancels on every relay that holds the vote, and the UI tells the user to cast the replacement as well.

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
peer) set `CLIENT_IP_HEADER=cf-connecting-ip`, otherwise every client shares the tunnel's address. If the port is reachable by
anything else, also set `TRUSTED_PROXY_CIDRS` to the proxy's address, or anyone can pick their own bucket with a forged header. dashd needs `txindex=1`
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
| `DB_PATH` | `./data/relay.sqlite` | SQLite file (rollback journal, `secure_delete`, no WAL); the image uses `/data/relay.sqlite` |
| `HTTP_HOST` | `127.0.0.1` | the image sets `0.0.0.0` |
| `HTTP_PORT` | `8788` | |
| `RELEASE_MARGIN_S` | `60` | default release is `max(now, time - RELEASE_MARGIN_S)` |
| `MAX_HOLD_S` | `3456000` (40 days) | how far ahead a vote's signed `time` and its release may lie |
| `MAX_PAST_S` | `86400` | a vote whose signed `time` is older than this is refused, 400 `stale-vote` (signed votes are public, so old ones can be replayed by anyone) |
| `MAX_HELD_PER_MN` | `64` | held votes per masternode; more is 429 `too-many-held` |
| `MAX_HELD_TOTAL` | `100000` | held (and in-flight) votes over all masternodes; more is 503 `relay-full` |
| `RATE_IP_PER_MIN` | `30` | token bucket per client IP for every POST (burst = this value); 429 `rate-limited` with `Retry-After` |
| `RATE_MN_PER_HOUR` | `120` | votes actually queued per masternode outpoint in any rolling hour (one vote per active proposal must fit: mainnet has ~30) (duplicates and votes Core already has do not count; in memory: a restart resets it) |
| `CLIENT_IP_HEADER` | | header carrying the client IP; empty = the socket address. `cf-connecting-ip`: the single value. `x-forwarded-for`: the RIGHTMOST entry (the one the trusted proxy appended; entries to its left are client-supplied). IPv6 clients share a bucket per /64, IPv4 and IPv4-mapped per address |
| `TRUSTED_PROXY_CIDRS` | | comma-separated IPv4 addresses / CIDRs and exact IPv6 addresses allowed to supply `CLIENT_IP_HEADER`; a request from any other socket peer is bucketed by its socket address and the header is ignored. Empty = trust the header from any peer, which is right when only cloudflared / caddy can reach the port (the compose setup) |
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
| `POST /v1/votes/cancel` | `{id, sig}` → 200 `{id, status: "cancelled"}`; 409 `maybe-broadcast` (with `status` and a `reason` to show) when an earlier attempt may have reached Core (`maybeSent`); 409 `not-held` once it left the held state otherwise |
| `GET /v1/votes/:id` | `{id, voteHash, status, releaseAt, broadcastAt, confirmedAt, attempts, lastError, nextAttemptAt, holdReason, sameAsCurrent, maybeSent}` |
| `GET /v1/status` | `{service, version, network, core: {reachable, height}, held, proposalSubmit}`, 200 whenever the process serves |
| `POST /v1/proposals/submit` | `{network, parentHash: "0", revision: 1, time, dataHex, collateralTxid}` → `{govHash, result}` |

`POST /v1/votes` body: `{network, collateralTxid, collateralIndex, govHash, signal: "funding", outcome: "yes"|"no"|"abstain",
time, sig, releaseAt?}`, where `time` is the signed nTime and `sig` the base64 of the 65-byte compact signature from
`signVote` (`@govhub/verify`). Validation order, each with its own `code`: `wrong-network`, `bad-request` (types, unknown
keys), `bad-vote` (`relayVoteError`: funding only, outcome yes/no/abstain, time positive and at most `MAX_HOLD_S` ahead),
`bad-release`, `unknown-mn` (404) / `mn-banned` (409), `bad-signature`, `unknown-proposal` (404) / `not-a-proposal`.
`bad-vote` is followed by `stale-vote` (400: `time` older than `MAX_PAST_S`).
Then: an already stored vote hash returns 200 (idempotent); then Core is asked with `gobject getcurrentvotes <govHash> <txid> <n>`
(a failing call is ignored): 409 `already-current` if the vote hash is among the masternode's current votes, 409
`newer-vote-in-core` if a funding vote of that masternode is dated at or after this one. Neither is queued and neither costs
a slot. Then a held vote of the same masternode on the same proposal is superseded by one with a greater `time` (409
`later-vote-held` otherwise; a vote of that key that is `sending` counts for this check but is never superseded, and if it
goes back to held the broadcaster drops it as `superseded` because a newer vote exists); then the limits, which only a vote that is really inserted counts against: per masternode per
hour (`rate-limited`), held per masternode (`too-many-held`) and held in total (503 `relay-full`). A release time must satisfy `time - 3540 <= releaseAt <= time + 86400` and `releaseAt <= now + MAX_HOLD_S`.

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
          submit        release_at reached      voteraw answered        seen in getcurrentvotes
 (new) ───────────► held ─────────────────► sending ─────────────► broadcast ──────────────────► confirmed
                     │  ▲                     │                       │  │
      cancel (signed)│  │ retry / too often   │ Core refuses for      │  │ the MN has a later funding vote
                     ▼  └─────────────────────┘ good: failed          │  ▼
                 cancelled                    │ no answer (timeout,   │  superseded
        a later vote for the same key         │ crash mid-call)       │
        replaces a held one: superseded       ▼                       │ not visible after CONFIRM_TIMEOUT_S (max 3x,
                                       maybe-broadcast ◄──────────────┘ then failed: unconfirmed)
                                       (retried like held; never cancellable, never held again)
```

- `held`: waiting for `releaseAt`, or for a retry. `holdReason` says why in one word (`release-time`, `one-change-per-hour`,
  `core-time-limit`, `retrying`) and `nextAttemptAt` until when. `lastError` explains a wait: `too-often` (Core's answer),
  `hour-rule` (this relay's own record of the last broadcast, the same rule checked before asking Core), `future-limit`,
  `unknown-proposal` (Core does
  not know the proposal yet; retried 60 s doubling to 1 h, `failed` 6 h after the release), `core-error` (transport, HTTP 5xx or
  any other Core error; retried 30 s doubling to 30 min, `failed` after 50 attempts), `not-visible` (re-broadcast pending).
- `sameAsCurrent`: when the vote was submitted, the masternode's current funding vote in Core had the same outcome. Such a
  vote is flagged, not dropped: it only moves the timestamp (and restarts Core's one-hour clock), but the client may mean it and
  the current vote can change before the release. Clients should warn before sending one.
- `sending`: `voteraw` is in flight (seconds). The broadcaster sets it with a conditional `held -> sending` UPDATE just before
  the call, so a cancel can no longer race with it: cancelling a `sending` vote is 409 `not-held` with `status: "sending"`.
  When Core answers, the row moves on with `WHERE status = 'sending'` updates: `broadcast`, back to `held` (Core answered with
  "wait" or an error, `lastError` as below) or `failed`. Without an answer (transport error, timeout) it goes to
  `maybe-broadcast`, and so does a row left in `sending` by a crash, due immediately at start-up (if Core did get the vote, it
  answers "already known" and the vote becomes `broadcast`). Clients must accept `sending` as a transient status.
- `maybe-broadcast`: waiting to be sent again, like `held` (same `holdReason`, `nextAttemptAt`, retries and limits), but an
  earlier attempt may already have reached Core: voteraw got no answer, the relay restarted mid-call, or the vote was broadcast
  and never showed up (`not-visible`, re-broadcast). A vote never goes from here back to `held`. `maybeSent` stays true when
  such a vote later fails, and a cancel is refused with 409 `maybe-broadcast` (the vote's `status` and a `reason` the client
  can show) whenever the flag is set and the vote was not superseded, so no client reports "cancelled" for a vote that may
  count. A row left in `sending` by a crash comes back with `lastError: core-error`.
- `broadcast`: `voteraw` answered "Voted successfully", or Core said it already has the vote (empty "Error voting : " /
  "Already known valid vote"; the confirmer then decides `confirmed`, `superseded` or a re-broadcast). The confirmer checks `gobject getcurrentvotes <govHash> <txid> <n>` every 30 s.
- `confirmed`, `superseded`, `cancelled`, `failed` are final (a final state is never overwritten). `failed` carries `lastError`: `obsolete`, `mn-gone`, `mn-banned`,
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

## Live testnet run (2026-10-24)

The relay ran in the testnet stack on the reference host (deploy/README.md 11.4) against `dashd 24.0.0-rc.4`, with votes
signed by the web app's own code (`apps/web/scripts/live-vote.ts`, results in `apps/web/scripts/results/live-vote.json`) on a
cheap test proposal `ab31c1ff…708d` (`packages/auth/scripts/testnet-proposal.ts`):

| Vote | Result |
|---|---|
| immediate YES, masternode-2 | `voteraw` "Voted successfully", `confirmed` by the relay within 20 s, in `gobject getcurrentvotes` and in the bridge's counted set |
| deferred ABSTAIN, masternode-3, nTime = release ~10 min ahead | `held`, broadcast at release minus the margin, `confirmed`; in Core and the bridge with the signed nTime |
| deferred NO, masternode-4, then a cancel | a cancel signed by another masternode's voting key refused (403), the voting key's own cancel accepted; never reached Core |
| after hardening (redeployed): a public vote Core already counts, replayed from the bridge | 409 `already-current`, nothing stored or counted (`apps/web/scripts/results/live-relay-hardening.json`) |
| after hardening: a fresh immediate ABSTAIN, masternode-6 | `confirmed` |

Together with a direct `voteraw` of a browser-signed vote this validates the testnet binary-hash scheme end to end from the web
app's signing code through the relay (the testnet-stack work independently confirmed `signVote` with one `voteraw`, see
`packages/verify/test/fixtures/testnet-votes.json`): Core accepted every vote, and `governanceVoteHash` equals Core's vote hash.

## Not done

- No Tor/onion listener, no relay-to-relay gossip, and no mixing: the operator sees IPs and timing (see above).
- Funding votes on proposals only: no `valid`/`delete`/`endorsed` signals, no operator BLS-signed votes, no triggers.
- No Platform (EvoVote) vote relaying (PLAN §5.3); this relay speaks Dash Core only.
- No authentication or payment for the public endpoints beyond the rate limits; the per-masternode hourly limit is in memory
  and resets on restart.
- No replacement of a vote that was already broadcast (the next vote simply waits out Core's one-hour rule).
- `/v1/status` does not report queue age or per-state counts, only the number of held votes.
