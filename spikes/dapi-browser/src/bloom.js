// BIP37 bloom filter in the shape DAPI's TransactionsWithProofsRequest wants.
// NB: DAPI nodes need vData >= 200 bytes; tiny filters (e.g. 3 bytes for one element) saturate and match everything.

export const BLOOM_UPDATE_NONE = 0, BLOOM_UPDATE_ALL = 1, BLOOM_UPDATE_P2PUBKEY_ONLY = 2;
const MAX_BYTES = 36000, MAX_HASH_FUNCS = 50, MIN_BYTES_DAPI = 200;

function murmur3(seed, data) {
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  let h = seed >>> 0;
  const n = data.length - (data.length % 4);
  for (let i = 0; i < n; i += 4) {
    let k = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  switch (data.length & 3) {
    case 3: k ^= data[n + 2] << 16; // fallthrough
    case 2: k ^= data[n + 1] << 8; // fallthrough
    case 1: k ^= data[n]; k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export class BloomFilter {
  /** @param {number} elements expected element count  @param {number} fpRate  @param {number} [tweak] random by default */
  constructor(elements, fpRate = 0.0001, tweak = crypto.getRandomValues(new Uint32Array(1))[0], flags = BLOOM_UPDATE_ALL, minBytes = MIN_BYTES_DAPI) {
    const ideal = Math.floor((-1 / (Math.LN2 ** 2)) * elements * Math.log(fpRate) / 8);
    const bytes = Math.max(minBytes, Math.min(ideal, MAX_BYTES));
    this.vData = new Uint8Array(bytes);
    this.nHashFuncs = Math.max(1, Math.min(Math.floor((bytes * 8) / elements * Math.LN2), MAX_HASH_FUNCS));
    this.nTweak = tweak >>> 0;
    this.nFlags = flags;
  }
  #bit(i, data) { return murmur3((Math.imul(i, 0xfba4c795) + this.nTweak) >>> 0, data) % (this.vData.length * 8); }
  insert(data) { for (let i = 0; i < this.nHashFuncs; i++) { const b = this.#bit(i, data); this.vData[b >> 3] |= 1 << (b & 7); } return this; }
  contains(data) { for (let i = 0; i < this.nHashFuncs; i++) { const b = this.#bit(i, data); if (!(this.vData[b >> 3] & (1 << (b & 7)))) return false; } return true; }
  /** Plain object accepted by DapiCore.subscribeToTransactions. */
  toJSON() { return { vData: this.vData, nHashFuncs: this.nHashFuncs, nTweak: this.nTweak, nFlags: this.nFlags }; }
}

/** Filter that matches every transaction (for observing the live tx / IS-lock firehose). */
export const matchAllFilter = () => ({ vData: new Uint8Array(512).fill(0xff), nHashFuncs: 10, nTweak: 0, nFlags: BLOOM_UPDATE_NONE });
