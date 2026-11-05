// A proposal's link, as the network records it, and (for a link shortener) where it led when this site was built: the build follows
// the redirects once (scripts/prerender.mjs) and ships /links.json from this origin. That answer is a dated observation, not a fact
// the chain commits to: whoever made a short link can point it elsewhere later, so the page says when it was resolved.
import { useEffect, useState } from 'react';

/** Link shorteners hide where a proposal's link leads (the same list as scripts/prerender.mjs). */
export const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 'shorturl.at', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'tiny.cc', 'rb.gy', 's.id', 't.ly', 'shorturl.com', 'v.gd']);
export const isShortLink = (host: string): boolean => SHORTENERS.has(host.replace(/^www\./, '').toLowerCase());

export interface Resolved {
  to: string;
  /** Unix seconds: when the build followed it. */
  at: number;
}

/** links.json, checked: only http(s) targets, only for keys that are shortener links. */
export function parseLinks(raw: unknown): Map<string, Resolved> {
  const out = new Map<string, Resolved>();
  if (!raw || typeof raw !== 'object') return out;
  const { resolvedAt, links } = raw as { resolvedAt?: unknown; links?: unknown };
  if (typeof resolvedAt !== 'number' || !links || typeof links !== 'object') return out;
  for (const [from, to] of Object.entries(links as Record<string, unknown>)) {
    if (typeof to !== 'string') continue;
    try {
      const f = new URL(from), t = new URL(to);
      if (isShortLink(f.hostname) && (t.protocol === 'https:' || t.protocol === 'http:') && !isShortLink(t.hostname)) out.set(from, { to: t.href, at: resolvedAt });
    } catch {
      /* not a URL */
    }
  }
  return out;
}

let shipped: Promise<Map<string, Resolved>> | null = null;
function shippedLinks(): Promise<Map<string, Resolved>> {
  shipped ??= fetch(`${(import.meta.env?.BASE_URL as string | undefined) ?? '/'}links.json`, { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then(parseLinks, () => new Map());
  return shipped;
}

/** Where `url` led when the site was built, when it is a shortened link the build resolved; null otherwise (or until known). */
export function useResolvedLink(url: string, short: boolean): Resolved | null {
  const [r, setR] = useState<Resolved | null>(null);
  useEffect(() => {
    if (!short) return setR(null);
    let on = true;
    shippedLinks().then((m) => on && setR(m.get(url) ?? null), () => {});
    return () => {
      on = false;
    };
  }, [url, short]);
  return r;
}
