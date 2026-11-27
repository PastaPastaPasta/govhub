// links.json from the build: only shortener keys, only http(s) targets that are not shorteners themselves, dated.
import { describe, expect, it } from 'vitest';
import { isShortLink, parseLinks } from './links.ts';

describe('parseLinks', () => {
  it('keeps resolved shortener links with the build time', () => {
    const m = parseLinks({ resolvedAt: 1_793_900_000, links: { 'https://shorturl.at/bNhSh': 'https://docs.google.com/document/d/1Qx8/edit' } });
    expect(m.get('https://shorturl.at/bNhSh')).toEqual({ to: 'https://docs.google.com/document/d/1Qx8/edit', at: 1_793_900_000 });
  });
  it('drops anything else', () => {
    const m = parseLinks({
      resolvedAt: 1,
      links: { 'https://example.org/a': 'https://b.example', 'https://bit.ly/x': 'javascript:alert(1)', 'https://bit.ly/y': 'https://tinyurl.com/z', 'https://bit.ly/w': 5 },
    });
    expect(m.size).toBe(0);
    expect(parseLinks(null).size).toBe(0);
    expect(parseLinks({ links: {} }).size).toBe(0);
  });
  it('knows shorteners with or without www', () => {
    expect(isShortLink('www.shorturl.at')).toBe(true);
    expect(isShortLink('dashcentral.org')).toBe(false);
  });
});
