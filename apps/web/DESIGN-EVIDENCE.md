# Governance lab evidence

All paths below are relative to the DashHQ lab root. Evidence stays local. Nothing was pushed, deployed or published.

| Surface | Before revision | After implementation revision | Data | Visible change |
|---|---|---|---|---|
| Gov overview, proposal, name contests, about | `fa04bea577fa3d994f7fa007e8ed173c57f3fc2b` | `52c3ed8927eb2c893cd2039361cc66f1c5770945` | Live public reads | Family bar/footer, visible networks, phone menu, evidence beside figures, copyable linked payees |
| Vote overview, contest, about | `9b7f7ec87e183c61c03758f5f82fdf4168222df3` | `2bb69e00811ea84c92c02965ef3fc89ff2958fc2` | Live public reads | Governance handoff, self-hosted Archivo, family tokens and shell |

Baseline images are in `shots/baseline/gov/` and `shots/baseline/vote/`. Final captures are in `shots/wip-c/gov/` and `shots/wip-c/vote/`, with a focused contest in `shots/wip-c/gov-contest-phone.png`. `shots/wip-c/report.json` records exact capture heads, viewport, theme, timestamps and request failures. A documentation-only commit may follow the implementation revisions above.

Final runtime captures were built from Gov `7a51ffad700d82b6dac8ffe354b1d2f6bd4cf5f3` and Vote `2bb69e00811ea84c92c02965ef3fc89ff2958fc2`. All 24 overview images and the focused contest image were opened and inspected at original resolution. The guarded journey run passed 41 checks, with no page exceptions or blocked writes.

The overview captures use matching routes, viewports, UTC timezone and themes. Live counts and relative times can change between the baseline and the final captures; they are not evidence of a data change. Desktop is 1440 × 900; phone is 390 × 844 at device scale 2.

## Validation

- Gov workspace: 2,221 passing tests, 5 skipped, under Node 22. The final web run passes all 723 tests in 60 files.
- Vote: 19 passing tests in 4 files.
- Both repositories pass typechecking and production builds. There are no dedicated lint scripts; whitespace checks pass, and the workspace suite includes its existing query lint tests.
- `apps/web/scripts/lab-governance-qa.mjs` uses `lab/qa-guard.mjs` to prevent writes. `shots/wip-c/journeys.json` records phone navigation, URL network selection, mixed-profile disclosure, keyring/sign-in access, the masked guest-key form, Vote → Gov → Explorer links and five live contest parity checks.
- Existing tests cover signing, key storage and receipts. Browser checks use no real keys and cast no votes. Authenticated live broadcasts are intentionally untested.
- Deep `/names/:label` URLs render in the lab through its existing HTTP 404 SPA fallback. The app works, but the response status remains 404. No lab tooling was changed.
- Live chain-proof availability can vary. The verification UI reports unavailable or partial checks rather than claiming verification.
- Public contender voter lists are capped at the first 100 identities and disclose that cap.

## Review gate

Status: **APPROVED**. The actual implementation diffs were reviewed for correctness/completeness, maintenance, architecture and security/reliability. No blocking findings remain. The review checked source-scoped refreshed contest results, URL-first profile selection, Core versus Platform network links, proof queries, unchanged CSP and FramedNotice, and unchanged signing/key/receipt internals. Remaining uncertainty is the authenticated live behavior described above.

The simplification pass removed duplicate theme state and theme controls, obsolete header/footer CSS and the old Vote theme module. Existing component tokens map to the shared tokens rather than adding a second component system. These changes preserve the voting and verification interfaces.

Both sites vendor shell **1.0.1** unchanged. The shell script is pinned as `7dd0e4bcad13c265403e6539d18c12df0030235c6eb1c3826c12d540610fec28`. No shell requests or lab tooling edits were needed.

## Round 2 (5 November 2026)

What the round-1 reviews (`reviews/round1-opus.md`, `reviews/round1-sol.md`) asked of Governance, and where the evidence is.

- **Verification.** The lab's "Chain not verified" everywhere was a lab artefact: the lab's CSP refused the verification Worker's
  reads. The diagnosis and the production comparison are in `reviews/r2-gov-verification.md`. The app now names what is
  running, says what an unfinished check means and what still holds, never shows a raw exception as the message, offers Try
  again, and keeps budget places "as reported" until proven. Evidence: `shots/r2-gov-ux/` (`fail-*` show a simulated chain
  outage; `lab-*` and `prod-*` show the lab and production verifying).
- **Shared links.** `scripts/prerender.mjs` writes a static entry page per route: titles, descriptions and share tags, HTTP 200
  on Pages. Open question for the first deploy: confirm with `curl -I` that Pages serves `/about` and `/names` from
  `about.html` and `names.html` (each also has a same-named directory without an `index.html`).
- **Voting flow.** Signed out, My masternodes lists three ways to vote and what each needs. The Radar handoff shows the node's
  public votes on request and links back to Radar.
- **Name contests.** `/names/<label>` handles EvoVote's forwarding (`from=vote`), display spellings and the wrong network.
- **Also in this round:** Past proposals as row cards on phones, a proposal search, honest About links (shortened links named
  as such), and "Governance" instead of "govhub" in the UI copy.
- **Screenshots.** `shots/r2-gov/` (lab capture) and `shots/r2-gov-ux/j-*` (journeys at 390 and 1440, light and dark).

Tests:

- Web: 735 vitest tests. Typecheck passes.
- dapi: client tests pass.
- Lab: 19 server tests, 103 route and proxy checks, and the browser safety check pass.
- e2e: the tamper suite passes again (21) after its replay was pointed at Testnet. Fifteen fixture and settings specs fail on
  the round-1 parent commit too (drift from the shell migration) and still fail. They are not addressed here.

## Round 3 (5 November 2026)

What the round-2 reviews (`reviews/round2-opus.md`, `reviews/round2-sol.md`) and stream S2 asked of Governance.

- **A masternode's votes.** `/masternodes/<proTxHash>` lists every active proposal at once (amount, network standing, the deadline
  that decides it) and fills in this masternode's vote per row as the bridge answers. Each row opens the keyring's vote panel for
  this masternode, or offline signing with its voting address filled in. Rows become cards on phones. Radar's
  `/masternodes?proTx=` link redirects there; the build writes an entry page per masternode.
- **Cold verification.** The build ships proven masternode registrations (`scripts/registrations.mjs`, `docs/TRUST.md` §2.2b): a
  cold proposal check in the lab went from 130 s to 10–32 s. The check line is one line with the five checks folded under it.
  Trade-offs and measurements: `reviews/r3-gov-verification.md`.
- **Past is a treasury ledger.** What each superblock paid, read from its coinbase in the verified chain, for a year (two on request),
  named where Governance has the proposal on record; per-proposal outcomes (funded, partly, not funded, expired unpaid).
- **Proposal purpose.** "What the owner says" beside "What the network records"; a shortened link's destination, resolved by the
  build and dated.
- **Price.** design/PRICE.md: Coinbase spot, source and UTC fetch time beside the value, stale/refresh-failed labels, none off
  Mainnet; Testnet amounts in tDASH.
- **Also:** content aligned to the shell gutter, one account control (the signed-out ⋮ menu is gone), slugs that wrap at hyphens.

Evidence: `shots/r3-gov/` (lab capture), `shots/r3-gov-s2/` (timing logs and journey screenshots).

## Round 4 (5 November 2026)

What the round-3 reviews (`reviews/round3-opus.md`, `reviews/round3-sol.md`) and stream S1 asked of Governance.

- **Vote on this proposal.** Every open proposal leads, right after its ask, with Yes / No / Abstain and the way to sign that fits
  what the visitor has: an open keyring gets its composer; voting keys pasted for this tab sign here (a copy, wiped once signed) and
  only the signed vote goes to the relay; anyone else signs offline with the Dash Core `signmessage` command filled in. Nothing new
  is stored and no key or signature goes into a URL. `src/ui/vote/VoteBlock.tsx`.
- **Masternode context.** `/masternodes/<protx>` links each proposal with `?mn=<protx>` (a public id): the proposal shows that
  masternode, its current vote and voting address, and links back. A shared masternode page no longer says "My masternodes", and a
  visit from Radar goes back to Radar.
- **Writes in the lab.** A relay answer carrying the read-only preview's stub ends the vote as "Preview: not sent" instead of
  retrying it as possibly held.
- **What the treasury funds.** The build reads the linked page of every proposal whose fields hash to its governance hash into
  `owners.json` (`scripts/ownerpages.mjs`, `src/lib/ownerPages.ts`): on DashCentral its page for that hash (DashCentral's own
  fields must carry the hash and name; its page for the governance name when the linked slug is wrong), elsewhere the page's title
  and description. 45 of 45 mainnet proposals on 5 November. Proposal pages quote it as the owner's unverified claims with host and
  date and a link out; the owner's title heads the page with the on-chain name beside it, and goes into the shared link's
  description; cards, Past and masternode rows show it quoted and labelled; search matches it. A page is shown only for the link it
  was read through. The browser never fetches those pages; CSP is unchanged. The fetcher refuses non-public addresses (resolved,
  pinned, no environment proxy), default ports only, hops checked, size and time bounded; the parser is single-pass.
- **Sign-in.** Shell 1.5.0 vendored (the phone bar now reads `dashhq / Governance`). The sheet uses `<dashhq-signin-help>` with
  "Create an account" in its slot, the ways in as `.dh-choice` cards (the unavailable wallet last), and says voting needs no account.
- **Also:** Active list sorts (payout order, closest to the line, newest, largest request); one check status in the proposal
  header, keeping an earlier proof of the same tally while it re-runs; one chain chip while checking; Past rows say they are reading;
  plainer words ("Requests", "Standing", "No verified owner yet", "Most votes: nobody gets it (Lock)"); name contests lead with the
  voting key when signed out and say when a contender has no other username; shorturl.at links resolve again (a GET when HEAD is
  refused).

Evidence: before `shots/round3/gov/` (revision `b188cae`); after `shots/r4-gov/` (lab capture) and `shots/r4-gov-s1/` (journeys:
Radar → masternode → proposal as that masternode → offline command → back to Radar, desktop light and phone dark; sign-in sheet;
pasted-key and offline paths; owner summaries).

Validation:

- Web: 813 vitest tests in 70 files; typecheck passes. New: the vote block's paths, pasted-key signing (one send at a time, copies
  wiped, key and view checks), the preview stub, owner-page parsing (hostile 2 MB pages in linear time, DashCentral gates, link
  binding), list sorts.
- e2e (fixture suite: auth, badge, fixtures, forum, hosting-ui, prelaunch-polish, profiles, proposal-wizard, recording, tamper,
  voting): 89 pass, 2 skipped.
- Lab: `node lab/verify.mjs` 108 checks pass. Browser journeys under `lab/qa-guard.mjs`: no blocked writes, no page errors.
- Review: three independent reviews of the vote block and owner pages; every finding fixed (`7ef978e`, `9dc4645`, `483002f`,
  `ff1d0e8`, `c619c14`).

Not tested: a real vote broadcast (the lab blocks writes; the block shows "Preview: not sent"), and a real voting key (the
pasted-key path is covered by unit tests with a generated key).

## Round 5 (5 November 2026)

What the round-4 reviews (`reviews/round4-opus.md`, `reviews/round4-sol.md`) and stream S1 asked of Governance.

- **What it funds, then the vote** (Sol #5). A proposal opens with "What this funds": the owner's summary quoted and attributed,
  the ask × its payments = the total, payments left, when it runs and the next payout, the payee, the owner, and where it stands.
  The vote block follows, with "Go to the vote ↓" in the header. The badge names what it vouches for, "Proposal data verified",
  apart from the owner row (Sol #11). An unclaimed proposal is headed by its name as words beside the exact name (Sol #21); the
  heading waits for owners.json (read with the app, given up after 4 s) instead of swapping (Opus #12). A proposal whose fields
  don't match its hash shows none of them as what it funds.
- **What the treasury funds** (Sol #6, Opus journey 3). `/treasury`, a tab beside Active and Past and linked from the budget: what
  this payout can pay (checked against the consensus limit), what is asked of it, what has the votes, the next payout; what it pays
  for grouped by standing and ordered by size (proposals carry no category, so none is guessed); and the last year's superblocks
  read from the chain, with this payout's allocation beside them. Each figure carries its basis: "Consensus limit", "Platform
  records" (or "Bridge's records" when it sums one), "Bridge's tally", "Verified from the chain".
- **No partial figure shown as final** (Opus #4). Past shows "Reading superblocks: 4 of 12 so far" and no total, average or count
  until all are read; a superblock that fails is named and the totals say "at least". Past's per-proposal outcomes, Active's "N of
  M in the budget" and the treasury wait the same way. A read that fails is never read as "none": an unread list isn't "no
  proposals", a tally a failed read may have had is "Votes not read" (cards, masternode rows, its own treasury group) and makes
  the counts "at least", and Past's "not recorded" and "That's all N" appear only when the reads answered.
- **Wrong network** (Opus #3, Sol #23). Proposal, masternode and name-contest pages ask the other network before "not found" and
  show the shell's `<dashhq-not-found>` (1.6) under the record's own header: "Not on Testnet. This proposal exists on Mainnet.
  Open it on Mainnet →", routed by the bar's handler. Radar's link follows the masternode to its network.
- **One name per proposal in every list** (Opus #11, Sol #19). Cards, masternode votes, Past and the treasury name a proposal by
  the owner's quoted title or its name as words, the exact name under it; one line above each list says whose words are quoted;
  the per-row "…, the owner's title (dashcentral.org)" is gone. Phones drop the payee from cards. Look-alike names keep their exact
  spelling as the title.
- **Also:** the discussion's view switch is a segmented control (Opus #21); the Active/Past tabs keep `?network=`; vote and
  new-proposal buttons at the family height; shell 1.6.2 (network order, folded sign-in help on phones, Sol #4); the
  e2e specs follow the new heading and the sign-in title, which round 4's integration renamed.

Evidence: before `shots/r5-gov-s1/before/` (revision `40b0b6f`, plus the reviewers' shots); after `shots/r5-gov-s1/after/` and
the lab capture `shots/r5-s1/gov/` (36 images, revision `c510a89`, no errors, blocked writes or non-200 pages); journeys
`shots/r5-gov-s1/journeys/report.json`.

Validation:

- Web: 848 vitest tests in 76 files; typecheck passes. New: ledger and treasury summaries, the treasury page's reading and
  failure states, which proposals a failed tally read leaves unknown, the budget header's counting / not known / at least, the
  other-network probe (found, none, couldn't check, timeout, a changed question), the masternode probe's bridge-network check,
  proposal reading order, heading wait and hash mismatch, reading titles and look-alikes.
- e2e (fixture suite): 89 pass, 2 skipped, with `GOVHUB_E2E_PORT` set (it builds into `.e2e-dist`).
- Lab: `node lab/verify.mjs` 110 checks pass. Guarded journeys at 390 (`isMobile`) and 1440, light and dark: 29 checks, no
  blocked writes, no page errors (masternode owner from Radar, the jump to the vote, journalist to the treasury and Past with no
  partial figure, a Mainnet link under Testnet and "Open it on Mainnet", Testnet tabs, phone sign-in, overflow at 390).
- Review: an independent review of the whole range, a simplification pass (`6adde51`), and a re-check of the fixes. The first
  review's findings are fixed in `7457769`, `ad4eb8a`, `caca498` and `24a74b8`; the re-check approved them, and its further
  findings on partial read failures are fixed in `a07ceb4`, `17cb48c` and `c510a89`.

Not done:
- The first visit's proposal check still takes 10 to 40 seconds (Opus #12). The chain anchor is already warmed on Active; the
  rest is per proposal (its collateral proof, the masternode list at its tally's height, the recount), so prefetching it would
  download about 1.4 MB per proposal that may never be opened.
- A Platform read that fails while a bridge answers with an empty list is still hidden by the data layer (`repo.ts`), so the
  list then reads as empty.
- `lab/check-shell.mjs` stops at the hub's vendored copy (another stream's repo); gov's copy matches `design/shell` 1.6.2
  byte for byte.

## Round 6 (6 November 2026)

What the round-5 reviews (`reviews/round5-opus.md`, `reviews/round5-sol.md`) and stream S1 asked of Governance, on shell 1.8.1 and
`design/ADOPTION-r6.md` (§1 retired pages, §3 one meaning of "Bridge", §4 sources beside figures).

- **"Bridge" means the Bridge app only** (Opus #2, Sol #10). Every user-visible "bridge" that meant Governance's relay now says
  "the governance data service" ("the data service" after the first mention in a block), in pages, errors, provenance, the vote
  tracker ("Data service: counted"), the verification drawer ("Data service live tally") and Settings ("Data services",
  "data service 1"). Code identifiers, settings keys, API paths and the service's host names are unchanged.
- **The treasury reads in sentences you can quote** (Opus #3, Sol #23 in part). No source chip sits inside a sentence: each tile
  names its source as a `.dh-src` tag beside its label ("Consensus limit", checked here; "Platform records"; "Reported tally";
  "Estimate"), "What it pays for" opens with a summary built from the figures ("5 proposals have the votes and fit in this payout:
  5,193 DASH, 76% of what it can pay. The largest is …"), and its sources close the section as numbered `.dh-sources` lines (the
  standings with the block they were counted at; the owners' titles, unchecked). While some votes are unread the summary says
  "at least" and "the largest of those read". The comparison keeps one chain proof beside its description. Proposals still carry
  no category, so none is invented.
- **Fiat as an estimate** (Opus #3). `formatUsdEstimate` (design/PRICE.md): "≈ $308,000", whole dollars to three significant
  figures, cents under $10, millions in words; the Coinbase time is a tag beside the value ("Stale" past ten minutes, the date only
  when it isn't today). The home's budget value says "Budget ≈ …".
- **Name contests answer 200 under the spellings people write** (Opus #8, ADOPTION-r6 §1). The build reads each contest's
  registered spelling (one proof-checked DPNS query per hundred labels) and each open contest's contenders' spellings, and writes
  `names/<spelling>.html` and its lower case, canonical to `/names/<label>`: 1,014 alias pages for 710 of 948 contests.
  `/names/alice` and `/names/Alice` are 200; EvoVote now forwards to the canonical address itself. A failed read loses only its
  page of labels; "index" is never an alias.
- **The vote names what is voted on** (Sol #4). The vote block opens with the proposal's title, its exact name, the ask, the
  payments left and where it stands; the offline signing instructions and rows name the proposal too.
- **The proposals start on a phone's first screen** (Sol #7). Phones drop the treasury link (the Treasury tab is below), put the
  chain check and "How funding works" on one line, and the search and sort on one row: the first card moved from 743 px to 496 px.
- **A masternode's work queue** (Sol #12, Opus #18). Search and an All / Not voted / Voted filter, kept in the address; the filter
  waits until every vote is read. Phone cards read "4,832 DASH per month · Passing by 355" with no stray separator.
- **One payments phrase** (Opus #16). "1 of 4 payments left", then "· 3 paid" once the chain is read; "1 more possible · 1 paid"
  when the chain's counts don't fit the schedule.
- **Also:** the network record at full width (Opus #19); a ProTx hash field on My masternodes, signed out, that opens the
  masternode's own page (and Radar for finding it by IP); Governance's own EvoVote notice removed, since the shell's arrival
  notice replaces it (ADOPTION-r6 §1); the phone menu is the shell's short one (ADOPTION-r6 §2: nothing for Governance).

Evidence: before `shots/r6-gov-s1/before/` (revision `fe748ad`); after `shots/r6-gov-s1/after/` and the lab capture
`shots/r6-s1/gov/` (40 images, revision `92f72d3`, every page HTTP 200, no console or page errors, no blocked writes; aborted
reads on page close and the data service's quorum-proof errors as in round 5); journeys `shots/r6-gov-s1/journeys/report.json`.

Validation:

- Web: 861 vitest tests in 77 files; typecheck passes; whitespace check passes. New: contest aliases, the payments line, the vote
  subject, the queue's filter and its wait, the ProTx field, `formatUsdEstimate` boundaries, the USD tag's states, the treasury's
  tags, summary, notes and lower bounds.
- e2e (fixture suite, `GOVHUB_E2E_PORT` set): 89 pass, 2 skipped.
- Lab: `node lab/verify.mjs` 111 checks pass. Guarded journeys at 390 (`isMobile`) and 1440, light and dark: 108 checks, no blocked
  writes, no page errors (Radar → masternode votes → filter and search → the vote with its subject in view → back; the treasury
  with no chip in a sentence, four source tags, an estimate, a summary and its notes; the phone landing and a menu that lists
  nothing twice; `/names/Alice` 200 and an old Vote link arriving with the shell's notice; the ProTx field keeping Testnet; no
  "bridge" for the data service on any page).
- Review: an independent review of the range (no blocking findings; its four medium and five low findings fixed in `c65267f`,
  `1b1f45b`), then a simplification pass (`e5a3f8a`).

Not done:
- The first visit's proposal check still takes 10 to 40 seconds (Opus #17), for the reason in round 5; a return visit shows the
  earlier result while it re-checks.
- Spellings nobody registered or asked for (`/names/ALICE`), and contests newer than the build, still load through 404.html.
- One sign-in across the family (Sol #2) is not a Governance-only change.
