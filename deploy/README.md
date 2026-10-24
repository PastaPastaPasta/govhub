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
   HTTP :8787 (read-only API) --- optional caddy (TLS + CORS)
```

Slots for `relay`, `issuer` and `accounts` are marked in `docker-compose.yml`. They are not built
yet.

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
| `docker-compose.yml` | base stack, **mainnet**: `dashd`, `bridge`, `caddy` (profile `proxy`) |
| `docker-compose.testnet.yml` | override: v24 image, testnet Core, testnet Platform |
| `docker-compose.regtest.yml` | override: isolated chain, `PUBLISH=0`, no identity secret |
| `docker-compose.p2p.yml` | override: publish dashd's P2P port (set `DASHD_P2P_PORT`) |
| `.env.example` | every variable, commented, no secrets |
| `dashd/dash.conf`, `dashd/entrypoint.sh` | Core config template and the wrapper that adds network, RPC credentials and `dbcache` |
| `caddy/Caddyfile` | TLS reverse proxy; GET/HEAD/OPTIONS only, CORS handled here |
| `scripts/init.sh` | prerequisite check, secrets directory (mode 0700), `.env` |
| `scripts/smoke-regtest.sh` | end-to-end regtest test |

Choosing a network means choosing which files are layered. `COMPOSE_FILE` in `.env` does it, and
`init.sh --network` writes it:

```
mainnet  COMPOSE_FILE=docker-compose.yml
testnet  COMPOSE_FILE=docker-compose.yml:docker-compose.testnet.yml
regtest  COMPOSE_FILE=docker-compose.yml:docker-compose.regtest.yml
+ P2P    append :docker-compose.p2p.yml          (and set DASHD_P2P_PORT=9999 / 19999)
+ TLS    COMPOSE_PROFILES=proxy                  (and set DOMAIN)
```

Two stacks on one host (say mainnet and testnet) need **different `COMPOSE_PROJECT_NAME`,
`GOVHUB_SUBNET` and `BRIDGE_PORT`** in their `.env` files, or the second `up` replaces the first
and shares its volumes (a testnet bridge would write into the mainnet archive). `init.sh --network`
sets all three per network (`govhub`, `govhub-testnet`, `govhub-regtest`), so run it once per
network, each in its own checkout directory. Volume names are `<project>_dashd-data` and
`<project>_bridge-data`; the commands below say `govhub_...`, so substitute your project name.

## 3. Hardware, disk and sync time

| | mainnet | testnet |
|---|---|---|
| Disk, Core datadir with `txindex=1` | **~59 GB measured**; provision **150 GB** SSD | smaller (*estimate* 15-30 GB, not measured) |
| Disk, bridge SQLite archive | tens of MB per month (*estimate*, not measured) | less |
| RAM | 4 GB works, 8 GB is comfortable (`dbcache` 1024 MiB plus Core's overhead) | 4 GB |
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

Skip this section while `PUBLISH=0`. With `PUBLISH=1` the bridge writes `proposal`, `tally` and
`cycle` documents to a `gov` contract, signed by an identity you own.

### 5.1 Registering your own `gov` contract

The `gov` contract is **owner-only**: every type has `creationRestrictionMode: 1`, so only the
identity that registered the contract can publish into it. A third-party bridge therefore cannot
write to ours. It registers its own copy, and the client merges bridges by `govHash` (PLAN
section 1.1). The `bridgeIdentityId` and contract id you publish are what users put in their
endpoint registry.

1. Take the schema from `packages/contracts-v1/gov.json`. It is the `documentSchemas` map.
2. Create the contract with a `DataContractCreate` transition signed by the identity's **CRITICAL**
   authentication key (HIGH is accepted by consensus, CRITICAL is our policy for contract
   creation). `spikes/sdk5/scripts/estimate-costs.ts` shows the evo-sdk 5.x calls end to end.
3. Cost: 0.1 DASH + 0.02 per document type + 0.01 per index. For `gov` (4 types, 6 indexes) that is
   **0.24 DASH** plus a small storage charge (about 0.0022 DASH, measured on the other contracts).
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
3. Fund the identity by topping it up with DASH. The plan's estimate is on the order of
   0.015 DASH per day while tallies are republished hourly (PLAN section 6.2), plus the cost of
   `proposal` and `cycle` documents. Watch the balance and raise the interval
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
   into an image. Permissions: `scripts/init.sh` re-applies them (0600, or 0644 inside the 0700
   directory when your host user is not uid 1000, so the container user can read it).
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

Replace `govhub_bridge-data` with `<project>_bridge-data`. The volume must be mounted read-write
even though the command only reads: SQLite's WAL mode needs the `-shm` file, and `.backup` is the
online-backup API, safe against a live writer. I ran this against a WAL-mode database and the copy
passed `PRAGMA integrity_check` and had the expected rows. The image is a third-party SQLite CLI
(`keinos/sqlite3`, pinned by digest above; it runs as root here only to read the volume): use your
own SQLite image if you prefer. A `bridge backup <file>` command in the bridge image would make this
unnecessary, and section 9 asks for one. Verify each copy with
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
  compose network. On a Linux host, anyone with a shell there can also reach the container's IP
  directly (RPC is password-protected; ZMQ has no authentication but carries public data), so do
  not give untrusted users host accounts. The wallet is disabled outside regtest. Do not
  "temporarily" publish these ports to debug.
- **Published ports.** Bridge: loopback by default (`BRIDGE_BIND=127.0.0.1`). Caddy: 80/443. dashd
  P2P only with `docker-compose.p2p.yml`. Docker bypasses `ufw`/`firewalld` rules for published
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
- **The API is read-only.** Caddy rejects anything but GET/HEAD/OPTIONS and owns the CORS headers
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

**Backup (requested).** A `bridge backup <file>` subcommand that uses SQLite's online-backup API,
so operators do not need a third-party SQLite image (section 6).

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
