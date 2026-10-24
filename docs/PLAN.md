# DashCentral-on-Platform — plan r3.2 (2026-10-24)

Working name **govhub**, at `gov.dashhq.org`. It replicates dashcentral.org's governance features
and includes all of EvoVote (vote.dashhq.org stays live for now). All app data is on Dash
Platform, and browsers read Platform directly with proofs. The backend covers only what Platform
can't do: run Dash Core, hold signed votes until their release time, store central-login
envelopes, and vouch for masternode (MN) owners.

The earlier revisions are kept as `PLAN-r2.md`. r3 drops the DashCentral mirror and sponsored
posting, uses the existing faucet for initial credit, and replaces the ZK badge with
blind-signature issuers. Anything marked *estimate* is measured in phase 0.

## Decisions (user, 2026-10-23)

**Scope**
- In: DashCentral governance features, community up/down votes, a DashCentral-compatible JSON
  API that we serve, and all EvoVote features.
- Out: MN monitoring and earnings, notifications, the Android app, the shoutbox, and **anything
  that needs DashCentral's data or API key** (no description or comment mirror).

**Backends and network**
- Our backends are the default, and every one of them is pluggable and replaceable by the user.
- Platform-login users may use our relays. Prove as much as possible through Platform.
- Ship v1 contracts on PV13 mainnet now and migrate when PV14 (5.0) activates. Release does not
  wait for activation. A release-candidate SDK (5.0 rc) is OK.

**Login and money**
- Login is a standard Dash seed that other wallets can restore.
- **No free posting, ever.** Users get initial credit only, from **our existing faucet with its
  existing rate limits**, about 0.003 DASH: enough for an identity and a few documents. After
  that, users top up with real DASH.

**Proposals and comments**
- Recreate proposal.dash.org's proposal creation on DAPI.
- Comments are open to everyone. The default filter shows MN owners plus the proposal owner on
  their own proposal.

**Voting and privacy**
- Deferred voting needs to hide which MNs belong together from the public, not from the relay.
- MN number privacy: disclose only that someone is an MN owner, never how many MNs or which type.
- The MN badge comes from a **trusted backend issuer** (us or someone else), using blind
  signatures. Badges show who vouched. Longer epochs are allowed.
- **No external audit.** Review is done by agents.
- We own the bridge, moderation, and issuer keys. Funding votes only.

The faucet's vout bug is being fixed separately.

---

## Phase 0 results (r3.2): these override the sections below

The full report is in [`PHASE0.md`](PHASE0.md).

**SDK and DAPI**
- **evo-sdk 5.0.0-rc.8 on mainnet PV13 (read-only): works.** It stays at version 13, connect takes
  63–143 ms, and the first proven query takes 0.5–0.9 s. The SDK chunk is 8.7 MiB gzipped.
- **evo-sdk 5.x has no Core API.** The browser uses our own grpc-web DAPI client (`packages/dapi`,
  ~9 KB gzipped, plus 24 KB for ChainLock BLS verification). Every Core flow in §4.4 and §6.1 was
  proven from a real browser origin against mainnet.
- **IS-locks arrive 1.0–3.3 s after the transaction and are never replayed.** Deposit watchers must
  subscribe *before* showing the QR code and must persist the IS-lock bytes. Otherwise only the
  chain-lock proof path is left.

**Votes and hashes**
- **Testnet votes are signed over the binary vote hash, not with message signing** (vote.cpp:176).
  Offline `signmessage` mode is mainnet only. Both schemes are in `@govhub/verify`; the testnet one
  still needs one real `voteraw`.
- **Hash byte order is decided:** every hash on Platform is in RPC/display order. Only the
  collateral `OP_RETURN` uses raw order, and the conversion lives in `@govhub/verify`. Its hash and
  collateral checks match Core on regtest and on all 28 live mainnet proposals.

**Identities and costs**
- **Identities are created with 3 keys** (MASTER, CRITICAL, HIGH: 0.00106 DASH). The 6-key layout
  costs 0.00182. TRANSFER and the DashPay ENC/DEC keys are added later only when needed: the same
  derivation paths, key id = index, so wallets still restore it.
- **A 0.003 DASH starter covers that identity plus about 3 short comments.** A first reaction costs
  about as much as a comment (0.0005 DASH), and flipping one costs 0.00003.

**Queries and schemas**
- **Query rule (PV13):** Drive breaks ties between candidate indexes by index name. Every query must
  carry an `orderBy` ending on the intended index's last property. `where` values for byte arrays
  are base64 strings.

**Badges**
- **Readers take the issuer and epoch from the proved `issuerKey` document, never from the badge.**
  The blind signature doesn't authenticate them.
- The issuer signs with OpenSSL raw RSA (0.3 ms) and verifies before returning. The library's JS
  signer is about 700× slower and skips that check.
- Clients run `blind()` in a Worker.
- Readers verify 100 badges in about 2 ms.

## 0. Constraints that shape the design

| Constraint | Consequence |
|---|---|
| Mainnet PV13; PV14 date unknown; testnet already PV14 | **evo-sdk 5.x (≥ rc.8, pin 5.0.0 when it is tagged)**. It seeds at protocol version 13, ratchets up only from proven metadata, and reads PV13-era data. 4.1.1 breaks once PV14 activates. One codebase, with features gated on the detected protocol version. Phase 0 proves that 5.x can read and write on PV13 mainnet. |
| PV13: no `refersTo`/`distinctFrom`/`ttl`/typed arrays/multi-`In`/ranked counts/bound auth keys/App Connect | v1 contracts are plain. The v2 contracts on PV14 adopt these features (§3.2). |
| Indexes are frozen per document type | That's acceptable. Contract versions are in config; clients read all versions and write to the newest. |
| Field ≤ 5,120 B; state transition ≤ 20,480 B; one document per batch | Long descriptions are deflated and split into 3 fields. Signatures are small. |
| PV13 gapped-index bug | Queries use an equality prefix plus at most one range or `in` on the next index property, ordered in index order. Lint this in CI. |
| DAPI has no governance RPCs | The bridge is required for governance data. DAPI covers all other Core data: transactions, blocks, ChainLocked headers, the SML, and IS-locks (verified live on mainnet). |
| Core discards expired proposals and votes that have been superseded | The bridge archives raw objects and votes from ZMQ from day one. |

---

## 1. Architecture

```
 Browser (static SPA on Pages + IPFS, evo-sdk 5.x, packages/verify, packages/badge-client)
   │  Platform reads/writes (proof-verified) ───────────────► DAPI evonodes (grpc-web)
   │  Core: tx / blocks / ChainLocked headers / SML / IS-locks ─► same evonodes
   ├─(pluggable) bridge(s): raw signed votes, live tallies, SML snapshot, DC-compatible API
   ├─(pluggable) relay(s):  voteraw at release time, gobject submit, held Platform votes
   ├─(pluggable) badge issuer(s): blind-sign MN badge tokens (separate origin)
   ├─(pluggable) accounts (central login): encrypted envelopes only
   └─ faucet.dashhq.org (existing dash-faucet-cf): starter vouchers, existing limits

 bridge = dashd (txindex, zmq) + daemon → `gov` contract docs (bridge identity)
 relay  = queue in front of a dashd (may share the bridge's node)
 issuer = small service with SML access (dashd or DAPI SML stream) + offline-generated keys
 audit  = `govhub-audit` CLI against your own dashd → attestation docs on Platform
```

### 1.1 Pluggable endpoints

**Settings.** An endpoint registry in Settings can be exported, imported, loaded through
`?config=`, and synced with a user-owned `settings` document. Every number in the UI shows its
source endpoint and whether it was verified. The registry covers:
- the DAPI node source (quorum service or a manual list)
- bridges: `{name, httpBase, govContractId, bridgeIdentityId}`
- relays
- badge issuers, as a trust list (§8)
- the accounts service
- the faucet
- moderation lists
- the price feed
- the frontend origin, with reproducible builds and an IPFS CID

**Third-party bridges** publish into their own `gov` contract. The client merges proposals by
govHash, which is safe because each one is verified against its collateral, and cross-checks
tallies between bridges.

**Each service** ships with an OpenAPI spec, conformance tests, and a reference implementation
started with `docker compose up`.

---

## 2. Trust model ("can't lie to you")

| Data | What the browser checks | Residual risk |
|---|---|---|
| Platform documents | evo-sdk proofs | SDK quorum-key bootstrap |
| Proposal content | Recompute the gov hash, then call `getTransaction(collateral)` over DAPI. The output must be OP_RETURN = the **raw (unreversed)** hash, worth at least 1 DASH, every output P2PKH or OP_RETURN, with at least 6 confirmations and a ChainLock. *Check the hash preimage against Core's `gobject check` in phase 0.* | The bridge omits a proposal |
| Votes | Recover the compact signature over `"DarkCoin Signed Message:\n" + "txid-n\|parent\|1\|outcome\|time"`. Then `hash160` must equal `keyIDVoting` in the SML, and the outpoint must match the ProRegTx. | The bridge omits votes |
| Tallies | Recompute from the verified votes, with regular MNs ×1 and evonodes ×4, at `asOfHeight`, and compare with `voteSetHash` | Same as votes |
| SML | Use the DAPI `subscribeToMasternodeList` stream and cross-check it across 2–3 nodes. Later: anchor to CbTx `merkleRootMNList` and a ChainLock verified with BLS (the BLS check already works live). | v1 trusts that several nodes agree |
| MN badges | Verify the RSA blind signature against the issuer's key, which is published on Platform before the epoch (§8) | Issuer soundness is trusted and labelled "vouched by X" |

Against omission: multiple bridges, attestations from the audit CLI, and "verified vs reported"
markers in the UI.

---

## 3. Contracts

### 3.1 v1 (PV13 mainnet)

All contracts set `additionalProperties: false`. Hashes are 32-byte byteArrays. Integer index
values stay below 2^63, because PV14 re-keys unsigned integers around the midpoint.

**`gov`**: owned by the bridge; every type is `creationRestrictionMode: 1`.

| Type | Mut. | Fields | Indexes |
|---|---|---|---|
| `proposal` | no | `govHash`, `parentHash`, `revision`, `time`, `dataHex`, denormalized `name`/`url`/`paymentAddress`/`paymentAmount`/`startEpoch`/`endEpoch`, `collateralTxid`, `collateralHeight` | unique [govHash]; [endEpoch]; [name, $createdAt] |
| `tally` | yes | `govHash`, `asOfHeight`, weighted and unweighted y/n/a, `voteSetHash`, `rank`, `inNextBudget`, `margin` | unique [govHash] |
| `cycle` | yes | `superblockHeight`, `budget`, `allocated`, `votingDeadlineHeight`, `estTime`, `validWeighted`, `paid` | unique [superblockHeight] |
| `claimAttestation` | no | `govHash`, `identityId`, `method`, `note` | [govHash] |

**`forum`**: open contract.

| Type | Mut./Del. | Fields | Indexes |
|---|---|---|---|
| `profile` | y/y | `displayName`, `about`, `avatarUrl` | unique [$ownerId] |
| `comment` | n/y | `govHash`, `parentId?`, `body` ≤5000 B, `fmt` | [govHash, $createdAt]; [$ownerId, $createdAt] |
| `reaction` | y/y | `target`, `kind` (1 = comment, 2 = proposal community vote), `value` ±1 | unique [$ownerId, target]; [target, $createdAt] |
| `claim` | n/y | `govHash`, `method`, `sig` | [govHash, $createdAt] |
| `proposalPost` | y/y | `govHash`, `title`, `b0..b2` (deflated markdown), `links` | unique [govHash, $ownerId] |
| `proposalDraft` | y/y | `time`, `revision`, `dataHex`, `govHash`, `collateralTxid?`, `stage` | unique [$ownerId, govHash]; [stage, $updatedAt] |
| `block` | n/y | `target`, `kind` (1 = identity, 2 = document), `reason` | unique [$ownerId, target] |
| `blockSubs` | y/y | `lists` (packed), `defaultOff` | unique [$ownerId] |
| `settings` | y/y | `endpoints` (deflated JSON) | unique [$ownerId] |
| `vault` | y/y | passkey vault (Yappr HPKE/PRF, no `refersTo`) | unique [$ownerId, credentialId] |

**`badge`**: open. Every type is `documentsMutable: false`, `canBeDeleted: false`, `transferable: 0`.

| Type | Fields | Indexes |
|---|---|---|
| `issuerKey` | `epoch` u32, `spki` 294–422 B (rsaEncryption DER, RSA-2048/3072 only), `keyId` = SHA256(spki), `variant` = "RSABSSA-SHA384-PSS-Randomized" | **unique [$ownerId, epoch]** (one key per issuer per epoch; blocks key tagging) |
| `issuerRevocation` | `epoch`, `keyId`, `effectiveCoreHeight` | unique [$ownerId, epoch] |
| `issuerReport` | `epoch`, `tokensIssued` | unique [$ownerId, epoch] |
| `mnBadge` | `issuerId`, `epoch`, `keyId`, `msgPrefix` (32 B), `sig` (256 or 384 B) | unique [issuerId, epoch, $ownerId] (phase 0: this order is needed so readers can query `$ownerId in [...]`) |

**`mod`**: owned by the moderation identity. Holds the default `block` list.

`proposalDraft` lets the relay auto-submit at 6 confirmations, and it keeps the prepare
parameters, which can't be recovered if lost.

### 3.2 v2 (PV14 track, built on testnet now)

**PV14 features adopted:**
- `refersTo`: comment → proposal, reaction → target, claim → proposal
- `distinctFrom`: no self-reactions
- `indexOnly` reactions, which cost less than half as much
- ranked counts for scores and top comments
- multi-`In`
- `ttl` where useful
- **contract-bound, budget-limited, expiring session keys** for central users
- **App Connect** wallet login

**Not adopted:**
- No sponsored gas and no posting token (user decision).
- *Option:* the PV14 moderation-charters system lets MNs elect the team behind the default block
  list. Decide this before the v2 contracts are created, because contract moderation can't be
  added later.

### 3.3 Migration runbook (PV13 → PV14)

Conformance tests run against both v1 (on a local dashmate v4.1.1 network) and v2 (on testnet).

At mainnet activation:
1. Register the v2 contracts.
2. The bridge re-publishes active and recent `proposal`, `tally` and `cycle` documents.
3. The moderation identity re-publishes the default list.
4. Issuers publish their keys in the v2 `badge` contract. Epochs roll over naturally.
5. Clients read v1 and v2 and write v2. A one-click button copies a user's blocks, profile and
   settings to v2.

Audit before activation: changed gapped-index results, the unsigned-int re-key, the PV14 ban on
keepsHistory types that can be deleted, no `-` in names, and the 5.0 rc.7/rc.8 wire break.

---

## 4. Login, identities, funding

### 4.1 One standard Dash seed

- **Seed:** BIP39 with **no passphrase** and identity index 0, derived along DIP-13 paths
  `m/9'/5'/5'/0'/0'/0'/id'` (testnet uses coin type 1').
- **Key layout** (DashPay iOS's layout; key id = key index):
  - 0: AUTH / MASTER
  - 1: AUTH / CRITICAL
  - 2: AUTH / HIGH (signs our documents)
  - 3: TRANSFER / CRITICAL
  - 4, 5: ENC / DEC, MEDIUM, bound to DashPay `contactRequest`. These can be added later to keep
    identity creation cheap; measure in phase 0.
- **Restores in:**
  - DashPay iOS (key-0 scan, no username needed)
  - Dash Evo Tool
  - Yappr's recovery-phrase sign-in, which is currently testnet only
  - Android: needs a test on a real device
- **Platform login** accepts this seed, an existing DashPay or Evo Tool seed, a pasted key
  (EvoVote-style), or a passkey vault. App Connect wallet login comes with v2.

### 4.2 Central login

- The seed is generated in the browser. It's shown once, and the user can always export it.
- The **envelope** holds the seed plus any MN voting keys, encrypted with AES-GCM under a key that
  comes from a **passkey PRF** and/or an **OPAQUE** password. The server never sees the password
  or a plaintext key. Optional TOTP.
- Password-wrapped envelopes never go on Platform. Envelopes are padded to a fixed size, so the
  server can't count a user's MNs.

### 4.3 Starter credit (existing faucet)

- faucet.dashhq.org, which we own, issues a pre-minted, ChainLocked asset-lock voucher.
  - The amount is about **0.003 DASH**, enough for an identity plus a few documents.
  - It's a portal-specific amount or route, protected by the faucet's **existing limits**
    (Turnstile and the edge rate limit).
- The browser creates the identity **with its own keys** using a chain-lock proof. The voucher
  only funds the identity; the operator never controls it.
- Anyone can claim one, central-login or Platform-login.
- No sponsorship. When the credit runs out, the user tops up.

### 4.4 Top-up with external DASH (DAPI only)

This is Dash Bridge's flow with Insight and rpc.digitalcash.dev replaced by DAPI.
1. Show a QR code for a one-time key at the top-up path (`m/9'/5'/5'/2'/0'/n`).
2. Open `subscribeToTransactionsWithProofs` from `tip-3`, with a bloom filter of **at least 200 B**.
3. When the deposit appears, build and broadcast the type-8 asset lock.
4. Take the IS-lock from the same stream (about 1 s), then call `identities.topUp`.
5. If no IS-lock arrives, fall back to a chain-lock proof.

Minimum 51,000 duffs. Nodes come from the quorum service; refresh the list every session because
nodes use 6-day certs; stay under 150 requests per minute per node. bridge.dashhq.org stays linked.

---

## 5. Voting

### 5.1 Core governance (funding votes only)

- **Keys:** voting keys live in memory only, in the passkey vault, or in the central envelope.
  There is also an **offline-sign mode**, which shows the exact strings to sign with
  `signmessage` in Dash Core, DMT, or a hardware wallet.
- **Signing:** the browser signs with the DarkCoin message magic (65 B, low-S) and POSTs to the
  relay(s), which call `voteraw` (base64 signature).
- **Confirmation:** the client checks the vote shows up in the bridge's vote list and keeps a
  signed copy so it can re-broadcast elsewhere.

### 5.2 Deferred / randomized voting (public unlinkability)

Core facts this relies on:
- nTime is signed, and Core rejects votes timed more than 1 h in the future.
- Core never rejects a vote for being old.
- An MN can change its vote on a proposal at most once per hour.

How it works:
1. For each MN the client samples an independent Tᵢ before the voting deadline minus 12 h. The
   deadline is the 1,662-block maturity window before the superblock.
2. Each vote is signed with nTime = Tᵢ and submitted as its own request after a random delay,
   optionally to a different relay.
3. The relay broadcasts at Tᵢ.
4. A cancel or replace signed with the voting key drops a held vote.
5. If a vote isn't visible by Tᵢ + δ, the watchdog re-broadcasts it.

### 5.3 EvoVote features (Platform contested resources)

- DPNS contested-name contests on PV13. Moderator elections and charters come on PV14.
- The same stored voting key is used. The voter identity is `SHA256(proTxHash ‖ keyIDVoting)` and
  needs no credits. Each MN gets 5 changes per contest.
- Votes can be pre-signed with consecutive nonces (24-slot window) and held by the relay for
  randomized broadcast.
- EvoVote's SDK quirks carry over: rebuild polls from live results, use the proTxHash in display
  order, verify by re-reading, and expect error 40305 after a voting-key change.

---

## 6. Proposals

### 6.1 Creation wizard (replaces proposal.dash.org and fixes its bugs)

The old generator counted blocks instead of confirmations, never checked the OP_RETURN, and lost
state on reload.

- **Validation** uses Core's rules: name `[-_a-z0-9]{1,40}` (case-insensitive), data ≤ 512 B, P2SH
  payout allowed.
- **Payment schedule** is superblock-aligned, the same as the generator: 16,616-block cycle,
  1,662-block maturity, ~155 s per block. It shows total cost and checks against the available
  budget from the bridge's `cycle` doc.
- **URL** defaults to `https://gov.dashhq.org/p/<identityId>/<name>`, which makes the claim
  trustless (§6.3).
- **State** is saved in a `proposalDraft` doc and localStorage.
- **Collateral**, two ways:
  - (a) A `gobject prepare` command for Dash Core. The user pastes back the txid, and the
    browser checks the tx over DAPI (OP_RETURN, amount, output types).
  - (b) In the browser: a one-time key with a backup, then a QR code for at least 1.0001 DASH.
    A DAPI stream detects the deposit, and the browser builds
    `[OP_RETURN hash (1 DASH), change → P2PKH refund]`.
- **Confirmations** come from the ChainLocked header stream plus `getTransaction`.
- **Submission:** the relay auto-submits from the `proposalDraft` at 6 confirmations, after
  re-verifying.

### 6.2 Ingestion

The bridge takes the ZMQ raw objects and votes and reconciles them with
`gobject list/get/getcurrentvotes`.
- A `proposal` doc is published at 6 confirmations.
- A `tally` doc is replaced when anything changes, throttled to about hourly (*estimate*: about
  0.015 DASH/day).
- Live numbers between snapshots come from the bridge API.

### 6.3 Claims (highest-ranked method wins)

1. **URL-embedded:** the URL is committed in the collateral hash, so the claim is trustless.
2. A signature from the payment address.
3. A signature from the collateral input key.
4. A hosting-team `claimAttestation`, for P2SH, multisig, or lost keys.

The description shown is the owner's `proposalPost`, otherwise the raw fields and a link to the
proposal URL. There is no DashCentral import.

---

## 7. (removed in r3: DashCentral mirror)

---

## 8. MN owner badge: blind-signature issuers

The goal is public "MN · vouched by X" with no MN identity, no count and no type. An adversarial
review on 2026-10-23 (Opus, standing in for the audit) found 3 critical and 6 high-severity
issues in the first draft. The protocol below includes all of the fixes.

### 8.1 Primitive

**RSABSSA-SHA384-PSS-Randomized** (RFC 9474) is mandatory.
- The randomized variant adds a 32-byte `msgPrefix`. The message has little entropy, because
  identity ids are public, so a deterministic variant, or a malformed issuer key, could let the
  issuer recover it.
- Client side: `@cloudflare/blindrsa-ts` (blind, finalize, verify).
- Issuer signing uses Node/OpenSSL raw RSA, which is CRT and constant-time with blinding, or Go
  CIRCL `blindrsa`. Either way the issuer **verifies the signature before returning it**, because
  a single faulty CRT signature leaks the key.
- Rejected: Privacy Pass (equivalent, just more framing), partially-blind RSA (an expired draft),
  VOPRF (readers can't verify it), and BBS (draft status, and not needed).

### 8.2 Epochs (keyed to superblocks)

- **Epoch E = one superblock cycle** (16,616 blocks ≈ 28.8 days). The user allowed longer epochs,
  but the reviewer recommends one cycle: three-cycle epochs would make a new MN wait about 130 days
  for a badge and add little anonymity. The length is configurable, and changing it is a contract
  version.
- **Tokens for E are only minted during epoch E−1,** and only for MNs that were valid at snapshot
  height S(E−1) and still have the same proTxHash and collateral.
- **Badges for E are only posted at or after S(E).** Readers enforce this using
  `$createdAtCoreBlockHeight`. Because every token is issued before any badge is posted, the
  issuer can't match a token to a badge by timing. There is no fast path for late joiners.
- A badge is shown during [S(E), S(E+1) + W], where W = 2,016 blocks (about 3.5 days) of grace.
  Renewal is automatic, so a lapse doesn't sharply reveal that an MN left.

### 8.3 Message formats

- **Badge message** (fixed-width binary, prefixed by the library's PrepareRandomize):
  `"govhub-badge:v2" ‖ net(1) ‖ contractId(32) ‖ issuerId(32) ‖ keyId(32) ‖ epoch(u32 BE) ‖ ownerId(32)`
- **Token request**, signed with Dash `signmessage` by the **MN voting key only**
  (user decision):
  `govhub-badge-req:v2|<net>|<issuerId>|<epoch>|<keyIdHex>|<proTxHash>|<nonce>|<sha256(blindedMsg)>`
  - Binding `H(blindedMsg)` stops anyone who sees the request (a CDN, an extension, the hosting
    provider of a delegated key) from stealing the slot.
  - Because this uses `signmessage`, hardware wallets and DMT work and no key has to be in the
    browser.

### 8.4 Issuer rules

1. Hand out stateless HMAC challenges with a short expiry.
2. Recover the public key from the request and check `hash160` = `keyIDVoting` in the current SML.
3. Check the MN was valid at both S(E−1) and now, with the same collateral outpoint.
4. Atomically insert into a unique key on (proTxHash, epoch) and another on (collateralOutpoint, epoch).
   - This stops re-registration and collateral churn.
   - A retry with the same `H(blindedMsg)` gets the same signature back; a different one is refused.
5. Sign, verify, return.
6. Keep minimal logs and no IPs. Delete records after epoch E+1.
7. Generate keys offline. Publish `issuerKey` docs **at least 3 epochs ahead**, so a later
   compromise can't claim those slots. The server only holds the current key, and each key is
   destroyed after its window.
8. Publish `issuerReport` each epoch, so readers can check that badges ≤ tokens issued ≤ eligible MNs.

### 8.5 Client rules

- The blinding code is **independent of the issuer**. It lives in the open-source
  `badge-client` package with reproducible builds and is served from the portal's pinned
  SRI/IPFS build, never from the issuer's origin.
  - Without this, an issuer could serve code that leaks the identity.
  - The default issuer runs on a **separate origin** from the portal.
- The client derives `keyId` and the epoch itself, from a **proved** Platform query and the Core
  height. It never takes them from the issuer.
- Request one MN per session. Prefer Tor or OHTTP. Use `credentials:'omit'`, `no-referrer`, and
  no storage.
- Use a fresh CSPRNG `r` and `msgPrefix` every time. Verify the finalized signature. If
  verification fails, start over and flag the issuer.
- Post the badge at a uniformly random time in [S(E), S(E)+W], through a random DAPI node the
  issuer doesn't operate.
- Warn (or refuse, where possible) when the identity is funded from wallets tied to MNs or has
  credit transfers from MN identities. Faucet vouchers are fine, because the faucet never checks
  MN status.

### 8.6 Reader rules

- Proved queries only, and only issuers on the local trust list. Unknown issuers show as
  "unverified issuer" or are hidden.
- The key must be the unique `issuerKey` for (issuer, E), created before S(E−1), and not revoked
  before the badge's height.
- The badge's height must be inside the display window. The signature must have modulus length,
  s < N, and pass RSABSSA verify. The message is rebuilt with `$ownerId`, so copying a badge to
  another identity fails.
- Display only "MN · vouched by X". Never counts, history or type. Badges are never summed across
  issuers: k issuers means one MN can earn k badges, so any count is per issuer.
- The default trust list is pinned in the open-source client and changed through public review.
  It ships with our issuer only. Adding other issuers, including ones run by other organizations,
  is supported but not planned.

### 8.7 Residual risks (disclosed in the UI and docs)

- **Issuer soundness:** an issuer can mint fake badges. This is accepted and labelled. It can only
  be audited through `issuerReport`.
- **Issuer knowledge:** an issuer learns which MNs (and voting-key clusters) took part, and
  request IP and browser fingerprint. A badge is anonymous only among participating MNs (perhaps
  50–500), not among all ~3k.
- **Same operator:** if one organization runs the issuer, portal, faucet and DAPI nodes, IP and
  browser correlation is the main de-anonymization risk. Use separate origins, Tor/OHTTP, and a
  second independent issuer.
- **Public fingerprinting:** comments that state votes can be lined up against public per-MN vote
  records, which also reveals the size of a shared voting-key cluster (that is, the count). This
  is not a cryptography problem. Keep the voting and commenting UIs separate, and warn users.
- **Delegated voting keys:** hosting providers and pools that hold voting keys can mint badges.
  This is accepted: the badge means "controls a valid MN's voting key".
- **Wait time:** a new MN waits 1–2 epochs (about 43 days on average) before it can show a badge.

---

## 9. Moderation

- The moderation identity (ours, separate from the bridge) publishes the default list. Clients
  subscribe to it by default and users can opt out or add other lists.
- Lists can target identities **and** individual documents. Moderation is hide-not-delete, with a
  "show hidden (N)" toggle. Bloom filters can come in v2 if lists grow.
- The default comment view shows badged authors plus the proposal owner on their own proposal.
  "Show all" is one click.

## 10. Frontend

- **Stack:** a React + Vite SPA that lazy-loads evo-sdk 5.x (~12.6 MB WASM). IndexedDB cache,
  strict CSP, SRI-pinned `badge-client`, hosted on Pages (gov.dashhq.org) plus IPFS.
- **DashCentral's information architecture:**
  - Budget header.
  - Active and past proposal lists with traffic-light bars and "needs N more yes".
  - Proposal info table.
  - Badges: MN · vouched by X, proposal owner, recently posted.
  - Infinite scroll, `/p/<slug>` URLs and `?comment=` links.
- **Added:** provenance markers, an EvoVote section, and optional CI prerender for SEO.

## 11. Shared code

Packages:
- `packages/verify`:
  - gov hash and collateral checks
  - vote signature recovery
  - SML parsing and ChainLock BLS
  - tally recompute
  - badge verify
- `packages/badge-client`: blind, finalize, schedule.
- `packages/contracts-{v1,v2}` and `packages/client`.

Repo `PastaPastaPasta/govhub`. Apps and services: `apps/web`, `services/{bridge,relay,issuer,accounts}`, `tools/audit-cli`.

Quality gates, since there is no external audit:
- code-review-validator and an adversarial Opus pass on every security-relevant PR, covering
  badges, envelopes, signing, verify, and relays
- property and fuzz tests on `verify` and `badge-client`
- RFC 9474 test vectors in CI

## 12. Phases

| # | Deliverable | Exit check |
|---|---|---|
| 0 | Spikes:<br>• evo-sdk 5.x reads and writes on **mainnet PV13** (throwaway contract)<br>• v1 contracts on local dashmate 4.1.1<br>• **measured** costs for identity (3 vs 6 keys), comment, reaction, replace<br>• gov-hash vector vs `gobject check`<br>• DAPI flows in a real browser<br>• 0.003 voucher → identity<br>• Android seed restore<br>• `blindrsa-ts` in the browser and against the Node issuer | Go/no-go table |
| 1 | Read-only:<br>• bridge (archive and publish)<br>• `gov` v1 on mainnet<br>• budget and proposal pages<br>• collateral and vote verification<br>• endpoint registry | Matches the live network for a full cycle |
| 2 | Social:<br>• `forum` and `mod` v1<br>• seed, key and passkey login<br>• faucet voucher onboarding and DAPI top-up<br>• comments, reactions, claims, proposal editor, block lists | Moderation drill |
| 3 | Voting and proposals:<br>• accounts service<br>• immediate and offline-sign voting through relays<br>• proposal-creation wizard with relay auto-submit<br>• DashCentral-compatible API | Live mainnet vote and proposal from the browser |
| 4 | Badges:<br>• `badge` contract<br>• issuer service with offline keys<br>• badge-client<br>• default "MN-only" filter switches on once the first epoch's badges are live | Adversarial review closed |
| 5 | Deferred voting, EvoVote contest voting, audit CLI | 5-MN randomized schedule lands |
| ∥ | PV14 track on testnet: v2 contracts, bound session keys, App Connect, migration rehearsal | Rehearsed cutover |

Badges need one full epoch of token issuance before the first display epoch. Until then, the
default filter is badge holders plus proposal owners, falling back to "all" while there are no
badges.

## 13. Risks

- **RC SDK on mainnet:** gated by phase 0. Pin 5.0 final when it's tagged.
- **Faucet:** relies on its existing limits (accepted). Its vout bug is being fixed separately.
- **No external audit:** mitigated by standard primitives (RFC 9474), test vectors, and agent
  reviews. A future ZK full-set proof (see PLAN-r2 §8) is shelved, because an unaudited custom
  circuit is too risky.
- **DAPI:** rate limits, short-lived certs, the IS-lock race (stream from several nodes and fall
  back to chain-lock), and no fee estimate (assume 1 duff/byte).
- **Relay and issuer metadata:** disclosed in the UI and docs.
- **Key custody:** PV13 has no multisig identities, so bridge, moderation and issuer keys are kept
  offline.

## Resolved questions (user, 2026-10-23)

1. Badge tokens are proven with the **voting key** only.
2. A second independent issuer only needs to be *possible*: the trust list is pluggable. We
   don't recruit one.
3. Repo: **`PastaPastaPasta/govhub`**.
