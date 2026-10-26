# govhub

A place to follow, discuss and vote on Dash governance proposals. It does what dashcentral.org did, but your browser checks
the data against the Dash network itself. Proposals and votes come from the Dash network, and comments and profiles live on
Dash Platform.

Live at **[gov.dashhq.org](https://gov.dashhq.org)** (Dash mainnet, with Testnet and Dev profiles in Settings).

## Documentation

- [How govhub checks what it shows](https://gov.dashhq.org/about/verification) and [what we can and can't lie
  about](https://gov.dashhq.org/about/trust): the short versions, in the app.
- [`docs/TRUST.md`](docs/TRUST.md): the full trust model. What the browser proves, and what each server (bridge, relays,
  badge issuers, DAPI and Platform nodes) could still get wrong or hide.
- [`docs/privacy.md`](docs/privacy.md): what our hosted servers see and keep.
- [`docs/self-hosting.md`](docs/self-hosting.md): running your own bridge, relay or badge issuer, and how the app uses
  several servers at once.
- [`deploy/README.md`](deploy/README.md): the step-by-step setup guide for those servers.
- [`docs/RECOVERY.md`](docs/RECOVERY.md): getting DASH back from a sign-up or top-up that didn't finish.
- [`docs/PLAN.md`](docs/PLAN.md): the design. [`docs/PLAN-r2.md`](docs/PLAN-r2.md) is the earlier revision, including the
  shelved ZK badge design.

## Layout

- [`apps/web`](apps/web): the web app (static; React and evo-sdk).
- [`services/bridge`](services/bridge), [`services/relay`](services/relay), [`services/issuer`](services/issuer): the
  servers.
- [`packages/`](packages): shared code (verification, DAPI client, sign-in and keyring, contracts, badges, forum).
- [`spikes/`](spikes): phase 0 experiments, each with its own README and findings.

## Running your own servers

```sh
cd deploy && scripts/init.sh --network testnet && docker compose up -d --build
```

That starts a Dash Core node and an archive-only bridge. See [`docs/self-hosting.md`](docs/self-hosting.md) for what else
you can run and how to point the app at it.

## Supporting govhub

Donations to `XcLkMQensjHhr5r9SAUVm4meh2HFKaeAXG` pay for our servers' Platform fees and the machine they run on. What
that costs is in [`docs/self-hosting.md`](docs/self-hosting.md#what-it-costs).

## License

MIT
