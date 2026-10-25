// Starter credit settings per Platform network: the pinned starter issuer (its own identity, never a badge issuer's), the `badge`
// contract its issuerKey documents live in, and the faucet that pays the starter. Like badges, epochs follow the Core chain of the
// PLATFORM network (EPOCH_PARAMS[platformNetwork]): the token's key is read from Platform, at Platform's core height.
import { BADGE_NETWORKS } from '../badge/config.ts';
import { DEFAULT_FAUCET, type Registry } from '../config/registry.ts';
import type { CoreNetwork } from '../data/types.ts';

export interface StarterIssuer {
  /** owner of the starter issuerKey documents (base58) */
  identityId: string;
  /** the issuer API (its /v1/starter routes), on its own origin */
  url: string;
}

/** Pinned here, in the open-source client, like the badge trust list; changes only through public review. */
export const STARTER_ISSUERS: Readonly<Record<CoreNetwork, StarterIssuer | null>> = {
  testnet: { identityId: '9Jwa6v2Bwj9TtDmgJGn3KV9qqXprYZUBEkKzkxzx3HD8', url: 'https://gov-issuer-testnet.dashhq.org' },
  mainnet: null,
};

export interface StarterConfig {
  network: CoreNetwork;
  issuer: StarterIssuer;
  /** the `badge` contract holding the starter issuer's issuerKey documents */
  contractId: string;
  faucetUrl: string;
}

/** null: no starter on this Platform network (yet). */
export function starterConfig(r: Pick<Registry, 'platformNetwork' | 'faucet'>): StarterConfig | null {
  const network = r.platformNetwork;
  const issuer = STARTER_ISSUERS[network];
  const contractId = BADGE_NETWORKS[network].contractId;
  if (!issuer || !contractId) return null;
  return { network, issuer, contractId, faucetUrl: r.faucet?.url ?? DEFAULT_FAUCET.url };
}
