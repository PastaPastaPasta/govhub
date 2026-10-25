// Key directories: one purpose and one publishing identity per directory, so the same RSA keys are never published as both a badge
// and a starter issuerKey (blind signatures are separated by key only).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPurpose, bindPublisher, keygen, readManifest } from '../src/keys.ts';

const A = 'H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH';
const B = '9Jwa6v2Bwj9TtDmgJGn3KV9qqXprYZUBEkKzkxzx3HD8';

describe('key directories', () => {
  it('a directory is bound to the first identity that publishes it; another identity is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keys-'));
    await keygen(dir, 10, 2, 2048, 'starter');
    expect(readManifest(dir).every((m) => m.identityId === undefined)).toBe(true);
    bindPublisher(dir, B);
    expect(readManifest(dir).map((m) => m.identityId)).toEqual([B, B]);
    expect(() => bindPublisher(dir, B)).not.toThrow(); // the same identity again (re-runs, more epochs)
    expect(() => bindPublisher(dir, A)).toThrow(/published under identity/);
    // keys added later are stamped on the next publish, and still bound to the first identity
    await keygen(dir, 12, 1, 2048, 'starter');
    expect(() => bindPublisher(dir, A)).toThrow(/published under identity/);
    bindPublisher(dir, B);
    expect(readManifest(dir).map((m) => m.identityId)).toEqual([B, B, B]);
    expect(Array.isArray(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))).toBe(true); // still the array format
  });

  it('a manifest from before purposes and identities is a badge directory and binds on its first publish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keys-'));
    await keygen(dir, 10, 1, 2048);
    expect(() => assertPurpose(readManifest(dir), 'badge')).not.toThrow();
    expect(() => assertPurpose(readManifest(dir), 'starter')).toThrow(/badge keys/);
    await expect(keygen(dir, 11, 1, 2048, 'starter')).rejects.toThrow(/badge keys/);
    bindPublisher(dir, A);
    expect(readManifest(dir)[0]!.identityId).toBe(A);
  });
});
