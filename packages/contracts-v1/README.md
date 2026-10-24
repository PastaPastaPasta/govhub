# govhub v1 data contracts (PV13 mainnet)

Four contracts, one JSON file each (the `documentSchemas` map that `new DataContract({ schemas })`
takes):

| File | Contract | Owner / who writes | Types |
|---|---|---|---|
| `gov.json` | `gov` | the bridge identity; every type `creationRestrictionMode: 1` | `proposal`, `tally`, `cycle`, `claimAttestation` |
| `forum.json` | `forum` | open | `profile`, `comment`, `reaction`, `claim`, `proposalPost`, `proposalDraft`, `block`, `blockSubs`, `settings`, `vault` |
| `badge.json` | `badge` | open (each issuer / MN writes under its own `$ownerId`) | `issuerKey`, `issuerRevocation`, `issuerReport`, `mnBadge` |
| `mod.json` | `mod` | the moderation identity; `creationRestrictionMode: 1` | `block` |

Everything here was validated offline against PV13 (4.1.1 and 5.0.0-rc.8) and PV14 (5.0.0-rc.8) and
registered on testnet (see `spikes/sdk5/README.md` for results, contract ids and costs). Re-run
with `cd spikes/sdk5 && npm run validate && npm run validate:docs`.

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
  `reaction`, `claim`, `mod.block`; `$updatedAt`: `proposalDraft`). `reaction`, `proposalDraft` and `vault`
  also require the other one (unindexed: only `vault` and `proposalDraft.$createdAt` need it for the UI).
  A type that does not list a system field does not store it.
  The client must send a value for a required field (milliseconds from its clock, checked against block
  time), but **Drive overwrites it with the block's time on creation** (`document_create_transition_action`:
  `created_at = block_info.time_ms`, same for `$updatedAt`, and `$createdAtCoreBlockHeight =
  block_info.core_height`), so stored values cannot be back-dated. "Since T" queries (F2d, F9c, M1b)
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
  documents (`comment`, `reaction`, `claim`, `proposalPost`, `proposalDraft`); two clients that disagree
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
   "where clause on non indexed property" (probe `X1`), but PV13 mainnet has not been exercised yet
   (the local dashmate 4.1.1 check is a separate phase-0 item), so gaps are forbidden. **Ambiguity trap:**
   PV13 picks the candidate index with the smallest "difference", ties broken by index *name* (a
   BTreeMap walked with a strict `<`). `reaction`: `target == X` alone scores 1 on both `byOwnerTarget`
   `[$ownerId, target]` (a gapped match!) and `byTarget` `[target, $createdAt]`, and `byOwnerTarget` sorts
   first. **Whenever the `where` does not cover every property of the index you mean, add an `orderBy`
   that ends at that index's last property** (F6 does: `[target, $createdAt]`). All shapes below satisfy this.
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
5. **Paging**: `limit` (default and max 100) plus `startAfter: <last document id>` (verified, `F3p2`).
6. **Value encodings in `where`** (found in the spike): `byteArray` values must be **base64 strings**
   (a `Uint8Array` throws "invalid type: byte array"); identifier values are **base58 strings**;
   integers are JS numbers. Documents read back render byte arrays as base64 and identifiers as base58.
7. There is no count, sum or "all documents of a type" query. Counts (reactions per proposal) are
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
| `name` | string 1..40, `^[-_a-zA-Z0-9]{1,40}$` | |
| `url` | string 1..512 | |
| `paymentAddress` | string 26..64 | |
| `paymentAmount` | int duffs | |
| `startEpoch`, `endEpoch` | int | unix s |
| `collateralTxid` | bytes 32 | byte order is application-defined; recommended: the RPC (display-order) txid decoded from hex |
| `collateralHeight` | u32 | |

All fields required, plus `$createdAt`. Indexes: `byGovHash` unique `[govHash]`; `byEndEpoch`
`[endEpoch]`; `byNameCreated` `[name, $createdAt]`.

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
| F2c | newest first | same | `[[govHash, desc],[$createdAt, desc]]` |
| F2d | comments since T (equality + range) | `govHash == <b64>`, `$createdAt > <ms>` | `[[govHash, asc],[$createdAt, asc]]` |
| F3 | comments by an author | `$ownerId == <b58>` | `[[$ownerId, asc],[$createdAt, desc]]` |
| F3p1/p2 | paging | as F2/F3 + `startAfter: <last id>` | as above |

### `reaction` (mutable, deletable)

`target` b32 (a comment's document id as raw bytes, or a `govHash`), `kind` 1..255 (1 comment, 2 proposal
community vote), `value` in {-1, +1}. Required: `$createdAt`, `$updatedAt`, `target`, `kind`, `value`.
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

### `proposalDraft` (mutable, deletable)

`time` int unix s, `revision` u32, `dataHex` string 2..1024, `govHash` b32, `collateralTxid` b32
(optional), `stage` 0..255 (convention: 1 awaiting collateral, 2 collateral seen / waiting for 6
confirmations, 3 submitted, 4 failed). Required: `$createdAt`, `$updatedAt`, `time`, `revision`,
`dataHex`, `govHash`, `stage`. Indexes: `byOwnerProposal` unique `[$ownerId, govHash]`,
`byStageUpdated` `[stage, $updatedAt]`.

| ID | Purpose | where | orderBy |
|---|---|---|---|
| F9 | my drafts | `$ownerId == <b58>` | `[[$ownerId, asc],[govHash, asc]]` |
| F9b | relay: drafts waiting at a stage | `stage == 2` | `[[stage, asc],[$updatedAt, asc]]` |
| F9c | relay: ... updated since T | `stage == 2`, `$updatedAt > <ms>` | `[[stage, asc],[$updatedAt, asc]]` |

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
| B1b | all keys of an issuer, newest first | `$ownerId == <I>` | `[[$ownerId, asc],[epoch, desc]]` |
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
testnet during phase 0 predates this cap (it allows 90..600) and is replaced at the next registration. Index:
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
| `claim.method`, `claimAttestation.method`, `block.kind`, `reaction.kind`, `comment.fmt`, `proposalDraft.stage` | enumerations in prose | bounded integers (1..255 / 0..255) | immutable schemas: new values must not need a new contract version |
| `reaction.value` | +-1 | `enum [-1, 1]` | 0 and other values rejected by consensus |
| `issuerKey.variant` | string | `const` | consensus refuses any other RSABSSA variant |
| `issuerKey`, `issuerRevocation` | HIGH (implicit) | CRITICAL signature | an online HIGH key cannot publish or revoke issuer keys |
| gov types | `canBeDeleted` unspecified | `true` | lets the bridge retract a wrong/reorged publication |
| `vault` | "Yappr shape, no refersTo" | also no `immutable`, no `bytes` type | neither exists on PV13 |
