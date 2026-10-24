// Deposit watching (loaded on first use by Dapi.watchTransactions / watchAddressForDeposit).
import { BloomFilter, type BloomFilterData } from './bloom.ts';
import { bytesEqual, hex } from './bytes.ts';
import type { Dapi } from './client.ts';
import { type MerkleBlock, type Tx, classifyScript, parseInstantLock, parseMerkleBlock, parseTx } from './dash.ts';
import { AllNodesFailedError, VerificationError } from './errors.ts';
import { backoffMs } from './pool.ts';
import { mergeStreams } from './race.ts';
import type { DepositEvent, IsLockEvent, WatchHandlers, WatchOptions, Watcher } from './types.ts';

type Item =
  | { k: 'tx'; e: DepositEvent }
  | { k: 'is'; e: IsLockEvent }
  | { k: 'block'; b: MerkleBlock };

export async function watchTransactions(
  d: Dapi, filter: BloomFilterData, handlers: WatchHandlers, o: WatchOptions = {}, match: (tx: Tx) => number[] = () => [0],
): Promise<Watcher> {
  if (filter.vData.length < 200) throw new Error('bloom filter must be at least 200 bytes (smaller ones match everything on DAPI nodes)');
  await d.ready();
  const wanted = o.streams ?? 3, readyNeeded = Math.min(o.readyStreams ?? 2, wanted);
  const fromHeight = o.fromHeight ?? Math.max(0, (await d.getBestBlockHeight({ signal: o.signal })).height - (o.lookback ?? 3));
  const live = new Set<string>(), seenTx = new Set<string>();
  const onError = handlers.onError ?? (() => {});
  let open = 0, readyDone = false, resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });
  const noteOpen = () => { open++; if (!readyDone && open >= readyNeeded) { readyDone = true; resolveReady(); } };

  const merged = mergeStreams<Item>(
    () => { const n = d.pool.pick(1, live)[0]; if (n) live.add(n); return n; },
    (node, emit) => {
      let opened = false;
      d.pool.charge(node);
      const h = d.core(node).subscribeToTransactionsWithProofs(filter, { fromHeight }, (ev) => {
        try {
          if (ev.type === 'rawtxs') {
            for (const raw of ev.txs) {
              const tx = parseTx(raw), matches = match(tx);
              if (matches.length) emit('tx:' + tx.txid, { k: 'tx', e: { tx, raw, matches, node } });
            }
          } else if (ev.type === 'islocks') {
            for (const bytes of ev.messages) {
              try { emit('is:' + hex(bytes), { k: 'is', e: { lock: parseInstantLock(bytes), bytes, known: false, node } }); } catch (e) { onError(e, { phase: 'islock-parse', node }); }
            }
          } else {
            const b = parseMerkleBlock(ev.merkleBlock);
            if (!b.rootOk) throw new VerificationError('merkle', 'merkleblock root does not match its header');
            emit('mb:' + hex(b.header.raw), { k: 'block', b });
          }
        } catch (e) { onError(e, { phase: 'stream-event', node }); }
      }, { idleTimeoutMs: o.idleTimeoutMs ?? 300_000, connectTimeoutMs: d.options.timeoutMs ?? 15000, onOpen: () => { opened = true; noteOpen(); } });
      void h.closed.then(() => { live.delete(node); if (opened) open--; });
      return h;
    },
    (item, node) => {
      if (item.k === 'tx') { seenTx.add(item.e.tx.txid); handlers.onTx(item.e); }
      else if (item.k === 'is') {
        const e = { ...item.e, known: seenTx.has(item.e.lock.txid), node };
        void Promise.resolve().then(() => handlers.onIsLock(e)).catch((err) => onError(err, { phase: 'islock-persist', node }));
      } else handlers.onBlock?.(item.b, node);
    },
    {
      n: wanted, maxReplacements: o.maxReplacements ?? 100, replaceDelayMs: (k) => backoffMs(Math.min(k, 6), 200, 5000),
      onClose: (node, res) => {
        const r = res as { reason?: string; error?: unknown };
        if (r.reason === 'error') { d.pool.fail(node, r.error); onError(r.error, { phase: 'stream-closed', node }); }
      },
    },
  );
  const abort = () => merged.cancel();
  o.signal?.addEventListener('abort', abort, { once: true });
  void merged.closed.then(() => o.signal?.removeEventListener('abort', abort));

  const failure = () => new AllNodesFailedError(merged.stats().failed.map((f) => ({ node: f.node, error: new Error(f.error) })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure()), o.readyTimeoutMs ?? 15_000);
    void merged.closed.then(() => { if (!readyDone) reject(failure()); });
  });
  try {
    await Promise.race([ready, failed]);
  } catch (e) {
    merged.cancel();
    throw e;
  } finally {
    clearTimeout(timer);
    failed.catch(() => {}); // the losing branch must not surface as an unhandled rejection
  }
  return { cancel: () => merged.cancel(), closed: merged.closed, stats: merged.stats, filter, fromHeight };
}

export function watchAddressForDeposit(d: Dapi, pubKeyHash: Uint8Array, handlers: WatchHandlers, o: WatchOptions = {}): Promise<Watcher> {
  const filter = new BloomFilter(1).insert(pubKeyHash).toJSON();
  const paysHash = (tx: Tx): number[] => tx.outputs.flatMap((out, i) => {
    const c = classifyScript(out.script);
    return (c.type === 'p2pkh' || c.type === 'p2sh') && bytesEqual(c.hash, pubKeyHash) ? [i] : [];
  });
  return watchTransactions(d, filter, handlers, o, paysHash);
}
