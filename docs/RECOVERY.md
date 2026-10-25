# Recovering DASH stuck during sign-in and funding

govhub creates and tops up Dash Platform identities from DASH that a user sends to a **one-time deposit address**. The browser watches
that address over DAPI, locks what arrives in a type-8 asset lock and registers the lock on Platform (`packages/auth/src/funding.ts`).
When something interrupts this, the DASH stays at the one-time address or in an asset lock that Platform has not used yet. The user's
recovery phrase (or key) controls it, but no ordinary wallet shows it.

This document covers:

- where funds can get stuck, and what gets them out;
- the derivation paths, so other tools can find the same keys;
- what other wallets can and can't see;
- what support can and can't do.

The operator never holds a user's keys. Recovery runs in the user's browser, from the phrase or key.

## The Recover tool (Settings, "Recover funds")

It works on any device, from the chain alone: it reads nothing from this browser's storage (`packages/auth/src/recovery.ts`,
`apps/web/src/auth/Recover.tsx`). The tool is also linked from funding errors, from late-payment notices, and from the sign-in sheet
whenever this browser knows of recoverable funds.

1. **Keys.** The tool takes the signed-in account, a recovery phrase, or a pasted key, and derives the public keys of govhub's
   one-time keys (see [Derivation paths](#derivation-paths)). It derives a private key only when the user acts on that key, and wipes
   it straight after. When the user is done, or the section closes, the tool wipes the phrase.
2. **Scan.** A bloom filter holds every key's hash160 and public key. DAPI has no address or UTXO lookup, so
   `subscribeToTransactionsWithProofs` replays the history from a start height to the tip in 5,000-block chunks, one node per chunk;
   a chunk that fails is replayed on another node.
   - **Default start:** the height just before govhub could first take a payment on that network (testnet 1,577,000; mainnet
     2,560,000).
   - **Older starts:** the user can pick "the last 30 days", "the last year", or a block height. An older start finds funding of the
     same paths by other wallets, at the cost of time (testnet replays about 140 blocks a second).
   - **Gap limits:** account setups run to five unused indexes past the phrase's last identity or last used index; each identity's
     top-ups run to five past the last used one. The tool scans another gap past that up front, so ordinary use needs only one pass.
3. **Proof.** A transaction counts only if:
   - its bytes hash to a txid that a merkleblock of the stream proves (the partial merkle tree reaches the header's root, the same
     standard as the funding watcher), and
   - a second node, one that did not serve the replay, does not contradict it (by not knowing it, or by saying it isn't mined).

   A chunk whose stream ends before every block it asked for is replayed on another node, so a lazy or hostile node can't make the scan
   look complete; the summary says up to which block it got. Block headers are not checked against proof of work, so the guarantee is
   "proven by one node's merkleblock and not contradicted by another", not a full SPV proof. Payments still in the mempool appear once
   they are mined ("Scan again").
4. **Items.**
   - **Unspent payments** to a key: every proven output, minus every proven spend.
   - **Type-8 asset locks** whose credit output pays a key. For each, the tool checks Platform's proved state (a path query of Drive's
     spent-asset-lock tree, root key 72, by outpoint: `PlatformPort.assetLockStatus`). The state is unused, used, or partly used.
     Fully used locks only appear as a count.
5. **Actions, per item.**
   - **Send to a Dash address** (payments only). A P2PKH-signed transaction to any P2PKH or P2SH address on the same network. A
     mainnet address is refused on testnet, and the other way round. The fee (1 duff/byte) and the amount are shown before sending.
     The tool refuses a sweep that would leave dust, and it holds the funding record's Web Lock while it sends.
   - **Create the account** (account-setup keys whose identity index is free, at least 0.002215 DASH locked), or **top up any
     identity** (at least 0.000505 DASH locked). A top-up key only tops up the identity it was made for. Both go through `runFunding`
     with the record rebuilt from the chain (`restore`):
     - payments are locked first;
     - a lock is registered with a ChainLock proof;
     - a closed tab resumes like any funding.
   - **An asset lock can't be sent back to a Dash address.** Its DASH is burnt into Platform credit. It can only become credit in an
     identity.
   - **Advanced: export the one-time key as WIF.** This sits behind a warning and a checkbox, is masked until shown, and is never
     logged or stored. See [Other wallets](#what-other-wallets-see).

Acting on an item is safe to repeat:

- A swept payment can't be spent twice: the network refuses the second spend.
- Platform refuses an asset lock it already used, without a fee. The tool checks the lock's state again right before using it.

## Audit: where DASH can get stuck

"This browser" means the funding record in localStorage (`storageFundingStore`). It holds public data only: txids, the signed lock and
the IS-lock. "Recover" means the tool above, from the phrase or key on any device.

| Situation | What happens | Recoverable before | Now | Needs this browser's storage |
|---|---|---|---|---|
| Account setup with a phrase, interrupted at any step | The record resumes once the same phrase is entered again: replay from its start height, the stored lock and IS-lock. | Only in the same browser | Same browser: resumes. Any device: Recover finishes the account or tops up any identity (or sweeps payments not yet locked). | No |
| Top-up with a phrase, interrupted | As above (key `m/9'/c'/5'/2'/i'/n`). On a new device the next top-up starts again at index 0: the same address, watched only from the tip. | Same browser only | Recover tops up the identity, or sweeps. | No |
| Top-up with a pasted key | The one-time key is `HMAC(session key, …)`, which no other wallet derives. | Same browser, with the same key pasted | Recover with "a private key I signed in with" (or while signed in with it): sweep, or top up that identity. The key must still be an active login key of the identity, because the tool finds the identity by it. Without the key, nobody can recover it. | No (the key is needed) |
| Payment below the minimum | The funding waits ("still need X"); the QR asks for the rest. | Pay the rest, same browser | Pay the rest, or Recover: sweep it, or top up an identity if it covers a top-up. | No |
| Overpayment | Every counted payment is locked. The extra becomes credit in the identity's balance. | Nothing lost | Nothing lost. The deposit screen now says so. | No |
| Several payments | Every IS-locked or mined payment above 148 duffs is locked, up to 100 inputs. The rest (unconfirmed at lock time, dust, past 100) is reported as late. | Late part: notice only | Late part: Recover. | No |
| Payment after the lock | Reported as late; it stays at the address. The old notice said "move it with a wallet", which no standard wallet can do. | No working path | Recover sweeps it or tops up an identity. The notice now links to Recover. | No |
| Lock broadcast but rejected (a payment double-spent) | Rebuilt from the payments that still count, at most three times, then an error. A payment that a confirmed transaction spends no longer counts (new). | Payments: same browser | Recover shows whatever is still unspent. | No |
| No IS-lock seen | After 60 s the funding switches to a ChainLock proof at Platform's chain-locked height. Closing the tab while a lock is in flight now asks first (`beforeunload`). | Same browser | A mined, unused lock: Recover registers it with a ChainLock proof. | No |
| Platform refuses the proof | IS-lock refused: ChainLock proof. Too small (10530): `LockTooSmallError`, which can top up an existing identity. Other refusals: the error and "Try again". | Too small: same browser | Recover, any device. | No |
| Identity keys already registered (key conflict) | The identity index already has an identity (made on another device). Before, the error sent users to "support", who can't do anything. Now `KeyConflictError` offers a top-up of an identity right there. | No | In the panel, or Recover. | No |
| localStorage cleared, new device mid-flow | A new record watches only from the current tip. Payments and locks made earlier at that address are invisible to it. | No (only by deriving keys by hand) | Recover finds them. | No |
| Two tabs | One Web Lock per record: the second tab says "already running in another tab". The Recover sweep takes the same lock. Without Web Locks, both tabs build identical lock bytes (RFC 6979), so nothing is paid twice. | n/a | n/a | n/a |
| Network or profile switch mid-flow | Records are keyed per network. A running funding keeps the network it started on; it resumes on that profile. | Same browser, same profile | Recover scans the current profile's Platform network and says so. Funds on the other network show after switching. | No |
| Wrong-network send | Deposit addresses carry the Platform network's prefix: `y…` on testnet (version 140), `X…` on mainnet (76). A wallet refuses an address of the other network (Base58Check version byte), so a cross-network send can't happen with a standard wallet. The "Dev" profile (mainnet proposals, testnet Platform) shows a testnet address; the deposit screen now says "testnet address: send testnet DASH only". Sweep destinations are checked the same way. | n/a | n/a | n/a |
| Tab closed while waiting for the payment | The record stays and the pending list offers "Continue". A payment made while no tab watched is found by replaying from the record's start height. | Same browser | Recover, any device. | No |
| Starter voucher | The faucet's lock credits the voucher's key, not the user's; redeeming creates the identity with the user's keys. A failed voucher is not the user's to spend elsewhere (`LockTooSmallError`, recoverable = false). Not scanned by Recover. Owned by the `starter-tokens` work. | n/a | n/a | n/a |
| Phrase or pasted key lost | Nobody can recover it, govhub included. That is the design: govhub never holds keys. | No | No | n/a |

**Limits of the scan**

- A DAPI node could hide a payment or a spend. Hiding a payment means it doesn't show, so scan again (other nodes serve other chunks).
  Hiding a spend means an already-spent payment shows as unspent; the network then refuses the sweep, and nothing is lost.
- Only merkle-proven payments are shown. The block header's proof of work is not checked; the second-node cross-check stands in for it.
  A forged payment can't be spent, and a forged lock is refused by Platform, which checks Core itself.

## Derivation paths

Every one-time key is secp256k1. Its address is P2PKH of its compressed public key. The coin type is `5'` on mainnet and `1'` on
testnet. The phrase is BIP39 English with **no passphrase**.

| Key | Path / rule | Used for |
|---|---|---|
| Account setup (registration funding) | `m/9'/coin'/5'/1'/i'`: identity index `i`, hardened | The deposit address and asset lock of a new identity at index `i` (its auth keys are `m/9'/coin'/5'/0'/0'/i'/k'`) |
| Top-up | `m/9'/coin'/5'/2'/i'/n`: identity index `i` hardened, top-up `n` not hardened (key-wallet `IdentityTopUp { registration_index }`, DIP-13) | The n-th top-up of identity `i` |
| Top-up with a pasted key | `HMAC-SHA256(key = the 32-byte signed-in private key, msg = "govhub/topup/v1" ‖ identity id (32 bytes) ‖ u32be(n) ‖ u8(ctr))`, `ctr` = 0, then 1, … until the result is a valid private key | The n-th top-up while signed in with a pasted key (no phrase). Only govhub derives it. |

> **Note for maintainers (pre-mainnet decision).** DIP-13 lists the registration funding level as a plain `identity index`
> (`m / 9' / coin' / 5' / 1' / identity index`; [dips@a4d46dd dip-0013.md](https://github.com/dashpay/dips/blob/a4d46dd/dip-0013.md)).
> key-wallet, the library behind Dash Evo Tool and the iOS develop branch, derives it non-hardened:
>
> - its registration pool is `AddressPoolType::Absent`, which uses `from_normal_idx(index)`;
> - see `key-wallet/src/managed_account/address_pool.rs` and `managed_account_type.rs` at rust-dashcore e4208c9.
>
> govhub's `registrationFundingPath` hardens it (`…/1'/i'`), so wallets that scan registration funding keys never derive govhub's
> account-setup keys. The top-up path matches. Changing it moves every account-setup address. Testnet records and funds at the old
> addresses would then need a legacy lane in the Recover tool. Decide before mainnet.

## What other wallets see

Checked in source at these commits, read without running them:

- DashSync iOS d3c1497
- dashj 0732897
- dash-wallet (Android) cdaf542
- dashwallet-ios fe19bd3
- Dash Core 6dedab5
- Dash Evo Tool 4c38d4c, with rust-dashcore e4208c9 and platform 9f7ed16

What they show:

- **Plain payments to govhub's one-time addresses: no standard wallet shows or spends them**, even after restoring the same phrase.
  - DashSync and dashj build their balance only from their BIP44 fund accounts; their identity funding keys are not counted as
    spendable.
  - Dash Core's wallet derives the DIP-9 funding paths only on demand for Platform signing, and never scans them.
  - key-wallet (Dash Evo Tool) puts identity funding addresses in its filter, but checks ordinary payments only against fund accounts.
- **Asset locks crediting govhub's keys:** only key-wallet based wallets (Dash Evo Tool) match type-8 locks to identity funding keys.
  They do so only for keys in their pools: the non-hardened registration path (so not govhub's account setups, see the note above)
  and top-up accounts they provisioned. Treat any other wallet showing a govhub lock as an exception.
- **Exporting the one-time key** (the Recover tool's advanced option, WIF) is the way to use another wallet. Before it shows the key,
  the tool warns that anyone holding the WIF can take the payments at that address and use an unused asset lock that credits it. The
  key controls nothing else: it is not an identity key.
  - **Dash Core:** `importprivkey` works for legacy wallets. For descriptor wallets, its help points to `importdescriptors` with
    `combo(<WIF>)`. Dash Core has no `sweepprivkeys`.
  - **Dash Wallet for Android:** has a sweep screen that takes a WIF (`SweepWalletFragment`).
  - **DashSync:** has a `sweepPrivateKey` call, but no caller in dashwallet-ios.

So: **to get DASH out of a govhub deposit address, use govhub's Recover tool, or export the key into a wallet that can sweep a WIF.**
Restoring the phrase in another wallet is not enough.

## Support playbook

Support has no keys, no server-side wallet, and no way to move, refund, reverse or "claim" a user's DASH or Platform credits. Never ask
for, accept or look at a recovery phrase, a private key, a WIF or a voucher link. Anyone who does is not govhub support.

What support can do:

1. **Point the user to Settings → Recover funds** (`/settings#recover`) on the network the payment was made on: switch the profile if
   needed. They enter their recovery phrase, or the key they signed in with, on their own device.
2. **Explain the outcomes:**
   - **Payments not yet used:** send them to any Dash address of that network, or use them for the account or a top-up.
   - **Asset lock:** it is already on Dash Platform and can never go back to a Dash address. It can create the account (if big enough
     and that account doesn't exist yet) or top up any identity (a top-up key's lock: its own identity).
   - **"Already used on Dash Platform":** the lock did its job. Check the identity's balance.
   - **Nothing found:**
     - the payment is not mined yet: wait a few minutes and scan again;
     - it went to another network;
     - it was paid earlier than the default start: pick an older start;
     - it was paid while signed in with a different key or phrase.
3. **Check public facts with the user** (txid, address, block) on a block explorer. These are public and need no keys.
4. **Escalate bugs** (a scan that keeps failing, an item that can't be used) with public data only: txid, address, network,
   the error text.

What support can't do:

- recover a lost phrase or key;
- undo a payment to a wrong address;
- move asset-lock credit back to Core;
- move credits between identities.

Starter vouchers belong to the faucet's own flow.

## For developers: adding a one-time key family

`scanForFunds({ families })` takes key families (`KeyFamily`), `DEFAULT_KEY_FAMILIES` plus any others. A family maps the secret
(`{ wallet }` or `{ session }`), the network and the phrase's identities to lanes. Each lane has:

- `derive(index)`
- `path(index)`
- `gap`
- an optional `minIndexes`
- `funding(index)`: `null` for sweep-only payments, or how runFunding should use them.

A later feature with its own one-time deposit key, such as a proposal fee, plugs in by appending its family. Its payments then show in
the Recover tool and can be swept.

`packages/auth/scripts/live-recovery.ts` runs the scan from Node against testnet (`GOVHUB_PHRASE_FILE=…`), printing public data only.
