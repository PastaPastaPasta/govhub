// MN badge settings (PLAN §8.6): the `badge` contract per Platform network and the reader's trust list of issuers.
// The default trust list is pinned here, in the open-source client, and changes only through public review; it ships with
// our issuer only. Users can add other issuers (anyone may run one) or turn ours off; the list lives in this browser.
//
// Epochs follow the Core chain of the PLATFORM network (Drive's $createdAtCoreBlockHeight), so the Dev profile (mainnet Core
// data on testnet Platform) shows testnet MN badges with testnet epoch parameters.
import { isIdentifier } from '@govhub/forum';
import type { CoreNetwork } from '../data/types.ts';

export interface TrustedIssuer {
  /** shown as "MN · vouched by <name>" */
  name: string;
  /** the issuer's Platform identity (owner of its issuerKey documents) */
  identityId: string;
  /** the issuer's API, on its own origin */
  url: string;
  enabled: boolean;
}

export interface BadgeNetworkConfig {
  /** the v1 `badge` contract (packages/contracts-v1/badge.json); empty = badges are not deployed on this network */
  contractId: string;
  defaultIssuers: readonly TrustedIssuer[];
}

/**
 * testnet: contract registered 2026-10-24 from the current badge.json (spki 294..422; the phase-0 contract
 * 3SrZbofJnMgWNiHFzpHc5u7wSRgCFJykZwKq3haqyMfc predates that cap and is not used). Issuer identity H62h… is separate from the
 * bridge and moderation identities.
 */
export const BADGE_NETWORKS: Readonly<Record<CoreNetwork, BadgeNetworkConfig>> = {
  testnet: {
    contractId: '2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU',
    defaultIssuers: [{ name: 'govhub', identityId: 'H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH', url: 'https://gov-issuer-testnet.dashhq.org', enabled: true }],
  },
  mainnet: { contractId: '', defaultIssuers: [] },
};

const KEY = (net: CoreNetwork) => `govhub.badge.trust.v1.${net}`;

function httpsUrl(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  try {
    const u = new URL(s);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Validates an untrusted trust list (from storage or an import); bad entries are reported and dropped. */
export function parseTrustList(v: unknown): { issuers: TrustedIssuer[]; errors: string[] } {
  const errors: string[] = [];
  const issuers: TrustedIssuer[] = [];
  for (const [i, x] of (Array.isArray(v) ? v : []).entries()) {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 40) : '';
    const url = httpsUrl(o.url);
    if (!name) errors.push(`issuer ${i + 1}: a name is required`);
    else if (!isIdentifier(o.identityId)) errors.push(`${name}: identityId must be a base58 identity id`);
    else if (!url) errors.push(`${name}: url must be an https URL without credentials, query or fragment`);
    else if (issuers.some((s) => s.identityId === o.identityId)) errors.push(`${name}: this identity is already on the list`);
    else issuers.push({ name, identityId: o.identityId as string, url, enabled: o.enabled !== false });
  }
  return { issuers, errors };
}

export function loadTrustList(net: CoreNetwork, storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): TrustedIssuer[] {
  try {
    const raw = storage?.getItem(KEY(net));
    if (raw) return parseTrustList(JSON.parse(raw)).issuers;
  } catch {
    /* fall through to the defaults */
  }
  return BADGE_NETWORKS[net].defaultIssuers.map((i) => ({ ...i }));
}

export function saveTrustList(net: CoreNetwork, list: TrustedIssuer[], storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  storage?.setItem(KEY(net), JSON.stringify(list));
}

export function resetTrustList(net: CoreNetwork, storage: Pick<Storage, 'removeItem'> | undefined = globalThis.localStorage): TrustedIssuer[] {
  storage?.removeItem(KEY(net));
  return BADGE_NETWORKS[net].defaultIssuers.map((i) => ({ ...i }));
}

export const isDefaultIssuer = (net: CoreNetwork, id: string): boolean => BADGE_NETWORKS[net].defaultIssuers.some((i) => i.identityId === id);
