# govhub v1 data contracts (PV13 mainnet)

Four contracts, one JSON file each (the `documentSchemas` map that `new DataContract({ schemas })`
takes):

| File | Contract | Owner / who writes | Types |
|---|---|---|---|
| `gov.json` | `gov` | the bridge identity; every type `creationRestrictionMode: 1` | `proposal` (slim), `tally`, `talliesSet`, `cycle`, `claimAttestation` |
| `forum.json` | `forum` | open | `profile`, `comment`, `reaction`, `claim`, `proposalPost`, `block`, `blockSubs`, `settings`, `vault`, `keyring` |
| `badge.json` | `badge` | open (each issuer / MN writes under its own `$ownerId`) | `issuerKey`, `issuerRevocation`, `issuerReport`, `mnBadge` |
| `mod.json` | `mod` | the moderation identity; `creationRestrictionMode: 1` | `block` |

Everything here was validated offline against PV13 (4.1.1 and 5.0.0-rc.8) and PV14 (5.0.0-rc.8) and
registered on testnet (see `spikes/sdk5/README.md` for results, contract ids and costs). Re-run
with `cd spikes/sdk5 && npm run validate && npm run validate:docs`.

### Mainnet and testnet definitions

The files above are the **mainnet** definitions, registered fresh at launch. The testnet contracts were
registered earlier and PV13/PV14 only let a `DataContractUpdate` *add* document types (not change or remove
one, not add an index to one), so testnet keeps the older shapes:

| Contract | Mainnet (register from) | Testnet (deployed) |
|---|---|---|
| `gov` | `gov.json`: slim `proposal` + `talliesSet` | `gov-testnet.json`: the full `proposal` (also stores `url`, `paymentAddress`, `paymentAmount`, `startEpoch`) + `talliesSet`, added by a contract update on 2026-10-25 (version 1 -> 2) to dev gov `3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ` and testnet gov `5gMnJLDpcoMaQCQNqmHtBiSqCxRCmroXFAffPNdJ2NJC` |
| `forum` | `forum.json`: no `proposalDraft` | `HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw` still has `proposalDraft` (as last specified in this file before 2026-10-25; nothing reads or writes it) |

Readers and the bridge accept both: the bridge reads the deployed contract's schemas at connect and writes
the shape it finds (`services/bridge/src/publish/publisher.ts`), the web app re-derives the slim fields
from `dataHex` and reads `talliesSet` only where the contract has it.
`spikes/sdk5/scripts/validate-*.ts` validate `gov-testnet.json` too.

## Conventions shared by all types

- `additionalProperties: false` everywhere. Every type sets `documentsMutable`, `canBeDeleted`,
  `transferable: 0` and `signatureSecurityLevelRequirement` explicitly (2 = HIGH unless noted).
- No `documentsKeepHistory`, `refersTo`, `distinctFrom`, `ttl`, typed arrays, countable/ranked
  indexes, `maxBytes`, or `-` in names. At most 3 properties per index and at most 3 indexes per type
  (the PV13 limit is 10).
- **Byte arrays** are `type: array, byteArray: true` with `minItems`/`maxItems`. **Identifiers**
  (`contentMediaType: application/x.dash.dpp.identifier`, always exactly 32 B) are used only where the
  value really is a Platform identifier (`identityId`, `parentId`, `block.target`, `issuerId`);
  hashes (`govHash`, `keyId`, ...) are plain 32-byte arrays.
- **Integers** are bounded explicitly. Times that are unix seconds (`time`, `startEpoch`, `endEpoch`,
  `estTime`) allow up to 2^53-1; amounts are **duffs** (1 DASH = 1e8 duffs, max 2.1e15). Every indexed
  integer stays far below 2^63 (PV14 re-keys unsigned integers around the midpoint).
- **System fields**: every indexed system field is in `required` (`$createdAt`: `proposal`, `comment`,
  `reaction`, `claim`, `mod.block`). `reaction` and `vault` also require `$updatedAt` (unindexed: only
  `vault` needs it, for the UI).
  A type that does not list a system field does not store it.
  The client must send a value for a required field (milliseconds from its clock, checked against block
  time), but **Drive overwrites it with the block's time on creation** (`document_create_transition_action`:
  `created_at = block_info.time_ms`, same for `$updatedAt`, and `$createdAtCoreBlockHeight =
  block_info.core_height`), so stored values cannot be back-dated. "Since T" queries (F2d, M1b)
  therefore compare against block time. `badge` types require `$createdAtCoreBlockHeight` (the reader
  rules in PLAN 8.6 depend on it); the SDK/DPP takes it from the block, the client only has to send a
  plausible number.
- **Value size**: any field value is capped at 5,120 bytes of **UTF-8 / raw bytes** and a state
  transition at 20,480 B. String `maxLength` counts characters, so a multi-byte `comment.body`
  of 5,000 characters can exceed 5,120 B: clients must check `TextEncoder().encode(body).length`
  (policy: <= 5,000 B). The largest document, a `proposalPost` with `b0+b1+b2` = 15,360 B, serialises to
  16,795 B in a transition (testnet accepted it).
- Keys: consensus accepts a CRITICAL **or** HIGH authentication key for `DataContractCreate` (v4.1.1
  `identity_signed.rs`); the spike used CRITICAL and so should the bridge/moderation identities by policy.
  Documents use HIGH. `issuerKey` and `issuerRevocation` additionally set
  `signatureSecurityLevelRequirement: 1`, so an online HIGH key on an issuer server cannot publish or
  revoke issuer keys.
- **Hash byte order** (`govHash`, `parentHash`, `voteSetHash`, `collateralTxid`): **decided (phase 0): every
  hash is stored in RPC/display order** (hex-decode the string that `gobject list`/`getrawtransaction` print).
  Conversion to the raw (internal) order happens only at the collateral `OP_RETURN` boundary, inside
  `@govhub/verify`. `govHash` is the join key between bridge-written and user-written
  documents (`comment`, `reaction`, `claim`, `proposalPost`); two clients that disagree
  silently see no comments. Fix the order together with the gov-hash test vector (phase 0, `gobject check`)
  and pin it in `packages/verify`.

## Writing and querying: rules that apply to EVERY shape below

Drive plans a document query with `Index::matches` (rs-dpp `document_type/index/mod.rs`) and
`MAX_INDEX_DIFFERENCE = 2`. PV13 (`index_for_types: 0`) uses that membership-only matcher, which is
defective for gaps ("must keep its defective semantics byte-for-byte for on-chain replay" in rc.8); PV14
(`index_for_types: 1`) uses `matches_contiguous`, which closes the hole. Derived rules, all
enforced by the shapes listed in this file:

1. **Equality prefix + at most one range or `in` on the NEXT index property, nothing after it.**
   The PV13 gapped-index bug returns wrong results for a `where` that skips a property inside an index
   (`[a, b, c]` queried by `a` and `c`). PV14 testnet rejects such a query with
   "where clause on non indexed property" (probe `X1`). **PV13 mainnet (phase 0 write check) accepts the
   same shapes and silently returns `[]`** even when matching documents exist (X1, X2, X2c, X3), so gaps
   are forbidden and the CI query lint is the only guard. **Ambiguity trap:**
   PV13 picks the candidate index with the smallest "difference", ties broken by index *name* (a
   BTreeMap walked with a strict `<`). `reaction`: `target == X` alone scores 1 on both `byOwnerTarget`
   `[$ownerId, target]` (a gapped match!) and `byTarget` `[target, $createdAt]`, and `byOwnerTarget` sorts
   first. **Whenever the `where` does not cover every property of the index you mean, add an `orderBy`
   that ends at that index's last property** (F6 does: `[target, $createdAt]`). All shapes below satisfy this.
   Confirmed on PV13 mainnet: F6 without its `orderBy` returns `[]` for a target that has reactions.
2. **`in` only on the LAST property of the index you use** (`Index::matches` allows the `in` field only on the
   last or second-to-last property; the second-to-last path is not used by anything here). `in` on the
   first property of the PLAN-order `mnBadge` index `[$ownerId, issuerId, epoch]` fails (`X2d`, probed on the
   superseded testnet contract); that is why `mnBadge` is indexed `[issuerId, epoch, $ownerId]`
   instead of the PLAN 3.1 order.
3. **`orderBy` lists index properties in index order**, as a contiguous run that ends at the
   property you filter or page on. It may omit the equality-prefix properties (`orderBy: [['$createdAt','asc']]`
   works), but must include the `in` property (`orderBy: [['target','asc']]`). One `in` per query.
4. A query may use at most 2 fewer properties than the index has (`MAX_INDEX_DIFFERENCE`), which is
   always satisfied here (max index length 3).
5. **Paging**: `limit` (default and max 100) plus `startAfter: <last document id>` (verified, `F3p2`) for **ascending** lists only.
   **A `desc` query must never carry `startAfter` (lint R8):** PV13 mainnet answers it, but evo-sdk 5.0.0-rc.8 rejects the proof
   ("Proof op family does not match the query direction: upright op in a right-to-left walk"), so the read fails; verified
   read-only on mainnet 2026-10-25 for F2c, F3 and a DPNS desc list, while the same lists with `asc` + `startAfter` verify. Newest-first
   lists (G3, F2c, F3) page by a bound instead: the next page asks for `<=` the previous page's last key and drops the ids already read at
   that key (`pageDesc` in `packages/forum/src/reader.ts`, `pastPage` in `apps/web/src/data/repo.ts`), so documents sharing one block time
   or end epoch are neither lost nor repeated.
6. **Value encodings in `where`** (found in the spike): `byteArray` values must be **base64 strings**
   (a `Uint8Array` throws "invalid type: byte array"); identifier values are **base58 strings**;
   integers are JS numbers. Documents read back render byte arrays as base64 and identifiers as base58.
7. **Descending order needs a range on PV13.** On mainnet PV13, `desc` is silently ignored when the
   `where` has only equality clauses, and results come back ascending. PV14 testnet honours it. Add a
   no-op range on the last ordered property (`$createdAt > 0`, `epoch >= 0`). Verified on mainnet
   (`spikes/sdk5/results/mainnet-order-probe.json`). F2c, F3 and B1b carry that range.
8. There is no count, sum or "all documents of a type" query. Counts (reactions per comment) are
   computed client-side by paging; PV14 ranked counts replace that in v2.

Every shape is numbered; the ID is the probe in `spikes/sdk5/scripts/testnet-queries.ts`, which ran
all of them against the registered testnet contracts with proofs (`results/testnet-queries.json`).

---

## `gov`

Bridge-owned, signed with a HIGH key. All types are deletable by the bridge so a wrong or reorged
publication can be retracted; none is transferable.

### `proposal` (immutable, deletable)

| Field | Type | Notes |
|---|---|---|
| `govHash` | bytes 32 | Core governance object hash |
| `parentHash` | bytes 32 | all zero for proposals |
| `revision` | u32 | |
| `time` | int | unix s (`nTime`) |
| `dataHex` | string 2..1024 | hex of the gobject data; Core caps decoded data at 512 B |
| `name` | string 1..40, `^[-_a-zA-Z0-9]{1,40}$` | indexed (G4) |
| `endEpoch` | int | unix s; indexed (G2, G3) |
| `collateralTxid` | bytes 32 | byte order is application-defined; recommended: the RPC (display-order) txid decoded from hex |
| `collateralHeight` | u32 | |

All fields required, plus `$createdAt`. Indexes: `byGovHash` unique `[govHash]`; `byEndEpoch`
`[endEpoch]`; `byNameCreated` `[name, $createdAt]`.

**Slim (decided 2026-10-25).** `url`, `paymentAddress`, `paymentAmount` (duffs) and `startEpoch` are not stored:
they are in `dataHex`, which the gov hash commits to, and every reader parses it anyway to check the
document (`@govhub/verify` `parseProposalData`, Core's parser). The web app fills them in from it
(`apps/web/src/data/platform.ts` `docToProposal`: amount = `round(payment_amount * 1e8)`); when `dataHex` does
not parse they stay empty and the content check fails the proposal. `name` and `endEpoch` stay because queries
need them; readers still compare them with the hashed data. Measured on testnet: a slim create costs about
0.00061 DASH, a full one 0.00066 (`services/bridge/scripts/results/testnet-cost-pass.json`). The testnet
contracts keep the full shape (`gov-testnet.json`); readers there use the stored values, so a stored field
that differs from `dataHex` still fails the content check.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| G1 | proposal by hash | `govHash == <b64>` | - |
| G2 | active proposals | `endEpoch > <now s>` | `[[endEpoch, asc]]` |
| G3 | past proposals, newest end first | `endEpoch <= <now s>` | `[[endEpoch, desc]]` |
| G4 | proposal(s) by name (slug lookup `/p/<id>/<name>`) | `name == <name>` | `[[name, asc],[$createdAt, asc]]` (or `[[$createdAt, asc]]`, `G4b`) |

### `tally` (mutable, deletable)

`govHash` (b32), `asOfHeight` u32, `yesWeighted`/`noWeighted`/`abstainWeighted` u32, `yesCount`/
`noCount`/`abstainCount` u32, `voteSetHash` b32, `rank` u32, `inNextBudget` bool, `margin` i32. All
required. Index: `byGovHash` unique `[govHash]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| G5b | one tally | `govHash == <b64>` | - |
| G5 | tallies of the visible proposals (<= 100) | `govHash in [<b64>, ...]` | `[[govHash, asc]]` |

Since `talliesSet`, the bridge writes a `tally` only for a proposal that left the active set: its final
tally, once, from its last packed entry (same numbers, same `asOfHeight`), with `rank` 0 and `inNextBudget`
false so nothing shows a stale "will be funded". This is what the Past list reads (G5). On a contract
without `talliesSet` (none left after the 2026-10-25 updates) it is still one replaced `tally` per proposal.

### `talliesSet` (mutable, deletable), added 2026-10-25

Every active proposal's tally in one document, because PV13 allows one document per state transition: one
replace of this document costs about what one per-proposal `tally` replace did (measured on testnet, PV14:
`tally` replace 2,475,040 credits; `talliesSet` replace with 6 entries 2,726,140, with 30 entries 4,249,220,
with 161 entries 11,228,280).

`page` u8 (0..255), `asOfHeight` u32, `b0` bytes 3..5120, `b1`, `b2` bytes 1..5120 (optional). Required: `page`,
`asOfHeight`, `b0`. Index: `byPage` unique `[page]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| G8 | every page, page 0 first | `page >= 0` | `[[page, asc]]`, `limit` 8 (`TALLY_SET_MAX_PAGES`) |
| G8b | one page (bridge lookup) | `page == <n>` | - |

**Format, version 1** (`packages/verify/src/tallyset.ts`, shared by the bridge and the web app). Big-endian,
fixed width:

```
stream = version u8 (= 1) | count u16 | count x entry
entry  = govHash[32] | voteSetHash[32]
       | yesWeighted u32 | noWeighted u32 | abstainWeighted u32
       | yesCount u32 | noCount u32 | abstainCount u32
       | rank u16 | flags u8 (bit 0 = inNextBudget, other bits 0) | margin i32           = 95 bytes
```

- The fields are those of `tally` without `asOfHeight`; the document's `asOfHeight` applies to every entry.
  Hashes are in RPC/display order like every other gov hash.
- Entries are sorted by `govHash`, strictly ascending (no duplicates).
- The stream is split into `b0`, `b1`, `b2` of at most 5,120 bytes, each but the last exactly 5,120: 161
  entries per document (`3 + 161 x 95 = 15,298` bytes). 30 entries (mainnet today) are 2,853 bytes, in `b0`.
- Fixed width on purpose: a replace with the same proposals keeps the size, so it pays processing only, no
  storage (a joining proposal adds 95 bytes, measured +2,603,800 credits on that replace).
- Readers reject the whole page on any deviation (unknown version, length that does not match `count`, a
  non-canonical split, unsorted or duplicate entries, unknown flag bits); its proposals then have no packed
  tally. A new format gets a new version byte.

**Publishing** (`services/bridge/src/publish/publisher.ts`): every publishable tally (proposal on Platform,
Core agreed, same funding threshold) goes in. Only stored runs are published (the `tallies` rows readers
recount against), never a live vote refresh. Holds:
- Core disagrees with one proposal's tally: that entry is left out (it cannot stay at its old numbers, because
  the document has one `asOfHeight` and the record stored at the new one differs). Until Core agrees again
  readers have no Platform tally for it ("no vote tally published", not verified); its other entries go out.
- The funding threshold differs from Core's, or Core could not be asked about some proposal (an RPC error):
  the set is not replaced at all that run, so a transient hold never empties or thins it.

The bridge replaces a page at most every `TALLY_PUBLISH_INTERVAL_S` (3600) and only when an entry changed
(`asOfHeight` alone is no change), so a new proposal's first entry can wait up to an hour. One exception: when
the record stored at the page's own height changed (a second stored run at the same block, with new votes),
the page is replaced at once, because readers recount it against that record. More than 161 tallies spill into
page 1 (then 2, ... up to `TALLY_SET_MAX_PAGES` = 8, 1,288 proposals; more are logged and not published) in
`govHash` order; a page that is no longer needed is emptied (`count` 0) once. A bridge whose archive knows no
page (fresh or restored, or the first run after a contract update) adopts the pages on Platform first (G8): only
pages its own identity owns, and it remembers only entries of proposals its archive knows. Stale pages are then
still emptied (a page that already says what the run would write is not rewritten), and a proposal that ended
meanwhile still gets its final tally. Final tallies are written only for proposals on Platform, at most 10 per run
(`MAX_FINALS_PER_RUN`; the rest follow on the next runs), and never over a per-proposal tally that is at least as
new (testnet documents from before the update). Context: on 2026-10-25 a first version of this adoption, run on the
rehearsal contract, turned 192 synthetic entries left by the fee measurement into 192 paid `tally` creates
(0.046 tDASH); `services/bridge/test/publisher.test.ts` "regression (testnet burst 2026-10-25)" pins the fix.

**Reading** (`apps/web/src/data/repo.ts` `tallies()`): G8, plus G5 for the same proposals; per proposal the
entry with the higher `asOfHeight` wins. On a tie the packed one wins, except over a final tally (`rank` 0, not in
the next budget), which the bridge may write before its next throttled replace drops the entry. Each entry is a `Tally` at the page's
`asOfHeight`, verified exactly like a `tally` document: a recount of the bridge's signed votes for that
height must reproduce every count and the `voteSetHash`. When a replace re-stamps an entry that did
not change with the new `asOfHeight`, the bridge, asked for the votes at that height, serves the record in
force there (its newest at or below it), which is that entry's vote set, so the recount still matches
(`services/bridge/test/publisher.test.ts` "a re-stamped entry"; `scripts/readback.ts` checks every entry
against that record).

**Ended proposals: why a final per-proposal `tally` and not a packed "ended" document.** Measured, a final
`tally` create costs 24,989,200 credits (0.00025 DASH) per proposal: about 0.04 DASH a year at ~150 proposals.
An append-only packed history would cost an append replace instead (about 4 to 11 million credits plus 2.6
million for the 95 new bytes), saving at most about 0.02 to 0.03 DASH a year, but it would need its own index
or page scheme (one `asOfHeight` per document, while proposals end at different heights), grow forever, and
make the Past list scan every history page instead of asking G5 for the proposals it shows. A "recently ended"
window alone would drop history. The per-proposal final keeps G5 and the Past list unchanged and is written
exactly once.
### `cycle` (mutable, deletable)

`superblockHeight` u32, `budget`, `allocated` (duffs), `votingDeadlineHeight` u32, `estTime` unix s,
`validWeighted` u32, `paid` (duffs actually paid, 0 until the superblock pays; PLAN left this type open).
All required. Index: `bySuperblock` unique `[superblockHeight]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| G6 | latest cycles | `superblockHeight > 0` | `[[superblockHeight, desc]]`, `limit` |
| G6b | one cycle | `superblockHeight == <h>` | - |

### `claimAttestation` (immutable, deletable)

`govHash` b32, `identityId` identifier, `method` 1..255, `note` string 1..500 (optional). Required:
`govHash`, `identityId`, `method`. Index: `byGovHash` (non-unique) `[govHash]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| G7 | attestations for a proposal | `govHash == <b64>` | `[[govHash, asc]]` |

---

## `forum`

Open contract; users sign with their HIGH key. `$ownerId` is always the author.

### `profile` (mutable, deletable)

`displayName` 1..64 (required), `about` 1..500, `avatarUrl` 1..512. Index `byOwner` unique `[$ownerId]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F1 | profile of one identity | `$ownerId == <b58>` | - |
| F1b | profiles of the commenters on screen (<= 100) | `$ownerId in [<b58>, ...]` | `[[$ownerId, asc]]` |

### `comment` (immutable, deletable)

`govHash` b32, `parentId` identifier (optional; the parent comment's document id), `body` string 1..5000
(see the byte rule above), `fmt` 0..255 (0 plain, 1 markdown). Required: `$createdAt`, `govHash`, `body`, `fmt`.
Indexes: `byProposal` `[govHash, $createdAt]`, `byAuthor` `[$ownerId, $createdAt]`. Thread trees are
assembled client-side from the proposal's flat list (there is deliberately no `parentId` index).

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F2 | comments of a proposal, oldest first | `govHash == <b64>` | `[[govHash, asc],[$createdAt, asc]]` |
| F2c | newest first | `govHash == <b64>`, `$createdAt > 0` (rule 7) | `[[govHash, desc],[$createdAt, desc]]` |
| F2d | comments since T (equality + range; `>=`, callers skip the ids they hold) | `govHash == <b64>`, `$createdAt >= <ms>` | `[[govHash, asc],[$createdAt, asc]]` |
| F3 | comments by an author, newest first | `$ownerId == <b58>`, `$createdAt > 0` (rule 7) | `[[$ownerId, asc],[$createdAt, desc]]` |
| F3p1/p2 | paging | F2: + `startAfter: <last id>`; F2c/F3 (desc): `$createdAt <= <last page's oldest>` instead (rule 5, R8) | as above |

### `reaction` (mutable, deletable)

`target` b32 (a comment's document id as raw bytes, or a `govHash`), `kind` 1..255 (1 comment; 2 was a proposal
community vote, which govhub removed on 2026-10-26: the contract is unchanged, but the app no longer writes or reads kind 2, and 2 must not be reused), `value` in {-1, +1}. Required: `$createdAt`, `$updatedAt`, `target`, `kind`, `value`.
Indexes: `byOwnerTarget` unique `[$ownerId, target]` (one reaction per user per target, flip by replacing),
`byTarget` `[target, $createdAt]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F5 | my reaction on one target | `$ownerId == <b58>`, `target == <b64>` | - |
| F5b | my reactions on the visible targets (<= 100) | `$ownerId == <b58>`, `target in [<b64>, ...]` | `[[$ownerId, asc],[target, asc]]` |
| F6 | all reactions on a target (client-side tally, paged) | `target == <b64>` | `[[target, asc],[$createdAt, asc]]` |

### `claim` (immutable, deletable)

`govHash` b32, `method` 1..255 (2 = payment-address signature, 3 = collateral-input key), `sig` exactly
65 B (compact signature with recovery byte). Required: `$createdAt`, `govHash`, `method`, `sig`. Index:
`byProposal` `[govHash, $createdAt]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F7 | claims on a proposal | `govHash == <b64>` | `[[govHash, asc],[$createdAt, asc]]` |

### `proposalPost` (mutable, deletable)

`govHash` b32, `title` 1..200, `b0` bytes 1..5120, `b1`, `b2` (optional, same bounds; the deflated
markdown is split across them), `links` string 1..1000 (optional). Required: `govHash`, `title`, `b0`.
Index: `byProposalOwner` unique `[govHash, $ownerId]`. The reader picks the post whose `$ownerId` is the
proven proposal owner.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F8 | the owner's post for a proposal | `govHash == <b64>`, `$ownerId == <b58>` | - |
| F8b | all posts for a proposal | `govHash == <b64>` | `[[govHash, asc],[$ownerId, asc]]` |

### `proposalDraft`: not in the mainnet contract (removed 2026-10-25)

Nothing uses it yet. It comes back with the proposal wizard, through a `forum` contract update (adding a type
is allowed; on PV13 the update fee is the full registration fee of the updated contract, about 0.44 DASH for
`forum` then, measured 0.46 on testnet for the keyring update). The testnet `forum` contract still has it, in the
shape this file had before (stage-indexed drafts; shapes F9, F9b, F9c, unused).

### `block` (immutable, deletable)

`target` identifier (an identity id or a document id), `kind` 1..255 (1 identity, 2 document), `reason`
string 1..280 (optional). Required: `target`, `kind`. Index: `byOwnerTarget` unique `[$ownerId, target]`.
Unblock = delete.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F10 | my block list (paged) | `$ownerId == <b58>` | `[[$ownerId, asc],[target, asc]]` |
| F10b | are these targets blocked by list L (<= 100) | `$ownerId == <L b58>`, `target in [<b58>, ...]` | `[[$ownerId, asc],[target, asc]]` |

### `blockSubs` (mutable, deletable)

`lists` bytes 32..5120 (optional; N x 32-byte list-owner identity ids, up to 160), `defaultOff` bool
(required). Index: `byOwner` unique `[$ownerId]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F11 | my subscriptions | `$ownerId == <b58>` | - |

### `settings` (mutable, deletable)

`endpoints` bytes 1..5120 (deflated JSON of the endpoint registry). Index: `byOwner` unique `[$ownerId]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F12 | my settings | `$ownerId == <b58>` | - |

### `vault` (mutable, deletable)

The shape of Yappr's passkey vault (`yappr-passkey-vault-contract.json`) minus its PV14-only parts:
`credentialId` bytes 16..255, `recipientKey` bytes 32, `version` 1..255, `authKeyId` u32, `enc` bytes 32,
`sealed` bytes 32..256; all required with `$createdAt`/`$updatedAt`. Index: `byCredential` unique
`[$ownerId, credentialId]`. Differences from Yappr's file: `type: "bytes"` / `size` became
`array + byteArray` with equal min/max, `authKeyId` lost its `refersTo`, and the doctype-level
`immutable: [credentialId, recipientKey]` is gone (not a PV13 keyword). **PV13 therefore cannot
stop a replace from changing `credentialId` or `recipientKey`; clients must treat them as immutable.**

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F13 | my vault entries | `$ownerId == <b58>` | `[[$ownerId, asc],[credentialId, asc]]` |
| F13b | the entry for one credential | `$ownerId == <b58>`, `credentialId == <b64>` | - |

### `keyring` (mutable, deletable) — added in phase 3

The encrypted masternode keyring (PLAN 4.2, 5.1, 5.2; crypto and layout in `packages/auth/src/keyring/`). Two documents per
identity: `kind` 0 = the voting keys, node labels and unlockers, `kind` 1 = signed votes waiting at a relay. Everything inside is
encrypted in the browser; the operator and the chain see only the bucket.

`kind` 0..255, `version` 1..255, `bucket` 1..255, `wraps` bytes 80..1280 (today always 640: 8 HPKE slots of 80 B, unused ones
random), `c0` bytes 32..5120 (required), `c1`, `c2` bytes 32..5120 (optional). The ciphertext is split into 4,096-byte fields:
bucket 1 uses `c0`, bucket 2 uses `c0..c2` (12,288 B; a transition stays far below 20,480 B). No timestamps are stored (none is
required), so a document carries no more metadata than Drive's own. Index: `byOwnerKind` unique `[$ownerId, kind]`.

Caps (the bucket depends on counts only, never on byte lengths): bucket 1 = up to 32 voting keys, 24 node labels and 8 unlockers;
bucket 2 = up to 96 keys and 80 labels. Pending votes: 16 / 60. Beyond bucket 2 the client refuses. What leaks: that the identity
has a keyring (and pending votes), which bucket, and when it changes; never how many keys or masternodes.

The bounds are deliberately wider than what version 1 writes (`wraps` up to 16 slots, fields up to 5,120 B), so a later client
version can change the layout without a contract change; readers check the exact sizes for the version they know.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| K1 | my keyring (kind 0) or my pending votes (kind 1) | `$ownerId == <b58>`, `kind == <0 or 1>` | - |

**Testnet:** added to the deployed `forum` contract `HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw` with a DataContractUpdate on
2026-10-24 (contract version 1 -> 2, signed by the owner's CRITICAL key, fee 0.46036245 DASH; adding a document type to an existing
contract is allowed at PV13 and PV14, a new index on an existing type is not). Live write costs with the u6 test identity
(`packages/auth/scripts/results/testnet-forum-keyring.json`): create bucket 1 0.00160 DASH, replace to bucket 2 0.00229, back to
bucket 1 refunds 0.00212, pending document create 0.00153. Mainnet registers `forum` fresh from this file.

---

## `badge`

All types are immutable, undeletable, non-transferable. All require `$createdAtCoreBlockHeight`.

### `issuerKey` (CRITICAL signature)

`epoch` u32, `spki` bytes 294..422 (rsaEncryption SPKI DER: RSA-2048 = 294 B, RSA-3072 = 422 B; nothing else is allowed), `keyId` b32 (= SHA-256(spki), checked by readers), `variant` string,
fixed by `const` to `RSABSSA-SHA384-PSS-Randomized` so a deterministic variant cannot be published.
Index: `byOwnerEpoch` unique `[$ownerId, epoch]` (one key per issuer per epoch).

| ID | Purpose | where | orderBy |
|---|---|---|---|
| B1 | the key of issuer I for epoch E | `$ownerId == <I>`, `epoch == E` | - |
| B1b | all keys of an issuer, newest first | `$ownerId == <I>`, `epoch >= 0` (rule 7) | `[[$ownerId, asc],[epoch, desc]]` |
| B1c | keys from epoch E on | `$ownerId == <I>`, `epoch >= E` | `[[$ownerId, asc],[epoch, asc]]` |

### `issuerRevocation` (CRITICAL signature)

`epoch` u32, `keyId` b32, `effectiveCoreHeight` u32. Index: `byOwnerEpoch` unique `[$ownerId, epoch]`.
Shape **B2**: `$ownerId == <I>`, `epoch == E`.

### `issuerReport`

`epoch` u32, `tokensIssued` u32. Index: `byOwnerEpoch` unique `[$ownerId, epoch]`.
Shape **B3**: `$ownerId == <I>`, `epoch == E`.

### `mnBadge`

`issuerId` identifier, `epoch` u32, `keyId` b32, `msgPrefix` exactly 32 B, `sig` bytes 256..384 (256 for
RSA-2048, 384 for RSA-3072; the exact length per `keyId` is checked by the reader). **Decided (phase 0):** issuer keys are
RSA-2048 or RSA-3072 only, so `spki` is capped at 422 B to match `sig` ≤ 384 B. The badge contract registered on
testnet during phase 0 (`3SrZbofJnMgWNiHFzpHc5u7wSRgCFJykZwKq3haqyMfc`) predates this cap (it allowed 90..600). It has been
replaced: the current testnet contract is `2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU`, registered on 2026-10-24 from the
current `badge.json`. Index:
`byIssuerEpochOwner` **unique `[issuerId, epoch, $ownerId]`**: at most one badge per author per issuer per
epoch, exactly the uniqueness PLAN 3.1 asks for, but ordered so that the reader query below is legal.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| B4 | which of these authors (<= 100) hold a badge from issuer I in epoch E | `issuerId == <I>`, `epoch == E`, `$ownerId in [<b58>, ...]` | `[[$ownerId, asc]]` |
| B4b | one author's badge | `issuerId == <I>`, `epoch == E`, `$ownerId == <b58>` | - |
| B4c | every holder of issuer I in epoch E (paged; issuer audits vs `issuerReport`) | `issuerId == <I>`, `epoch == E` | `[[$ownerId, asc]]` |
| B4d | issuer I's badges from epoch E on | `issuerId == <I>`, `epoch >= E` | `[[epoch, asc]]` |

Not possible with this index (probe `X2`): "all badges of author A" without naming the issuer and epoch.
The reader always has the trust list and the current epoch window, so it asks B4 per trusted issuer.

---

## `mod`

### `block` (immutable, deletable, owner-only creation)

Same fields as `forum.block` plus `$createdAt` (required). Indexes: `byOwnerTarget` unique
`[$ownerId, target]`, `byOwnerCreated` `[$ownerId, $createdAt]` (incremental sync of the default list).
Third parties publish their own lists with `forum.block` (any identity can) and are referenced from
`forum.blockSubs.lists`; `mod.block` is only the official default list.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| M1 | the default list (paged) | `$ownerId == <mod>` | `[[$ownerId, asc],[target, asc]]` |
| M1b | entries added since T | `$ownerId == <mod>`, `$createdAt > <ms>` | `[[$ownerId, asc],[$createdAt, asc]]` |
| M1c | are these targets on the list (<= 100) | `$ownerId == <mod>`, `target in [<b58>, ...]` | `[[$ownerId, asc],[target, asc]]` |

Removals are invisible to M1b (a deleted document just disappears): clients re-run M1 on a schedule.

---

## Shapes that must NOT be used

Probed on testnet (PV14), all in `results/testnet-queries.json`:

| ID | Shape | Result |
|---|---|---|
| X1 | `mnBadge`: `issuerId == I`, `$ownerId == A` (skips `epoch`) | rejected on PV14; **expected to return wrong results on PV13** (gapped-index bug, not yet exercised) |
| X2 | `mnBadge`: `$ownerId == A` (not an index prefix) | rejected on PV14; may be accepted wrongly on PV13 (difference 2 = `MAX_INDEX_DIFFERENCE`) |
| X2c | `mnBadge`: `$ownerId in [...]` with no `issuerId`/`epoch` prefix | rejected on PV14 |
| X2d | superseded PLAN-order index `[$ownerId, issuerId, epoch]`: `$ownerId in [...]` | rejected (`in` on the first property) |
| X3 | `comment`: `$createdAt > 0` (no index starts with `$createdAt`) | rejected |
| X0 | any `byteArray` value passed as `Uint8Array` | client-side error; send base64 |

Accepted by PV14 testnet but intentionally unused because PV13 behaviour is unverified: `in` on the
second-to-last property (`X2b`), `in` combined with a range on the next property (`X4`).

## Deliberate differences from PLAN 3.1

| Item | PLAN | Here | Why |
|---|---|---|---|
| `mnBadge` unique index | `[$ownerId, issuerId, epoch]` | `[issuerId, epoch, $ownerId]` | Drive allows `in` only on the last (or second-to-last) index property; the reader flow needs "which of these authors have a badge" |
| `mod.block` | fields unspecified | adds `$createdAt` and a second index `[$ownerId, $createdAt]` | incremental sync of a list that can have thousands of entries |
| `cycle.paid` | unspecified | integer duffs | richer than a flag; 0 = unpaid |
| `claim.method`, `claimAttestation.method`, `block.kind`, `reaction.kind`, `comment.fmt` | enumerations in prose | bounded integers (1..255 / 0..255) | immutable schemas: new values must not need a new contract version |
| `reaction.value` | +-1 | `enum [-1, 1]` | 0 and other values rejected by consensus |
| `issuerKey.variant` | string | `const` | consensus refuses any other RSABSSA variant |
| `issuerKey`, `issuerRevocation` | HIGH (implicit) | CRITICAL signature | an online HIGH key cannot publish or revoke issuer keys |
| gov types | `canBeDeleted` unspecified | `true` | lets the bridge retract a wrong/reorged publication |
| `proposal` | url, payment address/amount, start stored | only the hashed data, `name`, `endEpoch`, collateral | the rest is in `dataHex`; less to pay and nothing a reader must cross-check |
| `tally` per proposal, replaced hourly | one per proposal | `talliesSet` (all active, one document) + a final `tally` per ended proposal | PV13: one document per transition, so packing cuts the hourly cost from N replaces to one |
| `proposalDraft` | in `forum` | not on mainnet yet | unused until the proposal wizard; added back by a contract update |
| `vault` | "Yappr shape, no refersTo" | also no `immutable`, no `bytes` type | neither exists on PV13 |
| `keyring` | not in PLAN 3.1 (PLAN 4.2 keeps MN keys in the central envelope or the passkey vault) | its own type | `vault.sealed` is capped at 256 B: 7 keys, no labels; the keyring needs 4-12 KB padded |
