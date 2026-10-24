import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { deflate, inflate, packPostBody, POST_CHUNK_BYTES, POST_MAX_COMPRESSED, PostTooLargeError, splitChunks, unpackPostBody } from '../src/index.ts';

describe('deflate chunking for proposalPost b0..b2', () => {
  it('splits at exactly 5,120 bytes and allows at most three chunks', () => {
    expect(splitChunks(new Uint8Array(1)).map((c) => c.length)).toEqual([1]);
    expect(splitChunks(new Uint8Array(5120)).map((c) => c.length)).toEqual([5120]);
    expect(splitChunks(new Uint8Array(5121)).map((c) => c.length)).toEqual([5120, 1]);
    expect(splitChunks(new Uint8Array(10_240)).map((c) => c.length)).toEqual([5120, 5120]);
    expect(splitChunks(new Uint8Array(15_360)).map((c) => c.length)).toEqual([5120, 5120, 5120]);
    expect(() => splitChunks(new Uint8Array(15_361))).toThrow(PostTooLargeError);
    expect(() => splitChunks(new Uint8Array(0))).toThrow(/empty/);
    expect(POST_MAX_COMPRESSED).toBe(3 * POST_CHUNK_BYTES);
  });

  it('round-trips markdown, including multi-byte text, through zlib deflate', async () => {
    const md = '# Plan\n\nWe will **ship** it. ' + 'Ünïcødé ✓ '.repeat(500);
    const chunks = await packPostBody(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]![0]).toBe(0x78); // zlib header
    expect(await unpackPostBody(chunks)).toBe(md);
  });

  it('a long compressible body spans chunks and round-trips', async () => {
    // 16,000 hex digits of pseudo-random data (4 bits each) compress to ~8 KB: two chunks
    let x = 1;
    const words = Array.from({ length: 16_000 }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16).toString(16).slice(-1)).join('');
    const chunks = await packPostBody(words);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.slice(0, -1).every((c) => c.length === POST_CHUNK_BYTES)).toBe(true);
    expect(await unpackPostBody(chunks)).toBe(words);
  });

  it('incompressible bodies over the budget are refused with the compressed size', async () => {
    const noise = randomBytes(20_000).toString('base64');
    const err = await packPostBody(noise).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostTooLargeError);
    expect((err as PostTooLargeError).compressedBytes).toBeGreaterThan(POST_MAX_COMPRESSED);
  });

  it('refuses malformed layouts, corrupt streams and decompression bombs', async () => {
    const chunks = await packPostBody('hello world');
    await expect(unpackPostBody([])).rejects.toThrow(/1\.\.3/);
    await expect(unpackPostBody([new Uint8Array(10), chunks[0]!])).rejects.toThrow(/contiguous/);
    const bad = chunks[0]!.slice();
    bad[bad.length - 1]! ^= 0xff; // Adler-32 mismatch
    await expect(unpackPostBody([bad])).rejects.toThrow();
    const bomb = await deflate(new Uint8Array(2_000_000));
    expect(bomb.length).toBeLessThan(POST_MAX_COMPRESSED);
    await expect(unpackPostBody(splitChunks(bomb))).rejects.toThrow(/inflates to more than/);
    await expect(inflate(bomb, 3_000_000)).resolves.toHaveLength(2_000_000);
  });

  it('refuses bodies that are not UTF-8', async () => {
    const chunks = splitChunks(await deflate(Uint8Array.of(0xff, 0xfe, 0x00)));
    await expect(unpackPostBody(chunks)).rejects.toThrow();
  });
});
