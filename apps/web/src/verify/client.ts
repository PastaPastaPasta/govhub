// Page-side wrapper around the verification worker: one shared worker, promise per request.
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; onProgress?: (m: string) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'govhub-verify' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.kind === 'progress') return p.onProgress?.(m.message);
    pending.delete(m.id);
    if (m.kind === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'verification worker crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export function runVerification<K extends WorkerRequest['kind']>(
  req: Extract<Req, { kind: K }>,
  onProgress?: (message: string) => void,
): Promise<Extract<WorkerResponse, { kind: K }>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: WorkerResponse) => void, reject, ...(onProgress ? { onProgress } : {}) });
    getWorker().postMessage({ ...req, id });
  });
}
