# Governance lab evidence

All paths below are relative to the DashHQ lab root. Evidence stays local. Nothing was pushed, deployed or published.

| Surface | Before revision | After implementation revision | Data | Visible change |
|---|---|---|---|---|
| Gov overview, proposal, name contests, about | `fa04bea577fa3d994f7fa007e8ed173c57f3fc2b` | `52c3ed8927eb2c893cd2039361cc66f1c5770945` | Live public reads | Family bar/footer, visible networks, phone menu, evidence beside figures, copyable linked payees |
| Vote overview, contest, about | `9b7f7ec87e183c61c03758f5f82fdf4168222df3` | `2bb69e00811ea84c92c02965ef3fc89ff2958fc2` | Live public reads | Governance handoff, self-hosted Archivo, family tokens and shell |

Baseline images are in `shots/baseline/gov/` and `shots/baseline/vote/`. Final captures are in `shots/wip-c/gov/` and `shots/wip-c/vote/`, with a focused contest in `shots/wip-c/gov-contest-phone.png`. `shots/wip-c/report.json` records exact capture heads, viewport, theme, timestamps and request failures. A documentation-only commit may follow the implementation revisions above.

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
