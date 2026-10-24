// Flows executed INSIDE the browser page (driven by run.mjs through window.live). Read-only: nothing is ever broadcast.
// Every flow returns plain JSON and never throws; failures are recorded in the result.
import {
  BloomFilter, Dapi, GrpcError, classifyScript, hex, matchAllFilter, parseTx, unhex,
  type VerifiedTransaction, type Watcher,
} from '../../src/index.ts';

const COLLATERAL = '3451d292d461d1255007392a43d0da7b47eed938ff9a1234fb06ae19157fa365';
const COLLATERAL_HEIGHT = 2559683;
const COLLATERAL_BLOCK = '000000000000002411139f9e5be8c3cd0ebecdfbe1815888f8e299afc871cab0';

const now = () => performance.now();
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const errInfo = (e: unknown) => ({ name: (e as Error)?.name, code: (e as GrpcError)?.code, message: String((e as Error)?.message ?? e).slice(0, 300), network: !!(e as GrpcError)?.network });
async function attempt<T extends object>(fn: () => Promise<T>) {
  const t0 = now();
  try { const r = await fn(); return { ok: true as const, ms: Math.round(now() - t0), ...r }; } catch (e) { return { ok: false as const, ms: Math.round(now() - t0), error: errInfo(e) }; }
}
async function waitFor(pred: () => boolean, ms: number, step = 100): Promise<boolean> {
  const t0 = now();
  while (now() - t0 < ms) { if (pred()) return true; await sleep(step); }
  return pred();
}

// X11 and BLS are loaded lazily, exactly as an app would to keep them out of its first bundle
let dapi!: Dapi;
const loaded = { x11: 0, bls: 0 };
const mk = () => new Dapi({
  verifiers: async () => {
    const [{ x11 }, { verifyChainLock }] = await Promise.all([import('../../src/x11.ts'), import('../../src/bls.ts')]);
    loaded.x11++; loaded.bls++;
    return { hashHeader: x11, verifyChainLock };
  },
});

const summary = (v: VerifiedTransaction) => ({
  txid: v.txid, height: v.height, blockHash: v.blockHash, confirmations: v.confirmations, chainLocked: v.chainLocked, instantLocked: v.instantLocked,
  proof: v.proof, node: v.node, rawBytes: v.raw.length,
});

const flows = {
  async bootstrap() {
    dapi = mk();
    return attempt(async () => {
      const nodes = await dapi.ready();
      const best = await dapi.getBestBlockHeight();
      return { nodes: nodes.length, height: best.height, bestBlockHash: best.bestBlockHash, node: best.node };
    });
  },

  /** An old tx: ~750+ confirmations, so a 750-header X11 chain + BLS ChainLock + SML agreement + 4 quorum base blocks. */
  async verifiedCollateral() {
    const cold = await attempt(async () => summary(await dapi.getVerifiedTransaction(COLLATERAL)));
    const warm = await attempt(async () => summary(await dapi.getVerifiedTransaction(COLLATERAL)));
    return { cold, warm, loaded };
  },

  /** A recent confirmed tx from a block a few blocks below the tip, plus that block's coinbase. */
  async verifiedRecent() {
    return attempt(async () => {
      const best = await dapi.getBestBlockHeight();
      const { block } = await dapi.getBlock({ height: best.height - 6 });
      const plain = block.txs.find((t, i) => i > 0 && t.type === 0) ?? block.txs[0]!;
      const v = await dapi.getVerifiedTransaction(plain.txid);
      const cb = await dapi.getVerifiedTransaction(block.txs[0]!.txid);
      return { tipHeight: best.height, plain: summary(v), coinbase: summary(cb) };
    });
  },

  async notFound() {
    const t = await attempt(async () => summary(await dapi.getVerifiedTransaction('ab'.repeat(32))));
    return t;
  },

  async sml() {
    return attempt(async () => {
      const sml = await dapi.getSml({ force: true });
      const before = dapi.pool.size;
      const refresh = await dapi.refreshNodesFromSml();
      return {
        blockHash: sml.blockHash, height: sml.height, agreedBy: sml.agreedBy, asked: sml.asked, mnCount: sml.mnCount, evonodes: sml.evonodes.length,
        quorums400: sml.quorums.filter((q) => q.llmqType === 2).map((q) => ({ hash: q.quorumHash, baseHeight: q.baseHeight })).length,
        poolBefore: before, poolAfter: refresh.count, added: refresh.added,
      };
    });
  },

  async watchNoDeposit() {
    return attempt(async () => {
      const events = { tx: 0, locks: 0, blocks: 0, errors: [] as string[] };
      const t0 = now();
      const w = await dapi.watchAddressForDeposit(crypto.getRandomValues(new Uint8Array(20)), {
        onTx: () => { events.tx++; }, onIsLock: () => { events.locks++; }, onBlock: () => { events.blocks++; },
        onError: (e, c) => events.errors.push(`${c.phase}: ${(e as Error).message}`),
      });
      const readyMs = Math.round(now() - t0);
      const stats = w.stats();
      await sleep(4000);
      const during = w.stats();
      w.cancel(); await w.closed;
      return { readyMs, opened: stats.opened.length, liveAtReady: stats.live, liveDuring: during.live, filterBytes: w.filter.vData.length, fromHeight: w.fromHeight, events };
    });
  },

  /** Positive control: a real P2PKH hash160 from the collateral tx, replayed from its block. */
  async watchPositive() {
    return attempt(async () => {
      const { value: claims } = await dapi.call((core) => core.getTransaction(COLLATERAL));
      const tx = parseTx(claims.raw);
      const p2pkh = tx.outputs.map((o) => classifyScript(o.script)).find((c) => c.type === 'p2pkh');
      if (!p2pkh || p2pkh.type !== 'p2pkh') throw new Error('no p2pkh output in the collateral tx');
      const got: { txid: string; matches: number[]; node: string }[] = [];
      let blocks = 0;
      const w = await dapi.watchAddressForDeposit(p2pkh.hash, {
        onTx: (e) => got.push({ txid: e.tx.txid, matches: e.matches, node: e.node }), onIsLock: () => {}, onBlock: () => { blocks++; },
      }, { fromHeight: COLLATERAL_HEIGHT });
      const found = await waitFor(() => got.some((g) => g.txid === COLLATERAL), 15000);
      const stats = w.stats();
      w.cancel(); await w.closed;
      return { found, deliveries: got.length, distinctTxids: new Set(got.map((g) => g.txid)).size, blocks, dupes: stats.dupes, firstBy: stats.firstBy };
    });
  },

  /** The IS-lock path: match-all filter through the same merged-stream watcher; waits for a live IS-lock (up to 90 s). */
  async watchIsLock() {
    return attempt(async () => {
      const txs = new Set<string>();
      const locks: { txid: string; bytes: number; known: boolean; sigBytes: number; node: string; hex: string }[] = [];
      let blocks = 0, dupTxDeliveries = 0;
      const errors: string[] = [];
      const best = await dapi.getBestBlockHeight();
      const w = await dapi.watchTransactions(matchAllFilter(), {
        onTx: (e) => { if (txs.has(e.tx.txid)) dupTxDeliveries++; txs.add(e.tx.txid); },
        onIsLock: (e) => { locks.push({ txid: e.lock.txid, bytes: e.bytes.length, known: e.known, sigBytes: e.lock.signature.length, node: e.node, hex: hex(e.bytes) }); },
        onBlock: () => { blocks++; },
        onError: (e, c) => errors.push(`${c.phase}: ${(e as Error).message}`),
      }, { fromHeight: best.height - 1 });
      const got = await waitFor(() => locks.length >= 1, 120_000, 200);
      await sleep(3000); // let the other nodes' copies of the same lock arrive, so de-duplication is exercised
      const stats = w.stats();
      w.cancel(); await w.closed;
      const distinct = new Set(locks.map((l) => l.hex));
      return {
        gotIsLock: got, locks: locks.map(({ hex: _h, ...l }) => l), distinctLocks: distinct.size, deliveredLocks: locks.length, txs: txs.size, dupTxDeliveries, blocks,
        errors: errors.slice(0, 5), dupes: stats.dupes, firstBy: stats.firstBy, opened: stats.opened.length,
        // every distinct lock's txid was seen as a raw tx first (IS-lock arrives after the tx)
        allKnown: locks.every((l) => l.known),
      };
    });
  },

  /** Cost of X11 in this browser: 80-byte headers per second (drives the maxHeaderSpan default). */
  async x11Bench() {
    const { x11 } = await import('../../src/x11.ts');
    const { block } = await dapi.getBlock({ height: 2559683 });
    const h = block.header.raw;
    x11(h); // warm up
    const n = 300, t0 = now();
    for (let i = 0; i < n; i++) x11(h);
    return { headers: n, totalMs: Math.round(now() - t0), msPerHeader: +((now() - t0) / n).toFixed(2) };
  },

  async poolBudget() {
    return { sizes: dapi.pool.size, used: Object.fromEntries(dapi.pool.list().map((n) => [n, dapi.pool.used(n)]).filter(([, u]) => (u as number) > 0)) };
  },

  /** Bloom filter sanity inside the browser (real crypto.getRandomValues tweak). */
  async bloom() {
    const f = new BloomFilter(1).insert(unhex('9c12930edd1be98a0c0752c0a4bc1f3ee65587c9'));
    return { bytes: f.vData.length, hashFuncs: f.nHashFuncs, contains: f.contains(unhex('9c12930edd1be98a0c0752c0a4bc1f3ee65587c9')) };
  },

  expected: { COLLATERAL, COLLATERAL_HEIGHT, COLLATERAL_BLOCK },
};

declare global { interface Window { live: typeof flows & { Watcher?: Watcher } } }
window.live = flows;
