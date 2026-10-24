// Which address is "the client" for the per-IP limiter. Nothing here is stored or logged.
//  - CLIENT_IP_HEADER names a header set by the proxy in front; for `x-forwarded-for` the RIGHTMOST entry is used, because that is
//    the one our own proxy appended (everything to its left is client-controlled and can be forged to dodge the limiter).
//  - TRUSTED_PROXY_CIDRS (optional) restricts which socket peers may supply that header at all.
//  - The limiter buckets IPv6 clients by /64 (one subscriber usually owns a whole /64) and IPv4 / IPv4-mapped by the full address.
import { isIP } from 'node:net';

/** Expands an IPv6 address to its eight 16-bit groups, or null if it is not valid IPv6. */
function v6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1]!.split('.').map(Number);
    s = s.slice(0, -v4[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : new Array<string>(8 - h.length - t.length).fill('0');
  const all = [...h, ...fill, ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((x) => Number.isInteger(x)) ? all : null;
}

/** Canonical form of an address: port, brackets and zone id stripped, IPv4-mapped IPv6 (any spelling) turned into IPv4. */
export function normalizeIp(raw: string): string {
  let ip = raw.trim();
  const br = /^\[(.+)\](?::\d+)?$/.exec(ip);
  if (br) ip = br[1]!;
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  ip = ip.replace(/%.*$/, '');
  const g = v6Groups(ip);
  if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return ip;
}

/** The limiter key for an address: IPv6 -> its /64 prefix, IPv4 (and mapped) -> the address, anything else -> as is. */
export function ipBucket(raw: string): string {
  const ip = normalizeIp(raw);
  const g = v6Groups(ip);
  if (!g) return ip;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

type Matcher = (ip: string) => boolean;

/** One TRUSTED_PROXY_CIDRS entry: `a.b.c.d`, `a.b.c.d/len`, or an exact IPv6 address. Throws on anything else. */
function parseEntry(entry: string): Matcher {
  const [addr, len, ...rest] = entry.split('/');
  if (rest.length) throw new Error(`TRUSTED_PROXY_CIDRS: bad entry ${JSON.stringify(entry)}`);
  if (isIP(addr!) === 4) {
    const bits = len === undefined ? 32 : Number(len);
    if ((len !== undefined && !/^\d{1,2}$/.test(len)) || bits < 0 || bits > 32) throw new Error(`TRUSTED_PROXY_CIDRS: bad prefix length in ${JSON.stringify(entry)}`);
    const toInt = (s: string) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const net = (toInt(addr!) & mask) >>> 0;
    return (ip) => isIP(ip) === 4 && ((toInt(ip) & mask) >>> 0) === net;
  }
  if (isIP(addr!) === 6 && len === undefined) {
    const want = v6Groups(addr!)!.join(':');
    return (ip) => v6Groups(ip)?.join(':') === want;
  }
  throw new Error(`TRUSTED_PROXY_CIDRS: ${JSON.stringify(entry)} is not an IPv4 address/CIDR or an IPv6 address`);
}

/** Validates the list (used by loadConfig); throws with a clear message. */
export function validateProxyList(entries: readonly string[]): void {
  for (const e of entries) parseEntry(e);
}

export type PeerTrust = (peer: string | undefined) => boolean;

/** Empty list = every peer is trusted (the compose default: only the tunnel / caddy can reach the port). */
export function peerTrust(entries: readonly string[]): PeerTrust {
  if (!entries.length) return () => true;
  const ms = entries.map(parseEntry);
  return (peer) => peer !== undefined && ms.some((m) => m(normalizeIp(peer)));
}

/** The address the limiter should treat as the client. `header` is the lowercase header name, `get` reads a request header. */
export function resolveClientIp(opts: { header: string; get: (name: string) => string | undefined; peer: string | undefined; trusted: PeerTrust }): string {
  const { header, get, peer, trusted } = opts;
  if (header && trusted(peer)) {
    const v = get(header);
    if (v) {
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      const pick = header === 'x-forwarded-for' ? parts[parts.length - 1] : parts[0];
      // a value that is not an address (forged garbage) would be a bucket of its own: use the socket instead
      if (pick && isIP(normalizeIp(pick)) !== 0) return pick;
    }
  }
  return peer ?? 'unknown';
}
