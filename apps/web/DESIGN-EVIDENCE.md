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
