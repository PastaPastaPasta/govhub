# @govhub/auth

Identity, login and funding for govhub (docs/PLAN.md r3.2 section 4). Headless TypeScript, browser-first, Node >= 22. The UI is in
`apps/web/src/auth`.

```
npm test -w @govhub/auth          # offline: derivation, HPKE (RFC 9180), tx, sign-in, vault
npm run typecheck -w @govhub/auth
npx vite-node scripts/live-testnet.ts [create] [voucher] [topup] [signin] [vault] [addkeys]   # TESTNET, spends tDASH
```

Entry points: `@govhub/auth` (everything headless), `@govhub/auth/evo` (the evo-sdk 5 `PlatformPort` adapter; the caller passes the
already-loaded SDK so the 8.7 MB chunk is never pulled in by this package) and `@govhub/auth/webauthn` (browser only).

## What it does

| Area | Module | Notes |
|---|---|---|
| Seed | `seed.ts` | BIP39 English, 12 or 24 words, **no passphrase**. DIP-13 identity keys `m/9'/c'/5'/0'/0'/identity'/key'` (c = 5 mainnet, 1 testnet), registration funding `m/9'/c'/5'/1'/identity'`, top-up funding `m/9'/c'/5'/2'/identity'/n` (key-wallet `IdentityTopUp`). `SeedWallet` keeps the BIP32 root and the entropy, never the phrase string. |
| Key layout | `layout.ts` | Created with 0 AUTH/MASTER, 1 AUTH/CRITICAL, 2 AUTH/HIGH (ECDSA_SECP256K1, id = index). `addLaterKeys` adds 3 TRANSFER/CRITICAL and 4/5 ENC/DEC MEDIUM bound to DashPay `contactRequest` with one MASTER-signed IdentityUpdate. |
| Sign-in | `signin.ts` | Discovery by the key-0 hash, identity index 0.. with a gap of 5 (DashPay iOS, rs-platform-wallet, Yappr). The session key is the identity's HIGH authentication key, else CRITICAL, never MASTER; key indexes 0..11 are probed (Evo Tool), so seeds whose key ids differ from their indexes work. Key paste: WIF or hex, only the public key hash is sent. Sessions hold the key in memory; `end()` wipes it. |
| Funding | `funding.ts`, `tx.ts` | One-time key at the funding path; `watchAddressForDeposit` subscribes **before** the address is shown; type-8 asset lock spending the deposit (1 duff/byte); a second watcher on the lock's txid and inputs opens **before** the broadcast and its IS-lock bytes are persisted on arrival; instant proof, else a chain proof at Platform's `coreChainLockedHeight`; `identities.create` / `topUp`; a proved read confirms. Progress (`FundingRecord`) holds public data only, so a reload resumes once the same seed (or, for seedless top-ups, the same pasted key) is unlocked again. |
| Vouchers | `voucher.ts` | `dashpay://invite?assetlocktx=<txid>&pk=<WIF>&islock=null` (dash-faucet-cf). The identity gets the user's own seed keys; the voucher key only signs the proof. |
| Passkey vault | `vault/*` | `forum.vault` documents. RFC 9180 HPKE base mode (X25519, HKDF-SHA256, ChaCha20-Poly1305) to the key a WebAuthn PRF output derives; AAD binds contract, owner, credential, recipient key and key id. Bundles: the seed (entropy + identity index), one HIGH/CRITICAL key, or up to 7 MN voting keys, all padded to 240 B (256 B sealed). Every opened bundle is checked against the owner's keys on chain before a session exists (planted entries). |
| Central login | `central.ts` | Interface only (accounts service, OPAQUE + passkey envelopes); a later phase. |

## Findings

1. **The asset-lock proof index is the payload's credit-output index, not the burn output's vout.** rs-dpp
   `InstantAssetLockProof::output()` is `payload.credit_outputs.get(output_index)` and the chain proof's `out_point.vout` goes through
   the same lookup (`validate_asset_lock_transaction_structure` v0); the identity id is `sha256d(txid || u32le(index))`. With one
   credit output it is 0 wherever the burn sits. Live check: a voucher with the burn at vout 1 (change first, as dash-faucet-cf's
   BIP69 sort can produce) redeemed with index 0. `locateCredit` finds the credit output paying the key and uses its index.
2. **Testnet evonodes report `isSynced: false`** (status ERROR) in `getBlockchainStatus` while serving current blocks (2026-10-24,
   just after V24). `@govhub/dapi`'s `getBestBlockHeight()` refuses them, so funding takes the tip from `getBestBlockHeight` RPC (a
   claim, used only as a stream start a few blocks back).
3. The DIP-13 top-up path's last index is unhardened in key-wallet (`AddressPoolType::Absent`); the registration path here keeps
   the hardened `.../1'/identity'` the phase-0 mainnet run used. Both are cross-checked against key-wallet in the tests.
4. `Document.toJSON` needs a platform version argument in rc.8; byte fields come back base64.
5. **Nonce cache refresh (rc.8 source, tag v5.0.0-rc.8).** `sdk.wasm.refreshIdentityNonce(identifier)` (wasm-sdk `src/sdk.rs`
   118-121 -> rs-sdk `Sdk::refresh_identity_nonce`, `src/sdk.rs` 754-755 -> `NonceCache::refresh`, `src/internal_cache/mod.rs`
   224-245) marks the identity nonce AND every identity-contract nonce of that identity stale (timestamp 0), so the next facade
   write fetches both again. `settings: { identityNonceStaleTimeS: 0 }` is weaker: `get_or_fetch_nonce` (same file, 284-288)
   treats an entry as stale only when `last_fetch_timestamp < now - 0`, i.e. fetched in an earlier second, so a retry within the
   same second reuses the cached nonce. Both keep `max(cached, platform)` (335), so neither can lower a nonce, and neither helps
   when the re-fetch itself hits a lagging node. Live (`scripts/live-writer.ts u6 cache`, `scripts/results/live-writer-cache.json`):
   after a write that bypassed the cache, a facade create without a refresh signed the spent nonce ("nonce already present at
   tip"); with `identityNonceStaleTimeS: 0` (cache fetched seconds earlier) and after `refreshIdentityNonce` it succeeded. Of
   two earlier runs without the 10 s pause after the bypassing write, one timed out on that create (transport, nothing stored)
   and one was refused with `identityNonceStaleTimeS: 0` ("nonce already present at tip"); that the pause fixed it points to a
   re-fetch from a lagging node, which this run does not prove. The document writer
   does not depend on the cache at all: it reads `identities.contractNonceWithProof` (a direct proved fetch,
   `getIdentityContractNonceWithProofInfo`) and passes `identityContractNonce` itself; `addKeys` (SDK-built IdentityUpdate) calls
   `refreshIdentityNonce` after a spent-nonce refusal.
6. Right after `connect()`, `sdk.version()` can still report the SDK's starting protocol (13) on testnet (PV14); it ratchets up
   after the first response. The writer takes the protocol from the proved nonce read's `metadata.protocolVersion`, because the
   create id rule differs (PV13 sha256d(contract || owner || type || entropy); PV14 also the nonce).

## Document writer (`evo.ts` `writeDocument`)

Each write is a batch transition built and signed once per nonce (`DocumentCreate/Replace/DeleteTransition` +
`BatchTransition.fromBatchedTransitions`, nonce = proved identity-contract nonce + 1), broadcast with
`stateTransitions.broadcastAndWait`, and settled by proved state when the outcome is not a clean success:

| Outcome | Action |
|---|---|
| `nonce too far in future`, 40101, ambiguous (timeout, transport, `ExecutionNotProved`, `tx already exists in cache`) | re-send the SAME signed transition |
| `nonce already present in past / at tip`, `nonce too far in past` | sign again with a fresh proved nonce; a create only once a proved nonce read shows the nonce used and a later proved read shows its own id absent (no second document) |
| any other consensus refusal, or a local SDK error before sending (`InvalidArgument`, `SerializationError`, ...) | create / delete: final on the first send; replace (an earlier call may have landed), or any write after an earlier send: done only if proved reads (with backoff) show the write |
| a proved read shows a replace can no longer apply (another revision or other data) | fail with that message |

No new send starts after 2 minutes (document writes and `addKeys`); the settle reads still run, and the final error says
whether the write may still appear. Only a consensus refusal of a first send is final without a read: a local SDK error
(`SerializationError`, ...) can be raised after the transition executed (result conversion in `broadcastAndWait`), so it is
settled by proved reads before it is reported.

Done means: create, a proved read finds the id it signed; replace, `$revision === revision + 1` with exactly our fields; delete,
the document was found by a proved pre-read at height H0 (a document already gone fails fast) and a proved read shows it absent at
a height > H0. Live check: `npx vite-node scripts/live-writer.ts [u3|u6|owner]` (results in `scripts/results/live-writer.json`).

## Live testnet results (`scripts/results/live-testnet.json`, `apps/web/e2e/results/auth-live.json`)

| Step | Result |
|---|---|
| Create from external DASH (QR address) | IS-lock 1.1 s after broadcast, identity in 10 s end to end; create fee 0.00106604 DASH (3 keys) |
| Voucher (burn at vout 1) | chain-lock proof, about 2 to 6 min waiting for Platform's ChainLock; fee 0.00106400 |
| Top-up | IS-lock proof, 9 s; fee 0.00008021 |
| Vault entry write | 0.00053329 |
| Add keys 3..5 | 0.00073962 |
