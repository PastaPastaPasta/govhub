// Page-side wrapper around the badge worker: one shared worker, a promise per request.
import type { BadgeWorkerCall, BadgeWorkerRequest, BadgeWorkerResponse } from './protocol.ts';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: BadgeWorkerResponse) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'govhub-badge' });
  worker.onmessage = (ev: MessageEvent<BadgeWorkerResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.kind === 'error') p.reject(new Error(ev.data.message));
    else p.resolve(ev.data);
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'badge worker crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function badgeWorker<K extends BadgeWorkerRequest['kind']>(req: Extract<BadgeWorkerCall, { kind: K }>): Promise<Extract<BadgeWorkerResponse, { kind: K }>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: BadgeWorkerResponse) => void, reject });
    getWorker().postMessage({ ...req, id });
  });
}
