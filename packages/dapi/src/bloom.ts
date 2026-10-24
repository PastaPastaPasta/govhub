// BIP37 bloom filter in the shape DAPI's TransactionsWithProofsRequest wants.
// DAPI nodes need vData >= 200 bytes: tiny filters (3 bytes for one element) saturate and match everything.

export const BLOOM_UPDATE_NONE = 0, BLOOM_UPDATE_ALL = 1, BLOOM_UPDATE_P2PUBKEY_ONLY = 2;
const MAX_BYTES = 36000, MAX_HASH_FUNCS = 50;
export const MIN_BLOOM_BYTES = 200;

export interface BloomFilterData { vData: Uint8Array; nHashFuncs: number; nTweak: number; nFlags: number }

function murmur3(seed: number, data: Uint8Array): number {
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  let h = seed >>> 0;
  const n = data.length - (data.length % 4);
  for (let i = 0; i < n; i += 4) {
    let k = (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24)) >>> 0;
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  const tail = data.length & 3;
  if (tail) {
    let k = 0;
    if (tail === 3) k ^= data[n + 2]! << 16;
    if (tail >= 2) k ^= data[n + 1]! << 8;
    k ^= data[n]!;
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export class BloomFilter implements BloomFilterData {
  vData: Uint8Array;
  nHashFuncs: number;
  nTweak: number;
  nFlags: number;
  /**
   * @param elements expected element count (>= 1)
   * @param fpRate target false-positive rate
   * @param tweak random by default
   * @param flags BLOOM_UPDATE_*; ALL makes the server also match spends of outputs it matched
   * @param minBytes never below DAPI's 200-byte floor
   */
  constructor(elements: number, fpRate = 0.0001, tweak: number = crypto.getRandomValues(new Uint32Array(1))[0]!, flags = BLOOM_UPDATE_ALL, minBytes = MIN_BLOOM_BYTES) {
    if (!(elements >= 1)) throw new Error('bloom: elements must be >= 1');
    const ideal = Math.floor((-1 / (Math.LN2 ** 2)) * elements * Math.log(fpRate) / 8);
    const bytes = Math.max(minBytes, Math.min(ideal, MAX_BYTES));
    this.vData = new Uint8Array(bytes);
    this.nHashFuncs = Math.max(1, Math.min(Math.floor((bytes * 8) / elements * Math.LN2), MAX_HASH_FUNCS));
    this.nTweak = tweak >>> 0;
    this.nFlags = flags;
  }
  #bit(i: number, data: Uint8Array): number { return murmur3((Math.imul(i, 0xfba4c795) + this.nTweak) >>> 0, data) % (this.vData.length * 8); }
  insert(data: Uint8Array): this {
    for (let i = 0; i < this.nHashFuncs; i++) { const b = this.#bit(i, data); this.vData[b >> 3]! |= 1 << (b & 7); }
    return this;
  }
  contains(data: Uint8Array): boolean {
    for (let i = 0; i < this.nHashFuncs; i++) { const b = this.#bit(i, data); if (!(this.vData[b >> 3]! & (1 << (b & 7)))) return false; }
    return true;
  }
  toJSON(): BloomFilterData { return { vData: this.vData, nHashFuncs: this.nHashFuncs, nTweak: this.nTweak, nFlags: this.nFlags }; }
}

/** Filter that matches every transaction (for observing the live tx / IS-lock firehose). */
export const matchAllFilter = (): BloomFilterData => ({ vData: new Uint8Array(512).fill(0xff), nHashFuncs: 10, nTweak: 0, nFlags: BLOOM_UPDATE_NONE });
