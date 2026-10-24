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

## Mainnet budget (estimate from the numbers above)

| Item | DASH |
|---|---|
| Phase 0 mainnet check: identity plus a small contract with the tricky query shapes (`reaction`, `mnBadge`, `comment`) and a few writes. This replaces the planned local dashmate 4.1.1 network, because it tests the real PV13 query planner. | ~0.3 one-time |
| Launch: register the four v1 contracts, plus bridge, moderation and issuer identities | ~1.1 one-time |
| Bridge operations: ~30 proposals per cycle, plus tallies refreshed hourly on change | ~0.6 per month (~0.15 if tallies refresh every 6 h) |
| Issuer keys (one doc per epoch) | negligible |
| Starter vouchers | 0.003 each, from the faucet treasury |

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
1. One real testnet `voteraw` with the binary-hash scheme. It needs a testnet MN voting key.
2. Android seed restore. Needs a device, so this is for the user.
3. A faucet route for 0.003 vouchers at the portal's amount. This lives in dash-faucet-cf, alongside
   its separate vout fix.
