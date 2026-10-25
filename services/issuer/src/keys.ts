// Per-epoch issuer keys (PLAN §8.4 rule 7).
//
// Offline (`issuer keygen`): one RSA key per epoch, written to a directory on the offline machine:
//   epoch-<E>.pem      PKCS#8 private key, mode 0600
//   manifest.json      public part: [{ epoch, bits, spki (base64), keyId (hex) }]
// `issuer publish-keys` publishes the manifest's issuerKey documents (CRITICAL key, offline).
//
// Server: ISSUER_KEY_DIR holds epoch-<E>.pem for the epoch being issued (and at most ISSUER_MAX_STAGED_KEYS later ones, so a
// roll-over does not need an operator at the boundary). Keys for epochs whose issuance window has closed are destroyed.
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { deriveKeyId, toHex, bytesToBase64, base64ToBytes } from '@govhub/badge';
import { generateIssuerKey } from './signer.ts';

/** What a key directory's keys sign: MN badges, or starter tokens (a separate identity and directory, never the same keys). */
export type KeyPurpose = 'badge' | 'starter';
export const isKeyPurpose = (v: unknown): v is KeyPurpose => v === 'badge' || v === 'starter';

export interface ManifestEntry {
  epoch: number;
  /** absent in manifests from before starter keys existed: badge */
  purpose?: KeyPurpose;
  bits: 2048 | 3072;
  /** base64 of the rsaEncryption SPKI DER */
  spki: string;
  /** hex SHA256(spki) */
  keyId: string;
  /** the identity `publish-keys` publishes this directory under, stamped on the first publish; absent before that */
  identityId?: string;
}

const KEY_FILE = /^epoch-(\d{1,10})\.pem$/;
export const keyFileName = (epoch: number) => `epoch-${epoch}.pem`;

function writePrivate(path: string, data: string | Uint8Array): void {
  writeFileSync(`${path}.tmp`, data, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
}

export function readManifest(dir: string): ManifestEntry[] {
  const p = join(dir, 'manifest.json');
  if (!existsSync(p)) return [];
  const m = JSON.parse(readFileSync(p, 'utf8')) as ManifestEntry[];
  if (!Array.isArray(m)) throw new Error('manifest.json must be an array');
  return m;
}

const purposeOf = (m: ManifestEntry): KeyPurpose => m.purpose ?? 'badge';

/** Throws unless every key in the manifest has `purpose`: one directory never mixes badge and starter keys. */
export function assertPurpose(manifest: readonly ManifestEntry[], purpose: KeyPurpose): void {
  const other = manifest.find((m) => purposeOf(m) !== purpose);
  if (other) throw new Error(`this key directory holds ${purposeOf(other)} keys (epoch ${other.epoch}), not ${purpose} keys: use a separate directory and identity per purpose`);
}

/**
 * Binds the directory to the identity publishing it: refuses when any key was already published (stamped) under another identity,
 * then stamps every entry. One key directory is one identity's keys, so the same RSA keys can never be published as both a badge
 * and a starter issuerKey (keys are separated by identity and purpose; the issuer also refuses a shared key at run time).
 */
export function bindPublisher(dir: string, identityId: string): ManifestEntry[] {
  const manifest = readManifest(dir);
  const other = manifest.find((m) => m.identityId !== undefined && m.identityId !== identityId);
  if (other) throw new Error(`this key directory was published under identity ${other.identityId} (epoch ${other.epoch}), not ${identityId}: each identity needs its own keys`);
  if (manifest.some((m) => m.identityId === undefined)) {
    for (const m of manifest) m.identityId = identityId;
    writePrivate(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  return manifest;
}

/** Generates keys for epochs from..from+count-1 that the directory does not have yet. Returns the new entries. */
export async function keygen(dir: string, from: number, count: number, bits: 2048 | 3072, purpose: KeyPurpose = 'badge'): Promise<ManifestEntry[]> {
  if (!Number.isInteger(from) || from < 1 || !Number.isInteger(count) || count < 1 || count > 1000) throw new Error('bad epoch range');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const manifest = readManifest(dir);
  assertPurpose(manifest, purpose);
  const added: ManifestEntry[] = [];
  for (let e = from; e < from + count; e++) {
    if (manifest.some((m) => m.epoch === e) || existsSync(join(dir, keyFileName(e)))) continue;
    const kp = generateIssuerKey(bits);
    writePrivate(join(dir, keyFileName(e)), kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    const entry: ManifestEntry = { epoch: e, ...(purpose === 'badge' ? {} : { purpose }), bits, spki: bytesToBase64(kp.spki), keyId: toHex(await deriveKeyId(kp.spki)) };
    manifest.push(entry);
    added.push(entry);
  }
  manifest.sort((a, b) => a.epoch - b.epoch);
  writePrivate(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return added;
}

export const manifestSpki = (m: ManifestEntry): Uint8Array => base64ToBytes(m.spki);

/** Epochs that have a key file in `dir`. */
export function keyEpochs(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => KEY_FILE.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

export function loadKey(dir: string, epoch: number): KeyObject | null {
  const p = join(dir, keyFileName(epoch));
  if (!existsSync(p)) return null;
  const mode = statSync(p).mode & 0o077;
  if (mode !== 0) throw new Error(`${keyFileName(epoch)} must not be readable by group or others (chmod 600)`);
  return createPrivateKey(readFileSync(p));
}

/**
 * Destroys a key file: overwrite with zeros, fsync, unlink. On copy-on-write file systems (ZFS, btrfs) and SSDs the old blocks
 * may survive; that is a host property (README "Key custody").
 */
export function destroyKey(dir: string, epoch: number): void {
  const p = join(dir, keyFileName(epoch));
  if (!existsSync(p)) return;
  const size = statSync(p).size;
  const fd = openSync(p, 'r+');
  try {
    writeSync(fd, new Uint8Array(size), 0, size, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(p);
}
