# Sign in with a Dash wallet (App Connect)

govhub can sign people in with the DashPay mobile wallet, using App Connect
([DIP pasta-app-connect](https://github.com/dashpay/dips/pull/181), response contract
`H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ` from Platform protocol 14). It ships **off** on every profile.

## Turning it on

For everyone on a profile, flip one line in `apps/web/src/config/registry.ts` and deploy:

```ts
// PROFILES.mainnet
appConnect: { enabled: true, appId: MAINNET_FORUM.contractId },
```

For one browser tab without a deploy, open any page with `?appconnect=1` (for example
`https://gov.dashhq.org/?appconnect=1`). It lasts for that tab's session; `?appconnect=0` turns it off again. The opt-in only works
while the forum contract in Settings is the profile's own (`appId`); a key bound to it could not write to another forum contract.

With the flag off and no opt-in, nothing changes: the "Sign in with a Dash wallet" button stays disabled ("Coming soon"), and the
App Connect code (a separate chunk) is never fetched. Nothing needs provisioning: the forum contract and the response contract are
already on mainnet.

## What the request asks for

`dashpay://connect?v=2&n=m&r=<base64url body>` (no return link), with:

| Field | Value |
| --- | --- |
| `appId` | the profile's forum contract (mainnet `4EcYtwedNjTm4iGmx47GkLX2uNkCUWS4tt1KHhgGkjR3`) |
| label | `govhub` |
| `AUTH_BINDING` | one: `singleContract(forum)` at HIGH, proposed budget 0.1 DASH (1e10 credits), proposed expiry 90 days |
| `CONNECTION_ID` | 16 random bytes per browser and network (localStorage `govhub.appconnect.connection.<network>`) |
| `CREATED_AT` | now |

No `IDENTITY_HINT`, no CRITICAL, no `ENC_BINDING`. Every forum document type requires HIGH, so the one key can write comments,
reactions, posts, profiles and block lists, and nothing else: no credit transfers, no other contract, no key changes.

## What the page does

1. Makes a fresh ephemeral secp256k1 key (memory only) and shows the request as a QR code and an "Open in DashPay" link.
2. Polls `loginKeyResponse` by `hash160(appEphPub)` with proved reads, `$ownerId` ascending: every 2 s for a minute, then every
   4 s, at once when the tab regains focus. It gives up after 10 minutes or more than 20 candidates.
3. Verifies each answer against every rule of the DIP's "App Processing of connect": it decrypts under the envelope (the AAD binds
   it to the request and the owner); every slot is an enabled key of `$ownerId` (by point for ECDSA_SECP256K1, by hash160 for
   ECDSA_HASH160); the key is bound to exactly the requested contract, at HIGH, with a budget and an expiry; nothing is MASTER,
   unbound, of another purpose or unrequested; the primary binding is granted; nothing expires within an hour of the latest block
   time and the budget has credits left. A key the page's node does not show yet is looked for again for 30 seconds.
4. Asks "Continue as <DPNS name or id>?" with the budget and the expiry, because anyone who sees a request can answer it. Several
   identities answering are listed to choose from; "Not me" drops one and ignores its later answers to the same code. Answers
   already shown stay on screen if the code then expires or gets flooded.
5. Signs in with the session key through the existing document writer. The key stays in the tab's memory; it is not shared with
   other tabs (they rebuild sessions through key sign-in, which refuses bound keys) and is wiped on sign-out. So a reload or a
   second tab asks the wallet again, and registers another key on the identity; the wallet may retire the previous one, since
   every tab of a browser sends the same `CONNECTION_ID`.

If the wallet revokes the key (or retires it for a newer one), Platform refuses whatever it signs next ("Identity key N is
disabled"); the document writer also refuses before broadcasting when its identity read shows the key disabled. Every write goes
through the wallet session's signer (`apps/web/src/session/authSession.ts`), which recognises that refusal by its shape
(`session/keyDisabled.ts`), logs the raw error to the console, signs the tab out (wiping the key) and shows one banner, "Your
wallet session has ended. Reconnect with App Connect to continue.", whose Reconnect button opens the App Connect sign-in again. No
session is restored at startup (the key lives in the tab's memory only), so there is nothing to check then.

A wallet session cannot top up, add a passkey, pay for or submit a proposal (each derives from or stores the signing key, which is
temporary), request a masternode badge (it posts to the badge contract, so the token could never be posted), or open a saved
masternode keyring. Those views say why instead, and a write to any contract but the forum
is refused before it reaches Platform, so a misrouted write never spends the key's budget.

Fixture mode (`?fixtures=1&appconnect=1`) answers the request with a simulated wallet through the real verifier, for demos and the
end-to-end tests.

## Code

- `packages/auth/src/appconnect/`: request codec and URI, envelope, verifier, poller, the evo-sdk port, and govhub's request.
  Tests: `packages/auth/test/appconnect-*.test.ts`, including the DIP's vectors byte for byte.
- `apps/web/src/auth/WalletSignIn.tsx` (the lazy view) and `walletDemo.ts` (fixture mode's wallet).
- Flag: `appConnect` on each profile in `apps/web/src/config/registry.ts`, with `appConnectOptIn` and `appConnectEnabled`.
- End to end: `apps/web/e2e/app-connect.spec.ts`; screenshots in `apps/web/screenshots/app-connect/`.
