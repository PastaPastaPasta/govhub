// Live testnet voting runs: a guard on the browser context that lets a vote out ONLY for the one masternode the run is about, and
// never for a reserved one (testnet-mn-keys.ts). The e2e identity's saved keyring holds other keys (reserved masternode-27 among
// them), so a composer that selects "all masternodes" by mistake must be stopped before any POST /v1/votes leaves the browser.
// Cancels pass (they can only take a vote back). Everything blocked is counted; a run asserts that nothing was.
import type { BrowserContext, Route } from '@playwright/test';
import { reservedTestnetMnAddresses } from '../scripts/testnet-mn-keys.ts';

export interface LiveVoteGuard {
  /** the allowed masternode's collateral, `txid:index` */
  allowed: string;
  /** POST /v1/votes stopped here (collateral and outcome only) */
  blocked: Array<{ collateral: string; outcome: unknown }>;
}

interface Mn {
  proTxHash: string;
  collateralTxid: string;
  collateralIndex: number;
  votingAddress: string;
}

/**
 * Installs the guard. `bridge`: the testnet bridge's base URL (its /v1/mnlist maps voting addresses to collaterals). `onVote`: the
 * run's own handling of an allowed vote POST (default: sent on unchanged).
 */
export async function guardLiveVotes(context: BrowserContext, o: { bridge: string; proTxHash: string; onVote?: (route: Route, body: Record<string, unknown>) => Promise<void> }): Promise<LiveVoteGuard> {
  const res = await fetch(`${o.bridge.replace(/\/+$/, '')}/v1/mnlist`);
  if (!res.ok) throw new Error(`the bridge's masternode list answered HTTP ${res.status}`);
  const list = ((await res.json()) as { masternodes: Mn[] }).masternodes;
  const col = (m: Pick<Mn, 'collateralTxid' | 'collateralIndex'>) => `${m.collateralTxid.toLowerCase()}:${m.collateralIndex}`;
  const reservedAddrs = new Set(reservedTestnetMnAddresses());
  if (reservedAddrs.size < 4) throw new Error('the reserved masternodes were not all found in testnet.yml');
  const reserved = new Set(list.filter((m) => reservedAddrs.has(m.votingAddress)).map(col));
  const mine = list.find((m) => m.proTxHash === o.proTxHash);
  if (!mine) throw new Error(`masternode ${o.proTxHash.slice(0, 12)}… is not in the bridge's list`);
  if (reservedAddrs.has(mine.votingAddress) || reserved.has(col(mine))) throw new Error('that masternode is reserved: pick another one');
  const g: LiveVoteGuard = { allowed: col(mine), blocked: [] };
  await context.route(/\/v1\/votes$/, async (route) => {
    const r = route.request();
    if (r.method() !== 'POST') return route.fallback();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.postData() ?? '{}') as Record<string, unknown>;
    } catch {
      /* unreadable: blocked below */
    }
    const c = `${String(body.collateralTxid).toLowerCase()}:${String(body.collateralIndex)}`;
    // only the run's masternode; a reserved one never (already implied, kept explicit on purpose)
    if (c !== g.allowed || reserved.has(c)) {
      g.blocked.push({ collateral: c, outcome: body.outcome });
      return route.abort('blockedbyclient');
    }
    return o.onVote ? o.onVote(route, body) : route.fallback();
  });
  return g;
}
