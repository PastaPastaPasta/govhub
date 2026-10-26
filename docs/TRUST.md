# govhub trust model: what is proven, and what each backend could lie about

govhub's goal is that it "can't lie to you": the browser checks what it shows instead of taking a server's word. This
document says how far the code on `main` actually gets. Where it disagrees with the plan ([`PLAN.md`](PLAN.md) section 2),
the code wins and the gap is noted.

Scope: the web app (`apps/web`), the packages it verifies with (`packages/verify`, `packages/dapi`, `packages/badge`,
`packages/forum`, `packages/auth`), and the three services (`services/bridge`, `services/relay`, `services/issuer`). Paths are
from the repository root. "Not verified by the app" means the browser does not check the claim; it does not mean the claim is
false. Accuracy matters more than reassurance here, so the gaps are listed as plainly as the guarantees.

The in-app summary is the page `/about/trust` (`apps/web/src/pages/TrustPage.tsx`). It is linked from the "How do we know?"
drawer and from `/about/verification`.

## Contents

1. [Summary](#1-summary)
2. [Roots of trust](#2-roots-of-trust)
3. [How the chain is verified](#3-how-the-chain-is-verified)
4. [What the "Verified" badge requires](#4-what-the-verified-badge-requires)
5. [Fact by fact](#5-fact-by-fact)
6. [Backend by backend](#6-backend-by-backend)
7. [Privacy](#7-privacy)
8. [Known gaps and limits](#8-known-gaps-and-limits)
9. [Planned work (not on main)](#9-planned-work-not-on-main)
10. [Self-hosting and replacing backends](#10-self-hosting-and-replacing-backends)

## 1. Summary

**Proven in your browser** when a proposal shows "Verified", from roots you can inspect (section 2):

- A proposal's text and every displayed field match its governance hash.
- Its collateral burns at least 1 DASH to that hash. The collateral sits in a final (ChainLocked) block of a chain the browser
  verified itself, with at least 6 confirmations and at the published height.
- The masternode list, and from it the funding threshold, is proven by a block's coinbase in that chain.
- The vote count. A vote is counted only when its masternode is in the proven list, its registration (ProRegTx) proves the
  vote's collateral and the masternode's type, and its signature recovers to the voting key the proven list assigns. Any other
  vote is shown as excluded, with a count and a reason, and stops "Verified". The count equals the published tally field for
  field, including the `voteSetHash`.
- Whether the proposal passes, its place in the next budget (a recount and ranking of every listed proposal), and the payments it
  received, read from superblock coinbases of the verified chain.
- The "Verified" badge appears only when all five checks are proven (section 4).

**Not proven, and who could lie:**

- **Completeness.** A bridge can withhold votes, serve an older vote in place of a newer one, or leave out whole proposals.
  The recount proves only the votes it was given. Nothing in the app detects omission. Extra bridges are used for failover,
  not compared (section 6.1).
- **Everything read from Dash Platform** rests on quorum public keys that evo-sdk downloads from Dash's quorum list service
  (`quorums.<network>.networks.dash.org`). This covers comments, profiles, block lists, badges, ownership claims, balances,
  and the proposal, packed tally set, tally and cycle documents. The app does not prove those keys against its own verified chain. The service is
  not replaceable in Settings. This is the largest gap between the "can't lie" goal and the code (section 6.6).
- **Badge issuers** vouch for "MN owner" chips on their own word (section 6.3).
- **Relays** decide when, and whether, your vote reaches the network, and whether a proposal you paid for is submitted
  (section 6.2).
- **Whoever serves the app** decides what code runs. There is no reproducible build or published hash yet (section 2.1).

Surprising findings, all detailed below:

- **The default profile rests on one proof source.** The default is Dev: mainnet Core data on testnet Platform. Its only
  quorum-proof source is the Dev bridge, which runs Dash Core 24.0.0-rc.4 and serves `/v1/quorum-proof`, so chain facts rest on
  ChainLocks proven from the quorum checkpoint. If that bridge can't serve a proof (it is unreachable, or a Core without
  `getquorumproofchain` answers 501), chain facts fall back to the header checkpoint and mainnet proof of work, which still counts
  as "Verified" (`apps/web/src/config/registry.ts:167`; section 3).
- **The Dev bridge identity also runs the default block list.** Both deployed profiles use the Dev bridge identity as their
  moderation identity. On Dev it also owns the gov contract (`registry.ts:104,115,165`).
- **"Confirmed" for your own vote is the bridge's report.** It means the first bridge's vote set contains your exact signed
  vote, and the app says so ("the bridge reports the network counted it"). It names any other bridge or relay you configured
  that agrees. A relay and a bridge run by the same operator could still show it for a vote that never reached Dash Core
  (section 6.2).
- **Proposal lists use the bridge's numbers.** List cards may show the bridge's live tally instead of the Platform one.
  Their "in next budget" flag is the tally's own field, not a recount. Only the proposal page replaces these with proven values
  (section 5).

## 2. Roots of trust

Everything the app proves reduces to the roots below. If one of them is wrong, the guarantees built on it are void.

### 2.1 The app code

The app is a static build of `apps/web`. `.github/workflows/pages.yml` builds it on every push to `main` and deploys it to
GitHub Pages at **gov.dashhq.org**, with Cloudflare proxying in front (`deploy/README.md` section 14). Whoever controls the
repository's `main`, the GitHub Pages deployment, the `dashhq.org` DNS zone or the Cloudflare account can serve different code.
That code could show anything and skip every check. No check inside the app can protect against the app itself.

What exists to limit this:

- A strict Content-Security-Policy, injected only into the built `index.html` (`apps/web/vite.config.ts:12-34`). Scripts and
  workers are same-origin only. `connect-src` allows any `https:` origin, because every backend is user-configurable.
- `<meta name="referrer" content="no-referrer">` (`apps/web/index.html:7`).
- The app refuses to run inside another page's frame (`apps/web/src/app/frame.tsx`).
- Dependencies are pinned by `package-lock.json` and installed with `npm ci`.

What does not exist yet: reproducible builds, a published build hash or IPFS CID, and Subresource Integrity. PLAN.md plans
"reproducible builds and an IPFS CID", but nothing in the build config does it. So you cannot check that the
code gov.dashhq.org serves is the code on `main`.

To remove this root of trust, build and serve the app yourself (section 10). The checkpoints and pinned identifiers below are
part of the code, so you then also review those.

### 2.2 The pinned quorum checkpoint

`QUORUM_CHECKPOINTS` in `packages/dapi/src/quorumproof.ts:50-65` pins one block per network. Each entry gives the block's height
and hash, and the masternode and quorum merkle roots its coinbase commits to:

- mainnet: block 2,550,000, `000000000000000759db5eed...9c9683ce`
- testnet: block 1,560,000, `00000215d91d5f3cdfda9de3...ba07a35e`

These are the checkpoints of dashpay/platform PR #5523. They were re-read from two independent Dash Core nodes per network
(`packages/dapi/README.md`, "Quorum proof anchoring"). Trusting a checkpoint means trusting that no ChainLock quorum committed
under its quorum root, or mined after it, ever signs a false ChainLock. That includes quorums retired long ago. The verifier
follows the path the proof source chooses; like Dash Core's own verifier, it does not check that each link's signer was the
quorum selected for that height. The app checks selection only for the final ChainLock (`packages/dapi/README.md`, "Trust
assumptions of this path").

### 2.2a Block hashes pinned below the quorum checkpoint

`QUORUM_PINS` in `packages/dapi/src/quorumpins.ts` pins block hashes below each quorum checkpoint: every 2,000 blocks for
400,000 blocks (mainnet 2,150,000 to 2,550,000, 225 pins with the superblocks; testnet 1,160,000 to 1,560,000, 201 pins), plus
every mainnet superblock in that range. They let the app verify an old block (a collateral months back, a superblock's
coinbase) with the headers from it up to the next pin above it, at most 2,000, instead of every header down from the ChainLock.

This adds no new root. Every pin is an ancestor of the checkpoint block in 2.2, and that block's hash fixes all of its
ancestors through prevHash links. `packages/dapi/scripts/quorum-pins.mjs` derives the table that way. It downloads every header
from the lowest pin up to the checkpoint over DAPI, checks the X11 linkage up to the checkpoint's pinned hash, and reads the pins
from that verified run. It also cross-checks every pin against two independent sources (mainnet: insight.dash.org and
chainz.cryptoid.info; testnet: insight.testnet.networks.dash.org and two DAPI nodes agreeing). `--check` re-derives the table and
fails on any difference; run it to review the table. On the proof-of-work fallback (2.3) the pins are a second hard-coded root
next to the header checkpoint, as the quorum checkpoint itself is.

In the app (`packages/dapi/src/pinned.ts`), a run of headers counts only if each header's hash is the next one's prevHash up to
the pinned hash. A run that disagrees with the ChainLocked run wherever both have a block stops the check with an error
(`PinConflictError`). A DAPI node can withhold such a run but cannot substitute one. A block more than 5,000 blocks below the
lowest pin is out of reach, and the old walk down from the ChainLock applies, up to 400,000 blocks ("too old to verify here").

### 2.3 The header checkpoint and proof of work (fallback)

`CHECKPOINTS` in `packages/dapi/src/headerchain.ts:49-52` pins a second block per network for the proof-of-work path:

- mainnet: block 2,544,000
- testnet: block 1,578,000

On this path every header from the pin to the tip must pass Dash Core's header rules: Dark Gravity Wave difficulty, the work
target, median time past, and at most 2 h in the future. Two extra floors apply: every header's target is at most 8x the pin's,
and the chain must be as long as the clock requires. `packages/dapi/README.md` ("Anchored chain") estimates the cost of
forging past these floors at about two real blocks of work per hour since the pin.

- **Mainnet:** proof of work is accepted as secure. Facts proven this way can reach "Verified".
- **Testnet:** difficulty is too low to stop a forger (`POW_SECURE`, `headerchain.ts:41`). The chain is flagged `weak`, and
  every fact that rests on it is shown as "reported", never "Verified" (`packages/dapi/src/anchor.ts:283`;
  `apps/web/src/verify/aggregate.ts:127,154,216,259`).

The app uses this path whenever no quorum-proof source returns a valid, fresh proof and no saved ChainLock is fresh enough
(section 3).

### 2.4 Your clock

Freshness checks use the local clock:

- A ChainLock target must be under an hour old (`FRESH_S`, `packages/dapi/src/anchor.ts:36`; `packages/dapi/src/proofanchor.ts:111,131`).
- On the proof-of-work path, the clock sets the minimum chain height.
- Votes more than 1 h in the future are dropped (`countVotes`, `packages/verify/src/tally.ts:111`).

On the quorum-proof path, a wrong clock causes failures or stale results, not forged ones. On the proof-of-work path it also
weakens the proof: a clock that runs behind lowers the minimum chain height (`anchor.ts:270`), and with it the cost of
forging a chain.

### 2.5 Dash's quorum list service (for Platform reads)

This root is not pinned and not proven. See section 6.6.

### 2.6 Your own keys

Your keys never leave the browser:

- Masternode voting keys sign votes in the browser (`apps/web/src/voting/plan.ts:152-167`; `packages/verify/src/vote.ts:111`).
  A relay gets only the signed vote.
- Platform identity keys sign state transitions in the browser through evo-sdk (`packages/auth/src/evo.ts`).
- One-time keys derived from your phrase or sign-in key (account funding, top-ups, proposal fee deposits) sign asset locks,
  proposal collaterals and Recover sweeps in the browser (`packages/auth/src/tx.ts`; 6.10). A secret typed into Recover stays in
  memory and is wiped when you leave the tool (`apps/web/src/auth/Recover.tsx:50-61`).

Anyone with your voting key can vote as your masternode. Anyone with your recovery phrase controls your identity, and any
funds still at its one-time deposit keys. The same-tab
and cross-tab handling of those secrets is covered in section 8.

### 2.7 Identifiers pinned in the build

These are part of the app code (2.1), but you should know they exist:

- the `gov` contract ids (`registry.ts:15,103`) and the bridge identities whose `claimAttestation` documents count
  (`registry.ts:17,104`; `attestorsFor`, `registry.ts:205`);
- the forum and `mod` contracts and the moderation identity (`registry.ts:112-118`);
- the default relays (`registry.ts:19,21`);
- the default badge issuer (`apps/web/src/badge/config.ts:44-54`).

All of them except the badge issuer can be overridden in Settings, or through an imported config. The badge issuer list is not
part of that config; it is changed in its own settings section. `attestorsFor` also adds the profile's pinned bridge identity
whenever the configured gov contract is the profile's (`registry.ts:205-209`).

## 3. How the chain is verified

The verification worker (`apps/web/src/verify/worker.ts`) builds one "anchored chain" per DAPI setting. It reuses the result
in memory for a minute (`packages/dapi/src/anchor.ts:72-99`), and keeps the verified headers in IndexedDB so later runs only
extend them. Within the minute, an old block that a pin reaches adds only the run of headers up to that pin. Both paths end in the same facts: verified block
hashes from a low height up to a ChainLocked tip, and a masternode list (SML) proven by a block's coinbase.

**Quorum-proof path (no proof of work).** This is `anchorByProof`, `packages/dapi/src/proofanchor.ts:159`.

1. A source sends a DIP 175 proof chain (`DASHNC02`). It is checked in WebAssembly by `dash-core-proof`, the verifier of
   dashpay/platform PR #5521, built unmodified (`packages/dapi/core-proof-wasm/`). The proof runs from the pinned quorum
   checkpoint to a ChainLocked target T, which must be under an hour old.
2. The masternode list from a DAPI node must be from a block S with T - 8 <= S <= T. Within one session, the list the last
   anchor proved is used again while the new T still meets that rule; it is proven against the new chain again (step 4).
3. Headers from T down to S, and down to any older block of interest above the quorum checkpoint, are tied together by hash
   linkage alone. A ChainLock is final, so no proof-of-work rule is needed. An older block at or below the checkpoint is reached
   through a pinned hash instead (2.2a).
4. The SML is re-serialized to Core's consensus bytes and hashed. It must reproduce the coinbase's `merkleRootMNList` and
   `merkleRootQuorums`, and the coinbase must be merkle-proven into the header at S.
5. T's signature is checked against the quorum Core's `SelectQuorumForSigning` picks from the proven list.

**Proof-of-work path.** This is `runInner`, `packages/dapi/src/anchor.ts:186`. Headers are fetched from the pin and checked
under the rules in 2.3. Then the SML is proven into a block of that chain, and the newest ChainLock is verified against
quorums from that proven SML.

**Which path you get.** `anchor.ts:150-183` decides:

- The proof path runs when at least one source is configured and the verifier loads. If no source has a newer proof, a
  ChainLock this browser proved earlier is reused while it is under an hour old (`savedChainLock`, `proofanchor.ts:126-133,204`).
- If every source fails (unreachable, HTTP 501 from a pre-v24 dashd, 403, a forged or stale proof) and nothing saved is fresh
  enough, the app falls back to proof of work.
- Two verified ChainLocks for different blocks at one height stop the check with an error. They never fall back
  (`ChainLockConflictError`, `anchor.ts:173-174`).
- A source that cannot serve proofs at all is skipped for 10 minutes (`proofanchor.ts:50`).
- The fallback reason is kept in `trust.fallback`. The chain shield in the header shows what the chain rests on
  (`apps/web/src/ui/trust/ChainShield.tsx:106-108`).
- The drawer shows the same in the chain check's details.

**Sources per profile:**

| Profile | Core / Platform | Quorum-proof sources | What chain facts rest on today |
|---|---|---|---|
| Testnet | testnet / testnet | testnet bridge, then `quorums.testnet.networks.dash.org/proofs` | ChainLocks from the quorum checkpoint. If both sources fail: testnet proof of work, labelled "not secure". |
| Dev (default, `registry.ts:191`) | mainnet / testnet | Dev bridge only. Its dashd runs 24.0.0-rc.4 and serves quorum proofs (`registry.ts:167`). The mainnet quorum list server was removed: it answered 403 and sent no CORS headers (`registry.ts:91-98`). | ChainLocks from the quorum checkpoint. If the bridge can't serve a proof (unreachable, or a Core without `getquorumproofchain` answering 501): mainnet proof of work from the header checkpoint, which counts as "Verified". |
| Mainnet | mainnet / mainnet | none (not deployed, `registry.ts:172-185`) | n/a |

## 4. What the "Verified" badge requires

One badge per proposal, computed by `aggregate()` in `apps/web/src/verify/aggregate.ts:68-87`. "Verified" needs each of the
five `REQUIRED` checks (`aggregate.ts:13`) present exactly once, and each `proven`. The precedence is: any failure, then
anything still running, then any error, then anything only reported. Fixture data is always "Demo data". The five checks:

1. **Proposal text** (`contentComponent`, `aggregate.ts:92`). The governance hash recomputes from
   `(parentHash, revision, time, dataHex)`, and every displayed field equals the one parsed from `dataHex`
   (`checkContent`, `apps/web/src/verify/collateral.ts:113-143`). This runs synchronously, with no network. Slim `proposal`
   documents (mainnet `gov.json`) store only the hashed fields plus name and end date; the URL, payment address, amount and
   start are parsed from `dataHex` (`docToProposal`, `apps/web/src/data/platform.ts`).
2. **Submission fee** (`collateralComponent`, `aggregate.ts:104-145`). All of these are needed:
   - steps `hash`, `fields`, `tx`, `block`, `collateral`, `confirmations`, `chainlock` and `height` are all `ok`;
   - the chain steps rest on the anchored chain (basis `verified`);
   - the chain is not `weak`;
   - no second-node cross-check was needed;
   - the chain height equals the published `collateralHeight`.

   The per-transaction ChainLock fallback is never enough on its own (`aggregate.ts:125-126`). That fallback is a ChainLock
   checked against a masternode list that two of three DAPI nodes agree on.

   "Failed" is kept for cryptographic contradictions (`verdictFailure`, `collateral.ts:102-108`): the published fields against
   the governance hash, the real collateral (bytes that hash to its txid) not burning at least 1 DASH to that hash, or a
   collateral height the verified chain contradicts. When every DAPI node asked (two or more) answers NOT_FOUND, the check is
   "Couldn't verify (the nodes didn't return the fee transaction)": nodes can't prove that a transaction doesn't exist
   (`collateral.ts:204-211`; `aggregate.ts:114`).
3. **Chain and masternode list** (`chainComponent`, `aggregate.ts:149-157`). The anchored chain is not `weak`, and the funding
   threshold is `verified`. "Verified" here means every SML entry was read, and the type of every valid version-1 entry (which
   the SML hash does not cover) is proven from its ProRegTx (`threshold`, `apps/web/src/verify/chain.ts`).
4. **Vote count** (`votesComponent`, `aggregate.ts:173-223`). All of these are needed:
   - The shown tally is the **Platform** one: the active proposal's entry in the bridge's packed `talliesSet` document, or the
     per-proposal `tally` document (the final tally of an ended proposal, and every tally on older testnet contracts), whichever
     is newer (`tallies`, `apps/web/src/data/repo.ts:286-324`; `docToTallySet`, `platform.ts:152-156`). A packed entry is a tally as of
     its page's `asOfHeight`. A bridge-only live tally is never proven (`aggregate.ts:202`).
   - The browser counts a vote only when its masternode is in the proven SML, the masternode's hash-checked ProRegTx proves the
     vote's collateral outpoint and the type (weight), and the signature recovers to the voting key the **proven SML** assigns,
     never the bridge's key (`verifyVotes`, `apps/web/src/verify/votes.ts:166-300`). Every other vote is excluded and counted by
     reason: bad signature, an outpoint not in the bridge's list, a duplicated masternode, not in the proven list, not signed by
     the proven key, collateral or type not proven by the ProRegTx (`PROBLEM_TEXT`, `votes.ts`).
   - That count matches the tally in every field, including the `voteSetHash`.
   - Nothing was excluded, and the bridge's own masternode list agrees with the proven key and type of every counted voter
     (`keysFrom === 'sml'`, `votes.ts:289`).
   - The tally is not stale: at most 576 blocks behind the verified tip, and not superseded by a different newer live tally
     (`aggregate.ts:168,212-215`).

   When the tally only matches with the excluded votes added back (those whose signature recovers to the key the bridge lists,
   at the bridge's weight), and the bridge's list agrees with every counted voter's proven key and type, the check is "Partly
   verified" and says how many votes were excluded and why (`aggregate.ts:208`). When
   it matches neither count at the same height, it is a "mismatch" error, never a pass (`contradicts`,
   `apps/web/src/verify/verdict.ts:19`; `aggregate.ts:193-200`).
5. **Funding** (`fundingComponent`, `aggregate.ts:242-280`). The chain and vote checks must be proven. Then:
   - Ended proposals: the payment scan read every superblock in the payment window from the verified chain. If a payment
     could equally belong to another listed proposal (same address, same amount, its window too), the result is not proven.
   - Active proposals below the threshold: "not passing" is proven.
   - Active proposals at or above it: the funding order is needed. That is a recount of every listed active proposal, ranked
     by Core's rules against the proven threshold and budget. A proposal whose payment depends on Core's superblock-time
     estimate is not proven. One unproven recount makes the whole order unproven (`rankRecounts`, `apps/web/src/verify/ranking.ts:55-61`).
   - Funding is also not proven when the payment history could not be fully read: superblocks unread or left for later, not
     every listed proposal read, or a weak chain (`aggregate.ts:256-261`).

The badge never reads a tally's `rank` or `inNextBudget` fields (`provenFunded`, `aggregate.ts:287-292`).

**What "Verified" does not cover:**

- Completeness: votes or proposals the bridge withheld.
- Who owns the proposal: checked separately (section 5).
- Comments.
- Anything read from Platform beyond the five checks.

The drawer says the first of these in "What this can't detect" (`apps/web/src/ui/trust/VerificationDrawer.tsx`).

## 5. Fact by fact

"Platform proof" in this table means a read through evo-sdk `*WithProof` calls (`queryContract`, `apps/web/src/data/platform.ts:50-66`).
Its trust is the subject of section 6.6. The Platform proof shows that the document's owner published it. It does not show
that the content is true.

| Fact shown in the UI | How it is proven | Who could lie, and what they could do | What you would see |
|---|---|---|---|
| Proposal text, name, URL, amount, address, dates | Governance hash recomputed; fields parsed from `dataHex` (`collateral.ts:113-143`). The collateral must burn to that hash. | Bridge (publisher), or Platform reads (6.6): a changed field breaks the hash. A rewritten proposal with a matching new hash needs a collateral that burns to the new hash: naming the old one fails the check (it burns to the old hash); naming one the nodes don't return is "Couldn't verify". While that check is pending or inconclusive the proposal stays listed (`view.ts:102-105`). | "Failed verification" (hidden from lists), or "Couldn't verify". |
| The list of active and past proposals | Platform proof of the query result (`apps/web/src/data/repo.ts:235-276`). | Bridge: can omit, or delete its documents (`gov.json` `canBeDeleted: true`). A lying quorum service (6.6) could forge an incomplete result. | Nothing. A missing proposal is not detected. |
| Proposals marked "not yet published on Platform" | Bridge `/v1/proposals`, labelled reported (`repo.ts:259-263`). Content is checked like any other proposal. | Bridge: can't fake one without a real collateral. | Reported mark; the same content and collateral checks. |
| Proposal collateral: fee, block, confirmations, height | Tx bytes hash to the txid; it burns at least 1 DASH to the hash; merkle-proven into a block of the anchored chain; at least 6 confirmations from the verified tip; ChainLock verified (`apps/web/src/verify/collateral.ts`; `worker.ts:118-157`). | DAPI nodes: can withhold or answer slowly, and can't forge a collateral. Every node asked answering NOT_FOUND is "Couldn't verify (the nodes didn't return the fee transaction)", never a failure (`collateral.ts:204-211`; `aggregate.ts:114`). Without an anchored chain, the result is "reported". | "Couldn't verify" or "Partly verified", with the reason. "Failed verification" only for a contradiction the browser proves (section 4, check 2). |
| A proposal hidden as "failed verification" in lists | Background "light" check: a node's answer plus a second node's, no block proof (`apps/web/src/app/context.tsx:138-153`). Hidden only for a cryptographic contradiction: content against the hash, or the real collateral not burning to it (`verdictFailure`, `collateral.ts:102-108`). Results are cached per proposal (`checks.ts:88`). | Bridge (publisher): a proposal whose collateral the nodes don't return stays listed, marked "Couldn't verify". DAPI: NOT_FOUND, altered bytes or low confirmations never hide a proposal. | Hidden behind "Show N proposals that failed verification". |
| Funding threshold and masternode count (proposal page) | Proven SML, version-1 types from ProRegTxs (`chain.ts`, `threshold`). | DAPI: can withhold. | Reported until proven. |
| Funding threshold, budget, allocated (lists, budget header) | Bridge-published `cycle` document (Platform proof), or bridge `/v1/cycle` if Platform fails (`repo.ts:217-233`). | Bridge: can publish wrong values. The proposal page compares the budget with the proven limit ("the bridge reports ...", `apps/web/src/verify/facts.ts:100-105`). | Lists: nothing. Proposal page: a differing figure. |
| Superblock height, voting deadline, budget limit | Consensus rules at the verified tip (`chain.ts`, `scheduleAndBudget`). Dates are estimates at 2.62 min per block. | DAPI: can withhold newer blocks, so the tip is up to an hour stale (2.4). The heights themselves are computed, not reported. | — |
| Tally numbers on list cards | The fresher of the Platform tally (proof: the packed `talliesSet` entry, or the per-proposal `tally` document) and the bridge's live tally (reported) (`pickTally`, `apps/web/src/lib/view.ts:39-43`). | Bridge: it publishes both. Its Platform tally carries the "Platform proof" mark, which only shows who published it. A live tally with a higher `asOfHeight` wins (`view.ts:41`). | A provenance mark. No recount on lists. |
| "Passing", "in next budget" on list cards | Computed from the shown tally; uses the tally's own `inNextBudget` field (`view.ts:72`). | Bridge: sets that flag. | Nothing on lists. The proposal page shows the proven result once verified. |
| Tally on the proposal page | Platform tally: the packed `talliesSet` entry or the per-proposal `tally` document, whichever is newer (`tallies`, `repo.ts:286-324`; `docToTallySet` and `docToTally`, `platform.ts:134-156`), recounted from signed votes (section 4, check 4). | Bridge: can withhold votes, or serve an older vote of a masternode in place of its newer one. It can't alter a signed vote. A vote from a masternode it made up, or one not signed by the proven key, is excluded from the count; a tally that counts it is "Partly verified". A misstated key or type in its list is caught too. Testnet keys are proven like mainnet's on the quorum-proof path, and "not secure" only on testnet proof of work (`worker.ts:225`). | Nothing for withholding. Otherwise a recount mismatch, or "Partly verified" with the excluded votes. |
| The vote set ("Check the votes yourself") | Each counted vote: its masternode in the proven SML, its outpoint and type proven by the ProRegTx, its signature recovered to the voting key the proven SML assigns (`verifyVotes`, `votes.ts:166-300`). Duplicate masternodes in the bridge's list are refused (`votes.ts:174-189`). Anything else is excluded, never counted. | Bridge: can omit. | "N votes excluded", by reason, and a "Counted here" column with the browser's own count. |
| Funded / rank (proposal page) | Funding order recount (`worker.ts:233-262`; `ranking.ts`). | Bridge: can omit votes, or omit whole proposals from the ranking set (`facts.ts:112`). The result can still be "verified". | Nothing for omission. |
| Payments made | Superblock coinbases of the verified chain (`chain.ts`, `payments`). | DAPI: can withhold blocks, which leaves "unread" superblocks. A proposal missing from Platform with the same address and amount can't be ruled out (`facts.ts:79`). | A lower bound, "not exact". |
| Payments remaining | Estimate only (`facts.ts:93-94`). | — | Marked estimate. |
| Best block height (header) | One synced DAPI node's word, or the bridge's (`repo.ts:331-340`). | DAPI or bridge. | Marked reported. |
| The chain shield ("Chain verified to block N") | The anchored chain (section 3). | Proof sources and DAPI: can force the proof-of-work fallback by failing. | What it "rests on" changes; on testnet, "not secure". |
| Your masternodes (keyring) | Voting key matched in an SML that DAPI nodes agree on: the first two identical answers win (`packages/dapi/src/agreed-sml.ts:40-66`). The collateral outpoint comes from the bridge and is proven by the ProRegTx (`apps/web/src/voting/masternodes.ts:1-6`). | Two agreeing DAPI nodes, or the bridge. | Labelled "bridge" when only the bridge says so. |
| Your vote: held / broadcast | The relay's status answers. | Relay: can lie. | — |
| Your vote: "the bridge reports it on the network" / "counted" | The first configured bridge's vote set contains a vote whose signature recovers to your key, with the same time and outcome (`KeyringContext.tsx`; `bridgeVerdict`, `apps/web/src/voting/pending.ts`). "Counted": a recount of that set includes it. The copy says it is the bridge's report (`describeVote`, `apps/web/src/voting/status.ts`). It names agreement from other sources you configured: other bridges whose vote sets have the same signed vote (up to two are asked), and relays that report their Dash Core node lists it (`corroboration`, `status.ts:75`). | Bridge, or a bridge and relay together: could show it for a vote that never reached Dash Core. A second bridge or relay run by the same operator agrees just as easily. | With no agreeing source, "That is the bridge's word". Compare with your own node (the drawer gives the `dash-cli` commands). |
| Proposal owner | `verifyClaims` (`packages/verify/src/claim.ts`). Methods, highest rank first: (1) the identity named in the hashed URL, accepted by its own claim; (2) a signature from the payment address; (3) a signature from a collateral input key; (4) an attestation by the hosting team. | Method 4 is the hosting team's word, and labelled so. Methods 1-3 rest on Platform proofs of `$ownerId` (6.6) plus signatures checked here. | "owner, vouched for by the hosting team" for method 4 (`apps/web/src/ui/Ownership.tsx:72`). |
| Comment author | The document's `$ownerId` under a Platform proof. Platform only accepts documents signed by the owner's key. | 6.6. Display names are self-chosen and never trusted for identity (`apps/web/src/ui/Identity.tsx:1-3`). | — |
| DPNS name | `dpns.usernameWithProof` (`apps/web/src/data/forum.ts:44`). | 6.6. | — |
| "MN · vouched by X" chip | RSA blind signature from issuer X, whose key is published on Platform before the epoch (`packages/badge/src/reader.ts:71-116`). | Issuer X: can vouch for a non-masternode. 6.6 for the key documents. | Only what X claims. |
| Hidden comments and authors | Block lists read with Platform proofs (`apps/web/src/app/moderationLoad.ts:42-69`). | The list owner decides what is hidden; 6.6. | "Show hidden" toggle; lists can be turned off. |
| Reaction scores | Counted in the browser from Platform-proven reactions (`apps/web/src/ui/Votes.tsx:1-3`). | 6.6. Anyone can create identities, so scores are not sybil-resistant. | — |
| Identity balance | `identities.balanceWithProof` (`packages/auth/src/evo.ts:499-500`). | 6.6. | — |
| Voucher link | The voucher transaction from DAPI. Platform validates the asset lock when it creates the identity (`packages/auth/src/voucher.ts`). | Faucet: can refuse, can spend the voucher first, and knows which identity it funds (6.4). | "This voucher has already been used". |
| USD price | CoinGecko, reported (`repo.ts:342-354`). Fetched only when the Core network is mainnet (Dev profile included). | CoinGecko: any number. | Marked reported. |

## 6. Backend by backend

### 6.1 Bridge (`services/bridge`)

**What it does.**

- It reads governance objects, signed votes, blocks and ChainLocks from its Dash Core node. It publishes `proposal`, `cycle`
  and tally documents into a `gov` contract it owns (`services/bridge/src/publish/publisher.ts`). The tallies of active proposals
  go into one packed `talliesSet` document (paged), whose entries all carry the page's `asOfHeight`; an ended proposal gets one
  final per-proposal `tally` document. `proposal` documents are slim on mainnet `gov.json`: the app re-derives the URL, payment
  address, amount and start from `dataHex`.
- Every `gov` type is `creationRestrictionMode: 1` (owner only) and `canBeDeleted: true` (`packages/contracts-v1/gov.json`).
- It publishes a proposal only after its own checks: hash, data rules, collateral, and 6 confirmations
  (`publisher.ts:243-255`).
- It holds a tally back when its recount differs from Dash Core's own counts, unless `PUBLISH_ON_MISMATCH` is set
  (`publisher.ts:290-302`).
- It serves a read-only HTTP API (`services/bridge/src/api/server.ts`):

| Endpoint | How the app uses it |
|---|---|
| `/v1/status` | Coherence gate for the page's reads: the network it reports must match, and the contract too if it reports one (`repo.ts:167-180`). This is self-reported, not authentication. Also a fallback source for the block height. |
| `/v1/proposals`, `/v1/proposals/:hash` | Proposals not yet on Platform, labelled reported. |
| `/v1/proposals/:hash/votes` | The signed votes. Every vote is verified (section 5). |
| `/v1/mnlist[/:height]` | Masternode list for weights and outpoints. Cross-checked against the proven SML and ProRegTxs. |
| `/v1/tallies` | Live tallies, labelled reported. Also the targets of the funding-order recount. |
| `/v1/cycle` | Fallback when Platform can't be read. The app never uses the bridge's `getgovernanceinfo` parameters: consensus constants are compiled in (`repo.ts:211-215`). |
| `/v1/quorum-proof` | Quorum proofs. Untrusted (6.7). |

**What it could lie about or get wrong:**

- **Withhold or delay.** It can leave out proposals, votes or tallies, delete its own documents, or stop publishing. Nothing
  in the app detects omission. A stale Platform tally (more than 576 blocks behind the verified tip, or older than a different
  live tally) stops "Verified" (`aggregate.ts:212-215`). But a bridge that stops publishing and also stops serving newer
  votes would go unnoticed until that age is reached.
- **Serve an old vote.** Dash Core keeps one current vote per masternode. A bridge can serve a masternode's earlier vote
  instead of its newer one. The signature is valid, so the recount cannot tell.
- **Publish a wrong tally.** The recount detects it, as long as the bridge also serves the vote set for that height. If the
  set is the bridge's own (it serves both), a wrong tally only "matches" a vote set that omits or substitutes votes. That is
  the withholding above, not a forged vote.
- **Report a wrong masternode list.** Detected: the browser counts each vote with the key and type the proven SML and the
  ProRegTx give, never the bridge's. A bridge list that disagrees with them makes the result "Partly verified" (`listDiffers`,
  `votes.ts:267`). A masternode that has left or changed its key since the tally's height looks the same as a lie: its vote is
  excluded and the result is "Partly verified", not a pass (`votes.ts:240-266`).
- **Publish wrong `cycle` figures** (budget, allocated, valid count). Lists and the budget header use them unproven. The
  proposal page proves the threshold and budget limit itself.
- **Set `rank` and `inNextBudget` on tallies.** Lists show them. The proposal page never uses them for "Verified".
- **Add a vote from a masternode it made up.** The vote is excluded from the count, shown as "1 vote excluded (masternode not
  in the proven masternode list)", and the result can't pass (`votes.ts:247-248`). A tally that counts it is "Partly verified",
  never verified. Its made-up registration is never looked up, so it can't make the recount fail either (`proRegFor`,
  `worker.ts:102-114`). The same holds on testnet: voting keys there are proven from the SML like mainnet's (section 8, item 12).
- **Make "confirmed" appear for your vote** (6.2).

**What it can't do:**

- Alter a proposal or invent one without a real collateral.
- Forge a vote signature.
- Give a vote more weight than its masternode type allows, or count a masternode twice: the weight is the proven type's, and
  duplicates are refused.
- Make a wrong tally pass the recount while serving the honest vote set for that height.

**Failover, not comparison.** Settings may list several bridges, but their data is never compared or merged:

- The page's reads (proposals, live tallies, cycle) use the first bridge whose status checks out, and move on to the next if
  a call fails (`firstBridge`, `repo.ts:185-196`).
- The verification worker uses one bridge: the first one whose status checked out, fixed for the session, or bridge 0 before
  any status check (`bridgeDescriptor`, `repo.ts:356-360`). It does not fail over.
- The keyring (your masternodes, vote confirmation) always uses the first configured bridge, with no status check and no
  failover (`KeyringContext.tsx:326`; `VotePanel.tsx:416`). The one exception: once the first bridge reports your vote, up to
  two other configured bridges are asked whether their vote sets have it too, and the status names those that agree (6.2).

To catch omission, compare by hand: put another bridge first in Settings, or run the drawer's `dash-cli` commands against
your own node. PLAN.md's "multiple bridges" defence against omission is not built.

### 6.2 Relays (`services/relay`)

**What a relay receives:** `POST /v1/votes` with
`{network, collateralTxid, collateralIndex, govHash, signal, outcome, time, sig, releaseAt?}`
(`services/relay/src/relay.ts:137-156`). The browser signs the vote with the voting key. The relay never gets a key.

**It can't forge or alter a vote.**

- The signature covers the outpoint, proposal, signal, outcome and time.
- The relay checks that the signature recovers to the masternode's voting key (`relay.ts:203-209`).
- Dash Core checks it again on `voteraw`.

**What it could do:**

- **Censor.** It can drop a vote, or never broadcast it.
- **Delay or reorder.** `releaseAt` is not signed (`apps/web/src/voting/withdraw.ts:44-46`). Core accepts a late vote as long as
  it is newer than the masternode's current one. So a relay can release a vote late, or early. Releasing it more than 1 h
  before its signed time fails: Core rejects votes more than 1 h ahead of the receiving node's time
  (`packages/verify/src/mnvote.ts:14-15`). The relay's own 1 h rule (`relay.ts:196-201`) only binds an honest relay.
- **Ignore a cancel.** A held vote is cancelled with a message signed by the voting key, but an operator who ignores it can
  still release the vote (`services/relay/README.md`, "Cancels need an honest relay").
- **Lie about status.** "Held" and "broadcast" are the relay's word.

**Defences in the app:**

- **Several relays, if you list them.** Each send tries the healthy relays in a fresh random order and stops at the first that
  accepts, so a batch can spread across relays (`KeyringContext.tsx:996-1034`). Both deployed profiles list one relay
  (`registry.ts:152,166`).
- **Re-broadcast.** A vote the bridge doesn't show 10, 20 and then 30 minutes after its release is re-sent, up to 3 times
  (`pending.ts:96-97,283-285`). Each re-send goes to a relay not used yet, or back to the first relay when all have been used
  (`pickRebroadcastRelay`, `pending.ts:291-294`). With one relay, it is the same relay.
- **Your own copy.** The browser keeps the signed votes, encrypted under the keyring (`pending.ts:1-12`).

**Confirmation rests on the bridge, and says so.**

- "The bridge reports it on the network" (internally `confirmed`) means the first bridge's vote set contains a vote,
  signature-checked here, with the same time and outcome as yours.
- "The bridge reports the network counted it" means a recount of that set includes it.
- The relay's own status never sets these (`applyRelayState`, `status.ts:246`).
- The status line names any other source that agrees (`corroboration`, `apps/web/src/voting/status.ts:75`): another configured
  bridge whose vote set has the same signed vote (checked here; up to two are asked, `KeyringContext.tsx`), or a relay whose
  status is `confirmed`, which means the relay saw the vote in its own Dash Core node's `gobject getcurrentvotes`. With none,
  it says "That is the bridge's word". Nothing new is queried beyond the bridges and relays you configured.

The bridge used is always the first configured one (6.1). This catches a lying relay only when that bridge is independent of
the relay. The relay is a compose profile of the bridge's own stack, sharing its dashd (`deploy/README.md` section 11.4), and the
default relays and bridges are run by the same team (`registry.ts:19-21,151,165`). For certainty, check your vote on your
own node.

**Deferred voting.**

- Each masternode's vote gets its own random release time, between now and the voting deadline minus 12 h on mainnet
  (10 min on testnet). The vote is signed with that time (`apps/web/src/voting/plan.ts:21,87-123`).
- The relay holds it until then (status `held`), for at most 40 days (`services/relay/src/config.ts:91`).
- The aim is that your masternodes' votes do not appear on chain in one burst.
- The relay still learns the plan in advance: which masternodes submitted together, from which IP, and how they voted (7).

**Proposal submission (the "New proposal" wizard).**

- **In the browser.** The wizard builds `dataHex` and checks it against Core's proposal rules (`checkNewProposal`,
  `packages/verify/src/newproposal.ts:251-286`), then fixes `time` and the governance hash (`lockProposal`,
  `newproposal.ts:300-304`). It saves the draft locally and asks for a backup file before payment (`apps/web/src/proposal/draft.ts`;
  `PayStep.tsx`). The backup holds the full proposal and the `gobject prepare` and `gobject submit` commands, and no keys.
- **The fee.** You pay to a one-time deposit address derived from your sign-in key or seed (`packages/auth/src/proposal.ts:49-68`).
  The browser builds and signs the collateral: an `OP_RETURN` of the hash burning 1 DASH, plus change to a refund address
  (`buildProposalCollateral`, `packages/auth/src/tx.ts:263-295`). It checks that collateral with `checkCollateralTx`, and
  broadcasts it over DAPI, never through a relay (`proposal.ts:347-392`). You can also pay with your own Dash Core's
  `gobject prepare` and paste the txid.
- **The relay holds it.** Right after the broadcast, the browser hands `{network, time, dataHex, collateralTxid}` to a relay
  (`POST /v1/proposals`, `apps/web/src/proposal/relay.ts`). The relay checks the data and the collateral against its own Core,
  then runs `gobject submit` itself once its Core counts 6 confirmations (`services/relay/src/proposer.ts:180-211`). It
  refuses a submit result whose hash differs. A relay without this endpoint gets `POST /v1/proposals/submit` after the browser's
  own count reaches 6 (`submission.ts:88-93`).
- **What the browser checks.** It checks the collateral it fetched over DAPI with `checkCollateralTx`, and counts confirmations
  against its verified chain (`apps/web/src/proposal/services.ts:110-133`). After "submitted", it looks for the proposal on the
  first bridge ("Seen by the network") and on Platform ("On govhub").
- **What a relay can do.** It can refuse, delay, or never submit. "Waiting" and "submitted" are its word. While it reports
  "waiting", the browser asks no other relay, and after "submitted" it never re-submits (`submission.ts:39,112-121`). Both
  deployed profiles list one relay.
- **What it can't do.** It can't alter the proposal: the collateral burns to its hash. To submit different content it would
  have to pay its own 1 DASH collateral.
- **Your way around it.** Run the `gobject submit` command from the backup on your own Dash Core node. "I submitted it" in the
  page is not checked; it only records what you say (`SubmitStep.tsx:126-143`).
- **Privacy.** The relay learns your IP and the poll timing (about every 45 s while the page is open), and the full proposal.
  A govhub URL contains your identity id. It stores no IP, rounds times to the hour, and deletes finished records after 7 days
  (`services/relay/src/db.ts:131-150`; `services/relay/README.md`).

### 6.3 Badge issuers (`services/issuer`)

**How a badge is issued.**

- The scheme is RSA blind signatures, RSABSSA-SHA384-PSS-Randomized (RFC 9474) (`packages/badge/README.md`).
- A masternode asks for a token by signing the request with its **voting key**. The issuer checks the key against its own
  Dash Core masternode list. It also requires the masternode to be valid now and at the epoch snapshot, with the same
  collateral at both heights (`services/issuer/src/service.ts:129-178`).
- The badge message the issuer signs blind contains the receiving identity (`packages/badge/src/format.ts`). The issuer never
  sees that identity.

**What readers check** (`packages/badge/src/reader.ts:71-116`; `apps/web/src/badge/reader.ts`):

- Only issuers on the user's trust list count. The default list holds only the govhub issuer on testnet. Mainnet has no
  issuer and no badge contract yet (`apps/web/src/badge/config.ts:44-54`).
- Each issuer's per-epoch key must be published on Platform before the epoch's snapshot, and bound to that issuer and epoch.
- The signature must verify over the badge message rebuilt from `$ownerId`.
- The badge must be in its display window and not revoked.
- The reader audits each issuer's self-reported `tokensIssued` against the proven masternode count, and against the number of
  badges it finds. A flagged issuer's badges are hidden (`apps/web/src/badge/reader.ts:190-264`).

**What an issuer can do:**

- **Vouch for a non-masternode.** Nothing checks that the identity behind a badge runs a masternode. That is exactly the
  trust in "vouched by X". `BadgeLeaks.tsx` and the issuer README say so.
- **Issue up to a plausible number** of extra badges, by reporting a matching `tokensIssued`. The audit only catches more
  badges than the issuer itself reported, or an implausible report.
- **Refuse or delay** a token.
- **Learn which masternode asked, when, and from which IP** in every mode (`BadgeLeaks.tsx:79-82`). An operator who also runs
  evonodes can join that IP with the identity's Platform traffic (`services/issuer/README.md`, the "Same IP" row).

**What an issuer can't do:**

- Link a badge to the token request cryptographically, because it signs blind.
- Copy a badge to another identity, because `$ownerId` is in the signed message.
- Use a key it did not publish in time.

**Privacy modes.** There are two: Standard and Private (`packages/badge/src/schedule.ts`; Extra private was removed on
2026-10-25 and continues as Private). They differ in the epoch requested, in timing, and in a crowd-size check. The issuer
endpoint is the same. Both send a token request only after half an hour without Platform writes or other requests from
this browser, plus a random extra wait drawn per job (exponential, mean 1 hour, at most 4 hours; `apps/web/src/badge/visit.ts`,
`scheduler.ts`). A request found when the app opens waits a random 30 s to 10 min first.

- **Standard** (the default) asks for the current epoch and **holds** the token in the browser's encrypted job store, never
  on Platform. The badge is posted with the identity's next Platform write, once half an hour has passed since the request
  (`auth/runtime.ts` `markWrites` announces every write; `scheduler.ts` `postHeld`), or at once if the user presses
  **Register now**. The issuer could still narrow a badge down by comparing request times with the identity's public write
  times. A request sent while the app stayed open lies 30 minutes to a few hours after the identity's last write (PLAN §8.10).
  With Register now it can match the two by timing.
  Its no-logging policy is a promise the app can't check (`apps/web/src/badge/BadgeLeaks.tsx`).
- A held token is kept only in that browser: a write from another device does not publish it. If nothing is posted before
  its display window ends (S(E+1)+W, less a margin), it lapses. The issuer's per-epoch dedup then means that masternode can
  ask again only in the next epoch.
- **Private** asks for the next epoch at a random height, and posts at a random height in the first W blocks of that epoch
  (about 3.5 days on mainnet; `packages/badge/src/epoch.ts`, `postingWindow`). It posts only if the issuer's report for the
  previous epoch shows enough tokens: 20 on mainnet, 5 on testnet (`apps/web/src/badge/config.ts`, `client.ts` `step`).
  That check is skipped for an issuer's first epoch, which has no earlier report. The crowd is everyone who chose Private
  with the same issuer.
- The issuer can usually tell the modes apart by the epoch requested: the current one for Standard, the next one for
  Private (`service.ts:148-150`). Near the end of an epoch Standard also asks for the next one (`schedule.ts`,
  `requestableEpoch`).

**Dedup is per issuer only.**

- An issuer issues one token per masternode per epoch: `(epoch, proTxHash)` and `(epoch, collateral)` are unique
  (`services/issuer/src/db.ts:59-67`).
- Readers show at most one chip per identity per issuer, and never add up across issuers.
- Nothing stops one masternode from getting a badge from every issuer, for several identities.

**The issuer's own dashd.** The issuer takes epochs from its own Dash Core's tip. The govhub issuer does not let that tip alone
close an epoch, which deletes its dedup rows, or destroy an epoch's signing key. Both wait until Platform's proved chain-locked
core height confirms the tip, within twice the boundary margin by default. Otherwise the issuer skips them, logs a warning and
reports the problem in `/v1/info` (`services/issuer/src/epochs.ts`, `checkTip`; `services/issuer/README.md`, "Tip check"). That
check cannot stop a dashd that fakes the masternode list itself: the issuer trusts its own node to authenticate masternodes.

**Revocations and reports.**

- An issuer revokes an epoch with an `issuerRevocation` document signed by its CRITICAL key. Readers void that epoch's badges
  created at or after `effectiveCoreHeight` (`packages/badge/src/reader.ts:93-98,113`).
- After each epoch it publishes an `issuerReport` with `tokensIssued`, signed by a HIGH or stronger key. Readers accept a report only
  inside its window (`apps/web/src/badge/reader.ts:174-188`).
- Settings lists each issuer's epochs as valid, flagged or without a valid key (`apps/web/src/badge/BadgeSettings.tsx`).
- Badge documents themselves are immutable and undeletable (`packages/contracts-v1/badge.json`).

### 6.4 Voucher links

Govhub does not give anyone free credit: everyone pays for their own account with DASH. The one exception is a
voucher link that someone else gives you.

- A voucher is a `dashpay://invite?...` link the user pastes (`registry.ts:81`; `packages/auth/src/voucher.ts:1-41`). The app
  fetches the voucher transaction over DAPI and creates the identity with the user's own keys. The voucher key signs only as the
  asset-lock key (`voucher.ts:60-116`; `packages/auth/src/evo.ts`).
- The faucet can refuse or run out. It can spend the voucher first: the link carries the voucher's private key, which the
  faucet made; the app then says "This voucher has already been used" (`voucher.ts:74,95`). It knows which identity its
  voucher funded, since the identity id is derived from the voucher's outpoint (`voucher.ts:64`), which it created.

**What the faucet cannot do:** control the identity, whose keys are yours.

### 6.5 DAPI evonodes (Core data)

The node list comes from the quorum service's `/masternodes`, or from your own list in Settings (`createWebDapi`,
`apps/web/src/data/dapi.ts:22-30`). The node list itself is a claim: a wrong list only changes whom the app asks.

**What nodes can do:**

- **Withhold or answer slowly.** Checks then end as "Couldn't verify".
- **Hold back newer blocks.** The verified tip is a lower bound. The one-hour freshness rule limits how stale it can be.
- **Lie about anything not proven.**
  - The best height shown in the header.
  - Confirmations and ChainLock flags on the fallback path (always labelled reported).
  - InstantSend locks, which are parsed but never verified (`packages/dapi/README.md`, "Trust notes").
  - Whether a transaction exists. Nodes answering NOT_FOUND can make a real proposal's fee check "Couldn't verify", in the
    lists and on its page, but never "Failed verification" and never hidden (section 4, check 2).
- **See your funding address.** Deposit watching sends a bloom filter for it (`packages/auth/src/funding.ts`).

**What nodes can't do:** forge a header chain past the pinned checkpoint, a masternode list that hashes to a proven
coinbase, or a transaction that hashes to the requested txid. (Denying that a transaction exists only gets "Couldn't verify":
see above.) On testnet's proof-of-work path they can forge a chain, which is why it is labelled "not secure".

**Agreement facts.** The keyring's "your masternodes" lookup uses an SML that the first two agreeing nodes return, not the
anchored one (`apps/web/src/voting/masternodes.ts:3-6`). So does the collateral fallback ChainLock. Neither ever counts toward
"Verified".

### 6.6 Platform nodes and the quorum list service

**How Platform reads work.**

- Every Platform read uses an evo-sdk `*WithProof` call. These include `documents.queryWithProof`,
  `identities.balanceWithProof` and `dpns.usernameWithProof`. evo-sdk verifies the GroveDB proof and the quorum's BLS
  signature over it.
- The app runs evo-sdk 5.0.0-rc.8 with `trusted: true` (`apps/web/src/config/registry.ts:232`; `getSdk`, `platform.ts:20-39`). In that
  mode the SDK downloads the **quorum public keys** from `https://quorums.<network>.networks.dash.org`.
- With no Platform addresses set (the default), it also takes its **Platform node list** from there
  (`node_modules/@dashevo/evo-sdk/dist/sdk.js`, `connect()`).
- The app does not check those keys against its own verified chain or quorum proof. It also cannot pass another quorum URL:
  `getSdk` passes none, and Settings offers only Platform node addresses.
- PLAN.md lists this as "SDK quorum-key bootstrap". Proving Platform quorum keys from the pinned checkpoint, through the
  masternode list and the CbTx, is not done.

**What follows:**

- **Platform nodes alone** can withhold or answer slowly. They cannot forge a proven answer, and a proven query result is
  complete for the range it covers.
- **The quorum list service** is trusted for Platform the way the checkpoint is trusted for Core. Whoever controls it,
  including its DNS or TLS, could supply a key of their own and point the SDK at a node that signs with it. That would forge
  any Platform read: comments, profiles, block lists, issuer keys and badges, claims, balances, DPNS names, and the gov
  documents.
- **What still holds against such a forgery:**
  - Proposals still need a real collateral on the verified Core chain.
  - A forged tally still has to match a recount of signed votes. The bridge serves those votes, and their keys are proven
    against the Core chain.
  - So the five "Verified" checks hold. Completeness does not, and nothing social does.
- **Freshness.** The app does not check how recent a Platform answer is, beyond showing its Platform height
  (`repo.ts:144-148`). Tally staleness is bounded by the 576-block rule. Other documents (comments, block lists) could be served
  from an old state.
- **Untrusted mode** (`platform.trusted: false` in an imported config). The bundled wasm-sdk contains the error "Non-trusted
  mode is not supported in WASM", so reads should fail rather than go unverified. Not verified by the app's tests.

### 6.7 Quorum-proof sources (bridge `/v1/quorum-proof`, quorum list server `/proofs`)

A source can only fail. A proof authenticates itself:

- Every link is a BLS-signed ChainLock, starting from a quorum committed under the checkpoint's quorum root.
- The target state is what the verifier returns, not what the source says.
- The bridge's `X-Proof-*` headers are ignored.

So a source can't make a false state pass. It can withhold, delay, or send a valid but older proof. A target more than an hour
old is refused (`proofanchor.ts:111`).

Failing has a cost. When every source fails, the app falls back to proof of work (section 3). On mainnet that is still
"Verified", but it rests on 2.3 instead of 2.2. On testnet it drops to "reported". The requests omit credentials and referrer
(`quorumproof.ts:139-150`).

### 6.8 Moderation and the default block list

**Who controls it.** The default list is the `mod.block` documents of the moderation identity. Only the `mod` contract's owner
can create them (`packages/contracts-v1/mod.json`, `creationRestrictionMode: 1`). On both deployed profiles that identity is
the Dev bridge identity (`registry.ts:104,107-118`), which on Dev also owns the gov contract. PLAN.md calls for a separate moderation identity; mainnet has no forum
configuration yet.

**What the team can do with it.**

- Hide any comment or author from view.
- Blocks hide, they never delete (`packages/forum/src/moderation.ts:1`). Hidden items stay behind a "show hidden" toggle
  (`apps/web/src/ui/HiddenToggle.tsx`).
- A blocked author's name and avatar are hidden.
- Their reactions stop counting in scores (`apps/web/src/ui/useReactions.ts:60`).

**What you can do** (Settings, "Block lists", `apps/web/src/pages/SettingsPage.tsx:148-215`):

- Turn the default list off, and subscribe to other identities' lists. These choices are kept in this browser, or on Platform
  as your `blockSubs` document (`apps/web/src/app/moderationLoad.ts:19-31`).
- Keep your own list: the `forum.block` documents you publish with a comment's block buttons. It applies when you are signed
  in (`moderationLoad.ts:60`).

**If a list can't be read,** comments are held back with a notice and a "show the comments anyway" button
(`apps/web/src/ui/Discussion.tsx:111,267-275`).

### 6.9 Third parties

- **CoinGecko** supplies the USD price, which is shown as reported. It can return any number. It sees your IP, but no
  credentials or referrer are sent (`repo.ts:342-354`). Clear "price feed" in Settings to turn it off.
- **Cloudflare** proxies gov.dashhq.org (`deploy/README.md` section 14). Cloudflare Tunnels carry the bridge, the relays and
  the issuer in the reference deployment (sections 11 and 13). Cloudflare sees every request's IP, time and URL for those hostnames. It could
  alter the app it serves (2.1) and any HTTP answer. Altered bridge or relay answers are caught where section 5 says they are.
  Cloudflare's own logging is outside the app's control.
- **GitHub** hosts the repository and serves the build (2.1).
- **Dash's quorum list service** (`quorums.<network>.networks.dash.org`) serves the DAPI node list (claimed, replaceable),
  the Platform quorum keys and node list (trusted, 6.6), and on testnet a quorum-proof relay (untrusted, 6.7).

### 6.10 Recover (Settings, "Recover")

The Recover tool finds money stuck at govhub's one-time keys and lets you send it on (`apps/web/src/auth/Recover.tsx`;
`packages/auth/src/recovery.ts`; [`docs/RECOVERY.md`](RECOVERY.md)).

- **What it finds.** Unspent payments to the account-funding (today's `m/9'/c'/5'/1'/i` and the hardened `…/1'/i'` used until
  2026-10-25; [`docs/RECOVERY.md`](RECOVERY.md#derivation-paths)), top-up and proposal-fee deposit keys of your phrase or pasted
  key, and asset locks paying them that Platform does not prove fully used (`recovery.ts:455-475`). A payment can be swept to an
  address you type, or used to create or top up an identity. An asset lock can only create or top up an identity
  (`recovery.ts:525,598`). Proposal-fee deposits can only be swept.
- **Who it talks to.** DAPI nodes and Platform, nothing else: no bridge, relay, issuer or faucet.
- **What it checks.** Each transaction's bytes must hash to a txid that a merkleblock from the scan proves into its block
  header, and up to two other nodes must not contradict it (`recovery.ts:306-367`). The scan must cover every block it asked
  for (`recovery.ts:325-329`). Lock status is a proved Platform read (`evo.ts:506-515`), rechecked before use. The sweep is
  built and signed in the browser, and the node must return its txid (`recovery.ts:603-618`).
- **What it doesn't check.** The block headers are a node's word: they are not tied to the chain verified in section 3, and
  have no proof-of-work check. The heights it shows are reported.
- **What nodes can do.** Withhold a payment or lock, so the scan says nothing is stuck. Hide a spend, so a spent payment shows
  as unspent; the network then refuses the sweep ("already spent… Scan again"). Fabricating a payment or lock gets nowhere: the
  sweep is refused, and Platform refuses a fake lock. Scanning again, on other nodes, is the only remedy.
- **What Platform (6.6) can do.** A false "used" status drops a lock from the list.
- **What they learn.** The scan nodes get your IP and one bloom filter covering every one-time key of the pass, which links
  those keys to each other. Other nodes see the txids it cross-checks. The broadcast node sees the sweep: destination and
  amount. Platform sees the key hashes it looks up and the lock outpoints.

## 7. Privacy

Privacy is separate from correctness: a backend that can't lie can still learn things.

| Backend | What it learns |
|---|---|
| Web host (GitHub Pages, Cloudflare) | Your IP, the pages you load, and when. |
| Bridge | Your IP, and which proposals' votes and lists you fetch. This includes the vote-confirmation polling for proposals you voted on. Up to two other configured bridges (normally failover only) are also asked for a proposal's vote set right after the first bridge reports your vote, so they too can link your IP, by timing, to that proposal and your masternode. |
| Relay | Your IP, the timing, which masternodes submit together, and **how each one voted** before the vote is public (`services/relay/README.md`, "Threat model and privacy": public unlinkability only). For a proposal you submit: your IP and poll timing, linked to the full proposal and its collateral (6.2). |
| Badge issuer | Which masternode asked, when, and from which IP. In Standard mode, a short list of identities that could hold the badge, from the public times of their writes; with Register now, likely the identity, by timing (6.3, PLAN §8.10). |
| Faucet | Which identity its voucher funded (6.4). |
| DAPI evonodes | Your IP. The bloom filter of a funding or proposal-deposit address you watch; in Recover, one filter covering all your one-time keys, which links them. The transactions you look up and broadcast (proposal collaterals, Recover sweeps). |
| Platform nodes | Your IP. Every document, identity and name you read. The state transitions you sign. In Recover, the key hashes it looks up and the asset-lock outpoints it checks (6.10). |
| Quorum list service | Your IP, when the app starts. On testnet, also each quorum-proof request during verification. |
| CoinGecko | Your IP, whenever the Core network is mainnet (Dev profile included). |

**The no-linkable-logs policy.** It is stated in `docs/PLAN.md` ("No linkable logs"), `services/issuer/README.md` ("What is
stored and logged"), `deploy/README.md` ("Logging policy (issuer)") and `services/relay/README.md` ("Threat model and
privacy").

**Where it is enforced in code or CI:**

- **Issuer.** The per-request data is dedup rows `(epoch, proTxHash, collateral, H(blindedMsg))`, deleted with `secure_delete`
  when the epoch's window closes. The other tables hold per-epoch counts and settings (`services/issuer/src/db.ts:59-74`,
  `epochs.ts`). Logs are lifecycle, errors and hourly aggregate
  counters. `services/issuer/test/logging.test.ts` runs a full issuance with an IP and user-agent header and fails if either,
  or the proTxHash or outpoint, appears in any output.
- **Relay.**
  - Votes have no IP column.
  - The receive time is rounded to the hour (`services/relay/src/relay.ts:251`).
  - Rows are in random order (`services/relay/src/db.ts`).
  - Finished votes are deleted after 7 days by default (`services/relay/src/config.ts:101`).
  - The per-IP rate limiter keys on an HMAC with a per-process salt, in memory only (`services/relay/src/ratelimit.ts:12-31`).
  - `services/relay/test/privacy.test.ts` checks that the SQLite files hold no trace of the client address.
  - Held votes stay until released, so while held the relay database does link a masternode's planned vote to its release time.
- **Bridge.** `services/bridge/test/logging.test.ts` drives every API endpoint and error path (404, 400, 405, 413, 429, a
  Core failure, a failing archive) at the most verbose log level, with a distinctive client IP, user agent and requested
  govHash and height. It fails if any of them reaches stdout or stderr, if a log line pairs a govHash with an identity or a
  client, or if the quorum-proof rate limiter holds the IP in the clear (it keys on a salted HMAC, in memory:
  `services/bridge/src/api/quorumproof.ts:132`). The API's error handler logs the route pattern, never the requested path
  (`services/bridge/src/api/server.ts:126`).
- **Tunnel gateways.** When two stacks share one tunnel, a Caddy gateway sits in front of the guest's bridge, relay or issuer.
  Each gateway writes no access log and discards Caddy's default logger (`deploy/caddy/tunnel-gateway-*.Caddyfile`).
  `.github/workflows/deploy-lint.yml` fails CI otherwise. In a single stack, cloudflared reaches the services directly.
- **Public Caddy proxy** (`deploy/caddy/Caddyfile`, the alternative to the tunnel). No access log, and Caddy's default logger
  is discarded, like the gateways. One more logger writes only certificate-management namespaces (ACME obtain and renew,
  certificate cache maintenance) to stderr, so a failing certificate stays visible; those carry host names, not client
  addresses. deploy-lint fails CI on an access log, a default logger that is not discarded, or any other namespace.
- **cloudflared** runs with `--loglevel fatal` (`deploy/docker-compose.yml`).
- **Browser requests** to the bridge, relays, issuers, price feed and proof sources omit credentials and the referrer
  (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`). DAPI requests and the node-list fetch do not set these options
  (`packages/dapi/src/grpcweb.ts:137`, `nodes.ts:27`); the page-wide `no-referrer` still applies. evo-sdk's requests are outside
  the app's control.

**Not enforced:**

- **Docker** keeps json-file logs of every service (20 MB x 5).
- **Production settings** (Cloudflare Logpush, Web Analytics, edge logs, host snapshots). These are outside the code and not
  verified by the app.

## 8. Known gaps and limits

1. **Platform quorum keys are trusted, not proven** (6.6). This is the main gap for everything social, and for the
   completeness of proposal lists.
2. **Omission is undetectable** (6.1). One bridge is used at a time, with no cross-bridge comparison.
3. **Proof-of-work fallback.**
   - When no quorum-proof source answers, mainnet chain facts rest on the header checkpoint and proof of work (2.3), and still
     show "Verified".
   - The default Dev profile has one proof source, the Dev bridge (Dash Core 24.0.0-rc.4). If it can't serve a proof, Dev falls
     back (section 3).
   - On testnet the fallback is labelled "not secure".
   - The chain shield's "Rests on" line says which root was used. The badge itself does not.
4. **"Unverified" facts are labelled, not hidden.**
   - Reported values (bridge live tallies, best height, USD price, node-reported confirmations) carry a "reported" mark.
   - Platform-proven values carry a "Platform proof" mark. That mark means "this owner published it", not "it is true" (6.6).
   - Lists and the budget header show bridge-published figures with no recount (section 5).
5. **A fee transaction the nodes don't return is only "Couldn't verify".** Nodes can't prove that a transaction doesn't exist,
   so a proposal whose collateral every node asked answers NOT_FOUND for stays listed, marked "Couldn't verify" (6.5). A
   publisher can therefore list a proposal with no real collateral; it never shows as verified, and the bridge's own publisher
   checks the collateral before publishing (6.1). Such a proposal also counts in the lists' totals, such as the active count and
   the budget header, which only leave out "Failed verification".
6. **Tab sharing over BroadcastChannel.**
   - The sign-in is passed between open tabs of the same origin, in memory: a seed's entropy, or the sign-in key
     (`apps/web/src/session/tabShare.ts`, PR #21).
   - Any script running on the same origin can ask for it. That makes the origin, and so the app code (2.1), part of the trust
     for your identity key.
   - Sharing is turned off when the app is served from a sub-path, such as a shared GitHub Pages origin.
   - The masternode keyring and passkey outputs stay in their own tab.
7. **The "confirmed" vote status rests on the bridge,** and the status says so. Other bridges and relays you configured are named
   when they agree; a second source run by the same operator is no more independent (6.2).
8. **Freshness of Platform reads is not checked** (6.6). Freshness of Core facts depends on the local clock (2.4).
9. **Checkpoint trust includes retired quorums** (2.2). Only the final ChainLock's quorum selection is checked.
10. **InstantSend locks are never verified** (`packages/dapi/README.md`). Funding flows use them for speed. Platform validates
    the asset-lock proof itself when it accepts the identity.
11. **No build integrity** (2.1).
12. **The SML used for vote keys is the current one,** not the one at the tally's height.
    - A masternode that changed its key or left since then has its vote excluded from the count, and the result is "Partly
      verified" (`votes.ts:240-266`). (Core drops such a masternode's votes too, once its list changes, so a live tally is
      unaffected; an older Platform tally, up to 576 blocks behind, may still count them.)
    - The list at the tally's height can't be proven today: DAPI streams only the tip's list, and the bridge's `/v1/mnlist`
      lacks the entry fields (confirmed hash, operator key, addresses) needed to hash a list against that block's coinbase.
    - A masternode registered after the tally's height, and in the list now, is counted if the bridge serves its vote in the
      older set.
    - **Testnet voting keys are proven like mainnet's.** The SML entry hash covers `keyIDVoting` (`smlEntryBytes`,
      `packages/dapi/src/smlproof.ts:154`), and testnet votes are checked with testnet's own signature scheme: Core verifies
      the binary `GetSignatureHash()` there, not the "DarkCoin Signed Message" string (`voteSchemeFor`,
      `packages/verify/src/vote.ts:36`; tested on votes signed by Dash Core, `packages/verify/test/testnet-votes.test.ts`). The
      keys are unproven only when the chain rests on testnet proof of work, which marks every chain fact "not secure"
      (`worker.ts:225`). On the quorum-proof path a testnet proposal reaches "Verified" with every voter's key proven.
13. **The chain shield's wording.** It says Platform reads are checked "against the quorum signature"
    (`apps/web/src/ui/trust/ChainShield.tsx:133`), but not that the quorum keys come from the quorum service (6.6).
14. **Recover's scan is not anchored** (6.10). Its block headers are a node's word, so nodes can hide stuck funds or a spend
    from it. It can't be made to send your money anywhere you didn't type.
15. **A relay can sit on a paid proposal** (6.2). While it says "waiting", no other relay is asked; the backup's `gobject submit`
    command on your own node is the way around it.

## 9. Planned work (not on main)

Everything above describes `main`. No trust-relevant work is pending outside it as of this revision.

## 10. Self-hosting and replacing backends

**Replace a backend.**

- Every backend except the Platform quorum service is a setting (`apps/web/src/config/registry.ts`; Settings, "Advanced:
  choose your own servers"). That covers the networks and `gov` contract, the DAPI node source, Platform node addresses,
  bridges, relays, the price feed, and the forum and moderation settings (contracts, default list owner, claim portals).
- Quorum-proof sources and the faucet are in the registry, and can be set through an imported config or `?config=`. Settings
  has no field for them. (`accounts` is in the registry too, but not built.)
- Badge issuers have their own trust list (`apps/web/src/badge/config.ts`; Settings, "MN badge issuers").
- A `?config=` link shows every changed setting before it applies (`ROWS` and `registryDiff`, `registry.ts:573-600`; `apps/web/src/app/Layout.tsx`).

**Run your own backend.** [`deploy/README.md`](../deploy/README.md) is the kit: a Dash Core node plus the bridge, with optional
relay and issuer, through `docker compose`. A bridge on Dash Core v24 also serves quorum proofs. Adding a bridge in Settings
does not make it a proof source: the worker reads only `quorumProofs` (`apps/web/src/data/dapi.ts:17`). Add it there through an
imported config or `?config=`, and chain facts rest on the quorum checkpoint (2.2). With your own bridge first in the list, the signed votes and masternode list come
from your own Dash Core node. A bridge with no `gov` contract configured reports none, so it passes the coherence check
(`services/bridge/src/api/server.ts:147`; `repo.ts:168-176`). Proposals, tallies and cycles are still read from the `gov`
contract you configured, so its publisher can still omit proposals. Running your own node also lets you check votes with the
drawer's `dash-cli` commands.

**Serve the app yourself.**

1. Run `npm ci`, then `npm run build -w @govhub/web`.
2. Set `GOVHUB_BASE` for a sub-path (`apps/web/vite.config.ts`).
3. Serve `apps/web/dist` over HTTPS, with `index.html` as the fallback for unknown paths (`.github/workflows/pages.yml`).
4. Review `packages/dapi/src/quorumproof.ts`, `packages/dapi/src/headerchain.ts` and `apps/web/src/config/registry.ts`
   first: they hold the roots in section 2.

The app needs HTTPS for `crypto.subtle` and WebAuthn (`deploy/README.md` section 14). The build emits evo-sdk's WebAssembly as
a separate `.wasm` asset, which the server should compress (`apps/web/vite.config.ts:37-47`). A self-built copy at its own origin removes the web host from your trust (2.1). It still uses the backends you
configure, and it still trusts the Platform quorum service (6.6).
