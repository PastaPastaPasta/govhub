# Privacy

This page covers the servers the govhub project runs itself:

| Address | What it does |
|---|---|
| `gov.dashhq.org` | The website (the app you load in your browser) |
| `gov-bridge-mainnet.dashhq.org`, `gov-bridge.dashhq.org`, `gov-bridge-testnet.dashhq.org` | Bridges: they read governance data from a Dash Core node and serve it to the app |
| `gov-relay.dashhq.org`, `gov-relay-testnet.dashhq.org` | Relays: they pass masternode votes and new proposals on to the Dash network |
| `gov-issuer.dashhq.org`, `gov-issuer-testnet.dashhq.org` | Badge issuers: they hand out the "MN" badge to masternode owners |

You can replace the bridges and relays with servers someone else runs (Settings > Advanced), and choose other badge
issuers (Settings > Masternode badges). If you do, those servers follow
their operator's rules, not this page. The same goes for the Dash network itself: the evonodes, Platform nodes and other
public infrastructure the app talks to are run by other people, and this project has no say over them.

## Summary

- We don't keep accounts. You sign in with a Dash Platform identity, which lives on the Dash network, not with us.
- The app sets no cookies and has no analytics or tracking code.
- Your recovery phrase and private keys never leave your browser unencrypted, and we never receive them.
- Our servers see your IP address when your browser talks to them, like any website. Our code doesn't write IP addresses
  to disk or to logs.
- What you post on Dash Platform (comments, reactions, your profile, badges) is public, signed by your identity, and
  copied by every Platform node. We can't take it back for you.
- If you vote through our relay, it sees how your masternodes voted before the rest of the network does.

## What stays in your browser

Your recovery phrase or key is held in memory while you're signed in. It's never saved to disk. If you have several govhub
tabs open, they pass it to each other in memory, so a new tab doesn't ask you to sign in again. Closing the last tab or
restarting the browser signs you out.

Some things are saved in the browser's local storage so the app works the next time you open it:

- your settings (which servers to use, the theme, the badge issuers you trust, the block lists you follow);
- proposal drafts and the details of a payment you're waiting on, such as the deposit address (no keys);
- a cache of public data the app has already checked, so it doesn't download it again;
- encrypted records: votes you're following, and badge requests in progress. The key to open them comes from your own
  signing key, so they're unreadable without it.

Signing out clears the session, but not this saved data. Some of the saved items are named after your identity, so
someone with access to your browser can tell which identity was used there. To remove all of it, clear the site data
for gov.dashhq.org in your browser's settings.

If you use a passkey, the encrypted copy of your keys is stored on Dash Platform, and only your passkey can open it.

## What is public on Dash Platform

Dash Platform is a public database run by the Dash network. When you post something there, anyone can read it, and it's
tied to your identity.

| What | Public? | Can you remove it? |
|---|---|---|
| Comments | Yes | You can retract a comment. It can't be edited. Anyone who already copied it keeps their copy |
| Reactions, your profile, owner posts on your proposal | Yes | Yes, you can change or delete them |
| Your block lists | Yes | Yes |
| Masternode badges | Yes. It says "MN · vouched by X", not which masternode | No. Badges can't be deleted |
| Your keyring and passkey backup | Encrypted. Others can see that it exists, roughly how big it is, and when it changes | Yes |

Writing to Platform costs a small fee, paid from your identity's balance. Nobody at govhub sees or handles that money.

## What each of our servers sees

### The website

The app is a set of static files hosted on GitHub Pages, with Cloudflare in front of it. GitHub and Cloudflare see your IP
address, the pages you load and when, under their own privacy policies. The app adds no analytics, and its security
policy blocks scripts from other sites, including Cloudflare's own analytics script.

### Bridges

A bridge serves proposals, votes, the masternode list and vote counts. It sees your IP address and which proposals you
look at. After you vote, the app asks it every so often whether your vote has arrived, so it can see which proposals you
voted on.

Our bridges write no per-request logs. They store public governance data only: proposals, signed votes, masternode lists
and vote counts. That archive is kept for good, because Dash Core throws old votes away and the archive is the history.

### Relays

The relay passes your signed votes to the network. If you choose "Spread out", it holds them and sends each one at a
random time before the deadline you set, so your masternodes' votes don't all appear at once. It never sees your keys and
can't change your vote. It does see:

- your IP address;
- which masternodes voted, how they voted, and which ones were sent together;
- when you sent them. The relay stores the arrival time rounded down to the hour, but each vote also carries the exact
  time it was signed, which the relay keeps and the network shows once the vote is public.

A vote is kept until it's sent, which can be up to 40 days if you schedule it that far ahead, and is deleted 7 days after
it's done (sent, cancelled or replaced). The relay doesn't store IP addresses. Use several relays, or Tor, if you don't
want one operator to see all of this.

When you submit a proposal through the relay, it holds the proposal until the block with its fee payment is ChainLocked
(usually within a few minutes on mainnet), then submits it. The network makes the proposal live once the fee is 6 blocks
deep (about 15 minutes), and the relay checks then that its Dash Core has it. Proposals are public as soon as they're
submitted anyway.

### Badge issuers

To get a badge, your browser asks the issuer to sign a token, and proves the request comes from a masternode by signing
it with the masternode's voting key. The issuer sees which masternode asked, when, and from which IP address.

The token is signed "blind": the issuer can't see the token it signs, so it can't recognise the badge when it later shows
up on your identity. It could still guess by timing, if a badge appears right after a request. The app makes that harder:

- it waits until nothing has been posted from your browser for half an hour, plus a random extra wait, before asking;
- in Standard mode, the badge is posted with your next post, comment or reaction, at least half an hour after the request;
- in Private mode, it's posted at a random time in the first few days of the next badge period (about 3.5 days on
  mainnet), and only once enough other badges exist to hide among.

"Register now" skips the waiting, and then the issuer can match your badge to your masternode.

Our issuer keeps only what it needs to stop a masternode getting two badges in one period: which masternode asked, and
a scrambled fingerprint of its request that can't be traced to the badge. No times, no IP addresses. These records are
deleted once the period is over, at most about two months after the request on mainnet. Its logs are hourly totals. After each period it
publishes how many badges it signed. You can't check any of this from outside. The issuer's
[logging policy](../services/issuer/README.md#what-is-stored-and-logged-logging-policy) lists exactly what it keeps.

### Logs and backups

- Our servers write start-up messages, routine status lines and errors, without IP addresses or what was requested. Old log lines are
  deleted as new ones fill the space set aside for them.
- The Cloudflare connection that links our servers to the internet (a tunnel) logs only fatal errors.
- The bridge archive is backed up daily, and backups are kept for 30 days. The relay and issuer databases are not
  backed up.
- Cloudflare sees every request to our addresses at its edge (IP address, address requested, time). That's outside our
  code, and covered by Cloudflare's privacy policy.

## Other services your browser talks to

Even with all our servers replaced, the app talks to parts of the Dash network directly. Nobody in this project runs them:

- **Dash evonodes**, the network's servers that answer apps' questions about the blockchain. Used to fetch
  transactions and blocks, check proposal fees, and send transactions. They see your IP address and which transactions
  you look up.
- **Dash Platform nodes.** Used for everything stored on Platform. They see your IP address, what you read, and what you
  write.
- **Dash's quorum list service** (`quorums.mainnet.networks.dash.org`). Gives the app the list of evonodes to talk to
  when it starts.
- **CoinGecko.** Gives the DASH price in US dollars, on mainnet. You can turn it off in Settings.

## If you run masternodes


- A comment that says how you voted can be matched against your masternode's public votes.
- Asking for badges with several masternodes from one identity tells the issuer they belong together.
- Don't fund your govhub identity from a wallet tied to your masternode.
- Votes and proposals become public on the Dash network once they're sent. The relay only controls when.

## Changes

This page lives in the govhub repository, so every change to it is in the
[history](https://github.com/PastaPastaPasta/govhub/commits/main/docs/privacy.md). If something here doesn't match what
our servers do, please [open an issue](https://github.com/PastaPastaPasta/govhub/issues).

For the technical version, with the code behind each statement, see [the trust model](TRUST.md), section 7.
