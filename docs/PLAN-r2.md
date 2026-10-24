# DashCentral-on-Platform — plan r2 (2026-10-23)

Working name **govhub** (placeholder). Hosted under dashhq.org (suggest `gov.dashhq.org`). It
replicates dashcentral.org plus all of EvoVote (vote.dashhq.org stays live and is not replaced
yet). All app data lives on Dash Platform. Browsers read Platform directly with proofs. The only
backend is what Platform can't do: run Dash Core, hold signed votes until release time, and run
central login and funding.

r2 adds: pluggable backends, the SDK 5.x single-codebase strategy with a PV14 track, the
full-set ZK badge (replacing r1's registration design), number privacy, proposal creation over
DAPI, portable seed login, faucet vouchers, DAPI-only top-ups, and the EvoVote features.
Everything marked *estimate* or *assumption* gets measured in phase 0.

## Decisions so far (user, 2026-10-23)

- **Scope:**
  - In: DashCentral governance features, community up/down votes, a DashCentral-compatible JSON
    API, and all EvoVote features.
  - Later or never: masternode monitoring and earnings, email/push/Slack notifications, the
    Android app, the shoutbox.
- **Backends:** our backends are the default, but every one is pluggable and replaceable by the user.
- **Relays:** Platform-login users may use our relays. Prove as much as we can via Platform.
- **Contracts:** ship v1 contracts on PV13 mainnet now and migrate when PV14 (5.0) activates.
  PV14 work can happen on testnet, but release must not depend on activation.
- **Proposal creation:** reimplement the proposal generator (proposal.dash.org) using DAPI for
  the external Core data.
- **Login:** a standard Dash seed that is restorable in other wallets.
- **Free credits:** the faucet-voucher model, with a near-minimum identity good for a few comments.
- **Top-ups:** users can top up with external DASH.
- **Comments:** open to everyone, with the default view filtered to masternode owners.
- **Proposal claims:** manual claim attestation is fine for the rare P2SH/multisig case.
- **Delayed voting:** hiding the link from public observers is enough.
- **Masternode privacy:** the only public disclosure is "is an MN owner". Never how many nodes,
  never regular vs evonode. Hiding among registered nodes was acceptable if it is properly secure,
  and timing attacks are the main worry. The review (§8) found the opt-in registration
  fundamentally weak against timing, so r2 uses the full masternode set.
- **Keys and votes:** we own the bridge and moderation keys. Funding votes only.

---

## 0. Constraints that shape the design

| Constraint | Consequence |
|---|---|
| Mainnet PV13 now; PV14 activation date unknown; testnet already PV14 (5.0.0-rc) | Build on **evo-sdk 5.x (≥ rc.8, pin 5.0.0 final when tagged)**. It starts at the network's floor (13) and only ratchets up from proof-verified metadata, and it reads PV13-era contracts and documents. **4.1.1 is a dead end**: once PV14 activates it can't decode format-3 documents and every create fails. One codebase; features gated by the detected protocol version. *Phase 0 must prove 5.x reads and writes on PV13 mainnet with a throwaway contract.* Fallback is 4.1.1, accepting a forced rewrite at activation. |
| PV13 has no `refersTo`/`distinctFrom`/`ttl`/typed arrays/multi-`In`/ranked counts/bound auth keys/App Connect, and **no owner-paid gas** (`gasFeesPaidBy` is stored but ignored before PV14) | Posters pay their own fees on PV13, hence the faucet vouchers. Sponsored posting comes with the PV14 contracts. |
| Indexes are frozen per document type | That's acceptable: contracts are versioned and we migrate at PV14. Clients read every known version and write the newest. |
| Field ≤ 5,120 B; state transition ≤ 20,480 B; one document per batch | Long descriptions are deflated and split into 3 fields. Proofs must be small: Groth16 is 256 B. |
| PV13 gapped-index planner bug | Every query is an equality prefix, then at most one range or `in` on the next index property, ordered in index order. Lint this in CI. |
| DAPI has **no governance RPCs** (no `gobject`, tallies, or budget) | The bridge is mandatory for governance data. DAPI covers everything else on the Core side: transactions, blocks, headers with ChainLocks, SML, IS-locks. |
| Core discards expired proposals and non-latest votes | The bridge archives the raw objects and votes it receives over ZMQ from day one. |

---

## 1. Architecture

```
 Browser (static SPA, evo-sdk 5.x, packages/verify)
   │  Platform reads/writes (proof-verified) ─────────────► DAPI evonodes (grpc-web, CORS ok)
   │  Core data: tx / blocks / headers+ChainLocks / SML / IS-locks ─► same evonodes
   │
   ├─(pluggable) bridge(s) HTTP: raw signed votes, live tallies, SML snapshot, DC-compat API
   ├─(pluggable) relay(s)  HTTP: voteraw at release time, gobject submit, held Platform votes
   └─(pluggable) accounts + faucet (central login only): envelopes, vouchers

 bridge  = dashd (txindex, zmq) + daemon → writes `gov` contract docs (bridge identity)
 relay   = stateless-ish queue in front of a dashd (can share the bridge's node)
 accounts/faucet = Cloudflare Workers + Durable Objects (same pattern as dash-faucet-cf)
 audit   = `govhub-audit` CLI anyone runs against their own dashd → attestations on Platform
```

### 1.1 Pluggable backends

The frontend uses our endpoints by default. Every endpoint is user-replaceable, and nothing is
hard-wired.

- **Endpoint registry** in Settings, exportable/importable as JSON, also loadable via
  `?config=<url|b64>`. Each entry carries a health and verification status, and every number in
  the UI says which endpoint served it.
  - DAPI node source: the quorum-service URL, or a manual node list.
  - Bridges: `{name, httpBase, govContractId, bridgeIdentityId}`, as a list.
  - Relays: a list. Votes are fanned out across them.
  - Accounts service and faucet.
  - Moderation lists: the default-list identity can be replaced or removed.
  - Price feed.
  - Frontend origin. The SPA is also published to IPFS, with reproducible builds and a published CID.
- **Third-party bridges** publish into *their own* `gov` contract, since only the contract owner
  can create there. The client merges proposals by govHash, which is safe because each proposal
  is verified against its collateral. Tallies from several bridges are cross-checked and any
  difference is flagged.
- **Each service** has an OpenAPI spec, a conformance test suite, and a reference implementation
  runnable with `docker compose up` (dashd, bridge and relay), so anyone can operate one.
- **Settings sync:** settings optionally sync through a user-owned `settings` document, so they
  follow the identity across devices.
- **Accounts service:** if a user replaces it, their envelope lives wherever they point it. The
  seed is always exportable, so nothing is locked in.

---

## 2. Trust model ("can't lie to you")

| Data | Check performed in the browser | Residual |
|---|---|---|
| Platform documents | evo-sdk proof verification | SDK quorum-key bootstrap |
| Proposal content | Recompute the governance hash. Then `getTransaction(collateral)` over DAPI, decode it locally, and require: OP_RETURN = the **raw (unreversed)** hash, at least 1 DASH, every output P2PKH or OP_RETURN, at least 6 confirmations and ChainLocked. *Validate the preimage against a Core `gobject check` vector in phase 0.* | Bridge omits a proposal |
| Individual votes | Recover the compact signature over `"DarkCoin Signed Message:\n" + "txid-n\|parent\|1\|outcome\|time"`. Then `hash160` must equal `keyIDVoting` from the SML, and the outpoint must map to the proTxHash via the ProRegTx payload. | Bridge omits votes |
| Tallies | Recompute from the verified votes, weighted regular ×1 and evonode ×4, over the SML at `asOfHeight`; compare with the `voteSetHash` committed on Platform | Same as votes |
| SML / masternode list | DAPI `subscribeToMasternodeList` (1.36 MB, ~2.5 s parse), cross-checked across 2–3 nodes. v2: anchor to the CbTx `merkleRootMNList` and to a ChainLock verified by BLS. A live probe verified a mainnet ChainLock against an SML quorum with dashcore-lib. | v1 trusts the agreement of a few nodes |
| Budget/superblock | Deterministic from height plus the SML | — |

Against omission: several bridges, the `govhub-audit` CLI publishing attestation documents, and
a "verified vs reported" marker on every number.

---

## 3. Contracts

### 3.1 v1 contracts (PV13 mainnet)

All have `additionalProperties: false`. Hashes are 32-byte byteArrays. **Integer index fields
stay below 2^63**, because PV14 re-keys unsigned integer indexes around the midpoint.

**`gov`** is owned by the bridge identity, and `creationRestrictionMode: 1` applies to every type.

| Type | Mut. | Key fields | Indexes |
|---|---|---|---|
| `proposal` | no | `govHash`, `parentHash`, `revision`, `time`, `dataHex`, denormalized fields (`name`, `url`, `paymentAddress`, `paymentAmount`, `startEpoch`, `endEpoch`), `collateralTxid`, `collateralHeight` | unique [govHash]; [endEpoch]; [name, $createdAt] |
| `tally` | yes | `govHash`, `asOfHeight`, weighted and unweighted y/n/a, `voteSetHash`, `rank`, `inNextBudget`, `margin` | unique [govHash] |
| `cycle` | yes | `superblockHeight`, `budget`, `allocated`, `votingDeadlineHeight`, `estTime`, `validWeighted`, `paid` (packed) | unique [superblockHeight] |
| `epochRoot` | no | `epoch`, `checkpointHeight`, `blockHash`, `merkleRootMNList`, `anonRoot`, `leafCount` (cache only; clients re-derive) | unique [epoch] |
| `dcDescription` | yes | `govHash`, `title`, `b0..b2` (deflated) | unique [govHash] |
| `dcComment` | no | `govHash`, `dcId`, `parentDcId`, `username`, `postedAt`, `isOwner`, `isMno`, `body` | [govHash, postedAt] |
| `claimAttestation` | no | `govHash`, `identityId`, `method`, `note` | [govHash] |

**`forum`** is open (`creationRestrictionMode: 0`) and owned by the project identity.

| Type | Mut./Del. | Key fields | Indexes |
|---|---|---|---|
| `profile` | y/y | `displayName`, `about`, `avatarUrl` | unique [$ownerId] |
| `comment` | n/y | `govHash`, `parentId?`, `body` ≤5000 B, `fmt` | [govHash, $createdAt]; [$ownerId, $createdAt] |
| `reaction` | y/y | `target`, `kind` (1 = comment, 2 = proposal community vote), `value` ±1 | unique [$ownerId, target]; [target, $createdAt] |
| `claim` | n/y | `govHash`, `method`, `sig` | [govHash, $createdAt] |
| `proposalPost` | y/y | `govHash`, `title`, `b0..b2` (deflated markdown), `links` | unique [govHash, $ownerId] |
| `proposalDraft` | y/y | `time`, `revision`, `dataHex`, `govHash`, `collateralTxid?`, `stage` | unique [$ownerId, govHash]; [stage, $updatedAt] |
| `mnBadge` | **n/n** | `epoch`, `nullifier`, `rootHeight`, `proof` (256 B) | [epoch, nullifier]; [$ownerId, epoch] |
| `block` | n/y | `target`, `kind` (1 = identity, 2 = document), `reason` | unique [$ownerId, target] |
| `blockSubs` | y/y | `lists` (packed, ≤50), `defaultOff` | unique [$ownerId] |
| `settings` | y/y | `endpoints` (deflated JSON) | unique [$ownerId] |
| `vault` | y/y | Passkey vault (Yappr's HPKE/PRF design without `refersTo`) | unique [$ownerId, credentialId] |

**`mod`** is owned by the moderation identity and holds the default `block` list.

Notes:
- **No unique index on `mnBadge.nullifier`.** Platform can't verify proofs, so a unique index
  would let an attacker squat a nullifier with junk. Readers take the earliest *valid* proof,
  ordered by (`$createdAtBlockHeight`, `$id`).
- **`mnBadge` is immutable and undeletable,** so a later identity can't become "earliest" by
  deleting the first one.
- **`proposalDraft`** lets the relay **auto-submit** once the collateral reaches 6 confirmations,
  so the user can close the tab. It also preserves the prepare parameters, which are otherwise
  unrecoverable if lost.

### 3.2 v2 contracts (PV14 track, developed on testnet now)

Deploy them when mainnet activates PV14. They adopt:
- `refersTo`: comment → proposal, reaction → target, claim → proposal.
- `distinctFrom`: no self-reactions.
- `indexOnly` reactions, which are more than 50% cheaper.
- Ranked counts for scores and "top comments".
- Multi-`In`.
- `ttl` for ephemeral documents.
- **Sponsored posting:** a non-transferable posting token, `tokenCost` with `gasFeesPaidBy`
  contract owner, so a near-zero-balance identity can post within its quota. Caveat: the token
  claim itself isn't sponsored.
- **Contract-bound, budget- and expiry-limited session keys** for central users, so the browser
  holds a key that can only write our contracts.
- **App Connect** wallet login.
- *Option:* an MN-elected moderation team for the default list via the moderation-charters
  system contract. This must be decided before the v2 contracts are created.

### 3.3 Migration runbook (PV13 → PV14)

1. Pre-deploy v2 on testnet; the conformance suite runs on both v1 (local dashmate 4.1.1) and v2
   (testnet).
2. At mainnet activation:
   - Register the v2 contracts.
   - The bridge re-publishes `proposal` (active and recent), `tally`, `cycle` and `epochRoot`.
   - The moderation identity re-publishes the default list.
   - Clients read v1 and v2 and write only v2.
   - Users get a one-click "copy my blocks/profile to v2".
   - Comments stay readable in v1.
3. Gotchas to audit before activation:
   - Gapped-index results change.
   - The unsigned-int index re-key.
   - The keep-history-plus-delete ban.
   - No `-` allowed in names.
   - The 5.0 rc.7-vs-rc.8 client/node wire break, so pin ≥ rc.8.

---

## 4. Login, identities, funding

### 4.1 One standard Dash seed for everyone

A BIP39 mnemonic (12 or 24 words, **no passphrase**) using DIP-13 paths with the **DashPay iOS
key layout**, identity index 0, and key id = key index:

| id | path `m/9'/5'/5'/0'/0'/0'/id'` (testnet coin 1') | purpose / level |
|---|---|---|
| 0 | AUTH / MASTER | wallet discovery key |
| 1 | AUTH / CRITICAL | |
| 2 | AUTH / HIGH | signs our documents |
| 3 | TRANSFER / CRITICAL | credit transfers |
| 4, 5 | ENCRYPTION, DECRYPTION / MEDIUM bound to DashPay `contactRequest` | DashPay compatibility; may be added later via IdentityUpdate to keep the create cheap |

- **Where it restores:**
  - DashPay iOS: key-0 hash scan, gap 5; no username needed (it prompts for one).
  - Dash Evo Tool.
  - Yappr recovery-phrase sign-in: testnet only today.
  - Android: looks for key 0 at identity index 0. Needs a real-device test.
- Funding paths match the wallets: registration `m/9'/5'/5'/1'/0'`, top-up `m/9'/5'/5'/2'/0'/n`.
- **Platform login** accepts this seed, an existing DashPay/Evo Tool seed, a pasted key (as in
  EvoVote), or the passkey vault. Wallet login (App Connect) arrives with v2.

### 4.2 Central login

The accounts service never sees plaintext.
- The seed is generated in the browser and shown once with a "save your recovery phrase" step.
  It is always exportable.
- The envelope, holding the seed plus any MN voting keys, is AES-GCM encrypted under a key from
  the **passkey PRF** (preferred) and/or **OPAQUE** password login (the server never receives
  the password). Optional TOTP.
- **Password-wrapped envelopes never go on Platform.** Envelopes are padded to a fixed size so the
  server can't count a user's masternodes.
- The accounts service runs on Cloudflare Workers with Durable Objects (the faucet pattern) and
  is replaceable (§1.1).

### 4.3 Free starter identity (faucet voucher)

- **A new treasury** in `dash-faucet-cf`: a separate Durable Object, route and amount.
- **What it hands out:** pre-minted, ChainLocked asset-lock vouchers at **~0.003 DASH**, which is
  configurable. That is near the 0.002 minimum, so it's instant.
- **What the browser does:** it creates the identity **with its own keys** using a chain-lock
  proof. The voucher only funds; the operator never controls the identity.
- **Budget** (*estimate*): identity creation uses ~0.0004–0.0008 DASH, leaving roughly 2–4
  comments.
- **Gating:** one voucher per central account for its lifetime, Turnstile, a per-IP window, and a
  **daily budget**. The invitation path currently has no daily budget.
- **Fix first:** a likely bug in the existing invitation code. The identity id hard-codes vout 0,
  but `sortOutputs` can put the burn at vout 1. Then claimed vouchers aren't detected and get
  reissued. Found by code reading; not yet reproduced on chain.

### 4.4 Top-up with external DASH (DAPI only)

The browser ports Dash Bridge's flow, swapping Insight and rpc.digitalcash.dev for DAPI:
1. QR for a one-time key at the top-up path.
2. Open `subscribeToTransactionsWithProofs` from `tip-3` with a bloom filter of **at least 200 B**;
   the bridge's 3-byte filter saturates.
3. Detect the deposit and build the type-8 asset lock.
4. `broadcastTransaction`. The IS-lock arrives on the same stream about 1 s later.
5. `identities.topUp` with the IS-lock proof. Fall back to a chain-lock proof once
   `isChainLocked` is true and Platform's `coreChainLockedHeight` has reached the transaction's height.
6. Minimum deposit is 51,000 duffs.

Nodes come from the quorum service (CORS `*`; about 200 evonodes on 443). Refresh the node list
every session, because certificates are 6-day IP certs. Respect 150 requests per minute per node
and prefer streams. Also link out to bridge.dashhq.org.

---

## 5. Voting

### 5.1 Core governance (funding only)

- **Voting-key storage:** in memory only, the passkey vault, the central envelope, or
  **offline-sign mode**. Offline-sign shows the exact strings to sign with `signmessage` in Dash
  Core, DMT or a hardware wallet.
- **Signing:** the browser signs with the DarkCoin message magic (65 B, low-S), then POSTs to the
  relay(s), which call `voteraw`. The relay ignores the help text: signatures are base64, not hex.
- **Verification:** the client confirms the vote through the bridge's vote list and keeps a signed
  copy to re-broadcast elsewhere.

### 5.2 Deferred / randomized voting (public unlinkability)

- **Core rules this relies on:** nTime is signed; Core rejects votes with nTime more than 1 h
  ahead; old nTimes are always accepted; one change per hour per (MN, proposal, signal).
- **Scheduling:** for each MN the client samples an independent release time Tᵢ between now and
  the voting deadline minus 12 h. The voting deadline is the 1,662-block maturity window before
  the superblock.
- **Signing and submission:** each vote is signed with nTime = Tᵢ and submitted in a **separate
  request** after a random client delay. Votes can be split across relays.
- **Release:** the relay broadcasts at Tᵢ. A cancel or replace message signed with the voting key
  drops a held vote.
- **Watchdog:** the client re-broadcasts through another relay if a vote isn't visible by Tᵢ + δ.
- **Privacy:** this is enough for public observers, which is the stated requirement. The relay
  operator still sees arrival timing.

### 5.3 EvoVote features (Platform contested resources)

- **Scope:** DPNS contested-name contests on PV13 (EvoVote main parity). Moderator elections
  (charters) come with PV14.
- **How a vote works:** the same stored voting key is used. The voter identity is
  `SHA256(proTxHash ‖ keyIDVoting)` and needs no credits. Each MN gets 5 vote changes per contest.
- **Deferral:** votes can be pre-signed with consecutive nonces (24-slot window) and held by the
  relay for randomized broadcast, the same way as §5.2.
- **SDK quirks carried over from EvoVote:**
  - Rebuild polls only from live results.
  - ProTxHash in display order.
  - Verify a vote by re-reading it.
  - A changed voting key makes held votes stale (error 40305).

---

## 6. Proposals: create, ingest, claim, describe

### 6.1 Creation wizard

This replaces proposal.dash.org and fixes its bugs: it counted blocks instead of confirmations,
never checked the OP_RETURN, and lost state on reload.

- **Form:**
  - Validated with Core's rules: name `[-_a-z0-9]{1,40}`, case-insensitive; data ≤ 512 B; P2SH
    payout allowed.
  - Superblock-aligned epochs, as in the generator (16,616 blocks per cycle, 1,662-block
    maturity, ~155 s per block).
  - Total cost and a check against available budget, using the bridge's `cycle` document.
- **Claim URL:** the URL defaults to `https://gov.dashhq.org/p/<identityId>/<name>`, which makes
  the claim trustless (§6.3).
- **State:** saved to a `proposalDraft` document plus localStorage.
- **Collateral, two paths:**
  - (a) Show a `gobject prepare` command for Dash Core. The user pastes the txid; the browser
    checks the transaction over DAPI (OP_RETURN, amount, output types).
  - (b) In the browser: a one-time key with a backup, a QR for ≥ 1.0001 DASH, detection over the
    DAPI stream, then build and broadcast `[OP_RETURN hash (1 DASH), change → P2PKH refund address]`.
    P2SH change would invalidate the collateral.
- **Confirmations:** ChainLocked headers stream as the wake-up, and `getTransaction.confirmations`
  is the count.
- **Submission:** the relay auto-submits at 6 confirmations from the `proposalDraft`. It
  re-verifies everything and has to, because each submission is backed by a 1 DASH burn.

### 6.2 Ingestion

- The bridge takes ZMQ raw objects and votes and reconciles with `gobject list/get/getcurrentvotes`.
- It publishes `proposal` at 6 confirmations.
- It replaces `tally` on change, throttled to about hourly (*estimate*: ~0.015 DASH/day; ~2 M
  credits per replace).
- Live numbers between snapshots come from the bridge API.

### 6.3 Claiming, highest method first

1. **URL-embedded:** the claim URL is committed in the collateral hash, so it's trustless. Used by
   new proposals.
2. Signature from the payment address.
3. Signature from the key that paid the collateral input.
4. Hosting-team `claimAttestation`, for P2SH/multisig or lost keys.

### 6.4 Description precedence

The owner's `proposalPost`, then the DashCentral mirror, then the raw fields.

---

## 7. DashCentral mirror

- **Import:** descriptions and threaded comments, rebuilt from `level`/`order`, through their API.
  This needs the operator's permission and a partner key.
- **Storage:** bridge-owned `dcDescription`/`dcComment`, labelled "via DashCentral @user".
- **Keys:** everything is keyed by govHash, since DashCentral has duplicate slugs.
- **Moderation:** block lists apply to mirrored content too.

---

## 8. Anonymous "MN owner" badge (number-private, timing-hardened)

### 8.1 Why not registration (r1)

An adversarial review (Opus, 2026-10-23) found that any public opt-in registration fails R3
(timing). Each registration publicly marks an MN as a participant at a known time. An attacker
with k−1 MNs can flood a batch so the victim is alone (the n−1 attack). New identities that badge
right after a batch narrow the set to that batch. And departures of registered MNs (0–3 per cycle)
almost uniquely link a lapsing badge. k-anonymity floors don't hold up against this.

### 8.2 Design: full-set in-circuit proof, once per epoch

- **Anonymity set:** every valid MN in the SML at a checkpoint (~3k). There's no registration, so
  there is nothing to time-correlate at join.
- **Leaves:** `Poseidon(proTxHash, keyIDVoting)`, sorted by proTxHash, in a LeanIMT.
  - "Eligible" means valid at this checkpoint **or** the previous one, which smooths PoSe flapping.
  - Clients re-derive the root from a verified SML; the bridge's `epochRoot` is only a cache.
- **Circuit (Groth16/BN254, circom, ~170–180k constraints, *estimate*):**
  1. voting private key `sk` → pubkey (fixed-base secp256k1);
  2. SHA256 → RIPEMD160, which must equal `keyIDVoting`;
  3. Merkle membership of the leaf;
  4. nullifier = `Poseidon(DOMAIN, contractId, epoch, sk_lo, sk_hi, proTxHash)`.
  - Public inputs: root, epoch, contractId, message = `$ownerId`, nullifier, all range-checked
    below the field modulus r.
  - The proof is **256 B**. Proving is *estimated* at 3–10 s on a laptop and 20–60 s on a phone,
    with a ~100 MB zkey cached. All unmeasured.
- **Badge lifecycle:**
  - An epoch is E budget cycles (default E = 1, ~29 days).
  - Badges for epoch E+1 can only be created inside a fixed **renewal window W** at the end of
    epoch E (default: the last 7 days). Readers reject badges whose `$createdAtBlockHeight` falls
    outside W.
  - **Each identity's badge goes out at an independently random time inside W.** The client
    refuses to renew two identities in one session or from one IP.
  - The badge is shown only during epoch E+1: one root per scope, and no previous-root grace,
    which would let one MN hold two identities.
- **Number privacy (R2):**
  - The UI shows only "MN". No counts, no evonode flag; leaves are one per MN with no type.
  - An owner of N MNs *may* badge up to N identities, but nothing reveals N.
  - A multi-MN owner keeps a spare MN slot, so if a node leaves the list their badge doesn't lapse.
- **Soundness rules for readers:**
  - message must equal `$ownerId`, so a proof can't be copied to another identity;
  - scope must equal (network, contractId, epoch);
  - deduplicate on the nullifier only, never on proof bytes (Groth16 proofs can be re-randomized);
  - accept the earliest valid badge;
  - cap verification work per nullifier against spam.
- **Setup and audit:**
  - Phase 1 from Perpetual Powers of Tau (2^18).
  - Phase 2 as a public MPC (PSE p0tion); soundness holds if any one participant is honest.
  - The client checks the zkey against the transcript.
  - An **independent circuit audit** is required. circom-ecdsa's non-native arithmetic is the risk.
- **Voting key in the prover:** this is the same exposure users already accept when they vote
  through the portal. Proving runs locally, with an offline prover page available.
  - Caveat: anyone who later learns that voting key can link all past badges made with it.
    Rotating the voting key limits this.

### 8.3 Leaks the cryptography can't fix (shown in the UI)

1. **Funding trail.** Badge identities funded from MN payout or collateral wallets link instantly.
   The fix is faucet vouchers, or `IdentityCreateFromShieldedPool`, which is already on PV13 with
   a 0.03 DASH minimum. The client warns when an asset lock traces to an SML payout script.
2. **Network.** Broadcast badge state transitions through a proxy or Tor (anyone can submit them),
   and never from an MN host.
3. **Vote correlation.** Comment content intersected with public per-MN vote vectors. Keep the
   vote and comment flows separate, and warn the user.
4. **Departure lapse.** A single-MN owner whose node leaves the list is narrowed to that epoch's
   departures (tens of nodes with the full set).
5. **Pooled voting-key custodians** can badge many identities. Label the badge "controls a valid
   MN's voting key".

### 8.4 Launch dependency

The default "MN-only" filter needs badges at launch, but the ZK path needs a ceremony and an
audit. The options are listed under Questions.

### 8.5 Public MN claim

Optional and off by default. An `mnClaim` signed with a voting or collateral key names the
specific MN, the way DashCentral does. It warns that this gives up number privacy.

---

## 9. Moderation

- **Default list:** the moderation identity (ours, separate from the bridge) publishes it. Clients
  subscribe by default; users can opt out or add other lists.
- **Targets:** identities **and** individual documents (comments, posts, claims, descriptions,
  mirrored items, spam proposals).
- **Hide, don't delete:** blocked items are hidden behind a "show hidden (N)" toggle.
- **List growth:** if a list passes ~1k entries, add Yappr's bloom-filter type in v2.
- **Default comment view:** authors with a valid badge, plus the proposal owner on their own
  proposal (*assumption*). "Show all" is one click away.

## 10. Frontend

- **Stack:** React + Vite SPA. evo-sdk 5.x is lazy-loaded (~12.6 MB WASM), with an IndexedDB
  cache and a strict CSP. Hosted on Pages under dashhq.org, plus IPFS.
- **DashCentral layout kept:**
  - the budget header;
  - active and past lists with traffic-light bars and "needs N more yes votes";
  - the proposal info table;
  - badges: MN, proposal owner, recently posted;
  - infinite scroll, `/p/<slug>` URLs and `?comment=` links.
- **Additions:** provenance markers, an EvoVote section, and optional CI prerender for SEO.

## 11. Shared code

`packages/verify` is used by the browser, the bridge, the relay and the audit CLI. It covers:
- the governance hash and collateral check;
- vote message signing and recovery;
- SML parsing (DIP-4 hash) and ChainLock BLS verification;
- tally recomputation;
- the badge verifier.

Repo layout: `packages/{contracts-v1,contracts-v2,verify,client}`, `apps/web`,
`services/{bridge,relay,accounts}`, `tools/audit-cli`.

---

## 12. Phases

| # | Deliverable | Exit check |
|---|---|---|
| 0 | Spikes. evo-sdk 5.x (rc.8+) reads and writes on **mainnet PV13** with a throwaway contract. v1 contracts validated on local dashmate 4.1.1. **Measured costs** for identity create (3 vs 6 keys), comment, reaction and replace. The governance-hash vector matches `gobject check`. The DAPI flows work in a real browser (CORS, streams, IS-lock). Voucher identity creation works with a 0.003 lock. Android restore of the seed. | Go/no-go table |
| 1 | Read-only: bridge (archive, publish), `gov` v1 on mainnet, SPA budget and proposal pages, collateral and vote verification, endpoint registry | Numbers match DashCentral for a full cycle |
| 2 | Social: `forum` and `mod` v1, seed/key/passkey login, comments, reactions, claims, proposal editor, block lists, DashCentral mirror | Moderation drill |
| 3 | Central login and voting: accounts service, voucher faucet, DAPI top-up, immediate and offline-sign voting, the proposal-creation wizard with relay auto-submit | Live mainnet vote and proposal from the browser |
| 4 | Deferred voting, EvoVote contest voting, DashCentral-compatible API, audit CLI | 5-MN randomized schedule lands before the deadline |
| 5 | ZK badge: circuit, ceremony, audit, renewal windows, client re-derivation | Third-party root match; audit closed |
| ∥ | PV14 track on testnet: v2 contracts, sponsored posting, bound session keys, App Connect, migration rehearsal | Rehearsed v1 → v2 cutover on testnet |

## 13. Risks

- Running a 5.0 release-candidate SDK against mainnet. Phase 0 gates it, and we pin the final
  release when it's tagged.
- Faucet abuse. Mitigated by one voucher per account, a daily budget and Turnstile.
- Delays from the ZK ceremony and audit (§8.4).
- DAPI quirks:
  - rate limits;
  - short-lived certificates;
  - an IS-lock delivery race, so stream from several nodes and keep the chain-lock fallback;
  - no fee estimate, so use 1 duff/byte.
- Relay metadata (timing and IP) is disclosed, which is acceptable for public unlinkability.
- Moderation and bridge key custody. PV13 has no multisig identities, so keep keys offline.
