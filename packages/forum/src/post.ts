// proposalPost bodies: markdown, UTF-8, compressed with zlib "deflate" (RFC 1950: a 2-byte header, raw deflate and
// an Adler-32 checksum, so a corrupted or truncated chunk fails to inflate instead of rendering garbage), then split
// into b0..b2 of at most 5,120 bytes each (the PV13 field cap). The longest body that fits is whatever compresses
// to 15,360 bytes. Uses the platform CompressionStream (browsers and Node >= 18), so no codec is bundled.

export const POST_CHUNK_BYTES = 5120;
export const POST_MAX_CHUNKS = 3;
export const POST_MAX_COMPRESSED = POST_CHUNK_BYTES * POST_MAX_CHUNKS;
/** Inflate cap: a 15 KB deflate stream could otherwise expand to ~15 MB (a decompression bomb). */
export const POST_MAX_INFLATED = 256 * 1024;

export class PostTooLargeError extends Error {
  constructor(readonly compressedBytes: number) {
    super(`the body compresses to ${compressedBytes.toLocaleString('en-US')} bytes; at most ${POST_MAX_COMPRESSED.toLocaleString('en-US')} fit in a post`);
  }
}

async function pipe(input: Uint8Array, stream: CompressionStream | DecompressionStream, max = Infinity): Promise<Uint8Array> {
  const reader = new Blob([input as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      throw new Error(`the body inflates to more than ${max.toLocaleString('en-US')} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const deflate = (bytes: Uint8Array): Promise<Uint8Array> => pipe(bytes, new CompressionStream('deflate'));
export const inflate = (bytes: Uint8Array, max = POST_MAX_INFLATED): Promise<Uint8Array> => pipe(bytes, new DecompressionStream('deflate'), max);

/** Splits a compressed body into ≤ 5,120-byte chunks; throws PostTooLargeError past 3 chunks. */
export function splitChunks(compressed: Uint8Array): Uint8Array[] {
  if (compressed.length === 0) throw new Error('empty body');
  if (compressed.length > POST_MAX_COMPRESSED) throw new PostTooLargeError(compressed.length);
  const out: Uint8Array[] = [];
  for (let i = 0; i < compressed.length; i += POST_CHUNK_BYTES) out.push(compressed.slice(i, i + POST_CHUNK_BYTES));
  return out;
}

export async function packPostBody(markdown: string): Promise<Uint8Array[]> {
  return splitChunks(await deflate(new TextEncoder().encode(markdown)));
}

/** Joins and inflates b0..b2. Throws on a malformed stream, a chunk layout no writer produces, or a bomb. */
export async function unpackPostBody(chunks: readonly Uint8Array[]): Promise<string> {
  if (chunks.length < 1 || chunks.length > POST_MAX_CHUNKS) throw new Error('a post has 1..3 body chunks');
  // Writers fill every chunk but the last; anything else means a field went missing (e.g. b1 deleted, b2 kept).
  if (chunks.slice(0, -1).some((c) => c.length !== POST_CHUNK_BYTES)) throw new Error('body chunks are not contiguous');
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    joined.set(c, o);
    o += c.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(await inflate(joined));
}
