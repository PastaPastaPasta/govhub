// Link shorteners: a proposal link on one of these hosts hides where it leads. Shared by the app (lib/links.ts) and the build
// (scripts/prerender.mjs, which resolves such links once per build).
export const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 'shorturl.at', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'tiny.cc', 'rb.gy', 's.id', 't.ly', 'shorturl.com', 'v.gd']);
export const isShortLink = (host: string): boolean => SHORTENERS.has(host.replace(/^www\./, '').toLowerCase());
