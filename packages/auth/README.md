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

## Live testnet results (`scripts/results/live-testnet.json`, `apps/web/e2e/results/auth-live.json`)

| Step | Result |
|---|---|
| Create from external DASH (QR address) | IS-lock 1.1 s after broadcast, identity in 10 s end to end; create fee 0.00106604 DASH (3 keys) |
| Voucher (burn at vout 1) | chain-lock proof, about 2 to 6 min waiting for Platform's ChainLock; fee 0.00106400 |
| Top-up | IS-lock proof, 9 s; fee 0.00008021 |
| Vault entry write | 0.00053329 |
| Add keys 3..5 | 0.00073962 |
