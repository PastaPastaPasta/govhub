# DashCentral-on-Platform — plan r3.2 (2026-10-24)

Working name **govhub**, at `gov.dashhq.org`. It replicates dashcentral.org's governance features
and includes all of EvoVote (vote.dashhq.org stays live for now). All app data is on Dash
Platform, and browsers read Platform directly with proofs. The backend covers only what Platform
can't do: run Dash Core, hold signed votes until their release time, store central-login
envelopes, and vouch for masternode (MN) owners.

The earlier revisions are kept as `PLAN-r2.md`. r3 drops the DashCentral mirror and sponsored
posting, and replaces the ZK badge with blind-signature issuers. (r3 first planned initial credit from
the existing faucet; the owner reversed that on 2026-10-25, see §4.3.) Anything marked *estimate* is
measured in phase 0.

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
- **No free posting, ever, and no starter credit (owner, 2026-10-25).** Everyone funds their own
  identity with DASH: about 0.003 DASH is enough for an identity and a few documents, and they top
  up with real DASH after that. See §4.3.

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
- **0.003 DASH of funding covers that identity plus about 3 short comments.** A first reaction costs
  about as much as a comment (0.0005 DASH), and flipping one costs 0.00003.

**Queries and schemas**
- **Query rule (PV13):** Drive breaks ties between candidate indexes by index name. Every query must
  carry an `orderBy` ending on the intended index's last property. `where` values for byte arrays
  are base64 strings.
- **PV13 mainnet write check passed** (§8 of `spikes/sdk5`). On PV13, unsupported query shapes return
  `[]` silently, and `desc` is ignored unless a range is added on the last property. The CI query
  lint enforces both.

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
- the faucet (where a pasted voucher link comes from; it is not a source of credit)
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
  `m/9'/5'/5'/0'/0'/0'/id'` (testnet uses coin type 1'). The account's funding key is `m/9'/5'/5'/1'/0` (not hardened, as
  rs-platform-wallet; docs/RECOVERY.md, "Derivation paths").
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

### 4.3 No starter credit (owner decision, 2026-10-25)

- **Everyone funds their own identity.** Govhub gives no initial credit, to anyone. Sign-up funds
  an account by one means: pay about 0.003 DASH from any Dash wallet to a one-time address (§4.4's
  DAPI flow), and the browser creates the identity with its own keys.
- This replaces the earlier plan (r3 up to 2026-10-24), which had the existing faucet hand out
  pre-minted 0.003 DASH asset-lock vouchers, and the blind-signed "starter" token for masternode
  and proposal owners that was built on it (PR #25, testnet only, never on mainnet). Both were
  removed: no starter issuer, no `/v1/starter/*` routes, no starter store, keys or settings. The
  badge issuer is unchanged.
- A `dashpay://invite` voucher link that someone else gives you can still be redeemed from the
  sign-in sheet ("I have a voucher link"); govhub itself operates and promotes no credit.
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

1. **URL-embedded:** the URL is committed in the collateral hash, so the naming is trustless. Naming is not consent: the named identity becomes the owner only once it accepts, by publishing its own `claim` document with method 1 for that govHash (its `$ownerId` is the acceptance; no signature). Until then it shows as "Named by the proposal's creator", not verified.
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
   destroyed after its window. A key can still be published late, up to S(E+1) − margin (§8.9),
   so a new issuer serves Standard mode in its first epoch.
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
  credit transfers from MN identities. A voucher link someone gives you is fine, because the faucet never
  checks MN status.

### 8.6 Reader rules

- Proved queries only, and only issuers on the local trust list. Unknown issuers show as
  "unverified issuer" or are hidden.
- The key must be the unique `issuerKey` for (issuer, E), created before S(E+1) − margin (§8.9; it
  was S(E−1)), not revoked before the badge's height, and not newer than the badge (the badge's
  `$createdAtCoreBlockHeight` is at least the key's).
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

### 8.8 Privacy modes (owner decision, 2026-10-24)

"We can accept some privacy concerns for linkage from the issuer. Give the options for longer delays for better privacy. Don't
force it. If people accept us learning that's ok. Just we keep no logs for stuff that could be used to link." This changes
§8.2 and §8.5 as follows (code: `packages/badge` `schedule.ts`/`epoch.ts`, `services/issuer`, `apps/web/src/badge`):

- **Modes, chosen per user** (remembered per identity in the browser):
  - **Standard** (default): a token for the *current* epoch E. Since 2026-10-25 the badge is not posted at once: the token
    is held in the browser and posted with the identity's next Platform write (§8.10). Before that, it was posted within
    minutes and the issuer could link the masternode to the identity by timing.
  - **Private**: §8.5 as written: a token for E+1 at a random time during E, posted at a random time in [S(E+1), S(E+1)+W],
    kept 30 minutes apart from the browser's other Platform writes, and not posted if the issuer reported fewer than k tokens
    (testnet 5, mainnet 20; raised from 3 and 10 because the report counts Standard tokens too) for the epoch before (E+1's own
    report comes too late, see below).
  - *Extra private* (as Private, posted across the first half of E+1) was removed on 2026-10-25: it complicated the choice for
    little gain (§8.10). Saved Extra jobs and a remembered Extra choice continue as Private.
- **Issuance window:** tokens for E are minted during E-1 **and** during E (`[S(E-1), S(E+1))`); the issuer accepts the
  current or the next epoch. Dedup stays one token per (proTxHash, E) and per (collateral, E), whichever mode asked.
- **Reader rules:** a badge for E is valid if created at or after S(E) and shown during [S(E), S(E+1)+W]; one
  issuerKey per (issuer, E), created before S(E+1)-margin (§8.9, relaxed from S(E-1)), and no badge older than its key.
- **Audit:** E's issuerReport can only be final once E's issuance window has closed, so it is published, and counts, in
  [S(E+1), S(E+1)+W]. Badges ≤ tokensIssued is checked then; an issuer flagged for E-1 is also hidden for E (its report for E
  arrives only as E ends).
- **No linkable logs:** the issuer stores only the dedup rows (epoch, proTxHash, collateral, H(blindedMsg)), deleted when the
  epoch's window closes; no request times, IPs or user agents anywhere (DB, application logs, the tunnel gateway, cloudflared
  at loglevel fatal). Cloudflare's edge is outside our control (`services/issuer/README.md`, "Logging policy").

### 8.9 Late key publication (2026-10-25)

The key rule "the `issuerKey` for E is created before S(E−1)" is relaxed to **created before S(E+1) − margin**
(`keyDeadline`), and readers gain a check: **a badge is never older than its key** (the badge's `$createdAtCoreBlockHeight`
is at least the key's; Drive's core heights only grow). Keys published under the old rule stay valid: the new rule accepts a
superset. No contract change.

Why the old rule added nothing:
- Key tagging is blocked by the slot, not by timing: one `issuerKey` per (issuer, E) (unique index), immutable and
  non-deletable. A client blinds only after a proved read of that key, so every token for E is signed by the one key,
  whenever it was published. A proof can be stale but not forged, and a stale proof shows the same key or none.
- Private mode asks during E−1, so it needs E's key then. An issuer that publishes ahead (§8.4 rule 7) has it; a key
  that appears after S(E) − margin means Private is not offered for E. Every private token still exists before any private
  badge.

The bound is S(E+1) − margin, the end of the last Standard request window for E: from there clients ask for E+1, so a later
key could serve no honest request. It also keeps every key before E's `issuerReport` (created from S(E+1)), so the report
covers every token the key could have signed.

Also checked, not a reason for the old rule:
- **Issuance window** `[S(E−1), S(E+1))`: unchanged; tokens for E are minted from the later of S(E−1) and the key's
  publication.
- **Crowd check** (`minAnonymitySet`): it reads E−1's report, and E−1 "has no key" (the first-epoch case, posted without
  the check) is final at S(E) − margin, before any private badge for E is posted.
- **Revocation:** unchanged; a revocation published before a late key voids it from its height on.
- **Reports and audit:** unchanged. Badges older than their key are void; both heights are immutable, so this cannot shrink
  a count after the fact.
- **Display windows:** unchanged.
- **Timing:** no client can ask before the key exists, and a client that sees "no key" sends nothing, so there is nothing
  to compare before and after.
- **A DAPI node hiding the key** (a stale proof of absence) or **partitions** between clients that saw "no key" and "key":
  the worst is a delay, as under the old rule. No client can be given a different key.

What it costs:
- A thief with the CRITICAL key can also fill an empty slot for the current or the next epoch (before: from E+2 on).
  Publishing ahead closes those slots, as before.
- If E's key lands after S(E) − margin, every badge for E is a Standard badge, so E's badges reveal their mode. Standard
  badges posted outside the private posting windows already do.
- If E's key lands during E−1, the private requests for E fit between the key and S(E) − margin, so E's private crowd can be
  smaller than when the key was there all along. The crowd check reads E−1's report, which also counts every Standard
  token, so it was only a stand-in before and is a weaker one in that case. Accepted: an issuer that publishes ahead is
  unaffected. The stricter option, offering Private only for keys created before S(E−1), would be one check in the web
  client.

Issuer: a token store that started inside E's window may issue for E if it is older than E's key by the margin, because no
token for E can exist before the key. The store records the higher of dashd's tip and Platform's core height as its start.
Once a valid key is on Platform, the epoch is reported, with 0 tokens if the server never signed. The service cannot publish keys itself: `issuerKey` needs the CRITICAL key, which stays
offline (§8.4 rule 7, contract `signatureSecurityLevelRequirement: 1`). `issuer publish-keys` publishes the current epoch's
key while it can still land, adopts a slot that already holds our SPKI, and reports any other key as a conflict. The running
service checks Platform every tick and starts signing at the next tick after the key lands.


### 8.10 Deferred Standard: token now, publish later (owner decision, 2026-10-25)

"Please simplify and kill the extra private option it just over complicates the UX. Also for standard mode, I'd have us just
defer registering the badge until our next platform operation. A user can choose to 'register now' but in the normal case a
user would get the blind sig early and then wait until they care to publish it [...] With some gentle nudging that the more
time the better." Web client only. No protocol, contract or issuer change: the issuer still sees one Standard request for
the current epoch, and readers still accept a badge for E created in [S(E), S(E+1)+W]. Code: `apps/web/src/badge`
(`client.ts`, `scheduler.ts`, `visit.ts`, `context.tsx`) and `apps/web/src/auth/runtime.ts`.

**The flow.**
1. **Request.** Like a Private one, the request waits until nothing was written to Platform from this browser for 30 minutes
   and no other token request went out for 30 minutes. It then waits a further random 0–15 minutes (`REQUEST_JITTER_MS`),
   so it does not fall exactly 30 minutes after the identity's last public write. A browser that has been quiet for longer
   sends it at once. In the unified "Add your masternodes" flow the keyring save is a write, so the request goes out about
   30–45 minutes later, while the app is open. The UI says so once.
2. **Hold.** The token is finalized, verified and kept with the job in this browser's encrypted job store (localStorage,
   AES-GCM under a key derived from the identity's signing key). It is never put in the Platform keyring: saving that is
   itself a public write and would recreate the timing link. The masternode's proTxHash and the voting key are wiped from the
   job once the token is in hand (unless the user keeps the key to renew).
3. **Publish with the next write.** Every Platform write of a signed-in identity goes through `markWrites`
   (`auth/runtime.ts`), which announces it before it is sent. A held token for that identity is posted alongside, but only if
   at least 30 minutes have passed since the last token request from this browser (`mayPost`). The user's write is never
   delayed: the badge post is started, not awaited, and goes out within seconds of the write. A write inside the cooldown
   does not carry it; a later write will. Badge posts themselves and new identities do not count as triggers. The post is
   made under the browser-wide activity lock from the latest stored jobs, so two tabs cannot post the same token twice.
4. **Register now** posts at once, whatever the cooldown, with the note: "Posting now lets govhub's issuer match your
   masternode to this account by timing. Waiting until you next post or react hides that better; the longer the gap, the
   better."
5. **Lapse.** A held token is valid while the badge's height can still be in [S(E), S(E+1)+W]. The client posts it up to
   S(E+1)+W − margin (`lapseHeight`). Within about 3 days of that on mainnet (1,646 blocks), or a tenth of an epoch on testnet
   (58 blocks, about 2.5 hours; `lapseNudgeBlocks`), the UI says "Your badge will lapse in N unless registered" and offers
   Register now. After that the token is deleted.
6. **Renewal** is unchanged: with the voting key kept, a job for E+1 is made from S(E+1). Its token is held like any other,
   and once a newer badge is posted or held and current, an older held token is dropped (`supersede`).
7. **Private** is unchanged: next-epoch token, random request and posting heights, the crowd check. Its posts never ride on
   user writes. Both modes share one spacing (one request per quiet half hour per browser) and one job per (issuer, epoch),
   so a held Standard token for E and a Private job for E+1 coexist.
8. **Fewer warnings.** The "wait N min" note shows only while a request's cooldown runs **and** a held token or an active
   Private job would lose its separation by a write right now. It is a nudge: "Your MN badge request just went out. If you
   can, wait about N min before you post or react: the longer the gap, the harder it is to match your badge to your
   masternode."

**What each party learns.**

| | Immediate Standard (before) | Deferred Standard (now) |
|---|---|---|
| Issuer | MN X asked at t (and the IP), and a badge from identity I appeared about a minute later: X ↔ I with near certainty. | MN X asked at t (and the IP). The badge appears at I's first write after t + 30 min. Candidates for that badge are every Standard token for E issued before it and not yet posted, further narrowed by I's public write times (below). |
| Readers, anyone watching Platform | I has a badge from X's issuer, appearing a minute after nothing in particular. | I has a badge, appearing with I's own comment or reaction. |
| Platform nodes (DAPI) | The IP of the badge post, at the request time. | The IP of the badge post, with the user's write. |
| govhub (no logs) | Nothing kept. | Nothing kept; the token is only in the user's browser. |

**How the issuer could still narrow it down.** Platform writes are public and timestamped. The issuer knows every request
time; it can see every identity's write times. For a badge posted with I's write at t_b, X's request t_X must satisfy:
no write by I in the 30 minutes before t_X (the request spacing), and no write by I between t_X + 30 min and t_b (else the
badge would have gone earlier). So t_X falls either in I's idle gap before t_b (minus 30 minutes at each end) or in the
30 minutes before I's previous write. The badge hides among the Standard requests in those stretches. The longer the user
waits, the longer the gap and the bigger the crowd: hence the nudge. On a small network with few Standard requests per
day, this can still be a crowd of one.

**Residual risks.**
- **IP addresses.** The issuer sees the request IP; the Platform nodes the app talks to see the IP of every write, including
  the badge post. An issuer operator that also runs evonodes can join the two. Use Tor or a VPN.
- **A user who writes exactly once, right after the cooldown.** The gap is then about 30 minutes plus the request jitter,
  and the crowd is whoever asked in that half hour. That is better than one minute, but not much.
- **Requests a fixed time after a write.** Without jitter, a request held back by a write would go out at the first tick
  after write + 30 min. That pins it to the identity's last public write (for example the keyring save in the unified flow),
  linking masternode and identity without any badge at all. The random 0–15 minutes on top widens that to a 15-minute
  window. It does not remove it: an issuer that sees few requests can still line them up. A wider window, or sending the
  request in a later visit, would do better at the cost of a longer wait.
- **The same browser doing many requests.** One request per quiet half hour per browser, across tabs and identities, and
  one badge per identity per issuer. Several identities in one browser are still tied together by IP and by never asking
  at the same time.
- **Multiple devices.** The token lives only in the browser that fetched it. A write from another device neither
  publishes it nor counts for the spacing. The UI says "It's kept in this browser only: posting from another device won't
  publish it." Someone who mostly posts from their phone will see the badge lapse unless they post or Register now from
  this browser.
- **A lapsed token wastes the slot.** The issuer gives one token per masternode (and per collateral) per epoch. A token that
  lapses, is cancelled, or is lost with the browser's storage cannot be asked for again that epoch. The masternode can ask
  again from the next epoch. Clearing site data loses held tokens the same way. A memory-only job store (no signing key in
  the session) loses them on reload.
- **Late-epoch tokens have a short shelf life.** A Standard token fetched near the end of E still lapses at S(E+1)+W, so
  the lapse note can come within days of fetching. Asking for E+1 instead once less than about W of E is left would avoid
  that; not done here.
- **Visible lifetime.** A badge shows until S(E+1)+W whenever it was posted. Waiting longer means it shows for less of the
  epoch, and with renewal off a user who posts rarely may show a badge only briefly.
- **Badge and comment land together.** Anyone can see that the badge appeared in the same block as I's comment. That says
  only "I published its badge when it was active", which is the point. It does reveal the client's rule, and so the
  deferred mode itself.
- **The cooldown note can still be ignored.** A write right after a request (inside its cooldown) is never blocked. It
  weakens the separation even though it does not carry the badge.

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
| 2 | Social:<br>• `forum` and `mod` v1<br>• seed, key and passkey login<br>• DAPI funding (pay a QR address) and DAPI top-up<br>• comments, reactions, claims, proposal editor, block lists | Moderation drill |
| 3 | Voting and proposals:<br>• accounts service<br>• immediate and offline-sign voting through relays<br>• proposal-creation wizard with relay auto-submit<br>• DashCentral-compatible API | Live mainnet vote and proposal from the browser |
| 4 | Badges:<br>• `badge` contract<br>• issuer service with offline keys<br>• badge-client<br>• default "MN-only" filter switches on once the first epoch's badges are live | Adversarial review closed |
| 5 | Deferred voting, EvoVote contest voting, audit CLI | 5-MN randomized schedule lands |
| ∥ | PV14 track on testnet: v2 contracts, bound session keys, App Connect, migration rehearsal | Rehearsed cutover |

Badges need one full epoch of token issuance before the first display epoch. Until then, the
default filter is badge holders plus proposal owners, falling back to "all" while there are no
badges.

## 13. Risks

- **RC SDK on mainnet:** gated by phase 0. Pin 5.0 final when it's tagged.
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
