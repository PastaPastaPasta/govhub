# Running a govhub backend

This directory is the reference deployment: a Dash Core node (`dashd`) plus the govhub **bridge**,
started with `docker compose up`. Anyone can run one. The frontend treats every bridge as
replaceable (PLAN section 1.1), so a third-party bridge is a first-class deployment, not a fork.

```
  Dash P2P network
        |
     dashd  (txindex=1, governance on)          RPC 9998 + ZMQ 29998: compose network only
        |  ZMQ: raw governance objects, raw signed votes, blocks, chainlocks
        v
     bridge --- SQLite archive (named volume)   <- history Core no longer has
        |   \--- Dash Platform (your gov contract, your identity)   [PUBLISH=1]
        |
   HTTP :8787 (read-only API) --- cloudflared (Cloudflare Tunnel, default: no open ports)
                               \-- or caddy (TLS on your own IP, the alternative)
```

Slots for `relay` and `accounts` are marked in `docker-compose.yml`. They are not built yet. The
MN badge `issuer` is built (profile `issuer`, sections 11.5 and 13.2).

## Contents

1. [Quick start](#1-quick-start)
2. [Files](#2-files)
3. [Hardware, disk and sync time](#3-hardware-disk-and-sync-time)
4. [Seeding a node from existing data](#4-seeding-a-node-from-existing-data)
5. [Platform identity and contract (publishing)](#5-platform-identity-and-contract-publishing)
6. [Backups](#6-backups)
7. [Upgrades and governance resync](#7-upgrades-and-governance-resync)
8. [Security](#8-security)
9. [Bridge contract (what the bridge image must do)](#9-bridge-contract)
10. [Troubleshooting](#10-troubleshooting)
11. [Publishing the API: Cloudflare Tunnel or Caddy](#11-publishing-the-api-cloudflare-tunnel-or-caddy) (11.3: one tunnel for two stacks)
12. [Unprivileged LXC (Proxmox)](#12-unprivileged-lxc-proxmox)
13. [Reference deployment (R730)](#13-reference-deployment-r730)
14. [The web app: gov.dashhq.org](#14-the-web-app-govdashhqorg)

## 1. Quick start

Needs Docker Engine with Compose >= 2.24.

```sh
cd deploy
scripts/init.sh --network testnet     # or mainnet; checks prerequisites, creates secrets/ and .env
$EDITOR .env                          # defaults are safe: PUBLISH=0 archives without touching Platform
docker compose up -d --build
docker compose logs -f dashd          # watch the sync
curl -s http://127.0.0.1:8787/v1/status
```

Start with `PUBLISH=0`. The archive only grows while the bridge runs, and Core discards the
history it archives. Turn publishing on later, once you have a funded identity and a contract
([section 5](#5-platform-identity-and-contract-publishing)).

Smoke test, on an isolated regtest chain (needs only Docker and curl; touches no real network):

```sh
scripts/smoke-regtest.sh
```

It starts dashd and the bridge under a throwaway project name, mines blocks, creates a proposal
with `gobject prepare`, submits it, waits until the bridge's `/v1/status` reports it, and removes
all containers, volumes and temporary secrets. Exit code 0 means it passed.

**Image tags** (pin them; `.env` can override with `DASHD_TAG`):

| Network | `dashpay/dashd` tag | Why |
|---|---|---|
| mainnet | `23.1.8` | mainnet needs >= v23.1 |
| testnet | `24.0.0-rc.4` | testnet activated V24 on 2026-10-23 |
| regtest | `24.0.0-rc.4` | CI and smoke tests exercise the v24 code path |

Both tags are multi-arch (amd64 and arm64; checked with `docker manifest inspect`). A Core
upgrade is a decision (section 7), so there is no `latest`. Off regtest the node runs with the
wallet disabled (the bridge needs none); `DASHD_EXTRA_ARGS=-disablewallet=0` turns it back on.

## 2. Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | base stack, **mainnet**: `dashd`, `bridge`, `cloudflared` (profile `tunnel`), `caddy` (profile `proxy`) |
| `docker-compose.testnet.yml` | override: v24 image, testnet Core, testnet Platform |
| `docker-compose.relay-tunnel-guest.yml` | override (after `docker-compose.tunnel-guest.yml`): the gateway also forwards to this stack's relay (section 11.4) |
| `docker-compose.regtest.yml` | override: isolated chain, `PUBLISH=0`, no identity secret |
| `docker-compose.p2p.yml` | override: publish dashd's P2P port (set `DASHD_P2P_PORT`) |
| `docker-compose.tunnel-guest.yml` | override: serve this stack's bridge through another stack's cloudflared, via a gateway on a `tunnel` network (section 11.3) |
| `docker-compose.tunnel-host.yml` | override: this stack's cloudflared also joins another stack's `tunnel` network (section 11.3) |
| `docker-compose.issuer-tunnel-guest.yml` | override (last, after `docker-compose.tunnel-guest.yml`): the gateway also forwards to this stack's `issuer` (profile `issuer`) under its own alias (section 11.5) |
| `.env.example` | every variable, commented, no secrets |
| `dashd/dash.conf`, `dashd/entrypoint.sh` | Core config template and the wrapper that adds network, RPC credentials and `dbcache` |
| `caddy/Caddyfile` | TLS reverse proxy; GET/HEAD/OPTIONS only, CORS handled here |
| `scripts/init.sh` | prerequisite check, secrets directory (mode 0700), `.env` |
| `scripts/cloudflare-tunnel.sh` | creates the Cloudflare Tunnel, its ingress and DNS, and writes the token file (section 11) |
| `scripts/backup.sh` | online backup of the bridge archive with retention (sections 6 and 13) |
| `scripts/smoke-regtest.sh` | end-to-end regtest test |

Choosing a network means choosing which files are layered. `COMPOSE_FILE` in `.env` does it, and
`init.sh --network` writes it:

```
mainnet  COMPOSE_FILE=docker-compose.yml
testnet  COMPOSE_FILE=docker-compose.yml:docker-compose.testnet.yml
regtest  COMPOSE_FILE=docker-compose.yml:docker-compose.regtest.yml
+ P2P    append :docker-compose.p2p.yml          (and set DASHD_P2P_PORT=9999 / 19999)
+ tunnel COMPOSE_PROFILES=tunnel                 (Cloudflare Tunnel; scripts/cloudflare-tunnel.sh writes the token)
+ one tunnel, two stacks: append :docker-compose.tunnel-host.yml on the tunnel stack and
         :docker-compose.tunnel-guest.yml on the other (section 11.3)
+ TLS    COMPOSE_PROFILES=proxy                  (and set DOMAIN; the alternative to the tunnel)
```

Two stacks on one host (say mainnet and testnet) need **different `COMPOSE_PROJECT_NAME`,
`GOVHUB_SUBNET`, `BRIDGE_PORT` and `BRIDGE_TAG`** in their `.env` files, or the second `up` replaces
the first and shares its volumes (a testnet bridge would write into the mainnet archive), or a build
in one checkout retags the bridge image the other recreates from. `init.sh --network` sets all four
per network (`govhub`, `govhub-testnet`, `govhub-regtest`; tags `local`, `testnet`, `regtest`), so
run it once per network, each in its own checkout directory. Volume names are `<project>_dashd-data` and
`<project>_bridge-data`; the commands below say `govhub_...`, so substitute your project name.

## 3. Hardware, disk and sync time

| | mainnet | testnet |
|---|---|---|
| Disk, Core datadir with `txindex=1` | **~59 GB measured**; provision **150 GB** SSD | **5.6 GB measured** at 1,578,672 (blocks 4.6, evodb 0.6, txindex 0.4 GB); provision 20 GB |
| Disk, bridge SQLite archive | tens of MB per month (*estimate*, not measured) | less |
| RAM | 4 GB works, 8 GB is comfortable (`dbcache` 1024 MiB plus Core's overhead) | 4 GB (dashd used 0.8 GB, the bridge 0.2 GB) |
| CPU | 2 cores minimum; 4+ makes the initial sync much faster | 2 |
| Disk type | **SSD/NVMe.** An HDD makes the initial sync and the txindex build many times slower | same |
| Network | ~60 GB download for a fresh sync, then a few GB/month | smaller |

Where the 59 GB comes from: `docker system df -v` on a dashmate mainnet full-node volume
(`core_data`, 58.59 GB on 2026-10-23). Dashmate's index set can differ from this stack's, so treat
it as +/-10%. The chain grows by a few GB per year (*estimate*). Docker volumes live under
`/var/lib/docker`: check which disk that is (`docker info | grep "Docker Root Dir"`), or bind-mount
a bigger disk (section 4).

**Initial sync from genesis** takes hours to about a day on mainnet with an SSD and 4+ cores
(*estimate; not measured here, because this change was validated without syncing any real
chain*). It is CPU-bound (script and BLS validation, then the txindex build), so a larger
`DASHD_DBCACHE_MB` (4096 if you have the RAM) helps. Lower it again afterwards. Seeding from
existing data (section 4) skips the download.

The `dashd` health check passes when RPC answers, which is **not** when the node is synced. Check
sync with:

```sh
docker compose exec dashd dash-cli -conf=/tmp/dash.conf getblockchaininfo   # blocks vs headers, verificationprogress
docker compose exec dashd dash-cli -conf=/tmp/dash.conf mnsync status
```

The bridge archives from the moment it connects, even mid-sync, and reconciles against Core with
`gobject list` once Core's governance data is synced.

## 4. Seeding a node from existing data

Two ways to avoid the download. Both stop dashd first.

**A. Copy `blocks/` from a node you control, then reindex (recommended).** Core re-validates every
block and rebuilds chainstate and indexes, so you trust only your own copy. No network is needed.

```sh
# Start from an empty volume: `docker compose down -v` first if dashd has already run.
docker compose up --no-deps --no-start dashd                 # creates the volume
IMG=dashpay/dashd:23.1.8                                     # the tag you deploy
VOL=govhub_dashd-data                                        # <project>_dashd-data in `docker volume ls`
DEST=/home/dash/.dashcore/blocks                             # testnet: /home/dash/.dashcore/testnet3/blocks
docker run --rm -v "$VOL:/home/dash" --entrypoint mkdir "$IMG" -p "$DEST"
docker run --rm -v "$VOL:/home/dash" -v /path/to/SRC/blocks:/src:ro \
  --entrypoint cp "$IMG" -a /src/. "$DEST/"                  # SRC = the other node's datadir
# first start only: reindex. Remove it afterwards, or every restart reindexes.
#   .env: DASHD_EXTRA_ARGS=-reindex
docker compose up -d dashd
```

The files end up owned by `dash` (uid 1000), which is what dashd needs.

**B. Copy the whole datadir (`blocks/`, `chainstate/`, `indexes/`, `evodb/`, `llmq/`)** from a
node of the same or an older Core version. Fastest, but you trust the source's chainstate and
indexes completely, and you cannot go back to an older version afterwards. Never do this with
data from strangers. If you use a public snapshot, take `blocks/` only and use method A.

On a Proxmox unprivileged LXC you can copy straight from another container's ZFS snapshot on the
host, without stopping that node: section 12 has the commands and the uid mapping.

To keep the chain on a bigger disk, replace the named volume with a bind mount in a
`docker-compose.override.yml` (compose loads it automatically unless `COMPOSE_FILE` is set; add it
to `COMPOSE_FILE` in that case). The directory must be owned by uid 1000:

```yaml
services:
  dashd:
    volumes:
      - /mnt/bigdisk/dash:/home/dash
```

## 5. Platform identity and contract (publishing)

Skip this section while `PUBLISH=0`. With `PUBLISH=1` the bridge writes `proposal`, `talliesSet`
(every active tally packed into one document), `tally` (a proposal's final tally, once, when it
ends) and `cycle` documents to a `gov` contract, signed by an identity you own. On an older
contract without `talliesSet` it writes one `tally` per proposal instead.

### 5.1 Registering your own `gov` contract

The `gov` contract is **owner-only**: every type has `creationRestrictionMode: 1`, so only the
identity that registered the contract can publish into it. A third-party bridge therefore cannot
write to ours. It registers its own copy, and the client merges bridges by `govHash` (PLAN
section 1.1). The `bridgeIdentityId` and contract id you publish are what users put in their
endpoint registry.

1. Take the schema from `packages/contracts-v1/gov.json` (the mainnet definition: slim `proposal`,
   `talliesSet`). It is the `documentSchemas` map. `gov-testnet.json` is what the deployed testnet
   contracts hold; do not register it for a new deployment.
2. Create the contract with a `DataContractCreate` transition signed by the identity's **CRITICAL**
   authentication key (HIGH is accepted by consensus, CRITICAL is our policy for contract
   creation). `spikes/sdk5/scripts/estimate-costs.ts` shows the evo-sdk 5.x calls end to end.
3. Cost: 0.1 DASH + 0.02 per document type + 0.01 per index. For `gov` (5 types, 7 indexes) that is
   **0.27 DASH** plus a small storage charge (0.0021 DASH: 0.27209975 measured on testnet).
4. Put the resulting contract id in `.env` as `GOV_CONTRACT_ID`.

Register on testnet first (`faucet.thepasta.org` funds testnet identities). Contract documents
cannot be moved to another contract: if you change the schema, you register a new contract and
republish.

### 5.2 The bridge identity and its key file

1. Create a Platform identity (a standard seed-derived identity with a MASTER, a CRITICAL and a
   HIGH key; the three-key layout costs about 0.00106 DASH). Dash Evo Tool or the evo-sdk both
   work. Create it on the network that matches `PLATFORM_NETWORK`.
2. Keep the MASTER key (and ideally CRITICAL) **offline**. The bridge needs only one
   document-signing key: the **HIGH** AUTHENTICATION key.
3. Fund the identity by topping it up with DASH. With the packed tally set the bridge pays about
   0.0010 DASH per day (one ~0.0000425 DASH replace an hour with 30 active proposals), plus about
   0.0009 DASH per new proposal (its `proposal` document and, when it ends, its final `tally`):
   about 0.5 DASH a year (docs/PHASE0.md). Watch the balance and raise the interval
   (`TALLY_PUBLISH_INTERVAL_S`) if it drains faster than you want. An empty identity makes the
   bridge stop publishing, not stop archiving.
4. Write the key file `secrets/bridge_identity.json` (the path `init.sh` created, mounted at
   `/run/secrets/bridge_identity`):

```json
{
  "identityId": "<base58 identity id>",
  "keyId": 2,
  "privateKeyHex": "<64 hex characters, the HIGH key>"
}
```

   `"wif": "<WIF>"` is accepted instead of `privateKeyHex`. `keyId` is the id of the HIGH key
   inside the identity. The file is mounted read-only into the bridge container and never baked
   into an image. Permissions: `scripts/init.sh` re-applies them: 0600, and chowned to uid 1000
   when it runs as root (an LXC or a VM). As any other user that is not uid 1000 it uses 0644
   inside the 0700 directory, so the container user can read the file.
5. In `.env`: `PUBLISH=1`, `GOV_CONTRACT_ID=<id>`, then `docker compose up -d bridge`.

Use this identity for nothing else, and never reuse its key as a user key.

## 6. Backups

**The bridge's SQLite archive is the only copy of history that Core has discarded**: expired
proposals, superseded votes, and the raw signed votes the frontend verifies. It cannot be rebuilt
from Core or from Platform. Back it up, and test a restore.

| What | Backup? |
|---|---|
| `bridge-data` volume (`/data/bridge.sqlite`) | **Yes. Daily at least, and before every upgrade.** |
| `secrets/` (RPC password, identity key) | Yes, encrypted, separately from the data backup |
| `.env` | Yes (no secrets in it) |
| `dashd-data` | No. It is re-downloadable. Back it up only to save the sync time |
| `caddy-data` | Optional (certificates; avoids ACME rate limits after a rebuild) |

Take the archive backup **while the bridge is running**. Stopping the bridge loses every ZMQ
message published while it is down, and superseded votes cannot be fetched afterwards. SQLite's
online backup is safe on a live database:

```sh
mkdir -p backups
docker run --rm --user root -v govhub_bridge-data:/data -v "$PWD/backups:/backup" \
  --entrypoint sqlite3 \
  keinos/sqlite3@sha256:9064091a943982e2a90f095219d0d6adec03472f9042529563e3e66c9632af66 \
  /data/bridge.sqlite ".backup /backup/bridge-$(date +%F).sqlite"
```

The bridge image can also do it itself, with no third-party image: `scripts/backup.sh [DIR] [KEEP_DAYS]`
runs `bridge backup` in the container, copies the file out, checks it with `PRAGMA integrity_check`
(when `sqlite3` is installed), deletes copies older than KEEP_DAYS and exits non-zero on any failure.
Section 13 has a cron job for it.

Replace `govhub_bridge-data` with `<project>_bridge-data`. The volume must be mounted read-write
even though the command only reads: SQLite's WAL mode needs the `-shm` file, and `.backup` is the
online-backup API, safe against a live writer. I ran this against a WAL-mode database and the copy
passed `PRAGMA integrity_check` and had the expected rows. The image is a third-party SQLite CLI
(`keinos/sqlite3`, pinned by digest above; it runs as root here only to read the volume): use your
own SQLite image if you prefer, or `bridge backup` (below). Verify each copy with
`sqlite3 backups/bridge-YYYY-MM-DD.sqlite "PRAGMA integrity_check"` and ship it off the machine.

Restore: stop the bridge, copy the backup to `/data/bridge.sqlite` in the volume (owned by the
bridge's runtime user, and delete any stale `-wal`/`-shm` files next to it), start the bridge. The
bridge then catches up on anything missed, with the exception of history Core no longer has.

## 7. Upgrades and governance resync

**Before any upgrade:** take a backup (section 6) and read the release notes.

**Dash Core.** Change `DASHD_TAG` in `.env` (or edit the override file), then:

```sh
docker compose pull dashd
docker compose up -d dashd
```

dashd gets 3 minutes to flush on stop. A major upgrade can rewrite on-disk databases, after which
**you cannot go back** to the old version with the same datadir. Mainnet moves to v24 only after
v24.0.0 is released and the network has activated V24. The bridge reconnects to ZMQ on its own
(votes published during the restart are recovered through RPC reconciliation, except superseded
ones).

**Bridge.**

```sh
git pull
docker compose build bridge
docker compose up -d bridge
```

Schema migrations are forward-only. Do not run an older image against a database a newer one has
touched; restore the backup instead.

### Governance resync (backfill)

Use this when the archive is missing votes Core still has: a new bridge on an old node, a bridge
that was down, or a restored backup. Core keeps current votes in `governance.dat`. If you move that
file aside, Core re-requests the objects and votes from its peers on the next start and announces
each one as new, so **every live vote arrives again on ZMQ**. The bridge must be running and
subscribed first, or the replay is wasted.

```sh
docker compose up -d bridge                      # bridge up and subscribed first
docker compose stop dashd                        # clean stop writes governance.dat
# find it: mainnet .dashcore/governance.dat, testnet .dashcore/testnet3/..., regtest .dashcore/regtest/...
docker compose run --rm --no-deps --entrypoint find dashd /home/dash/.dashcore -maxdepth 2 -name 'governance.dat*'
docker compose run --rm --no-deps --entrypoint mv dashd -v \
  /home/dash/.dashcore/governance.dat /home/dash/.dashcore/governance.dat.bak
docker compose up -d dashd
docker compose logs -f bridge                    # watch votes arrive
```

Adjust the path for testnet (`testnet3/`). `mnsync status` on dashd shows the governance sync.
Keep the `.bak` file until the bridge's vote count looks right, then delete it. This restores
**current** votes only. Votes Core already superseded or expired are gone for good, which is why
the bridge runs from day one.

## 8. Security

- **RPC (9998) and ZMQ (29998) are never published.** There is no `ports:` entry for them in any
  compose file, dashd's `rpcallowip` is limited to the compose subnet (`GOVHUB_SUBNET`), and CI
  fails if a rendered config publishes either port. They are reachable from containers on the
  compose network. The public-facing services (`cloudflared`, `caddy`) are on a separate `edge`
  network with only the bridge, outside `rpcallowip`, so no tunnel ingress or proxy rule can expose
  dashd. On a Linux host, anyone with a shell there can also reach the container's IP
  directly (RPC is password-protected; ZMQ has no authentication but carries public data), so do
  not give untrusted users host accounts. The wallet is disabled outside regtest. Do not
  "temporarily" publish these ports to debug.
- **Published ports.** Bridge: loopback by default (`BRIDGE_BIND=127.0.0.1`). cloudflared: none
  (it dials out to Cloudflare). Caddy: 80/443. dashd P2P only with `docker-compose.p2p.yml`. Docker bypasses `ufw`/`firewalld` rules for published
  ports (it writes its own iptables chains), so the bind address is your real control. If you set
  `BRIDGE_BIND=0.0.0.0`, you serve plain HTTP to the internet; use the proxy profile instead.
- **Firewall.** Allow inbound 80/443 (proxy) and, if you publish it, the P2P port (9999 mainnet,
  19999 testnet). Everything else inbound can stay closed. Outbound must allow P2P to the network.
- **Secrets** live as files under `secrets/` (directory 0700, git-ignored, never in `.env`, never in
  an image layer, never in `docker inspect` output). The RPC password is 256 bits of randomness
  generated by `init.sh`. dashd copies it into a conf file under `/tmp` inside its container only.
- **The identity key** can spend the identity's credits and publish as the bridge. Use a dedicated
  identity, hold only the HIGH key on the server, keep MASTER/CRITICAL offline, and keep the balance
  low. If the server is compromised: rotate the key (with MASTER), and register a new contract if
  you cannot trust the old one.
- **The API is read-only.** The bridge itself answers anything but GET/HEAD/OPTIONS with 405 and
  sends `Access-Control-Allow-Origin: *`, so it is safe to expose through the tunnel with no proxy
  in front. With the proxy profile, Caddy also rejects other methods and owns the CORS headers
  (`CORS_ALLOW_ORIGIN`, default `*`). The bridge's data is signed or verifiable by the client, so the
  proxy is not a trust boundary, but an open writable endpoint would be one.
- **Updates.** Pin image tags and review upgrades. Docker Hub tags can move: for strict
  reproducibility, pin by digest (`DASHD_TAG` accepts `24.0.0-rc.4@sha256:...`).
- **Logs.** json-file with rotation (20 MB x 5) per service. dashd logs are verbose.
- Run the stack as an unprivileged user in the `docker` group. Membership in that group is
  root-equivalent on the host, so do not share the account.

## 9. Bridge contract

`deploy/` and `services/bridge` are developed separately. This is what `deploy/` assumes of the
bridge image; the smoke test and CI rely on it.

**Image.** `services/bridge/Dockerfile`, built with the repository root as context
(`context: ..`). It runs as **uid 1000** (the `node` user in the official Node images): the
secret files are bind-mounted with the host's ownership, and `init.sh` chooses their mode on that
assumption, as it does for dashd. It creates `/data` owned by that user, so the named volume
mounted there is writable. A `HEALTHCHECK` on `GET /v1/status`. Add a root `.dockerignore` (or
`services/bridge/Dockerfile.dockerignore`) so the build context does not include `node_modules`
and the spikes.

**Start-up and resilience.** Compose's `depends_on: service_healthy` only orders `docker compose
up`. After a daemon restart or reboot, Docker starts both containers by restart policy, so the
bridge **must retry Core RPC and reconnect ZMQ until dashd is ready** (RPC returns error -28 while
Core warms up) and must not exit on those errors. ZMQ subscribers must raise their receive
high-water mark well above libzmq's default of 1000 (match dashd's 200000): a governance resync
delivers tens of thousands of votes in a burst.

**Environment** (compose sets all of them; an empty value means "use the built-in default"):

| Variable | Set by compose to | Meaning |
|---|---|---|
| `CORE_NETWORK` | `mainnet` / `testnet` / `regtest` | Core network |
| `PLATFORM_NETWORK` | `mainnet` / `testnet` | Platform network for publishing (`.env` can override) |
| `CORE_RPC_URL` | `http://dashd:9998` | Core JSON-RPC |
| `CORE_RPC_USER` | `.env`, default `govhub` | RPC user |
| `CORE_RPC_PASSWORD_FILE` | `/run/secrets/core_rpc_password` | file holding the RPC password |
| `CORE_ZMQ_URL` | `tcp://dashd:29998` | one ZMQ endpoint carrying `rawgovernanceobject`, `rawgovernancevote`, `hashblock`, `hashchainlock` |
| `DB_PATH` | `/data/bridge.sqlite` | SQLite archive, on the `bridge-data` volume |
| `HTTP_HOST` / `HTTP_PORT` | `0.0.0.0` / `8787` | HTTP listener (inside the container) |
| `PUBLISH` | `.env`; `0` on regtest | **`0` = archive and serve only: must not require `GOV_CONTRACT_ID` or the identity file, must not touch Platform** |
| `GOV_CONTRACT_ID` | `.env` | required only when `PUBLISH=1` |
| `BRIDGE_IDENTITY_KEY_FILE` | `/run/secrets/bridge_identity` | JSON key file ([section 5.2](#52-the-bridge-identity-and-its-key-file)); read **only** when `PUBLISH=1`. The file may be empty (archive-only deployments) or **absent** (regtest mounts no identity), so do not check for it at start-up when `PUBLISH=0` |
| `RECONCILE_INTERVAL_S` | `10` on regtest, else `.env` | `gobject list` reconcile period |
| `BRIDGE_LOG_LEVEL`, `CORE_RPC_TIMEOUT_MS`, `CORE_RPC_RETRIES`, `TALLY_PUBLISH_INTERVAL_S`, `CYCLE_PUBLISH_INTERVAL_S`, `MIN_COLLATERAL_CONFS`, `PLATFORM_MAX_CONCURRENT_WRITES`, `PUBLISH_ON_MISMATCH`, `PORTAL_PROPOSAL_URL` | `.env` | optional tunables |

**HTTP.** `GET /v1/status` returns JSON, and returns HTTP 200 even while Core is syncing or
unreachable (put the state in the body; the image health check and the proxy both use the path).
For the smoke test, after a proposal has been submitted to Core it must contain the proposal's
governance hash (display hex) **or** a numeric field named `proposals` with a value >= 1 anywhere
in the document. Everything the proxy forwards is read-only (GET/HEAD); the bridge needs no write
endpoints.

**Backup.** `bridge backup <file>` uses SQLite's online-backup API, so operators do not need a
third-party SQLite image (section 6).

**Behavior.** With `PUBLISH=0` on regtest the bridge archives a proposal that was created with
`gobject prepare` and submitted with `gobject submit` (collateral confirmations do not gate
archiving, only publishing).

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `dashd` unhealthy for a long time after a restart | Core is replaying or loading the block index; mainnet can take many minutes. `docker compose logs dashd`. The health check has a 15 minute grace (`DASHD_HEALTH_START_PERIOD`) |
| `cannot read RPC password file` | The secret is not readable by uid 1000 on Linux. Re-run `scripts/init.sh` (it picks 0644 inside the 0700 directory for other uids) |
| dashd exits: "txindex" or "governance" | An edited `dash.conf` removed `txindex=1` or set `disablegovernance=1`. Core refuses to run governance without txindex |
| `docker compose up` fails with "dependency failed to start: dashd is unhealthy" | Core needed longer than the health check allows (`DASHD_HEALTH_START_PERIOD` plus about 2.5 minutes), for example while replaying after an unclean stop. dashd keeps running; wait for `getblockcount` to answer, then `docker compose up -d` again |
| `Pool overlaps with other one on this address space` | `GOVHUB_SUBNET` collides with an existing Docker network; pick another range in `.env` |
| `docker compose config` fails with `!override` | Compose is older than 2.24 |
| bridge `PUBLISH=1` exits at start | `GOV_CONTRACT_ID` or `secrets/bridge_identity.json` is missing or invalid (section 5) |
| No votes in the archive after a long gap | Run the governance resync (section 7) |
| Core RPC calls from the host fail | By design: `docker compose exec dashd dash-cli -conf=/tmp/dash.conf <cmd>` |
| cloudflared: `"cloudflared tunnel run" requires the ID or name of the tunnel` | The token file is empty: run `scripts/cloudflare-tunnel.sh` (section 11) |
| cloudflared: `Provided Tunnel token is not valid` | The token file holds something else, or the token was rotated: re-run `scripts/cloudflare-tunnel.sh` |
| `cloudflare-tunnel.sh`: `Authentication error` / `Not authorized` on `cfd_tunnel` | The API token lacks Account > Cloudflare Tunnel > Edit. The zone lookup needs Zone > Zone > Read, DNS calls need Zone > DNS > Edit |
| Public hostname answers 502/1033 | cloudflared is not running or not connected: `docker compose logs cloudflared`, and check `COMPOSE_PROFILES=tunnel` |
| `docker info` shows storage driver `vfs` in an LXC | The host's ZFS is older than 2.2 (no overlayfs on ZFS): upgrade the host, or give `/var/lib/docker` an ext4/xfs mount point (section 12) |

## 11. Publishing the API: Cloudflare Tunnel or Caddy

### 11.1 Cloudflare Tunnel (default)

`cloudflared` runs in the stack (profile `tunnel`) and dials **out** to Cloudflare. No inbound port is
opened, the host needs no public IP and holds no TLS certificate, and the bridge's own port stays on
loopback. The tunnel is *remotely managed*: its public hostnames and ingress rules live in
Cloudflare, and the container only needs the tunnel token.

1. Create a Cloudflare API token with **Account > Cloudflare Tunnel > Edit** (on the account), plus
   **Zone > Zone > Read** and **Zone > DNS > Edit** (on the zone of your hostnames).
2. From `deploy/`, on the server or on any machine (then copy the token file over):

   ```sh
   CF_API_TOKEN=... scripts/cloudflare-tunnel.sh --account <account id> --zone example.org \
     --route gov-bridge.example.org=http://bridge:8787
   ```

   It creates the tunnel `govhub` (`--name` changes it) or reuses an existing one of that name,
   **replaces** its ingress with exactly the routes given plus a 404 catch-all, creates or updates a
   proxied `CNAME <host> -> <tunnel-id>.cfargotunnel.com` per route, and writes the token to
   `secrets/cloudflare_tunnel_token` (0600; `--token-out` for another path). It prints no secret.
   `CF_API_TOKEN_FILE=<file>` works instead of the variable. If the tunnel already exists the script
   stops unless you pass `--reuse`, so a second stack cannot take over the first one's tunnel by
   accident. It also refuses to repoint a CNAME that points somewhere other than a tunnel unless you
   pass `--force-dns`. Every hostname is checked before anything changes, so a refused route leaves
   the tunnel, its ingress and DNS as they were. If you ran it on another machine, copy the token file into `secrets/` and
   re-run `scripts/init.sh` as root, which chowns it to uid 1000 so cloudflared can read it.
3. In `.env`: `COMPOSE_PROFILES=tunnel`, then `docker compose up -d`. `docker compose logs
   cloudflared` shows nothing on success: cloudflared runs at loglevel fatal (no request logs, section 11.5). Check it from outside (step 4).
4. Check from outside:

   ```sh
   curl -s https://gov-bridge.example.org/v1/status | jq .proposals
   curl -si -H 'Origin: https://portal.example' https://gov-bridge.example.org/v1/status | grep -i access-control-allow-origin
   curl -si -X POST https://gov-bridge.example.org/v1/status | head -1      # 405: the API is read-only
   ```

Routes are compose service names, because cloudflared is on the compose network. When the relay and
accounts services land, re-run the script with every route (it replaces the whole ingress list):

```sh
scripts/cloudflare-tunnel.sh --account <id> --zone example.org --reuse \
  --route gov-bridge.example.org=http://bridge:8787 \
  --route gov-relay.example.org=http://relay:<port> \
  --route gov-accounts.example.org=http://accounts:<port>
```

Give every service its own hostname (its own browser origin); the issuer in particular must never
share an origin with the others.

Through the tunnel the bridge answers directly. It sets `Access-Control-Allow-Origin: *`, allows
GET/HEAD/OPTIONS and returns 405 for everything else (section 8). Cloudflare adds TLS and its edge
protection, and does not cache JSON by default. For a second layer, a WAF custom rule on the hostname
can block `not http.request.method in {"GET" "HEAD" "OPTIONS"}` (that needs a token with zone WAF
permissions).

The tunnel token lets anyone run a connector for your hostnames: keep it like the identity key, in
`secrets/` only. To rotate it, refresh the token in the Cloudflare dashboard (or API), re-run the
script with `--reuse` and **every** `--route` (it replaces the whole ingress list) so it writes the
new token, and run `docker compose up -d cloudflared`.

### 11.2 Caddy (alternative)

Use Caddy when the host has a public address and you do not want Cloudflare in the path:
`COMPOSE_PROFILES=proxy`, `DOMAIN=<host>`, DNS pointing at the host, ports 80 and 443 open. Caddy gets
a certificate from Let's Encrypt, filters methods and owns the CORS headers (`caddy/Caddyfile`). Do not
serve one hostname through both.

### 11.3 One tunnel for two stacks on one host

A second stack on the same host (say testnet next to mainnet) can be published through the first stack's
cloudflared and tunnel, with one extra public hostname and no second connector.

Do **not** attach cloudflared to the other stack's `edge` network. Compose names both bridges `bridge`, and a
container on two networks resolves a name that exists on both to only one of them, chosen by network order
(on Docker 29, `govhub-testnet_edge` sorts before `govhub_edge`, so `http://bridge:8787` silently went to the
testnet bridge in a test). Instead:

- the **guest** stack (no cloudflared) layers `docker-compose.tunnel-guest.yml`. It adds `tunnel-gateway`, a
  Caddy reverse proxy (read-only filesystem, uid 1000) on the guest's `edge` network and on a new
  `<project>_tunnel` network, under the alias `TUNNEL_ALIAS` (default `<project>-bridge`). It forwards everything
  to the guest's bridge, which still answers GET/HEAD/OPTIONS only and sets CORS itself. Its config is
  `caddy/tunnel-gateway-bridge.Caddyfile`: no access log, and Caddy's default logger (which writes proxy errors with the
  client address to stdout, kept by Docker) is discarded. Every `caddy/tunnel-gateway-*.Caddyfile` does the same, and the
  deploy-lint workflow fails if one does not, or if a compose file runs the gateway without one.
- the **host** stack (with `COMPOSE_PROFILES=tunnel`) layers `docker-compose.tunnel-host.yml`. cloudflared then
  also joins that network as an external network (`TUNNEL_GUEST_NETWORK`, default `govhub-testnet_tunnel`).

Nothing named `bridge` is on the `tunnel` network, so the host's own routes do not change, and dashd is on
neither network (CI checks both). Bring it up guest first, because the host side needs the network to exist:

```sh
# guest (testnet checkout), .env: COMPOSE_FILE=docker-compose.yml:docker-compose.testnet.yml:docker-compose.tunnel-guest.yml
docker compose up -d
# host (mainnet checkout), .env: COMPOSE_FILE=docker-compose.yml:docker-compose.tunnel-host.yml
#                               TUNNEL_GUEST_NETWORK=govhub-testnet_tunnel
docker compose up -d --no-deps cloudflared        # only cloudflared is recreated
```

Then add the hostname to the tunnel. `--reuse` **replaces the whole ingress list** of the tunnel, so give it every
route, and run it from the host (mainnet) checkout:

```sh
scripts/cloudflare-tunnel.sh --account <id> --zone example.org --name govhub --reuse \
  --route gov-bridge.example.org=http://bridge:8787 \
  --route gov-bridge-testnet.example.org=http://govhub-testnet-bridge:8787
```

> **Warning:** a route you leave out is deleted from the tunnel, and the hostname stops answering. The Cloudflare
> dashboard (as the reference deployment uses) is an alternative: add the one public hostname
> `gov-bridge-testnet.example.org -> http://govhub-testnet-bridge:8787` there and nothing else changes.

Check from cloudflared's network namespace (its image has no shell or wget). The two bridges are told apart by the
`network` field of `/v1/status`:

```sh
N="--network container:govhub-cloudflared-1"
docker run --rm $N busybox wget -q -O- http://govhub-testnet-bridge:8787/v1/status | grep -o '"network":"[a-z]*"'   # "testnet"
docker run --rm $N busybox wget -q -O- http://bridge:8787/v1/status | grep -o '"network":"[a-z]*"'                  # "mainnet", still the host's
```

While cloudflared is attached, the guest's `docker compose down` cannot remove `<project>_tunnel` (the
containers stop anyway). To run the host without the guest, take `docker-compose.tunnel-host.yml` out of its
`COMPOSE_FILE`; with it in, `up` fails while the network is missing.

### 11.4 The relay

The relay (services/relay) is a profile of this compose file: `COMPOSE_PROFILES=relay` (with `tunnel`:
`tunnel,relay`). It shares this stack's dashd and RPC secret, keeps held votes on the `relay-data` volume, publishes
its port on loopback (`RELAY_PORT`, default 8790) and takes the client address from `cf-connecting-ip` (in memory
only, for rate limits; nothing about clients is stored). Route: `gov-relay.<zone> -> http://relay:8788`.

A second stack's relay (say testnet next to mainnet) is published through the host stack's tunnel by the guest's
`tunnel-gateway` (section 11.3), never by joining the shared `tunnel` network itself: layer
`docker-compose.relay-tunnel-guest.yml` after `docker-compose.tunnel-guest.yml` (with `COMPOSE_PROFILES=relay`). It gives the
gateway a Caddyfile (`caddy/tunnel-gateway-relay.Caddyfile`, no logs like the others) with a second listener, `8788 -> relay:8788` over the guest's
`edge` network, and a second alias `<project>-relay` on `tunnel`. Route: `gov-relay-testnet.<zone> ->
http://govhub-testnet-relay:8788`. The relay answers browsers itself (CORS, 4 KiB POST bodies, per-IP and per-masternode
limits, client address from `cf-connecting-ip`, which the gateway passes through).

### 11.5 The MN badge issuer

The `issuer` service (profile `issuer`, `services/issuer/README.md`) blind-signs MN badge tokens. It is
not a read-only API like the bridge: `POST /v1/challenge` and `POST /v1/token` take requests from browsers, so
publish it through the tunnel under **its own hostname** (its own browser origin), never the portal's or the
bridge's. It sends its own CORS headers (`Access-Control-Allow-Origin: *`, no credentials), so no proxy is needed.

Before the first start you need an issuer identity, a `badge` contract and the offline keys
(`services/issuer/README.md`, "Keys"). Then:

1. `.env` section 7: `ISSUER_IDENTITY_ID`, `BADGE_CONTRACT_ID`, and `COMPOSE_PROFILES=issuer` (for example
   `tunnel,issuer`). Leave `ISSUER_MAX_STAGED_KEYS=1` on mainnet.
2. Secrets in `secrets/` (`init.sh` creates the first two):
   - `issuer_hmac_secret`: random hex for the stateless challenges. Keep it, or open challenges die on a restart.
   - `issuer_report_key.json`: the issuer identity's **HIGH** key as `{"identityId","keyId","privateKeyHex"}`, for
     `issuerReport` documents. `init.sh` creates it **empty**; the issuer refuses to start until it holds the HIGH key.
   - `issuer-keys/epoch-<E>.pem`: the private keys for the epochs the server may hold, mode 0600, owner uid 1000.
     The directory must stay writable, because the service destroys the key of each closed epoch.
3. `docker compose up -d --build issuer`, then check:

   ```sh
   curl -s http://127.0.0.1:8789/v1/info | jq '{network, issuingEpochs, height, ready, keyIds}'    # ready must be true
   docker compose logs --no-log-prefix issuer | jq -c 'select(.level == "error" or .level == "warn")'
   ```

   `ready: false` means no key can sign right now. The reason is in the log: no key file, no `issuerKey` on
   Platform, an `issuerKey` published too late, a key that does not match the published one, or more staged keys than
   `ISSUER_MAX_STAGED_KEYS`.
4. Add the route to the tunnel. `scripts/cloudflare-tunnel.sh` replaces the **whole** ingress list, so pass every
   existing route again with `--reuse`:

   ```sh
   scripts/cloudflare-tunnel.sh --account <id> --zone example.org --reuse \
     --route gov-bridge.example.org=http://bridge:8787 \
     --route gov-issuer.example.org=http://issuer:8789
   ```

**Through another stack's cloudflared.** On a host with two stacks, one cloudflared serves both, through the guest's
`tunnel-gateway` like the relay (section 11.4): the issuer never joins the shared `tunnel` network. Layer
`docker-compose.issuer-tunnel-guest.yml` last, after `docker-compose.tunnel-guest.yml` (and
`docker-compose.relay-tunnel-guest.yml` if the relay is published too). The gateway then runs
`caddy/tunnel-gateway-issuer.Caddyfile` (8787 bridge, 8788 relay, 8789 issuer) with the extra alias
`${ISSUER_TUNNEL_ALIAS:-<project>-issuer}`, for example `govhub-testnet-issuer`, so the route is
`http://govhub-testnet-issuer:8789`.

**Logging policy (issuer).** Nothing that could link a badge request to a client may be kept (owner decision; the full
table is in `services/issuer/README.md`, "What is stored and logged"):

- the issuer's token store keeps only the dedup rows, deleted when the epoch's window closes, and no times or addresses;
- the issuer's own stdout/stderr (kept by Docker's json-file driver) has no MN ids, outpoints, addresses or per-request
  lines, only hourly counters;
- the tunnel gateway runs `caddy/tunnel-gateway-issuer.Caddyfile` with no access log and the default logger discarded;
- cloudflared runs at `--loglevel fatal` (no per-request lines; debug logs every request, and info, warn and error log
  failed origin requests with a time). The `Registered tunnel connection` lines are info, so check the tunnel with `cloudflared tunnel info` or the
  metrics port instead of the log;
- Cloudflare's edge sees request metadata and is outside our control. Turn off Logpush, Web Analytics and other request
  logging for the issuer hostname where the plan allows. Do not put a logging proxy (or Caddy's `log` directive) in front
  of the issuer.

**State.** The `issuer-data` volume holds the dedup rows of the open issuance window and the per-epoch counts that become
`issuerReport`. It is small. If it is lost during a window, MNs can get a second token and the report undercounts,
which readers treat as a fraud signal. The rows are deleted when the window closes, so back it up often while a
window is open. Private keys are not in it: they live in `secrets/issuer-keys`.

**Update.** `git pull && docker compose build issuer && docker compose up -d issuer`. A restart is safe: the
challenge secret, the keys and the store survive it.

## 12. Unprivileged LXC (Proxmox)

The stack runs unchanged in an **unprivileged** Proxmox container with `features: nesting=1,keyctl=1`.
Install Docker Engine and the compose plugin from Docker's apt repository. On Proxmox VE 8.4 (kernel
6.8, ZFS 2.2.8) with an Ubuntu 24.04 container on a ZFS subvolume, nothing else was needed:
`docker run hello-world` works and the storage driver is `overlayfs`. ZFS older than 2.2 cannot host
overlayfs, so Docker falls back to `vfs` (slow, and every layer is a full copy). In that case upgrade
the host, or give `/var/lib/docker` a mount point on ext4 or xfs.

**uid mapping.** With the default map, uid 1000 inside the container (dashd's `dash`, the bridge's
`node`, cloudflared as configured here) is uid **101000** on the host. Run `scripts/init.sh` as root
inside the container; it chowns the secret files to 1000:1000 and keeps them 0600.

**Seeding dashd from another container on the same host** (section 4, method B), without stopping
the source node: a ZFS snapshot is crash-consistent, and dashd replays the few blocks since its last
flush on start.

```sh
# on the Proxmox host. SRC = the source container's dataset, CT = the new container's id.
SRC=rpool/data/subvol-<src>-disk-0
SNAP=govhub-seed-$(date +%Y%m%d)
zfs snapshot "$SRC@$SNAP"
FROM=/$SRC/.zfs/snapshot/$SNAP/<path to the mainnet datadir>
TO=/rpool/data/subvol-<CT>-disk-0/var/lib/docker/volumes/govhub_dashd-data/_data/.dashcore
#   (create the volume first, inside the container: docker compose up --no-deps --no-start dashd)
for d in blocks chainstate indexes evodb llmq; do rsync -a --info=progress2 "$FROM/$d" "$TO/"; done
chown -R 101000:101000 "$TO"
zfs destroy "$SRC@$SNAP"
```

If the source runs without `txindex` (no `indexes/` directory), copy the rest anyway: dashd builds the
txindex from `blocks/` in the background on its first start (testnet: 1.58 M blocks in 3 minutes). Run
the governance resync (section 7) only after `getindexinfo` reports `txindex.synced: true`, because
Core rejects every proposal whose collateral it cannot look up and does not ask for it again.

Leave out `dash.conf`, wallets, `debug.log`, `.lock`, `*.pid` and `peers.dat`. `governance.dat` is
optional, since the governance resync (section 7) rebuilds it anyway. Use a source of the same Core
version or older (section 4). For the reference deployment, 50 GB copied in about 2.5 minutes, and
dashd was at the tip with `getindexinfo` reporting `txindex.synced: true` under a minute after the
start, with no reindex.

**Firewall.** The container firewall can stay on (`firewall=1`). The tunnel is outbound only, the
bridge is published on loopback, and dashd needs only outbound P2P unless you add
`docker-compose.p2p.yml`.

## 13. Reference deployment (R730)

The project's own bridges: `gov-bridge.dashhq.org` (Core mainnet) and, as a second stack in the same
container, `gov-bridge-testnet.dashhq.org` (Core testnet, below). It is a Proxmox unprivileged LXC
(Ubuntu 24.04, 6 cores, 16 GB RAM, 2 GB swap, 250 GB on ZFS, starts on boot), set up as in section 12.
With both stacks running it used 2.8 GB of RAM and 57 GB of its ZFS dataset (2026-10-24; `df`, so after
compression: the datadirs are 55 GB mainnet and 5.6 GB testnet in apparent size).

| | |
|---|---|
| Checkout | `/opt/govhub` (stack in `/opt/govhub/deploy`, project `govhub`) |
| Networks | Core **mainnet**, Platform **testnet** (the current dev wiring): `PLATFORM_NETWORK=testnet` |
| Publishing | `PUBLISH=1`, `GOV_CONTRACT_ID=3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ`, identity `9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv` (HIGH key only on the server) |
| Tuning | `DASHD_DBCACHE_MB=2048`, `DASHD_MAXCONNECTIONS=40` |
| Public | `COMPOSE_PROFILES=tunnel`, tunnel `govhub`: `gov-bridge.dashhq.org -> http://bridge:8787`; with `docker-compose.tunnel-host.yml` in `COMPOSE_FILE` cloudflared also serves the testnet stack (section 11.3) |
| Backups | `/opt/govhub-backups`, daily from cron (below) |

All commands below run as root in the container, from `/opt/govhub/deploy`.

**Update.**

```sh
cd /opt/govhub && git pull
cd deploy && docker compose build && docker compose up -d
docker compose ps && curl -s http://127.0.0.1:8787/v1/status | jq '{proposals, height, core: .core.reachable, mism: .tallies.coreMismatches, publish: .publish.last}'
```

`build` rebuilds only the bridge (the other images are pulled). `up -d` recreates only what changed.
A bridge restart misses ZMQ messages for a few seconds. The next reconcile recovers everything
except votes superseded in that window. Take a backup first when the update touches the bridge
(schema migrations are forward-only). Core upgrades are a separate decision (section 7).

**Logs.**

```sh
docker compose logs -f --tail 100 bridge          # JSON lines
docker compose logs --no-log-prefix bridge | jq -c 'select(.level == "error" or .level == "warn")'
docker compose logs -f --tail 50 dashd
docker compose logs --tail 50 cloudflared
```

Logs rotate at 20 MB x 5 per service (json-file). `/v1/status` shows the state at a glance: Core
reachability and sync, the ZMQ counters and gaps, archive counts, tally mismatches with Core, and the
last publish pass with the identity's credits before and after.

**Backups of the SQLite archive.** The archive is the one thing here that cannot be rebuilt
(section 6). `/etc/cron.d/govhub-backup` takes an online backup daily at 03:30, keeps 30 days and logs
to syslog (`journalctl -t govhub-backup`). `pipefail` keeps the script's exit status, so cron and any
monitoring see a failed backup:

```
30 3 * * * root bash -o pipefail -c '/opt/govhub/deploy/scripts/backup.sh /opt/govhub-backups 30 2>&1 | logger -t govhub-backup'
```

Check a copy with `sqlite3 /opt/govhub-backups/bridge-<date>.sqlite 'PRAGMA integrity_check'`. These
copies sit on the same disk as the live archive, so ship them off the machine as well, and keep
`secrets/` in an encrypted backup of its own. Restore: section 6.

**Restarts.**

```sh
docker compose restart bridge                     # safe; a few seconds of missed ZMQ
docker compose stop dashd && docker compose up -d # dashd gets up to 3 min to flush
docker compose down && docker compose up -d       # whole stack; volumes are kept (never `down -v`)
```

Every service has `restart: unless-stopped` and the container starts on boot, so a host reboot brings
the stack back by itself. After a long outage, run the governance resync (section 7) to recover the
current votes.

**Checks.**

```sh
docker compose exec -T bridge node bin/bridge.mjs verify 2>/dev/null | jq '{ok, votes: .votes.byStatus, tallies: .tallies.mismatches}'
docker run --rm --network govhub_default -v govhub_bridge-data:/data \
  -v /opt/govhub/services/bridge/scripts:/app/services/bridge/scripts:ro \
  -e DB_PATH=/data/bridge.sqlite -e PLATFORM_NETWORK=testnet \
  -e GOV_CONTRACT_ID=3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ \
  -e BRIDGE_IDENTITY_ID=9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv \
  --entrypoint node govhub-bridge:local scripts/readback.ts     # every published document, with proofs
```

Watch the identity balance (`publish.last.creditsAfter` in `/v1/status`; 10^11 credits = 1 DASH) and
top it up before it runs out. An empty identity stops publishing, not archiving.

**Bring-up record (2026-10-24).** dashd 23.1.8 was seeded from a snapshot of another mainnet node on
the same host (section 12). It loaded the chain at 2,560,432, reached the tip (2,560,718) under a
minute after the start, and reported txindex synced, with no reindex. The bridge archived 28
proposals and 1 trigger over RPC. The governance resync (section 7) then delivered 4,958 signed votes
on ZMQ in about a minute with 0 sequence gaps: 4,957 valid signatures plus 1 operator vote.
`bridge verify` was clean, with 28/28 tallies equal to Core and threshold 332 = 332. One forced
publish pass (`bridge publish --once --force`) replaced the 28 tallies and 2 cycles, so the
voteSetHash of every tally now follows govhub-voteset-v1. It adopted the 28 existing proposal
documents, had 0 failures, and cost 90,970,860 credits (0.00091 tDASH). `scripts/readback.ts` then
matched 58/58 documents with proofs.

### 13.1 Testnet stack

A second, independent stack for Core **testnet** published into Platform **testnet**: testnet governance in the
app, and votes from testnet masternodes. Created with `scripts/init.sh --network testnet` in its own checkout.

| | |
|---|---|
| Checkout | `/opt/govhub-testnet` (stack in `/opt/govhub-testnet/deploy`, project `govhub-testnet`, subnet `172.29.74.0/24`, API on `127.0.0.1:8788`, image `govhub-bridge:testnet`) |
| Core | `dashpay/dashd:24.0.0-rc.4` (testnet activated V24 at 1,578,000), `DASHD_DBCACHE_MB=1024`, `DASHD_MAXCONNECTIONS=40` |
| Publishing | `PUBLISH=1`, `PLATFORM_NETWORK=testnet`, `GOV_CONTRACT_ID=5gMnJLDpcoMaQCQNqmHtBiSqCxRCmroXFAffPNdJ2NJC`, identity `24tL6v5jMR1H9dtUoTgbedePsMJtYPk4Q4bo6h8jTdK9` (HIGH key only on the server; made by `spikes/sdk5/scripts/testnet-bridge-setup.ts`). The `forum`, `badge` and `mod` contracts are shared with the other stack. Forum documents are keyed by `govHash`, which commits to the proposal's collateral txid, a transaction that exists on one chain only, so mainnet and testnet proposals do not share hashes |
| Public | `COMPOSE_FILE=...:docker-compose.tunnel-guest.yml`; the mainnet stack's cloudflared reaches it as `http://govhub-testnet-bridge:8787` (section 11.3): `gov-bridge-testnet.dashhq.org` |
| Backups | `/opt/govhub-testnet-backups`, daily from the same cron file |

Commands are those of the mainnet stack, run from `/opt/govhub-testnet/deploy` (port 8788, project and volume
names `govhub-testnet...`). Update the testnet checkout first and bring its gateway up before recreating the
mainnet cloudflared. The second line in `/etc/cron.d/govhub-backup` uses its own directory, so neither job's
retention touches the other's copies:

```
45 3 * * * root bash -o pipefail -c '/opt/govhub-testnet/deploy/scripts/backup.sh /opt/govhub-testnet-backups 30 2>&1 | logger -t govhub-backup-testnet'
```

**Bring-up record (2026-10-24).** dashd 24.0.0-rc.4 was seeded (section 12) from a ZFS snapshot of a testnet
v24.0.0-rc.4 node on the same host that runs without txindex and with governance disabled: `blocks`,
`chainstate`, `evodb` and `llmq` (5.6 GB) copied in 17 s. It loaded the chain at 1,578,589, was at the tip
within seconds, and built the txindex from height 0 in 3 min 7 s. A governance resync with the bridge
listening then delivered 5 proposals and all 33 signed votes on ZMQ in about 40 s with 0 gaps. Every vote
verified with the testnet scheme (binary vote hash) against the masternode's `keyIDVoting`, and `bridge verify`
was clean: 5/5 tallies equal to Core, threshold 22 = 22. An ABSTAIN signed with `@govhub/verify`'s `signVote`
and sent with `voteraw` was accepted by Core and archived as valid (the vote fixtures in
`packages/verify/test/fixtures/testnet-votes.json` come from this archive). Identity creation cost 122,425,400
credits, the `gov` contract 24,195,056,280 (0.242 tDASH), and the first publish passes (5 proposals, 5 tallies,
2 cycles) about 0.0054 tDASH. `scripts/readback.ts` matched 12/12 documents with proofs. The superblock before the
bring-up had no trigger (no testnet proposal reached the threshold), so it has no `cycle` document with `paid`.

### 13.2 Testnet issuer (MN badge)

The MN badge issuer for testnet runs on the R730 (CT 185), in the compose project of the testnet stack. It has its
own checkout, so it can follow the `mn-badge` branch without touching the rest of that stack.

| | |
|---|---|
| Checkout | `/opt/govhub-issuer` (stack in `/opt/govhub-issuer/deploy`), branch `mn-badge` until it is merged |
| Project | `govhub-testnet`, the testnet stack's project, so the issuer reaches its `dashd` |
| Compose | `COMPOSE_FILE=docker-compose.yml:docker-compose.testnet.yml:docker-compose.tunnel-guest.yml:docker-compose.relay-tunnel-guest.yml:docker-compose.issuer-tunnel-guest.yml`, `COMPOSE_PROFILES=relay,issuer` (the testnet stack's `.env` plus the issuer settings) |
| Start | `docker compose up -d --no-deps issuer tunnel-gateway` (the issuer, and the gateway with the issuer listener; dashd, the bridge and the relay are not touched) |
| Secrets | `/opt/govhub-testnet/deploy/secrets`: it shares the testnet stack's RPC password; the HMAC secret, the HIGH key file and `issuer-keys/` are in the same directory |
| Keys on the server | `ISSUER_MAX_STAGED_KEYS=7`: a week of daily keys without an operator. This is a testnet convenience; mainnet keeps 1 |
| Port | `127.0.0.1:8789` (loopback) |
| Public | tunnel `govhub`, route to add in Cloudflare: `gov-issuer-testnet.dashhq.org -> http://govhub-testnet-issuer:8789`. Pass the existing routes again when you re-run `scripts/cloudflare-tunnel.sh --reuse` (it replaces the whole list) |

Testnet ids:

| | |
|---|---|
| Issuer identity | `H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH`, funded with 0.5 tDASH from the QA wallet. Separate from the bridge and moderation identities. Its CRITICAL key stays offline, outside the repo |
| `badge` contract | `2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU`, registered 2026-10-24 from the current `packages/contracts-v1/badge.json` (0.2214 tDASH) |
| Superseded | `3SrZbofJnMgWNiHFzpHc5u7wSRgCFJykZwKq3haqyMfc` (phase 0): it allowed `spki` of 90..600 bytes |
| `issuerKey` documents | epochs 2742 to 2755, published at core height about 1,578,675. The deadline for epoch 2742 was 1,578,816 (`S(2741)`) |

**Cutover to privacy modes (current-epoch tokens).** Issuers before that change published E's `issuerReport` in
`[S(E), S(E)+W]`; readers now accept it only in `[S(E+1), S(E+1)+W]`, and a report cannot be replaced (one per issuer and
epoch). Deploy the new issuer and web build together, before an epoch boundary, and expect the epoch whose report the old
issuer already wrote (and, through the sticky rule, the next one) to show as unaudited. The old issuer also destroyed the
current epoch's key at `S(E)`, so Standard requests work from the next epoch on.

Testnet epochs are 576 blocks, about a day (`packages/badge/README.md`, "Testnet timing"). With the keys above, tokens
for epoch 2742 are issued from block 1,578,816 to 1,579,391, and the first badges show from block 1,579,392. The last
published key is for epoch 2755, so publish more keys (`issuer keygen`, `issuer publish-keys`) at least 3 epochs before
that runs out.

Update (as root, from `/opt/govhub-issuer/deploy`):

```sh
cd /opt/govhub-issuer && git pull
cd deploy && docker compose build issuer && docker compose up -d --no-deps issuer
curl -s http://127.0.0.1:8789/v1/info | jq '{network, issuingEpochs, height, ready, keyIds}'
```

To add keys: generate and publish them on an offline machine, then copy `epoch-<E>.pem` into
`/opt/govhub-testnet/deploy/secrets/issuer-keys` (0600, uid 1000), no more than 7 epochs ahead of the one being issued.

## 14. The web app: gov.dashhq.org

The web app is a static build (`apps/web`) deployed by `.github/workflows/pages.yml` to GitHub Pages, with the custom domain
**gov.dashhq.org** and Cloudflare proxied in front (the dashhq.org pattern). It has its own origin: on the shared
`pastapastapasta.github.io` origin every other Pages site of the account could read and write govhub's settings, badge trust
list and IndexedDB caches. The build takes its base path from `actions/configure-pages` (`/` once the custom domain is set,
`/govhub/` before), and GitHub answers the old `pastapastapasta.github.io/govhub/` URLs with a 301 to the custom domain.

DNS (zone dashhq.org): `gov CNAME pastapastapasta.github.io`. Cutover order:

1. Create the CNAME **DNS only** (grey cloud) and wait until it resolves publicly.
2. Set the Pages custom domain: `gh api -X PUT repos/PastaPastaPasta/govhub/pages -f cname=gov.dashhq.org`, then re-run the
   `pages` workflow so the build switches to base `/`.
3. Wait for GitHub to issue the certificate (`gh api repos/PastaPastaPasta/govhub/pages --jq .https_certificate.state` is
   `approved`; if it stays `null` for long, clear the cname and set it again), then
   `gh api -X PUT repos/PastaPastaPasta/govhub/pages -F https_enforced=true`.
4. Turn the Cloudflare proxy on (orange cloud). The zone's SSL mode must be **Full (strict)** (Flexible loops on GitHub's
   HTTPS redirect). Keep an eye on `https_certificate.state` at renewal time: GitHub renews the certificate through the proxied
   record.
5. Framing headers: GitHub Pages ignores `public/_headers`, so add a Cloudflare response-header Transform Rule for
   `http.host eq "gov.dashhq.org"` setting `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
   (also `X-Content-Type-Options: nosniff`). The API token needs **Zone > Transform Rules > Edit** for that. Until then the app
   renders only an "open in its own tab" notice inside a frame (`app/frame.tsx`).

Expect a few minutes of downtime between steps 2 and 3: GitHub redirects the github.io URLs to gov.dashhq.org at once, while
the build still in place points its assets at `/govhub/` and the certificate is not issued yet (the app needs HTTPS for
`crypto.subtle` and WebAuthn). Do the cutover in one sitting. Check that the WASM is served compressed:
`curl -sI -H 'Accept-Encoding: gzip, br' https://gov.dashhq.org/assets/<wasm_sdk_bg-*.wasm> | grep -i content-encoding`.

Cloudflare Web Analytics: turn off its automatic setup for gov.dashhq.org in the Cloudflare dashboard (privacy; it would inject `static.cloudflareinsights.com/beacon.min.js`, which the app's CSP blocks anyway, so the CSP stays as it is).

Everything the app keeps in the browser (settings, theme, sign-in, keyring, badge state, caches) is per origin, so it does not
move from the old address. Passkeys are bound to the domain too: a passkey added on `pastapastapasta.github.io` does not work on
gov.dashhq.org. Users sign in again with their recovery phrase or key (and add a passkey again). Once the custom domain is set,
every github.io URL redirects, so the old origin's storage can no longer be opened: custom settings have to be exported there
(Settings > Export, import and share) before the switch and imported on gov.dashhq.org.
