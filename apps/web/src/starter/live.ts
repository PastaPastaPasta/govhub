// The real deps of starter/client.ts: proved Platform reads through the badge reader (issuerKey + revocation of the pinned starter
// identity, accepted by @govhub/badge's reader rules) and the badge worker for blinding and every request to the issuer or faucet.
import type { Registry } from '../config/registry.ts';
import { badgeQuery } from '../badge/queries.ts';
import { BadgeReader } from '../badge/reader.ts';
import { badgeWorker } from '../badge/workerClient.ts';
import { starterDepsFromReader, type StarterDeps } from './client.ts';
import type { StarterConfig } from './config.ts';

let cached: { key: string; deps: StarterDeps } | null = null;

export function liveStarterDeps(r: Registry, cfg: StarterConfig): StarterDeps {
  const key = JSON.stringify([r.platformNetwork, r.platform, cfg]);
  if (cached?.key === key) return cached.deps;
  const reader = new BadgeReader({ net: cfg.network, contractId: cfg.contractId, query: (q) => badgeQuery(r, cfg.contractId, q), issuers: [] });
  const deps = starterDepsFromReader(reader, { network: cfg.network, issuer: cfg.issuer, faucetUrl: cfg.faucetUrl, worker: badgeWorker });
  cached = { key, deps };
  return deps;
}
