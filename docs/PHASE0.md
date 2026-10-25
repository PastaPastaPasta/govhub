# Phase 0 report (2026-10-24)

The detailed results are in each spike's README. All writes so far were on **testnet**, which runs
PV14, so its fees approximate PV13 rather than match it exactly. Mainnet was used read-only.

## Go / no-go

| Assumption | Result | Evidence |
|---|---|---|
| evo-sdk 5.x works on mainnet PV13 | **GO** (reads and writes) | `spikes/sdk5` §8: identities created with IS-lock proofs, a contract registered, and documents created, replaced and deleted on mainnet. 22/25 query probes pass; the 3 failures are PV13 behaviours now covered by the query rules |
| One SDK covers PV13 and PV14 | **GO** | Version goes 13 → 14 on testnet; no PV13 regressions seen |
| v1 contracts are valid on PV13 and PV14 | **GO** | wasm-dpp 4.1.1 at PV13 and rc.8 at PV13/PV14 all pass; registered on testnet; every documented query shape runs |
| Governance hash and collateral checks match Core | **GO** | `packages/verify`: regtest `gobject prepare/check/submit` plus 28 live mainnet proposals |
| Browser vote signing matches Core | **GO** (mainnet scheme). Testnet scheme still open | Byte-identical to Core `signmessage`; Core `verifymessage` accepts |
| Every Core flow over DAPI from a browser | **GO** | `spikes/dapi-browser`: 41/41 checks from a real origin against mainnet, including streams, IS-locks, the SML and ChainLock BLS |
| Blind-RSA badge works end to end | **GO** | `spikes/blindrsa`: RFC 9474 vectors pass; issuer 0.3 ms per signature, reader 0.02 ms per verify |
| A 0.003 DASH starter is enough | **GO, but tight** | 3-key identity costs 0.00106, leaving about 3 short comments |
| Seed restores in other wallets | Open | Restore on a real Android device |

## Measured costs (testnet, PV14)

| Operation | DASH |
|---|---|
| Identity, 3 keys / 6 keys | 0.00106 / 0.00182 |
| Add 3 keys later | 0.00074 |
| Comment, 280 / 5,000 chars | 0.00056 / 0.00178 |
| Reaction, first / flip | 0.0005 / 0.00003 |
| `proposal` (bridge) | 0.0008 |
| `tally` replace (bridge) | 0.0000256 |
| Largest `proposalPost` (15 KB) | 0.0049 |
| Register `gov` / `forum` / `badge` / `mod` | 0.24 / 0.433 / 0.221 / 0.141 (≈ 1.04 total) |

### Pre-mainnet cost pass (2026-10-25, testnet PV14)

Measured with the bridge's own document builders (`services/bridge/scripts/testnet-cost-pass.ts`,
`results/testnet-cost-pass.json`; 1 DASH = 1e11 credits). Before: one `tally` per proposal, full `proposal`. After:
every active tally in one `talliesSet` document, slim `proposal`, a final `tally` once per ended proposal.

| Bridge write | Before (credits) | After (credits) |
|---|---|---|
| Hourly tally refresh, 6 active proposals changed | 6 x 2,475,040 = 14,850,240 | 2,726,140 (one `talliesSet` replace) |
| Hourly tally refresh, 30 active proposals changed | 30 x 2,475,040 = 74,251,200 | 4,249,220 |
| Hourly tally refresh, 161 proposals (one full document) | 161 x 2,475,040 = 398,481,440 | 11,228,280 |
| A proposal joins the active set | 24,989,200 (`tally` create) | +2,603,800 on that hour's replace (95 bytes more) |
| A proposal ends | 2,475,040 (retire replace) | 24,989,200 (final `tally` create, once) |
| `proposal` create | 66,150,000 (mean of 4) | 61,200,000 (mean of #2..#4; #1 in a fresh contract: 74,213,920) |
| Register `gov` | 0.24195 DASH (4 types, 6 indexes) | 0.27210 DASH (5 types, 7 indexes) |
| Register `forum` | 0.433 DASH (with `proposalDraft`) | ~0.423 DASH (formula 0.42 + storage, with `keyring`, without `proposalDraft`) |

On the real testnet contracts (same day): `talliesSet` create 0.00036408 DASH with 6 entries (testnet gov) and
0.00096300 with 29 (dev gov, mainnet data); a replace 2,567,120 and 3,595,340 credits. Adding `talliesSet` to an
existing contract cost 0.27029627 DASH per contract (a contract update pays the registration fee of the whole
updated contract).

## Mainnet budget (estimate from the numbers above)

| Item | DASH |
|---|---|
| Phase 0 mainnet check: identity plus a small contract with the tricky query shapes (`reaction`, `mnBadge`, `comment`) and a few writes. This replaces the planned local dashmate 4.1.1 network, because it tests the real PV13 query planner. | ~0.3 one-time |
| Launch: register the four v1 contracts (0.272 + 0.423 + 0.221 + 0.141), plus bridge, moderation and issuer identities | ~1.1 one-time |
| Bridge operations: ~30 active proposals, tallies refreshed hourly on change, ~150 new proposals a year | **~0.51 per year** (was ~6.6 per year before the cost pass; see below) |
| Issuer keys (one doc per epoch) | negligible |
| Starter vouchers | 0.003 each, from the faucet treasury |

Annual bridge cost with 30 active proposals, every one changing every hour (the worst case of "hourly on change"),
~150 new proposals a year (30 active, median duration ~4 months on mainnet today):

| Item | Before (DASH/yr) | After (DASH/yr) |
|---|---|---|
| Tally refresh | 30 x 8,760 x 2,475,040 = 6.504 | 8,760 x 4,249,220 = 0.372 |
| Proposals joining / ending | 150 x (24,989,200 + 2,475,040) = 0.041 | 150 x (2,603,800 + 24,989,200) = 0.041 |
| `proposal` documents | 150 x 66,150,000 = 0.099 | 150 x 61,200,000 = 0.092 |
| **Total** | **~6.64** | **~0.51** |

Fewer changes per hour cut "before" roughly in proportion (10 changing proposals: ~2.2) but hardly change "after":
the packed document is replaced once whenever any entry changed. A 6-hour interval divides the tally line by 6.
`cycle` documents are the same before and after and left out.

## Decisions made in phase 0
- Every hash on Platform is in RPC/display order. Only the collateral OP_RETURN uses raw order.
- Issuer keys are RSA-2048 or RSA-3072 only, so `spki` is 294–422 B. The testnet `badge`
  contract predates this cap and is replaced at the next registration.
- The `mnBadge` index is `[issuerId, epoch, $ownerId]`.
- Identities are created with 3 keys. Other keys are added only when a feature needs them.
- The browser's Core access uses our own grpc-web client, because evo-sdk 5.x has no Core API.

## Testnet artifacts
- Contracts (owner `9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv`):
  - `gov` `3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ`
  - `forum` `HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw`
  - `badge` `3SrZbofJnMgWNiHFzpHc5u7wSRgCFJykZwKq3haqyMfc`
  - `mod` `CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY`
- Keys are outside the repo in `~/.local/share/govhub-phase0/testnet/`.
- testnet funding: faucet.dashhq.org returned 429 `requiresHardCaptcha` (a retry window of about
  23 min). The spike was funded with 1.5 tDASH from the existing EvoVote QA wallet instead.

## Mainnet PV13 write check (2026-10-24)
- **Spend:** received 0.3 DASH and burned 0.218. 0.082 is left on two identities
  (`5h2Bj6ETFQ6BxgtCLTeMna5RvGX8eHj3oFh5abNSy82j` and `AGU4wJ9ZiBkP7HJV6YHEmFBkfAQBXu7JYt9Gp4wpwBbd`).
- **Contract:** the throwaway `pv13check` is `6MEp2FpVkHwCMeHoqft5PFFdMe81eeAiwGd2q2nbPVmJ`
  (`reaction`, `comment`, `mnBadge`). Registering it cost 0.211 DASH, which matches the PV13 fee formula.
- **Costs:** mainnet costs agree with testnet within about 1% for identities and reactions.
  Comments and the first badge cost 14–50% more, which looks like first-use index-tree effects in
  single samples. Testnet numbers are safe for planning.
- **PV13 query behaviour:**
  - (1) A query that misses the index's `orderBy`, or has a gapped or unsupported shape, silently
    returns `[]`. It does not raise an error.
  - (2) `desc` is ignored on equality-only queries unless a range on the last property is added.
  - Both are now rules 1 and 7 in `packages/contracts-v1/README.md`. The CI query lint must enforce
    them.
- **SDK at PV13:** rc.8 rejects a zero `$id`. Compute the id as
  `sha256d(contractId‖ownerId‖type‖entropy)`, because `Document.generateId()` throws at PV13.
- **Insight:** `insight.dash.org` returns 403 to Node's default fetch user agent. The app's own Core
  access is over DAPI, so this only affects tooling.

## Still open
1. ~~One real testnet `voteraw` with the binary-hash scheme.~~ Done in phase 3 (2026-10-24): votes signed by `@govhub/verify`
   `signVote` and by the web app's voting code were accepted by testnet Core (`voteraw`, directly and through the relay); see
   services/relay/README.md "Live testnet run".
2. Android seed restore. Needs a device, so this is for the user.
3. A faucet route for 0.003 vouchers at the portal's amount. This lives in dash-faucet-cf, alongside
   its separate vout fix.
