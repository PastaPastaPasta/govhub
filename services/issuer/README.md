# @govhub/issuer

The MN badge issuer (docs/PLAN.md section 8.4). It blind-signs one badge token per masternode per epoch, for requests
signed with the masternode's **voting key**. It never sees the badge message, so it cannot tell which identity
receives the badge. The formats, epoch table and reader rules are in `packages/badge/README.md`; this file covers the
service, its keys, its API and how to run it.

```
 dashd (RPC only)                         Platform (evo-sdk, proved reads)
   getblockcount,                           issuerKey of the epoch (check before signing)
   protx list registered true [<height>]    issuerReport (written once per closed epoch, HIGH key)
   (lists cached by the timer: MnLists)
        |                                        |
        v                                        v
   TokenService  <-- challenge, token --  HTTP API (hono) <-- browser Worker (blind, finalize)
        |
   SQLite (epoch, proTxHash, collateral, sha256(blindedMsg)); no IPs, no timestamps
        |
   BlindSigner: OpenSSL raw RSA, s^e == m check
        ^
   ISSUER_KEY_DIR: epoch-<E>.pem (current epoch, at most ISSUER_MAX_STAGED_KEYS later ones)
```

## Running

```sh
npm install                                    # repository root (npm workspaces)
node services/issuer/bin/issuer.mjs run        # or: npm run issuer -w @govhub/issuer -- run
npm test -w @govhub/issuer
npm run typecheck -w @govhub/issuer
docker build -f services/issuer/Dockerfile -t govhub-issuer .      # from the repository root
```

Node >= 22.18 runs the TypeScript directly (type stripping). The image (`node:22.23-slim`) runs as uid 1000, keeps
the token store in `/data` and private keys in `/keys` (mode 0700), listens on 8789, and has a `HEALTHCHECK` that
runs `issuer healthcheck` (exit 0 if `GET /healthz` answers).

| Command | |
|---|---|
| `issuer run` | the HTTP service plus a timer (`ISSUER_TICK_S`) for epoch housekeeping |
| `issuer healthcheck` | exit 0 when the local service answers `/healthz` on `HTTP_PORT` |
| `issuer keygen --dir D --from E --epochs N [--bits 2048\|3072]` | **offline**: one key per epoch, see "Keys" |
| `issuer publish-keys --dir D --identity-file critical.json --contract C --network N [--min-ahead 3]` | **offline**: publish the `issuerKey` documents with the CRITICAL key |
| `issuer revoke --epoch E [--through E2] --from-height H --identity-file critical.json --contract C --network N [--yes]` | **offline**: publish `issuerRevocation` documents with the CRITICAL key (a dry run without `--yes`), see "Revoking a key" |
| `issuer epoch --network N --height H` | print the epoch schedule around height H (JSON) |

## What the issuer checks

`POST /v1/token` runs these checks in order (`src/service.ts`):

| # | Check | Failure |
|---|---|---|
| 1 | shape: `request` is a string, `signature` is base64 of 65 bytes, `blindedMsg` is base64; the request parses in canonical form | `bad-request` |
| 2 | `net` is this issuer's network; the issuer is this identity | `wrong-network`, `wrong-issuer` |
| 3 | `epoch` is the current or the next epoch at the cached tip (`issuingEpochsAt`); the answer carries the current one as `issuingEpoch` | `wrong-epoch` |
| 4 | a key is ready for that epoch (see "Keys"); the request's `keyId` is that key | `unavailable`, `wrong-key` |
| 5 | the challenge in `nonce` is authentic and not expired; `sha256(blindedMsg)` equals the bound hash; `blindedMsg` has modulus length | `bad-challenge`, `bad-request` |
| 6 | **authentication**: the public key recovered from the `signmessage` signature has the hash160 that is `keyIDVoting` of the proTxHash in the **current** list (cached) | `unauthorized` |
| 7 | at most 6 requests per MN per minute (memory only); the tip, read fresh from dashd, still issues E (inside `E-1` or `E`) | `unavailable`, `wrong-epoch` |
| 8 | **eligibility**: the MN is valid (not PoSe-banned) now; it was registered **and** valid at `S(E-1)` (cached snapshot); its collateral outpoint is the same at both heights | `not-eligible` |
| 9 | the token store has existed since the window opened, or since the epoch's key was published if that came later; atomic dedup in SQLite, then sign and verify | `unavailable`, `already-issued` |

Notes:

- Every failure in step 6 is the same `403 unauthorized`: an unknown proTxHash, a wrong key and a bad signature look
  identical, so a stranger learns nothing about any MN. Only the holder of the voting key sees the answers from step 7 on.
- The issuer issues nothing, and records no start height, while dashd is in initial block download.
- Nothing before authentication touches dashd: the timer (`ISSUER_TICK_S`) caches the current list and the `S(E-1)`
  snapshot with `protx list registered true [height]` (`MnLists`, `src/core.ts`; the snapshot once it is
  `boundaryMarginBlocks` deep). Only an authenticated request costs one `getblockcount`, so a stranger cannot load dashd.
- A token store created (or reset) after an epoch's window opened refuses that epoch: it cannot know the tokens issued
  before, so it could neither dedup them nor report the right count. The first height is kept in the database. The
  exception is a key published after the store started (by at least `boundaryMarginBlocks`, because Platform's core height
  can run a few blocks ahead of dashd's): no client can ask before it reads the proved key, so no token for that epoch
  can predate the store. This lets a new issuer serve the current epoch.
- Dedup: `PRIMARY KEY (epoch, proTxHash)` and `UNIQUE (epoch, collateral)`. A retry with the same
  `sha256(blindedMsg)` gets the same signature (RSA signing is deterministic) and is not counted again. A
  different blinded message is refused with `already-issued`. Two MNs that share one voting key each get their own
  token, because dedup is per proTxHash.
- Signing (`src/signer.ts`): length must equal the modulus, and `1 < m < n` (OpenSSL silently left-pads short input,
  so the length check is explicit). The raw operation is `privateDecrypt` with `RSA_NO_PADDING`, which uses CRT. Before
  the result leaves the class, `publicEncrypt` with `RSA_NO_PADDING` must give back `m`: one faulty CRT signature
  would leak the key. Signing runs inside the SQLite transaction, so a failure stores nothing.
- Core is read-only: `getblockcount`, `protx list`. If Core is unreachable or the lists are not loaded, the answer is
  `503 unavailable`. The issuer currently uses the stack's RPC credential, which allows every RPC; before mainnet,
  give it its own `rpcauth` user with `rpcwhitelist=<user>:getblockcount,getblockchaininfo,protx` (not done yet).

### Challenges

The `nonce` of a request is a stateless challenge from `POST /v1/challenge`, 40 bytes:

```
nonce = rand(16) || expiry(u64 BE, unix seconds) || HMAC-SHA256(secret, "govhub-issuer-challenge-v1|<net>|<issuerId>|" || rand || expiry)[0..16]
```

The domain binds network and issuer. TTL is `ISSUER_CHALLENGE_TTL_S` (default 600, minimum 30). The secret comes
from `ISSUER_HMAC_SECRET_FILE` (hex, at least 32 bytes). Without it a random secret is made per process, and a restart
invalidates open challenges. There is no server state. A replay inside the TTL is harmless: the request also binds
`sha256(blindedMsg)`, and the store deduplicates.

## HTTP API

`openapi.json` is the reference (OpenAPI 3.1). Serve the issuer on its **own hostname**, never the portal's or
the bridge's origin.

| Endpoint | |
|---|---|
| `GET /healthz` | `{"ok": true}` |
| `GET /v1/info` | variant, network, issuer and contract ids, epoch parameters, dashd height, issuing epochs (current, next), `keyIds` per epoch, `ready`, challenge TTL. **Advisory only**: clients derive epoch and `keyId` from proved Platform data and the core height |
| `POST /v1/challenge` | `{nonce, expiresAt}` (`nonce` is hex) |
| `POST /v1/token` | body `{request, signature, blindedMsg}` (signature and blindedMsg in base64) returns `{blindSig, epoch}` (`blindSig` in base64) |

Errors are `{error, message}`:

| `error` | HTTP | Meaning |
|---|---|---|
| `bad-request` | 400 | malformed input, or the request does not bind this blinded message. Also 413 for a body over 4 KiB |
| `wrong-network`, `wrong-issuer` | 400 | the request is for another network or issuer |
| `bad-challenge` | 401 | the challenge is invalid or expired; fetch a new one |
| `unauthorized` | 403 | the signature is not from the voting key of that proTxHash |
| `not-eligible` | 403 | PoSe-banned now, not valid or not registered at `S(E-1)`, or collateral changed |
| `wrong-epoch` | 409 | neither the current nor the next epoch, or issuance for it has closed |
| `wrong-key` | 409 | the request names another key than this epoch's `issuerKey` |
| `already-issued` | 409 | this MN (or its collateral) already has a token for this epoch |
| `unavailable` | 503 | no key ready, lists not loaded, Core or signing failed, the per-MN limit, or the global limit (with `Retry-After: 5`) |

Limits: a per-MN limit (6 per minute) after authentication, and a global `ISSUER_MAX_TOKEN_RPS` (default 2000) on
requests that pass the cheap checks (shape, epoch, key, challenge HMAC, blinded-message hash) and so reach signature
recovery; junk does not consume it. Add a per-IP rate limit at the edge (Cloudflare) against floods of valid-looking
requests: this is **required** in production, because well-formed requests with forged signatures (a challenge can be
reused for its TTL; epoch and keyId are public) do consume the global budget. The issuer itself keeps no IP state. Rejecting a stranger's request costs a parse, an HMAC and a signature recovery, with no RPC. No per-IP
state is kept.
Every response carries `Access-Control-Allow-Origin: *` (no credentials), `Cache-Control: no-store`,
`Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

## Epochs and timing

The issuer mints tokens for the **current** epoch (Standard mode) and the **next** one (the private modes): a token for E
while the dashd tip is in `[S(E-1), S(E+1))`. It therefore holds the keys of both epochs. Clients stay `margin` blocks
from the boundaries, because Platform's chain-locked height lags the dashd tip. The full table, the display
window and the delay a new badge sees (testnet up to ~27 hours, mainnet up to ~32 days) are in
`packages/badge/README.md`. Testnet epochs are 576 blocks (about a day) on purpose.

## Keys

Keys are generated **offline**, one RSA key per epoch:

```sh
issuer keygen --dir ./keys-offline --from 2742 --epochs 14            # RSA-2048; --bits 3072 for RSA-3072
issuer publish-keys --dir ./keys-offline --identity-file critical.json --contract <badge contract> --network testnet
```

`keygen` writes `epoch-<E>.pem` (PKCS#8, mode 0600) and `manifest.json` (public: epoch, bits, SPKI in base64,
`keyId` in hex), and skips epochs that already have a key.

`publish-keys` (`src/publish.ts`) creates the `issuerKey` documents with the identity's **CRITICAL** key. The contract
requires `signatureSecurityLevelRequirement: 1` for `issuerKey` and `issuerRevocation`, so the online HIGH key on the
server can neither publish nor revoke keys. Readers accept a key created before `S(E+1) - margin` (`keyDeadline`), so
the current epoch's key can still be published; a key is skipped (`too late`) only if it would not land before that.
Publish **at least 3 epochs ahead** anyway, so a later compromise cannot claim those slots, and so the private modes,
which ask during E-1, have E's key in time (`--min-ahead` only reports whether enough later epochs have keys; it does
not enforce anything).

Each slot holds one key forever (unique, immutable, not deletable), so publishing is safe to repeat. Per epoch it prints
one JSON line with a `status`:

| `status` | |
|---|---|
| `published` | created now, and read back |
| `already published` | the slot already holds this key (same SPKI) |
| `adopted` | the SDK reported an error (a duplicate, a timeout), but the slot holds this key: the write landed |
| `conflict` | the slot holds a **different** key. It is final; if you did not publish it, the CRITICAL key is compromised |
| `too late` | it could not land before `S(E+1) - margin` |
| `error` | the publish failed and the slot is empty (re-run), the manifest's `keyId` is not `SHA256(spki)`, or our key landed after the deadline |

The exit code is 3 if any epoch is a `conflict`, 1 if any is an `error`, else 0.

On the server:

- `ISSUER_KEY_DIR` holds `epoch-<E>.pem` for the two epochs being issued (current and next) and at most `ISSUER_MAX_STAGED_KEYS` later ones
  (default 1, so the roll-over needs no operator at the boundary). With more staged keys the issuer **refuses to
  issue** and says so in `/v1/info` and the log. Every staged key is a future epoch that a server compromise could
  mint badges for.
- Before using a key, the issuer reads the proved `issuerKey` for the epoch and refuses if it is missing, was
  published at or after `S(E+1) - margin`, has another variant or `keyId != SHA256(spki)`, is older than the token store
  (above), or the private key does not match the published
  SPKI (logged as a `CONFLICT`: the slot cannot be fixed). The file must not be readable by group or others. A missing
  key is looked up again on every tick (`ISSUER_TICK_S`), so the issuer starts signing within one tick of the key
  landing on Platform.
- Once the issuance window of an epoch has closed (`S(E+1)` plus the margin), its key is destroyed: overwritten with zeros,
  fsynced, unlinked. On ZFS, btrfs and SSDs old blocks may survive; that is a property of the host, not of this code.

**A missing current-epoch key** (a new issuer, or keys that ran out). Standard mode asks for the current epoch, so it
works as soon as that epoch's key is on Platform; it does not wait for the next epoch. The service cannot publish the
key itself, because that needs the CRITICAL key, which never goes on the server. On the offline machine:

```sh
issuer keygen --dir ./keys-offline --from <current epoch> --epochs 1     # skipped if the manifest has it
issuer publish-keys --dir ./keys-offline --identity-file critical.json --contract <badge contract> --network testnet
```

In this order:

1. Start the service and let it sync once, then wait until the chain is a few blocks past that (`boundaryMarginBlocks`
   plus two: about 25 minutes on mainnet, 13 on testnet). The token store records the height it first ran at, and it
   issues for an epoch only if it is older than that epoch's key by the margin. Otherwise it could have missed tokens
   issued before it existed. A key published too soon is not used for that epoch; the status and the log say
   `token store started at height …`.
2. Copy `epoch-<E>.pem` to the server (0600, uid 1000).
3. Run the two commands above. The service signs from its next tick.

Once a valid key is on Platform, the epoch is reported at its end, with 0 tokens if this server never signed for it. A
missing report would flag the issuer for that epoch and the next. Why the old rule (key before `S(E-1)`) could go:
`packages/badge/README.md` and PLAN §8.9.

Keep the identity's MASTER and CRITICAL keys offline (CRITICAL signs the `issuerKey` documents). Only the HIGH key goes
to the server, and only for `issuerReport` documents. Key files are JSON
`{"identityId", "keyId", "privateKeyHex" | "wif"}`.

### Revoking a key

If the server is compromised, every epoch key it held (the two being issued and the staged ones) can mint badges. Revoke
them from the offline machine with the CRITICAL key, like `publish-keys`:

```sh
issuer revoke --epoch 2742 --through 2744 --from-height 1650000 --identity-file critical.json --contract <badge contract> --network testnet        # dry run
issuer revoke --epoch 2742 --through 2744 --from-height 1650000 --identity-file critical.json --contract <badge contract> --network testnet --yes
```

Readers (`packages/badge/src/reader.ts`) void every badge of epoch E created at or after the revocation's
`effectiveCoreHeight`. Any revocation the issuer published for (issuer, E) counts, whatever its `keyId`, so an epoch with
no published key can be revoked too (the command uses a zero `keyId`), and any key published for it later is void from
that height. Pick the height of the compromise or earlier: badges created before it stay valid. The document is
immutable, cannot be deleted and is unique per (issuer, epoch), so the command prints the plan and publishes only with
`--yes`. For an epoch that already has a revocation it reports `already revoked` (at or below the height) or `conflict`
(a later height, which cannot be replaced; exit code 3). A failed publish stops the run with `error` (exit code 1); what
was published before it is reported, and a re-run reports those epochs as `already revoked`.

**Squatting risk.** Whoever holds the CRITICAL key can publish a revocation for any epoch. A thief can publish one with
`effectiveCoreHeight = 4294967295` (never in effect) for every epoch: the unique index then blocks the issuer's real
revocation, and badges minted with stolen epoch keys stay valid. The same thief can also publish `issuerKey` documents
for epochs that have none yet, including the current and the next one (publish ahead so there are none). Revocations do not help once the CRITICAL key itself is lost; recovery is: disable the
CRITICAL key with the MASTER key (identity update), revoke what is still free, and have readers drop or replace the
issuer identity in their trust lists. Keeping the CRITICAL key offline is the protection.

Pre-publishing a no-op revocation (`effectiveCoreHeight = max`) for every future epoch was considered and **not
adopted**. Under the reader rules it is sound in the narrow sense (a revocation at the maximum height voids nothing), and
it would stop a thief from squatting those slots or from griefing honest badges with an early height. But the slot is
unique and immutable, so it would block the issuer's own revocation in exactly the same way: no epoch with a
pre-published revocation could ever be revoked, including after the likelier event, a server compromise that leaks
epoch keys while the CRITICAL key is safe. It trades the main use of revocations for protection against a key that is
kept offline anyway. The web client also treats any revocation for an epoch as final: it refuses new requests for that
epoch and does not post badges whose key is revoked, whatever the height, so a no-op revocation would stop the epoch's
badges in this app as well.

## What is stored and logged (logging policy)

The owner's rule: users may accept that the issuer could learn which masternode a badge belongs to (Standard mode), but
**we keep no logs of anything that could link them**. Every layer, checked:

| Layer | What it keeps |
|---|---|
| Token store (SQLite, `issuer-data`) | only `(epoch, proTxHash, collateral, sha256(blindedMsg))` for one-token-per-MN dedup and idempotent retries, plus per-epoch counts. No request times, IPs, user agents, request strings or signatures. Rows are deleted (`secure_delete`) when the epoch's issuance window closes, at `S(E+1)` plus the margin. Rollback journal, not WAL: a WAL would keep every insert in order until a checkpoint, i.e. the order in which masternodes got tokens. SSD and filesystem remnants are a host property |
| Application logs (stderr, kept by Docker's json-file driver) | lifecycle and error lines with no MN, outpoint, address or request detail; requests only as hourly aggregate counters. Hono's error handler is replaced and `console` is silenced in `issuer run`, so no library prints a request. `test/logging.test.ts` runs a full flow with `cf-connecting-ip`/user-agent headers at debug level and searches all output for the proTxHash, outpoint, IP and user agent |
| Rate limits | in memory only, never persisted: a global per-second budget, and a count per MN (after authentication) for the current wall-clock minute only. The whole per-MN map is dropped when the minute changes, on the next request or the housekeeping tick, so no request times and no list of masternodes that asked outlive the minute. `test/logging.test.ts` inspects that state too (`TokenService.debugSnapshot()`, tests only) |
| Tunnel gateway (Caddy, `caddy/tunnel-gateway-issuer.Caddyfile`) | nothing: no access log, and the default logger (which writes proxy errors with the client address) is discarded |
| cloudflared | `--loglevel fatal`: no per-request lines at all (debug logs every request; info, warn and error log failed origin requests with a time). Watch tunnel health on the metrics port or with `cloudflared tunnel info` |
| Cloudflare's edge | outside our control: Cloudflare sees request metadata (client IP, time, path). An operator can reduce what it keeps by turning off Logpush, Web Analytics and similar features for the issuer's hostname where the plan allows |

- SQLite runs with `secure_delete`, `synchronous = FULL` and a rollback journal (`journal_mode = DELETE`).
- Once an epoch's issuance window has closed (plus the margin), its rows are deleted. Only the per-epoch count stays, and the epoch is marked closed, so late
  requests for it get `wrong-epoch`. Keep `/data` and the key directory out of host backups and snapshots.
- An epoch closed above the highest epoch this version ever closed (a store carried over from code before the current/next
  rule, which closed E at `S(E)`) is reopened at the next tick, with a warning in the log, if no token was ever issued for it
  and no report is recorded: closing deleted nothing for it, so dedup is intact. This is one-way: an epoch closed by the
  current rule is never reopened, even if the tip goes back. An epoch that stays closed while its window is open is not
  listed in `/v1/info` (`keyIds`, `ready`), and the status problem says why.
- After the window closes the issuer publishes `issuerReport {epoch, tokensIssued}` with the HIGH key, once per epoch
  it served. Tokens for E can be issued until `S(E+1)` (Standard mode), so the report is published after that, and
  readers accept it only if it was created in `[S(E+1), S(E+1)+W]` and is plausible, and compare it with the
  number of valid badges. If a report for the epoch already exists with another count (another instance, or a stolen
  report key), the issuer logs an error: the document is immutable. It publishes only once Platform's core height has
  reached `S(E+1)`. A stolen HIGH key can publish reports for future epochs now: readers reject them as out of window,
  but the unique index then blocks the real report, so those epochs can never be audited; recovery needs a new issuer
  identity.
- Logs are JSON lines on stderr. They never contain IPs, proTxHashes, request strings, blinded messages or
  signatures, and token events are not logged one by one. Only hourly aggregate counters are logged (`issued`,
  `retry`, and a counter per error code).
- Nothing about which MN took part is published.

## Configuration

Environment variables plus secret files. An empty value means the default. Secrets are only read from files.

| Variable | Default | |
|---|---|---|
| `NETWORK` | `mainnet` | `mainnet`, `testnet`, `devnet`, `regtest`. Devnet and regtest use the testnet Platform |
| `ISSUER_IDENTITY_ID` | | required: base58 id of the issuer identity |
| `BADGE_CONTRACT_ID` | | required: base58 id of the `badge` contract |
| `CORE_RPC_URL` | `http://127.0.0.1:<network port>` | |
| `CORE_RPC_USER` | | |
| `CORE_RPC_PASSWORD_FILE` | | file with the RPC password (`CORE_RPC_PASSWORD` also works, for development only) |
| `CORE_RPC_TIMEOUT_MS` | `15000` | |
| `ISSUER_KEY_DIR` | `./keys` | `epoch-<E>.pem` files; the image sets `/keys` |
| `ISSUER_MAX_STAGED_KEYS` | `1` | keys for epochs after the one being issued |
| `ISSUER_HMAC_SECRET_FILE` | | hex, at least 32 bytes; random per process if unset |
| `ISSUER_CHALLENGE_TTL_S` | `600` | minimum 30 |
| `DB_PATH` | `./data/issuer.sqlite` | the image sets `/data/issuer.sqlite` |
| `HTTP_HOST` / `HTTP_PORT` | `127.0.0.1` / `8789` | the image sets `0.0.0.0` |
| `ISSUER_REPORT_KEY_FILE` | | **required**: the identity's HIGH key file for `issuerReport` (readers flag an issuer without reports, clients post no badge without one). Must belong to `ISSUER_IDENTITY_ID` |
| `ISSUER_MAX_TOKEN_RPS` | `2000` | requests per second allowed into signature recovery (per-MN limits apply after authentication) |
| `ISSUER_TICK_S` | `30` | seconds between epoch housekeeping runs (min 1) |
| `ISSUER_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Deployment

The compose service `issuer` (profile `issuer`) is in `deploy/docker-compose.yml`. It is built from this Dockerfile with the
repository root as context, joins `default` (dashd RPC) and `edge`, and publishes `${ISSUER_BIND:-127.0.0.1}:${ISSUER_PORT:-8789}`. It
uses the secrets `core_rpc_password`, `issuer_hmac_secret` and `issuer_report_key`, and the volumes
`issuer-data:/data` and `${SECRETS_DIR}/issuer-keys:/keys` (mode 0700, uid 1000, writable so the service can
destroy old keys). `deploy/scripts/init.sh` creates the HMAC secret, an empty `issuer_report_key.json` placeholder
(the service refuses to start until you fill it) and the key directory. `deploy/docker-compose.issuer-tunnel-guest.yml` publishes it
through another stack's tunnel via the guest's gateway. How to publish it, and the testnet deployment, are in
`deploy/README.md` (sections 11.5 and 13.2).

## Web client

The badge flow is in `apps/web/src/badge`:

- **Get MN badge** at `/badge`: the user pastes the proTxHash and the voting key (WIF). The MN keyring can do the
  same with `useBadgeClient().requestBadge(votingKeyWif | signer, proTxHash, {issuer?, keepKey?})` and registers its signer
  with `registerVotingSigner(proTxHash, signer)` while it is unlocked.
- Blinding, finalizing and every call to the issuer run in a Worker, from the portal's own pinned build, never from
  code the issuer serves. Calls use `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'` and
  `redirect: 'error'`.
- The key and epoch come from the proved `issuerKey` and Platform's core height. The request is sent at a random
  height in the issuance window (the next epoch's, if less than a quarter of the current one is left), and the badge is
  posted at a random height in the posting window.
- **Activity separation** (`visit.ts`), browser-wide and time-based (localStorage, across tabs, reloads and identities): a
  token request goes out only after half an hour without any Platform write from this browser (every identity state
  transition is recorded at the PlatformPort) and without another request; badge posts wait half an hour after the last
  request, and go before requests. The check and the mark run under a browser-wide Web Lock. A failed request waits a
  random 1 to 3 hours; the page shows the error, the next try, and a "Retry now" button. During the cooldown every tab asks the user not to post. One scheduler per identity runs across
  tabs (Web Locks), and every save merges into the latest stored jobs under a lock. Jobs are stored per (identity,
  signing key); an entry that does not decrypt is never overwritten.
- A Private / Extra private badge is posted only when the issuer's report for the epoch before shows at least the network's
  minimum number of tokens (testnet 5, mainnet 20): a badge among two or three would stand out. The report has one count
  for all tokens of an epoch, Standard ones included, so it cannot say how many chose a private mode; the minimum is set
  higher to allow for that, and the page says so. If the issuer served that epoch but published no report, the badge is not
  posted (readers hide the issuer's badges then anyway). A token request that never reached the issuer (the challenge
  failed) does not start the half-hour cooldown.
- One request per issuer per epoch per identity. More would only tell the issuer which MNs belong together.
- Pending jobs are kept in `localStorage`, encrypted with AES-256-GCM under
  `HKDF-SHA256(identity signing key, salt "govhub-badge-store-v1", info identityId)`, with the identity id as AAD,
  padded to 16 KiB buckets. The pasted voting key is forgotten once the request is sent, unless the user opts in to
  renewal (`keepKey`, off by default). Finished jobs forget the proTxHash.
- Settings has the trust list and the audit status per issuer. The default list is pinned in the client and has
  our issuer only: `govhub`, `H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH`, `https://gov-issuer-testnet.dashhq.org`.
- The discussion filter "Proposal owner + MN owners" becomes the default once any trusted badge is live.

## Trust and residual risks

The badge means "controls the voting key of a valid masternode, according to issuer X". It is disclosed in the UI.

| Risk | What it means |
|---|---|
| Issuer soundness | An issuer can mint fake badges. `issuerReport` is self-reported, so the audit only catches an issuer whose public badges exceed its own claim |
| Issuer knowledge | The issuer learns which MNs asked, when, and their IP and browser. A badge is anonymous only among the MNs that asked that issuer in that epoch |
| Same IP | The issuer sees the request's IP address; the DAPI nodes the app uses see the same address when the identity reads or writes. An operator running both (on testnet, and likely on mainnet, the issuer's operator runs evonodes) links the MN to the identity whatever the timing. The Cloudflare tunnel also sees request bodies with client IPs. Use Tor or a VPN, and a second independent issuer |
| Small crowds | A badge that appears for the first time (or stops) can be matched to an MN that started (or stopped) asking at the same time when few others did. The client posts nothing below the minimum token count; the issuer still chooses whom it serves |
| Session timing | The half-hour separation stops exact matching, not statistical matching: requests go out only while the app is open, so over many epochs an issuer can still correlate request times with sessions in which an identity writes later. It covers this browser and origin only; a user who writes right after a request (despite the note) links the two |
| Public fingerprinting | Comments that state votes can be matched against public per-MN vote records. Keep voting and commenting separate |
| Delegated voting keys | A host or pool that holds a voting key can mint a badge for it. Accepted |
| Wait time | A new MN waits up to one epoch plus W (testnet ~27 hours, mainnet ~32 days) |
| One badge per issuer | Dedup is per issuer. An MN can get a badge from each issuer, so k issuers give k badges. They are shown per issuer and never summed |
| Client libraries | The browser's blinding uses sjcl, which is not constant-time (local only). `blindrsa-ts` is small and 0.x; it is pinned |

## Future work (not implemented)

**Federated global dedup.** Issuers that trust each other share a secret key K and write tags
`HMAC(K, proTxHash || epoch)` under a Platform unique index, so the public sees only random tags and counts.
Trade-offs: it works only inside the federation, the members can de-anonymize each other's participation, and
nothing in it is publicly auditable.

True unlinkable dedup across all issuers needs a zero-knowledge nullifier (PLAN-r2 section 8, shelved). A public
on-chain registry of which MN took a token was considered and rejected, because it publishes participation per MN.

## Testnet setup

`scripts/testnet-setup.ts` is one-off tooling (run `npx vite-node scripts/testnet-setup.ts` from `services/issuer`).
It created the testnet issuer identity (separate from the bridge and moderation identities, funded from the QA
wallet) and registered the `badge` contract. Its secrets stay in `~/.local/share/govhub-issuer-testnet/`; it prints
none. Ids and the deployment are in `deploy/README.md` section 13.2.

## Tests

`npm test -w @govhub/issuer` runs offline against fakes of Core and Platform, on the RFC 9474 vectors in `test/vectors`:
the signer (including a simulated faulty CRT signature, which must be refused), challenges, the token store, the
order of checks and every error code, the HTTP layer, the epoch manager (key loading, late keys, staged-key limit, key
destruction, row deletion, reports), and `publish-keys` (late keys, adoption, conflicts).
