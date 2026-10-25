# govhub

A Dash governance portal: the features of dashcentral.org, plus Platform contested-resource
voting (EvoVote). All application data lives on Dash Platform. Browsers read Platform directly
and verify the proofs. Core-side data comes over DAPI and is checked against the chain where
possible.

Status: **phase 0 (spikes)**. Nothing here is production-ready.

- Trust model: [`docs/TRUST.md`](docs/TRUST.md) says what the browser proves, and what each backend (bridge, relays,
  badge issuers, faucet, DAPI and Platform nodes) could still lie about or hide.
- Design: [`docs/PLAN.md`](docs/PLAN.md) (r3.1). [`docs/PLAN-r2.md`](docs/PLAN-r2.md) holds the
  earlier revision, including the shelved ZK badge design.
- Phase 0 spikes: [`spikes/`](spikes/). Each spike is a standalone package with its own README
  and findings.
- Shared code: [`packages/`](packages/).

## Running your own backend

[`deploy/`](deploy/) is the self-hosting kit: a Dash Core node plus the bridge, started with
`docker compose up`, for mainnet, testnet or an isolated regtest chain, with optional TLS and CORS.
See [`deploy/README.md`](deploy/README.md) for hardware, sync, backups (the bridge's archive is
history Core discards), upgrades and security. Quick start:

```sh
cd deploy && scripts/init.sh --network testnet && docker compose up -d --build
```

The frontend uses our backends by default. Every backend can be replaced by the user: bridge,
relay, badge issuer, accounts, faucet, and DAPI node source.

## License

MIT
