// The coin's name as shown next to amounts: test coins are "tDASH", so a testnet amount never reads as real money.
import type { CoreNetwork } from '../data/types.ts';

export const unitFor = (network: CoreNetwork): string => (network === 'testnet' ? 'tDASH' : 'DASH');

let current = 'DASH';

/** The unit for the network the app shows now (set by the app provider when the data source changes). */
export const dashUnit = (): string => current;

export function setDashUnit(network: CoreNetwork): void {
  current = unitFor(network);
}
