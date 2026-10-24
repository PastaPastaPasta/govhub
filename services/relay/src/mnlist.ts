// Cached view of Core's registered masternodes (`protx list registered true`): collateral outpoint -> voting key id and PoSe state.
// Refreshed when older than the TTL, and on a miss at most once per MISS_REFRESH_MIN_S (so unknown outpoints cannot be used to hammer Core).
import { decodeAddress, type Network } from '@govhub/verify';
import { rpcMessage, type CoreClient, type ProTxEntry } from './core/rpc.ts';
import { log, type Clock } from './log.ts';

export interface MnEntry {
  collateralTxid: string;
  collateralIndex: number;
  /** state.PoSeBanHeight !== -1. voteraw uses GetValidMNByCollateral, so a banned MN cannot vote. */
  banned: boolean;
  /** hash160 of the voting key (state.votingAddress); null if the address is not a P2PKH address of this network. */
  votingKeyId: Uint8Array | null;
}

const MISS_REFRESH_MIN_S = 10;

export class MnDirectory {
  private readonly core: CoreClient;
  private readonly network: Network;
  private readonly clock: Clock;
  private readonly ttlS: number;
  private map = new Map<string, MnEntry>();
  private fetchedAt = -Infinity;
  private inflight: Promise<void> | null = null;

  constructor(core: CoreClient, network: Network, clock: Clock, ttlS: number) {
    this.core = core;
    this.network = network;
    this.clock = clock;
    this.ttlS = ttlS;
  }

  /** The masternode owning this collateral outpoint, or null. Throws when Core cannot be asked and nothing is cached. */
  async lookup(txid: string, n: number): Promise<MnEntry | null> {
    const key = `${txid.toLowerCase()}-${n}`;
    if (this.clock() - this.fetchedAt > this.ttlS) await this.refresh();
    const hit = this.map.get(key);
    if (hit) return hit;
    if (this.clock() - this.fetchedAt >= MISS_REFRESH_MIN_S) {
      await this.refresh();
      return this.map.get(key) ?? null;
    }
    return null;
  }

  /** One refresh at a time. A failed refresh keeps serving the previous list (if any) and is retried by the next lookup. */
  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const list = await this.core.call<ProTxEntry[]>('protx', ['list', 'registered', true]);
        const map = new Map<string, MnEntry>();
        for (const e of list) {
          const decoded = typeof e.state?.votingAddress === 'string' ? decodeAddress(e.state.votingAddress, this.network) : null;
          map.set(`${String(e.collateralHash).toLowerCase()}-${e.collateralIndex}`, {
            collateralTxid: String(e.collateralHash).toLowerCase(),
            collateralIndex: e.collateralIndex,
            banned: e.state.PoSeBanHeight !== -1,
            votingKeyId: decoded && decoded.type === 'p2pkh' ? decoded.hash160 : null,
          });
        }
        this.map = map;
        this.fetchedAt = this.clock();
      } catch (e) {
        if (this.map.size === 0) throw e;
        log.warn('masternode list refresh failed, using the previous list', { rpc: rpcMessage(e) !== null });
        // Do not hammer a struggling Core: count the failed attempt towards the TTL / miss throttle.
        this.fetchedAt = this.clock();
      }
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}
