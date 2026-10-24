// Evonode discovery. The quorum service lists nodes (CORS *); usable ones are ENABLED with versionCheck "success".
// The URL is a user-replaceable setting: pass your own (any endpoint returning the same JSON shape) or a static list.
export const MAINNET_NODE_LIST = 'https://quorums.mainnet.networks.dash.org/masternodes';
export const TESTNET_NODE_LIST = 'https://quorums.testnet.networks.dash.org/masternodes';

/** "host:port" with a DNS name or IPv4 address. Anything else is dropped before it can become part of a request URL. */
const ENDPOINT = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?:\d{1,5}$/;
export const isEndpoint = (s: unknown): s is string => typeof s === 'string' && ENDPOINT.test(s) && Number(s.slice(s.lastIndexOf(':') + 1)) <= 65535;

export interface FetchNodesOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Keep only nodes the service marks ENABLED with versionCheck "success" (default). Off keeps every ENABLED node. */
  requireVersionCheck?: boolean;
}

interface ServiceNode { status?: string; versionCheck?: string; addresses?: { platform_https?: unknown[] } }

/** Fetch `host:port` platform_https endpoints from a quorum-service-compatible URL. */
export async function fetchNodes(url: string = MAINNET_NODE_LIST, { signal, timeoutMs = 10_000, requireVersionCheck = true }: FetchNodesOptions = {}): Promise<string[]> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) ctrl.abort(signal.reason); else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error('node list timeout')), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`node list HTTP ${res.status}`);
    const body = (await res.json()) as { data?: ServiceNode[] };
    if (!Array.isArray(body.data)) throw new Error('node list: unexpected response shape');
    const out: string[] = [];
    for (const n of body.data) {
      if (n.status !== 'ENABLED' || (requireVersionCheck && n.versionCheck !== 'success')) continue;
      const e = n.addresses?.platform_https?.[0];
      if (isEndpoint(e)) out.push(e);
    }
    return out;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const rand = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

/** Fisher-Yates sample of k distinct entries. */
export function sample<T>(arr: readonly T[], k: number, random: () => number = rand): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a.slice(0, k);
}
