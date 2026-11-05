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
