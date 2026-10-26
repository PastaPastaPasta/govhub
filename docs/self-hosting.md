# Running your own govhub servers

govhub's servers are only the defaults. Anyone can run their own and point the app at them, or hand out a link that does it
for other people. Reasons you might:

- You'd rather not rely on us. Your browser already checks most of what our servers send, but a server can still leave
  things out (see [what we can and can't lie about](TRUST.md)).
- You want your masternode votes to go through a relay you control.
- You want a second source for governance data, or a copy that keeps working if ours go down.
- You run a community and want to vouch for masternode owners with your own badge issuer.

This page explains what each server does, how the app uses servers you add, and where the setup instructions are.
The hands-on guide is [`deploy/README.md`](../deploy/README.md).

## The pieces

| Server | What it does | What you need | Costs DASH? |
|---|---|---|---|
| **Bridge, archive only** | Serves proposals, signed votes, the masternode list and chain proofs from your own Dash Core node | Dash Core v24 with `txindex`, Docker, about 150 GB of SSD and 4–8 GB of RAM for mainnet | No |
| **Bridge, publishing** | All of the above, and it writes proposals and vote counts to Dash Platform, under your own contract | As above, plus a Platform identity | About 0.27 DASH to register the contract, then about 0.5 DASH a year |
| **Relay** | Sends masternode votes and new proposals to the Dash network, at once or spread out over time | Dash Core with `txindex` (it can share the bridge's node) | No |
| **Badge issuer** | Signs the tokens behind "MN · vouched by …" badges | Dash Core, a Platform identity, and an offline machine for its signing keys | A little, for publishing its keys and monthly reports |
| **The app** | The website itself | Any static web host with HTTPS | No |

One Dash Core node can serve a bridge, a relay and an issuer at the same time. Our own setup runs all of them on one
machine (deploy/README.md, section 13).

## What it costs

Here is what running govhub's own servers on mainnet has cost so far, from our records. Your numbers will be close if you
run the same pieces.

**One-time, in DASH** (October 2026):

| What | Cost |
|---|---|
| Registering the four contracts (governance, forum, badge, moderation) | 1.057 DASH |
| Creating four Platform identities (admin, bridge, moderation, badge issuer) | 0.004 DASH |
| Publishing the badge issuer's keys for 14 months | 0.004 DASH |
| The bridge's first publish (29 proposals, the vote counts, 2 budget records) | 0.023 DASH |

Contract registration is most of it. Someone running only a publishing bridge needs just the governance contract
(about 0.27 DASH), and an archive-only bridge or a relay needs none.

**Ongoing, in DASH:**

| What | Cost |
|---|---|
| Bridge, publishing vote counts every hour and budget records every 6 hours | about 0.5 DASH a year (an estimate: about 0.001 DASH a day, plus about 0.0009 DASH for each new proposal) |
| Badge issuer: one report a month, and a new set of keys each year | about 0.01 DASH a year |
| Relay, archive-only bridge | nothing |

These fees go to the Dash network, not to anyone in particular. If the bridge's balance runs out, it stops publishing
but keeps everything else running.

**The machine.** All of our servers run on one small Linux machine: 6 CPU cores, 16 GB of RAM and 250 GB of disk, of which
they use about 3 GB of RAM and 60 GB of disk with both mainnet and testnet running. A rented server of that size, or a
smaller one with 4 cores, 8 GB of RAM and 150 GB of SSD for mainnet only, is enough. The website itself is hosted for
free on GitHub Pages, with Cloudflare in front.

## How the app uses servers you add

You can list several servers of each kind. What the app does with them depends on the kind, and it's not always
"ask all of them".

### Bridges: one at a time, in your order

Proposal lists and vote counts come from the first bridge in your list that's on the right network and serves the right
governance contract (see below). If that bridge stops answering, the app moves on to the next one. The bridge used to
check votes and the masternode list is picked the same way when a page loads, and kept until you reload.

The masternode pages are simpler: finding your masternodes, reading their current votes, checking whether a vote has
arrived, and offline signing all use the first bridge in your list, with no checks and no backup. So keep a working bridge
for the right network at the top.

**The app doesn't compare bridges with each other or merge what they send.** If two bridges disagree, you'll only see
the first one's answer. To get a second opinion, put your own bridge first. The one exception: after you vote, the app
also asks the second and third bridges in your list whether they've seen your vote, and shows which ones did.

Proposals and vote counts are read from Dash Platform first, with proofs. The bridge supplies the signed votes behind
each count, the masternode list, and anything not yet published to Platform (marked as "reported" in the app).

### Which bridges fit

A bridge is used only if its `/v1/status` reports:

- the same Dash network (mainnet or testnet) as the profile you're on, and
- the same governance contract as the one the app reads, or no contract at all.

An archive-only bridge reports no contract, so it fits any profile on its network. That makes it the easiest thing to
run: it can't publish anything, but the app can use it for votes and the masternode list, and it's a good check on ours.

A publishing bridge has to have its own contract. The governance contract only lets its owner write to it, so nobody else
can publish into ours. To use someone's publishing bridge, you switch the app to their contract (Settings > Advanced >
Networks), and then the proposal list and vote counts come from what they published.

Comments, reactions and profiles live in a separate contract (the forum contract) and are keyed by the proposal's hash, which is the same
on every bridge. Switching governance contracts doesn't hide the discussion.

### Relays: one relay per vote

Each vote goes to one relay. The app picks among the relays you list (healthy ones first, in random order), and only
tries the next if one fails. Listing several relays spreads your votes across operators, so no single one sees all of
them, and keeps voting working if one is down. A relay that reports the wrong network is tried last, and refuses votes for a network it isn't on.

### Chain proofs

To check the chain quickly, the app asks for a proof that the current Dash quorums descend from a checkpoint built into
the app. The app checks each proof against that checkpoint, so a dishonest source can't fake one. All it can do is not answer. The app tries the sources in order
and falls back to checking proof of work if none answers. A bridge on Dash Core v24 serves these proofs.

Adding a bridge in Settings doesn't make it a proof source. Proof sources are set through an imported settings file or a
settings link (below).

### Badge issuers: each badge names who vouched

The badge issuers you trust are a separate list (Settings > Masternode badges). Each trusted issuer that vouched for an
identity shows its own chip: "MN · vouched by X". Badges from different issuers aren't added up.

All issuers publish into the same shared badge contract, so your issuer needs no contract of its own: just a Platform
identity and its published keys. Issuers aren't part of an exported settings file; people add yours by name, identity
and address.

### Block lists

The default block list is ours. In Settings you can turn it off, and follow anyone's block list by their identity, with
no server involved.

## Pointing the app at your servers

Everything is under **Settings > Advanced: choose your own servers**:

- the networks and governance contract;
- bridges (address, and the contract and identity they publish under);
- relays;
- Dash evonodes (DAPI) and Platform nodes;
- the price feed;
- the forum and moderation contracts (where comments and the default block list live).

Changed settings are marked "custom", and "Use the profile's settings" puts them back.

To give your setup to someone else, use **Export, import and share**:

- **Download JSON** saves a file they can import.
- **Copy share link** makes a link to gov.dashhq.org with your settings in it. When someone opens it, the app shows each
  setting the link would change and does nothing until they agree. A link can also point to a settings file on your own
  site. The app fetches that file only after the person agrees, because the request tells your site who opened the link.

Settings are saved per browser. The profile (Mainnet, Testnet, Dev) is saved along with only what you changed, so you
still get our updates to everything else.

Be careful with the forum contract. Your encrypted keyring and passkey backup are stored under it, so a different one
means a different keyring, and existing passkeys won't open it.

## Setting up

Start with an archive-only bridge: it keeps a copy of governance data and serves it, but doesn't publish anything to
Platform. It needs no Platform identity and costs nothing beyond the machine:

```sh
git clone https://github.com/PastaPastaPasta/govhub.git
cd govhub/deploy
scripts/init.sh --network mainnet
docker compose up -d --build
```

Then, in [`deploy/README.md`](../deploy/README.md):

| To do this | Read |
|---|---|
| Check hardware, disk and how long the first sync takes | Section 3 |
| Fill the archive with the votes Dash Core already has | Section 7, "Governance resync" |
| Start from a copy of another node's data instead of a full sync | Section 4 |
| Put it on the internet (Cloudflare Tunnel, or Caddy with your own certificate) | Section 11 |
| Publish to Platform under your own contract | Section 5 |
| Run a relay | Section 11.4, and [`services/relay/README.md`](../services/relay/README.md) |
| Run a badge issuer | Section 11.5, and [`services/issuer/README.md`](../services/issuer/README.md) |
| Back up the archive | Section 6 |
| Serve your own copy of the app | [`TRUST.md`](TRUST.md), section 10 |

The bridge's API is described in [`services/bridge/openapi.json`](../services/bridge/openapi.json). It also answers the
two DashCentral calls (`/api/v1/budget` and `/api/v1/proposal`), for tools that used dashcentral.org.

Try everything on testnet first. Testnet DASH is free from a faucet, and a mistake there costs nothing.

## Privacy on your servers

Our [privacy page](privacy.md) only covers the servers we run. If you run a public server, tell your users what it keeps
and for how long. The services are built to keep very little (no IP addresses on disk, no per-request logs), but your
own reverse proxy, host or CDN may log more.
