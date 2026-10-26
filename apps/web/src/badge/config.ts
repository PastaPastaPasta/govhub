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
  /**
   * A Private badge is posted only if the issuer reported at least this many tokens for the epoch before (review R1):
   * a badge among two or three stands out. The issuerReport has one count per epoch, Standard and private tokens together, so it
   * cannot say how many chose a private mode (SR-23); the minimum is set higher to leave room for the Standard tokens in it.
   * Testnet's value suits a demo with a handful of test masternodes.
   */
  minAnonymitySet: number;
  /**
   * An issuerReport above this is implausible (more tokens than masternodes, with a margin) and flags the issuer (review M1, N4).
   * The reader uses the proven masternode count (anchored chain, SML checked against the CbTx) when it can; this pinned value is
   * the cap and the fallback.
   */
  maxPlausibleTokens: number;
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
    minAnonymitySet: 5,
    // testnet has about 150 masternodes (2026-10)
    maxPlausibleTokens: 500,
  },
  // mainnet: contract and issuer identity 9MJV… created 2026-10-26 from the operations seed (deploy/README.md 13.3, 13.4).
  // About 2,400 masternodes (2026-10); the bound needs updating if that grows a lot.
  mainnet: {
    contractId: 'Acfd9ZKRFdAAxpSab5kb9zP2P5bKQQ4kZVqeBnck3pZi',
    defaultIssuers: [{ name: 'govhub', identityId: '9MJV17bn7C9xu1n3nopcZzScTnac3TNUjR17HmpKY4Cr', url: 'https://gov-issuer.dashhq.org', enabled: true }],
    minAnonymitySet: 20,
    maxPlausibleTokens: 4_000,
  },
};

const KEY = (net: CoreNetwork) => `govhub.badge.trust.v1.${net}`;
const ALL_DEFAULTS = Object.values(BADGE_NETWORKS).flatMap((n) => n.defaultIssuers);
const DEFAULT_NAMES = new Set(ALL_DEFAULTS.map((i) => i.name.toLowerCase()));
const DEFAULT_IDS = new Set(ALL_DEFAULTS.map((i) => i.identityId));

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
    // printable ASCII only, so a look-alike of a default issuer's name cannot pass the name checks (N16)
    const raw = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').slice(0, 40).trim() : '';
    const name = /^[\x20-\x7e]+$/.test(raw) ? raw : '';
    const url = httpsUrl(o.url);
    if (!name) errors.push(`issuer ${i + 1}: a name in plain letters, digits and punctuation is required`);
    else if (!isIdentifier(o.identityId)) errors.push(`${name}: identityId must be a base58 identity id`);
    else if (!url) errors.push(`${name}: url must be an https URL without credentials, query or fragment`);
    else if (issuers.some((s) => s.identityId === o.identityId)) errors.push(`${name}: this identity is already on the list`);
    else if (issuers.some((s) => s.name.toLowerCase() === name.toLowerCase())) errors.push(`${name}: another issuer on the list has this name`);
    else if (DEFAULT_NAMES.has(name.toLowerCase()) && !DEFAULT_IDS.has(o.identityId as string)) errors.push(`${name}: this name belongs to a default issuer`);
    else issuers.push({ name, identityId: o.identityId as string, url, enabled: o.enabled !== false });
  }
  return { issuers, errors };
}

/** `localStorage` throws when site data is blocked: read it inside a try (a default parameter would throw outside it). */
function local(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function loadTrustList(net: CoreNetwork, storage: Pick<Storage, 'getItem'> | undefined = local()): TrustedIssuer[] {
  try {
    const raw = storage?.getItem(KEY(net));
    if (raw) return parseTrustList(JSON.parse(raw)).issuers;
  } catch {
    /* fall through to the defaults */
  }
  return BADGE_NETWORKS[net].defaultIssuers.map((i) => ({ ...i }));
}

export function saveTrustList(net: CoreNetwork, list: TrustedIssuer[], storage: Pick<Storage, 'setItem'> | undefined = local()): void {
  try {
    storage?.setItem(KEY(net), JSON.stringify(list));
  } catch {
    /* not persisted: the list still applies to this page */
  }
}

export function resetTrustList(net: CoreNetwork, storage: Pick<Storage, 'removeItem'> | undefined = local()): TrustedIssuer[] {
  try {
    storage?.removeItem(KEY(net));
  } catch {
    /* nothing stored */
  }
  return BADGE_NETWORKS[net].defaultIssuers.map((i) => ({ ...i }));
}

export const isDefaultIssuer = (net: CoreNetwork, id: string): boolean => BADGE_NETWORKS[net].defaultIssuers.some((i) => i.identityId === id);
