/// <reference lib="webworker" />
// Badge worker (PLAN §8.5): runs workerOps.ts off the main thread. The code is the portal's own pinned build (@govhub/badge),
// never anything served by an issuer.
import { errText } from '../lib/format.ts';
import type { BadgeWorkerRequest, BadgeWorkerResponse } from './protocol.ts';
import { handleBadgeCall } from './workerOps.ts';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: BadgeWorkerResponse) => self.postMessage(m);

self.onmessage = (ev: MessageEvent<BadgeWorkerRequest>) => {
  const m = ev.data;
  handleBadgeCall(m).then(post, (e: unknown) => post({ id: m.id, kind: 'error', message: errText(e) }));
};
