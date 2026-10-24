import { HttpBridge, type Bridge } from './bridge.ts';
import { FixtureBridge } from './fixtures.ts';
import type { BridgeDescriptor } from '../verify/protocol.ts';

export function makeBridge(d: BridgeDescriptor): Bridge {
  return d.kind === 'fixture' ? new FixtureBridge() : new HttpBridge(d.name, d.base);
}
