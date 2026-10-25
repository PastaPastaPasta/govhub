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
