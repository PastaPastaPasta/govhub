# govhub web: design (UX overhaul, 2026-10)

The first version showed every check, on every number, all the time. Normal users want four things:
which proposals are up, whether they will be funded, what people say about them, and how to vote.
This design puts those first. The cryptography still runs on every proposal page, in full, but it
collapses into **one trust badge per proposal** and **one chain shield for the site**. Every
individual check, its basis and the raw data sit one click away in a drawer.

## 1. Information architecture

```
Header:  [govhub]   Proposals   My masternodes            [shield · Dev]  [Account ▾]
                                                               │               │
                                    chain status for the profile        Sign in / identity, balance, top up,
                                    (drawer: trust root, tip, network)  passkeys, sign out; Settings; Theme;
                                                                        About verification

/                  Proposals › Active   budget summary + active proposals (landing view)
/past              Proposals › Past     ended proposals, newest first
/p/<name>          Proposal page        hero, vote, description, discussion, summary; drawer
/p/h/<govHash>     Proposal page (canonical by hash)
/masternodes       My masternodes       keyring: keys, masternodes, your votes on their way
/votes             Vote on many         one ballot for every active proposal (from My masternodes)
/settings          Settings             network (Testnet / Dev / Mainnet), appearance, block lists,
                                        badge privacy, advanced endpoints, export and share
/about/verification About verification  what "Verified" means, the states, what is not detectable
/badge             MN owner badge       (unchanged; linked from Settings)
```

- The network profile (Testnet / Dev / Mainnet) moves out of the header into Settings. The header
  keeps a small chip on the chain shield with the profile's short label, so it is always visible
  but never loud. Fixture mode shows "Demo data" in the same chip.
- The theme switch moves into the account menu (and Settings › Appearance).
- The "Where the numbers come from" footer legend is removed. Its content lives in the drawer and
  on the About page.

## 2. What "Verified" means

A proposal shows **Verified** only when *every one* of these five checks is proven in this
browser. "Proven" means the browser checked it itself, against the pinned chain checkpoint, without
taking any server's or node's word for it.

| # | Check | Proven when | Source of the rule |
|---|---|---|---|
| 1 | **Content** | The governance hash recomputes from the published bytes, and every shown field (name, URL, address, amount, dates) is the hashed one. | `checkContent` |
| 2 | **Collateral** | The collateral transaction is fetched over DAPI, burns ≥ 1 DASH in an `OP_RETURN` to the recomputed hash, every output is P2PKH or `OP_RETURN`, its txid matches; it is merkle-proven into a block that is **in the chain this browser anchored** (headers linked down to the pinned checkpoint, on a ChainLock proven from the quorum checkpoint or on mainnet proof of work); ≥ 6 confirmations counted from the verified tip; covered by a verified ChainLock; and its block height equals the published collateral height. Every collateral step is `ok` and every chain step has basis `verified`. | `verifyCollateral` steps, `chain.anchored` |
| 3 | **Chain and masternode list** | The chain facts are anchored (not testnet proof of work), the masternode list is proven by its block's coinbase, and the funding threshold is computed from that proven list (every older entry's type proven from its registration). | `ChainReport` |
| 4 | **Votes** | Every signed vote behind the **shown** tally is recounted: each signature recovers to the voting key, each key and weight matches the proven masternode list and each voter's ProRegTx, no vote was dropped, and every field plus the `voteSetHash` matches the shown tally at the same block. | `verifyVotes`, `keysFrom === 'sml'` |
| 5 | **Funding status** | Follows from proven data only. Not passing: the recounted net yes is below the proven threshold. Passing and active: a recount of every active proposal, ranked by Core's rules against the proven threshold and budget, is fully proven and does not hinge on Core's superblock-time estimate. Ended: every payment found in the proposal's window is read from a proven superblock coinbase, with no unreadable block and no ambiguous twin. | `RankingResult`, `PaymentsFact` |

Paths that **never** count as proven (each makes the badge "Partly verified" at best):

- a node's word for confirmations, block or ChainLock (`basis: 'reported'`), or a second node that
  did not answer;
- the per-transaction ChainLock fallback used when the chain could not be anchored (it rests on a
  masternode list that only 2 of 3 nodes agree on);
- a ChainLock that does not yet cover the collateral block (`chainlock` step `warn`);
- a published collateral height that differs from the proven one, or is missing;
- anything on a chain that proof of work does not protect (testnet without a quorum proof);
- voting keys only as the bridge reports them;
- fixture data (shown as **Demo data**, never Verified).

What "Verified" cannot rule out, said plainly in the drawer: a bridge can **withhold** votes or whole
proposals. A recount proves the votes it was given; votes the bridge didn't serve can't be detected.
Owner claims are checked separately (shown as the owner's name) and are not part of the badge.

### States

| State | Icon | Shown when | Line under it |
|---|---|---|---|
| **Verified** | shield with a tick, Dash blue | all five proven | "Content, collateral, votes and funding checked in your browser" |
| **Checking…** | shield outline with a turning arc | any check still running and none failed | the current step ("Recounting 229 signed votes") |
| **Partly verified** | half-filled shield, slate | all done, at least one only reported | the first reason, e.g. "Votes not fully recounted: voting keys only as the bridge reports them" or "Testnet: this chain is only protected by proof of work" |
| **Couldn't verify** | shield with "!", amber | a check could not complete (network) | e.g. "The network couldn't be reached to fetch the collateral" |
| **Failed verification** | shield with "×", red | a check contradicted the data | e.g. "The published fields don't match the hashed data". The proposal is hidden from lists (existing behaviour, with "Show N that failed verification") |
| **Demo data** | dashed shield, grey | fixture mode | "Sample data recorded from mainnet. Nothing here is live" |

Order of precedence: Demo › Failed › Checking › Couldn't verify › Partly verified › Verified.
Verified is the last resort, reached only when every required check is present and proven.

### Cost

- The proposal page runs everything automatically in the worker: collateral first, then the chain
  facts and the vote recount (both reuse the anchored chain, cached for a minute and the headers
  for good), then the funding order only when the proposal is passing and active. The funding
  order is cached per data source for 10 minutes and shared by every proposal page.
- Lists do **not** recount. Cards show the last full result for that proposal (IndexedDB), and a
  cached "Verified" only while the card shows the same tally (same block) it was computed for.
  The light background collateral check still runs, two at a time, to hide failures.

## 3. Components

- `TrustBadge` — the button: icon + state word; `size="s"` icon-only for cards (with an accessible
  name). Opens the drawer.
- `VerificationDrawer` — `<dialog>` side sheet (bottom sheet on mobile): header with state, reason
  and **Re-check**; the five checks, each with its plain result and a "Details" disclosure holding
  the current per-step rows (basis, trust root, timings); "Check the votes yourself" (recount
  tables, `voteSetHash`, copyable Dash Core commands, bridge link); proposal data (JSON, dataHex,
  hashes, Platform document); "What this can't detect"; link to About verification.
- `ChainShield` — header chip: shield + profile label; drawer with the anchor (trust root,
  ChainLock, tip, timings) and a link to Settings › Network.
- `AccountMenu` — popover menu.
- `ProposalRow` — the list card.
- `FundingMeter` — net yes against the threshold, with "Passing" / "Needs N more votes".
- `VotePanel` — a single decision: Yes / No / Abstain, "with all N masternodes" (change),
  "Send now" or "Spread out" (more private) under Options, one button. Tracker and celebration
  from PR #10 below it. Verify-this-vote goes into "Check it yourself" inside the celebration.
- `LearnMore` — `<details>` for long explanatory copy.

## 4. Wireframes (text)

### Active (landing)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Next payout in 27 days                                                       │
│ 4,946 of 6,828 DASH allocated · voting closes in 24 days                     │
│ [██████████████████████████▌▌▌|░░░░░░░░]                                     │
│ 5 proposals in the budget · 1,882 DASH still available                       │
└──────────────────────────────────────────────────────────────────────────────┘
 Active  Past                                                 29 proposals
┌──────────────────────────────────────────────────────────────────────────────┐
│ DCG-Operations-Aug-Nov-26                 4,832 DASH / month   [▓▓▓▓▓▓|▓▓ ]  │
│ Dash Core Group · ✓                       1 of 4 payments left Passing +355  │
│ 751 yes · 64 no · 0 abstain · 1 comment                        In budget     │
├──────────────────────────────────────────────────────────────────────────────┤
│ OrchardPay                                1 DASH / month        [▓▓▓  |    ] │
│ Unclaimed · XbSrPJ…bJCs                   21 of 24 left   Needs 157 more votes│
└──────────────────────────────────────────────────────────────────────────────┘
```

Mobile: the three zones stack (title/owner, ask, meter), full width.

### Proposal

```
‹ Active proposals
DCG-Operations-Aug-Nov-26                                         [✓ Verified]
by Dash Core Group
┌ ask ─────────────────────────────────────┐  ┌ Summary ──────────────────────┐
│ 4,832 DASH per month, 1 of 4 left         │  │ Total      19,328 DASH         │
│ [▓▓▓▓▓▓▓▓▓▓|▓▓▓▓]  Passing by 355 votes   │  │ Payments   Aug 2026 – Dec 2026 │
│ In the next budget · closes in 24 days    │  │ Paid so far 3                  │
│ 751 yes · 64 no · 0 abstain               │  │ Website    dashcentral.org ↗   │
│ [ Vote on this proposal ]                 │  │ Community  ▲ 4  ▼ 1            │
└───────────────────────────────────────────┘  └───────────────────────────────┘
Your vote (masternode owners)            ← only when the keyring is open, or a CTA
About this proposal (owner's post, or "read it on dashcentral.org")
Discussion (comments, first-class)
```

The drawer ("How do we know?") opens from the badge:

```
✓ Verified                                            [Re-check]
Content, collateral, votes and funding checked in your browser.
  ✓ Content matches what was hashed                    Details ▸
  ✓ Collateral is in the verified chain, final         Details ▸
  ✓ Chain and masternode list proven to block …        Details ▸
  ✓ 229 signed votes recounted; tally matches           Details ▸
  ✓ Passing, in the next budget (rank 1)               Details ▸
▸ Check the votes yourself
▸ Proposal data and hashes
  What this can't detect: votes the bridge didn't serve …
  About verification
```

## 5. Visual system

- **Type:** Archivo (variable weight and width, already bundled). One family; the width axis is the
  expressive one: semi-expanded (wdth 112) for headings and the payout figure, normal for text,
  condensed (wdth 82) for hashes and addresses. Scale (1.25): 12.8 / 14 / 16 / 20 / 25 / 31 / 39 px.
  Body 16 px, line-height 1.55, measure ≤ 72ch.
- **Colour (light / dark):** paper `#F3F6F9` / `#0A1520`; surface `#FFFFFF` / `#0F1F2D`; ink
  `#0D2231` / `#E5EDF4`; secondary ink `#4A5F71` / `#A3B5C5`; lines `#DCE4EB` / `#1E3345`; accent
  Dash blue `#008DE4` (text on light `#006CB0`, on dark `#5DBDF7`). Funding uses green / amber /
  red only for passing state; trust uses blue (verified), slate (partial), amber (couldn't),
  red (failed). No purple or violet anywhere.
- **Spacing:** 4 px base: 4, 8, 12, 16, 24, 32, 48, 64.
- **Radii by role:** 4 px chips and inputs, 8 px buttons, 12 px panels, 16 px sheets. No shadows on
  panels; sheets and menus get one soft shadow because they float.
- **Motion:** only in answer to the user (drawer slide, vote celebration) plus the Checking arc;
  all of it off under `prefers-reduced-motion`.
- **Accessibility:** AA contrast in both themes, visible focus ring (Dash blue, 2 px, offset), every
  icon button labelled, the badge's state in its accessible name, dialogs with focus return,
  keyboard-operable menus.
