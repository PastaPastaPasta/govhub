import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@govhub/verify';

/** Platform renders byte arrays as base64; the app works in hex (stored byte order, no reversal). */
export function b64ToHex(b64: string): string {
  return bytesToHex(base64.decode(b64));
}

export function hexToB64(hex: string): string {
  return base64.encode(hexToBytes(hex));
}

export function isHex64(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}
