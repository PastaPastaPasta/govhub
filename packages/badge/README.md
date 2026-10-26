# @govhub/badge

The shared code of the MN owner badge (docs/PLAN.md section 8): the blind-signature client, the reader rules, the
message and token-request formats, and the epoch math. Pure TypeScript (ESM), browser- and Worker-safe: only
WebCrypto (`globalThis.crypto`), no Node imports, no I/O. The issuer's signer is not here; it lives in
`services/issuer`, which imports this package. The web app (`apps/web/src/badge`) uses it for both the client and
the reader.

A badge says "MN · vouched by X". X is an issuer that checked that the identity's owner controls the voting key of a
valid masternode. The issuer signs blind, so it cannot tell which identity ends up with the badge.

```
npm install                          # at the repository root (npm workspaces)
npm test -w @govhub/badge
npm run typecheck -w @govhub/badge
```

## Primitive

**RSABSSA-SHA384-PSS-Randomized** (RFC 9474), through `@cloudflare/blindrsa-ts` **0.4.6**, pinned exactly. The
library is 0.x and small, so every upgrade is a deliberate change. Its `engines` field says Node >= 24. It runs on
Node 22 (this package declares `>=22`, the issuer image uses Node 22.23), and only its client half is used here.

The library's own signer is not used: it is pure JS, not constant-time and about 700 times slower than OpenSSL. The
issuer signs with OpenSSL raw RSA and checks the result itself (`services/issuer/README.md`). Measurements and the
review findings behind these choices are in `spikes/blindrsa/README.md`.

What the wrapper (`src/client.ts`) adds on top of the library:

| Check | Where |
|---|---|
| `blindSig` has modulus length and is `< n` (the library would reduce it silently) | `finalize` |
| the finalized signature is verified again with our own checks | `finalize` |
| `sig` has modulus length and is `< n` | `verify` (never throws, returns `false`) |
| inputs are copied into plain `Uint8Array`s (the library does `x.slice().buffer`, which on a Node `Buffer` is the whole pool) | every call |
| the issuer key is valid (below) | `importIssuerKey` |

`importIssuerKey(spki)` accepts only: an `rsaEncryption` SPKI, in canonical DER (re-exporting must give the same
bytes, so `keyId` names one encoding of one key), `e = 65537`, a modulus of exactly 2048 or 3072 bits, and an odd
modulus with no factor among the primes below 100. This is a sanity check, not a primality test. A malicious key is
handled by the random `msgPrefix`, not by key checks.

## Sizes

| | RSA-2048 | RSA-3072 |
|---|---|---|
| `issuerKey.spki` (rsaEncryption OID) | 294 B | 422 B |
| signature, blinded message | 256 B | 384 B |
| `mnBadge` payload (issuerId 32 + epoch 4 + keyId 32 + msgPrefix 32 + sig) | 356 B | 484 B |

The badge message is 148 B. The prepared message (`msgPrefix || message`) is 180 B. The project's testnet issuer
uses RSA-2048.

## Formats

### Badge message (`src/format.ts`)

```
"govhub-badge:v2" || net(1) || contractId(32) || issuerId(32) || keyId(32) || epoch(u32 BE) || ownerId(32)
```

| Field | Meaning |
|---|---|
| `net` | 1 mainnet, 2 testnet, 3 devnet, 4 regtest |
| `contractId` | the `badge` contract, so a v1 and a v2 contract give different badges |
| `issuerId` | the issuer identity (owner of the `issuerKey` document) |
| `keyId` | `SHA256(spki)` |
| `epoch` | the badge epoch E |
| `ownerId` | the identity that holds the badge (`$ownerId` of the `mnBadge` document) |

RSABSSA's randomized prepare puts a fresh 32-byte `msgPrefix` in front. It is stored in the `mnBadge` document.

**Only the key binds a signature to an issuer and an epoch.** The issuer signs blind, so `net`, `contractId`,
`issuerId` and `epoch` inside the message are chosen by the client and are not authenticated by the signature. A key
must therefore belong to exactly one issuer and one epoch (the issuer destroys it after its window). A reader takes
`issuerId` and `epoch` from the proved `issuerKey` document, `net` and `contractId` from its own config, and `ownerId`
from `$ownerId`. It never takes them from the `mnBadge` document. `bindIssuerKey` and `verifyBadgeSignature` enforce
this: the message is rebuilt from the bound key and `$ownerId`.

### Token request (`src/request.ts`)

Sent to the issuer, signed with Dash `signmessage` by the MN **voting key** only:

```
govhub-badge-req:v2|<net>|<issuerId base58>|<epoch decimal>|<keyIdHex>|<proTxHash display hex>|<nonce hex>|<sha256(blindedMsg) hex>
```

`nonce` is the issuer's challenge, 16 to 64 bytes. Hex is lowercase. The parser is strict: it requires
`build(parse(s)) == s` and caps the input at 512 characters (the longest legal request is 407). Binding
`sha256(blindedMsg)` means that anyone who sees a signed request (a CDN, an extension, the host of a delegated voting
key) cannot use it to take the MN's slot with their own blinded message.

## Epochs (`src/epoch.ts`)

Epochs follow Core superblocks. All parties compute them from the same table, so the table is part of the reader
rules: **changing any value for a network is a new `badge` contract version.**

```
L = superblockCycle * epochCycles          S(E) = E * L          epoch(h) = floor(h / L)
```

| | superblock cycle | cycles per epoch | L (blocks) | W (grace) | boundary margin |
|---|---|---|---|---|---|
| mainnet | 16616 | 1 | 16616 (~28.8 days) | 2016 (~3.5 days) | 8 |
| testnet, devnet | 24 | 24 | 576 (~1 day) | 72 (~3 hours) | 3 |
| regtest | 10 | 1 | 10 | 5 | 0 |

Times assume 2.5 minutes per block. `BLOCK_SECONDS` (157.5) is only used to show estimates in the UI, never in a rule.
The margin keeps clients away from epoch boundaries, because Platform's core height lags the issuer's dashd tip by a
few blocks.

| Window | Heights | Used by |
|---|---|---|
| issuance of tokens for E | `S(E-1) <= h < S(E+1)` (the issuer's dashd tip): the next epoch during E-1, the current one during E | issuer |
| Standard request for E | at once, during E (`[S(E), S(E+1) - margin)`) | client |
| Private request for E | `[S(E-1) + margin, S(E) - margin)`, one uniformly random height (`privateRequestWindow`) | `pickRequestHeight` |
| posting of the badge | Private: `[S(E) + margin, S(E) + W]`, one uniformly random height. Standard: no height; the web client posts it with the user's next write, up to `S(E+1) + W - margin` (PLAN §8.10) | `pickPostHeight` |
| display of a badge for E | `S(E) <= h <= S(E+1) + W`, for the badge's `$createdAtCoreBlockHeight` **and** for the reader's current height | reader |
| `issuerKey` for E | created strictly before `S(E+1) - margin` (`keyDeadline`); no badge for E is older than it | reader, issuer |
| `issuerReport` for E | created in `[S(E+1), S(E+1) + W]` (`reportWindow`): after E's issuance window closed | reader, issuer |

Heights on Platform are `$createdAtCoreBlockHeight`, which Drive sets from the block, so they cannot be back-dated.

**Why a key may be published late** (PLAN §8.9). The key used to be required before `S(E-1)`. That added no protection
against key tagging: the unique, immutable `issuerKey` per (issuer, E) does that, and a client blinds only after a proved
read of it, so every token for E is signed by that one key whenever it appeared. Private mode still needs E's key during
E-1 (an issuer that publishes ahead has it); a key that appears later only means Private is not offered for E. The bound
`S(E+1) - margin` is where Standard requests for E stop, and it keeps the key before E's report.
Epoch 0 is not used: the window functions and `acceptIssuerKey` require `E >= 1`.

**Privacy modes** (PLAN §8.8, §8.10, owner decisions): **Standard** (default) asks for the current epoch; the web
client holds the token and posts the badge with the user's next Platform write (or at once on "Register now"), so the
badge's time follows the user's activity rather than the request. **Private** asks for the next epoch during this one,
so every private token for E exists before any private badge can be posted. The old epoch's badge is still shown until
`S(E+1) + W`, so renewal can happen without a visible gap.

### Testnet timing

Testnet has a superblock every 24 blocks (about 1 hour). One cycle per epoch would mean a new token and a new paid
badge document every hour, and a browser open every hour to renew. 24 cycles make an epoch about a day: renewal
is daily and a new badge still shows within about a day. W = 72 is the same ~12% of an epoch as on mainnet.

How long a new badge takes: in Standard mode, the token comes once the current epoch's key is on Platform and the
browser has been quiet for half an hour plus a random extra wait (mean 1 hour, at most 4 hours), and the badge appears
with the user's next post or reaction. In Private mode a request is for the next epoch E, sent at a random height in E-1's window, and the badge is posted at a random
height in `[S(E) + margin, S(E) + W]`. So a private badge first shows between about 0 and one epoch plus W after the user
asked:

| | up to |
|---|---|
| testnet | ~27 hours |
| mainnet | ~32 days |

While the voting key is kept, the web client renews every epoch.

## Reader rules (`src/reader.ts`)

The caller does the proved Platform queries, for issuers on its trust list only, and passes in the documents and the
current core height. `acceptIssuerKey` then checks, in order:

1. a document exists, `$ownerId` is the trusted issuer, `epoch` is the expected E, `variant` is
   `RSABSSA-SHA384-PSS-Randomized`
2. it was created before `S(E+1) - margin` (`keyDeadline`), and it is the only document returned (the unique index allows
   one; more is refused)
3. `keyId == SHA256(spki)`, and `importIssuerKey` accepts the `spki`
4. if an `issuerRevocation` exists for (issuer, E), badges created at or after its `effectiveCoreHeight` are void.
   Any revocation counts (fail closed)

`verifyMnBadge` then checks one `mnBadge` document against the accepted key: `issuerId`, `epoch` and `keyId` equal the
key's; `msgPrefix` is 32 B; the badge's height and the current height are both in the display window; the badge is not
older than the key (its height is at least the key's `$createdAtCoreBlockHeight`); the badge is not revoked; the signature has modulus length, is `< n`, and passes RSABSSA verify over the message rebuilt from
the key's binding and `$ownerId`. Copying a badge to another identity fails because `$ownerId` is in the message.

Rules that live above this package (in `apps/web/src/badge/reader.ts`):

- Never a count, a history or a type; at most one badge per identity per issuer.
- Badges are never summed across issuers. k issuers can give one MN k badges, shown per issuer.
- Audit (apps/web): the verified badges of (issuer, E) are counted against the issuer's own `issuerReport.tokensIssued`.
  Tokens for E can be issued until `S(E+1)`, so a report counts only if it was created in `[S(E+1), S(E+1)+W]` (a stolen
  report key cannot fix future counts in advance); an issuer flagged for E-1 is hidden for E too
  and is plausible: at most the masternode count of the **proven** list (`@govhub/dapi` anchored chain, SML checked
  against the CbTx `merkleRootMNList`) plus 5%, capped by a pinned bound (testnet 500, mainnet 4,000) that is also the
  fallback when the list cannot be proven. More badges than tokens, an implausible report, no valid report once `S(E+1)+W`
  has passed, or more badges than the audit can count (it counts one past the bound) flags the issuer and hides its
  badges for that epoch. Anyone can post invalid `mnBadge` documents, so thousands of them could push an honest issuer's
  epoch past the count limit (a costly griefing path, accepted).
- The clock for every rule is Platform's proved `coreChainLockedHeight` (from the proof metadata of the badge queries),
  not a node-reported height. MN validity at `S(E-1)` is the issuer's check against its own dashd; readers cannot check
  it (they never learn which MN stands behind a badge).

Verification is cheap: about 20 to 30 microseconds per badge in Chromium (spike results).

## Client rules (`src/schedule.ts`, `src/client.ts`)

- Fresh CSPRNG `msgPrefix` and blinding factor per `blind()` call. Never persist or resend `inv`, and never retry
  `blind()` with an old output for a different message. The issuer cannot detect reuse, so this is a client rule.
- `blind()` is 16 to 40 ms of JS bignum arithmetic (sjcl, not constant-time; the exposure is local to the user's own
  browser). Run it in a Worker.
- Derive epoch and `keyId` from a proved `issuerKey` and the core height, never from the issuer's `/v1/info`.
- Private modes: a due action found when the app opens waits a random 30 s to 10 min (`resumeDelayMs`). Standard mode
  runs at once.
- A signature that fails `finalize` means the issuer is broken or hostile: start over and flag it.

## Module map

| File | Exports |
|---|---|
| `src/client.ts` | `importIssuerKey`, `prepare`, `blind`, `finalize`, `verify`, `bindIssuerKey`, `prepareBadge`, `verifyBadgeSignature`, `VARIANT`, `ALLOWED_MODULUS_BITS`, `SPKI_LEN` |
| `src/format.ts` | `buildBadgeMessage`, `parseBadgeMessage`, `deriveKeyId`, `NET_BYTE`, `isNetwork`, length constants |
| `src/request.ts` | `buildTokenRequest`, `buildTokenRequestFor`, `parseTokenRequest`, `requestBindsBlindedMsg` |
| `src/epoch.ts` | `EPOCH_PARAMS`, `epochStart`, `epochOf`, `issuingEpochsAt`, `issuanceWindow`, `privateRequestWindow`, `postingWindow`, `reportWindow`, `displayWindow`, `inDisplayWindow`, `displayEpochsAt`, `keyDeadline` |
| `src/schedule.ts` | `PrivacyMode`, `PRIVACY_MODES`, `pickRequestHeight`, `pickPostHeight` (per mode), `clientPostingWindow`, `requestableEpoch` (per mode), `resumeDelayMs` |
| `src/reader.ts` | `acceptIssuerKey`, `verifyMnBadge` and the document types |
| `src/docs.ts` | parsers for the JSON `Document.toJSON()` returns (`parseIssuerKeyDoc`, `parseIssuerRevocationDoc`, `parseMnBadgeDoc`, `parseIssuerReportDoc`) and field builders for writers. Parsers throw on malformed input; a reader treats that as "no valid document" |
| `src/bytes.ts` | hex, base64, base58 ids, `sha256`, constant-time `equalBytes`, `randomBelow` |

The `badge` contract is `packages/contracts-v1/badge.json` (documents `issuerKey`, `issuerRevocation`,
`issuerReport`, `mnBadge`; query shapes B1 to B4 in that README).

## Tests

`npm test -w @govhub/badge` runs offline: the RFC 9474 Appendix A vectors (`test/vectors`), round trips at both key
sizes, negative cases (wrong owner, epoch, key, network, contract or issuer; tampered prefix or signature; `s >= n`;
bad key encodings), the message and request formats, the epoch math, and the reader rules.

## Limits

- The client's blinding uses sjcl (deprecated on npm, upstream issue #60). A replacement would be a change to
  this package and the pinned version.
- `blindrsa-ts` is 0.x and small. It is pinned, and the wrapper above does not rely on it for length, range or key
  checks.
- Residual risks of the whole design (issuer soundness, what the issuer learns, correlation) are in
  `services/issuer/README.md`.
