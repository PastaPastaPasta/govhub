# govhub

A Dash governance portal: the features of dashcentral.org, plus Platform contested-resource
voting (EvoVote). All application data lives on Dash Platform. Browsers read Platform directly
and verify the proofs. Core-side data comes over DAPI and is checked against the chain where
possible.

Status: **phase 0 (spikes)**. Nothing here is production-ready.

- Design: [`docs/PLAN.md`](docs/PLAN.md) (r3.1). [`docs/PLAN-r2.md`](docs/PLAN-r2.md) holds the
  earlier revision, including the shelved ZK badge design.
- Phase 0 spikes: [`spikes/`](spikes/). Each spike is a standalone package with its own README
  and findings.
- Shared code: [`packages/`](packages/).

The frontend uses our backends by default. Every backend can be replaced by the user: bridge,
relay, badge issuer, accounts, faucet, and DAPI node source.

## License

MIT
