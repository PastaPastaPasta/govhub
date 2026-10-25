# govhub web app

React + Vite single-page app. It reads Dash Platform directly (evo-sdk, with proofs), gets Core data
over DAPI, and checks it in a background Worker. Layout and visual system: [`DESIGN.md`](DESIGN.md).

```sh
npm run dev            # http://localhost:5317
npm run build          # typecheck + production build (the strict CSP is only in the built index.html)
npm test               # unit tests (vitest)
npx playwright test    # fixture end-to-end tests, headless; starts and stops its own server
npm run screenshots    # SCREENSHOTS=1: refreshes screenshots/
npm run e2e:live       # GOVHUB_LIVE=1: against live Platform and DAPI (Dev and Testnet)
```

Add `?fixtures=1` to any URL for the recorded mainnet snapshot ("Demo data").

## What "Verified" means

Every proposal page runs all checks automatically and shows **one** badge. **Verified** means all
five of these were proven in your browser, with nothing taken on a server's or node's word:

1. **Content.** The governance hash recomputes from the published bytes, and every field shown
   (name, URL, payment address, amount, dates) is the hashed one.
2. **Collateral.** The collateral transaction burns at least 1 DASH in an `OP_RETURN` to that
   hash, has only P2PKH and `OP_RETURN` outputs and the right txid. It is merkle-proven into a
   block of the chain this browser verified from a pinned checkpoint (on ChainLocks proven from the
   quorum checkpoint, or mainnet proof of work), it has at least 6 confirmations counted from the
   verified tip, a verified ChainLock covers it, and its height is the published one.
3. **Chain and masternode list.** The masternode list is proven by its block's coinbase, and the
   funding threshold is computed from it.
4. **Votes.** Every signed vote behind the shown tally is recounted: signatures against the voting
   keys, keys, types and collateral against the proven list and each voter's registration, and the
   result (every count and the `voteSetHash`) equals the shown tally at the same block.
5. **Funding status.** Follows from proven data only: not passing on the recounted votes and the
   proven threshold; or, when passing, a fully proven recount and ranking of every active proposal
   by Core's rules; or, once ended, the payments read from proven superblock coinbases.

Never counted as proven: a node's word (confirmations, block, ChainLock), the per-transaction
ChainLock fallback used when the chain can't be anchored, a collateral not yet ChainLocked, a
published collateral height that differs from the chain's, testnet proof of work, voting keys as the
bridge reports them, and fixture data.

| Badge | Meaning |
|---|---|
| **Verified** | All five proven. |
| **Checking…** | Checks still running, none failed. |
| **Partly verified** | All done; something rests on someone's word. The badge says what, in one line. |
| **Couldn't verify** | A check couldn't complete (network). Re-check from the drawer. |
| **Failed verification** | A check contradicted the data. The proposal is hidden from the lists. |
| **Demo data** | Fixture mode. Never "Verified". |

**What it can't detect:** a bridge can withhold votes or whole proposals. A recount proves the votes
it was given; votes the bridge didn't serve can't be detected. Owner claims are checked separately.

The rules live in [`src/verify/aggregate.ts`](src/verify/aggregate.ts); every combination of check
states is tested in `aggregate.test.ts`. The in-app version is the page at `/about/verification`.

### Cost

Measured from a cold browser (empty IndexedDB) on 2026-10-25 (`e2e/trust-live.spec.ts`):

| | Dev (mainnet Core data) | Testnet |
|---|---|---|
| Chain anchoring | 45,072 headers on proof of work, ~17 s | a quorum proof + 603 headers, ~1.5 s |
| Older masternode registrations (once, then cached) | 1,048, ~8 s | 52, under 1 s |
| Vote recount of the proposal | under 1 s | under 1 s |
| Funding order (29 proposals, only when passing) | ~5 s | not needed (not passing) |
| Badge settles on **Verified** | 34.6 s | 5.4 s |

Warm (headers and registrations cached) a proposal page settles in a few seconds. The order is: the
collateral first (it anchors the chain), then the chain facts and the vote recount, then the funding
order only when the proposal is active and passing (cached for 10 minutes and shared by every
proposal page). The header's chain shield anchors the same chain shortly after the first paint, so
the first proposal page usually finds it ready.

Lists don't run the full checks: recounting and ranking every proposal on each list load would cost
the funding order's ~5 s plus every collateral's block proof. Cards show the last full result of the
proposal page, and a cached "Verified" only while the card shows the same tally (same block) it was
computed for. The light background collateral check still runs, two at a time, to hide failures.

## Creating a proposal (`/create`)

The wizard replaces proposal.dash.org. It goes step by step, shows the cost first (the 1 DASH fee is burned
and never refunded, plus a network fee under 0.0001 DASH), and keeps technical detail behind "Details".
Code: `src/pages/NewProposalPage.tsx` and `src/proposal/`; Core rules in `@govhub/verify` (`newproposal.ts`);
deposit keys and the fee transaction in `@govhub/auth` (`proposal.ts`).

1. **Details.** Name, payment address (P2PKH or P2SH), and the link voters read. The default link is
   `https://gov.dashhq.org/p/<identityId>/<name>`. Because the link is part of the hashed data, it names the
   creator's identity without anyone having to trust it (claim method 1, PLAN 6.3). Using it needs a sign-in;
   without one the user enters their own link.
2. **Payments.** The amount per payment, the first superblock and how many. The start and end epochs fall
   halfway between superblocks, the way Dash Core's own dialog (`qt/proposalcreate.cpp`) sets them. Dates
   use Core's estimate of 2.62 min per block. The amount is checked against each superblock's payment
   limit, computed from consensus rules. A warning shows when it is more than the next payout still has
   unpromised, using the bridge-published `cycle` and its provenance. On testnet, superblocks are hourly
   and Core allows a 2-hour margin, so the page shows the real number of superblocks it can be paid at.
3. **Review.** `checkNewProposal` runs Core's `ValidateProposal` on the exact bytes: alphabetical keys,
   compact JSON, at most 512 bytes. It also runs the payout parser `ParsePaymentAmount`: Core accepts a
   proposal whose amount a superblock can never pay, and this catches that. Locking fixes the time, which
   is hashed. From then on the proposal can't change.
4. **Pay the fee.** The page offers a backup file first, and payment stays closed until it is saved
   (download, or copy). Then the user pays one of two ways:
   - **From any wallet.** The page shows a one-time deposit address. Its DAPI watcher subscribes before
     the address appears. Only IS-locked or mined payments are spent. The fee transaction
     `[OP_RETURN <gov hash> 1 DASH, change -> refund P2PKH]` is checked with `checkCollateralTx` and saved
     before it is broadcast. The refund address must be P2PKH, because Core refuses any other output
     type. It defaults to the seed's `m/44'/coin'/0'/0/0`, or the signed-in key's own address.
   - **With Dash Core.** The page shows the exact `gobject prepare 0 1 <time> <hex>` command. The user
     pastes the txid back, and the page checks the transaction over DAPI.
5. **Submit.** The page hands the proposal to the first configured relay right away
   (`POST /v1/proposals`). The relay holds it and runs `gobject submit` at 6 confirmations (Core's
   `GOVERNANCE_FEE_CONFIRMATIONS`). If a relay has no holding, the page calls `/v1/proposals/submit`
   itself at 6 confirmations. If a relay is down three times in a row, the next one is tried. The
   `gobject submit …` command is always shown so the user can submit from their own node.
   Confirmations are counted from the chain verified in the browser: anchored, proven by quorum proofs
   or proof of work, and labelled "reported" where they rest on a node's word or testnet proof of work.
   A ChainLock on the block is shown as final. Then the page checks that a bridge has the proposal
   ("seen by the network") and that it is on Platform ("on govhub"). It celebrates the way vote
   acceptance does and links to the claim flow, where the owner publishes the description.

**Drafts and recovery.** No draft is published: no Platform document exists until submission. Drafts
live in `localStorage` (`govhub.proposalDraft.<id>`) and in the backup file. The file holds the draft,
the Core commands and plain instructions, and never a key. "Restore from a backup file" checks it before
trusting it: it recomputes the hash from the time and data, re-validates the data for the network, and
compares the shown fields with the hashed ones.

**Deposit keys.** These are recoverable: Settings → Recover funds scans them (`proposalFeeFamily` in `DEFAULT_KEY_FAMILIES`,
docs/RECOVERY.md), with the same derivation as the wizard (`proposalDepositKey` in `@govhub/auth`):

- A seed sign-in uses `m/9'/<coin>'/100'/0'/<index>`. DIP-9 feature 100' is unregistered and used by
  govhub. As in DIP-13's funding keys, the last index is not hardened. The wizard picks a free index among 0..19
  at random, so two devices rarely collide; the Recover tool always scans 0..19 plus a gap of 20.
- A key sign-in uses `HMAC-SHA256(key, "govhub/proposal-collateral/v1" || identity id || u32be(index) || ctr)`,
  the same construction as `sessionTopUpKey`.

The browser payment needs one of these two sign-ins.

**When something goes wrong.** These cases are also on the page:

- **The relay is down.** The next relay is tried. The manual command and the backup still work.
- **The fee transaction never confirms.** It was dropped or double-spent, so no fee was burned. The
  page tells the user to pay again.
- **Core refuses the proposal.** Its message is shown. The data was checked against Core's rules
  before payment.
- **The tab is closed.** A holding relay submits anyway. Reopen `/create`, or restore the backup.

`?fixtures=1` simulates the payment and the relay (`demoServices`). `e2e/proposal-wizard.spec.ts` runs
the whole flow that way.
