import { describe, expect, it } from 'vitest';
import { formatDash, formatDashAmount, formatDate, formatDuration, formatRelative, formatSigned, shortAddress, shortHash, urlHost } from './format.ts';

describe('formatDash', () => {
  it('formats duffs at a sensible precision', () => {
    expect(formatDash(100_000_000)).toBe('1 DASH');
    expect(formatDash(12_550_000_000)).toBe('125.5 DASH');
    expect(formatDash(483_200_000_000)).toBe('4,832 DASH');
    expect(formatDash(682_826_378_160)).toBe('6,828 DASH');
    expect(formatDashAmount(12_345)).toBe('0.00012345');
    expect(formatDashAmount(0)).toBe('0');
    expect(formatDashAmount(199_999_999)).toBe('2');
  });
});

describe('durations', () => {
  it('uses minutes, hours, then days', () => {
    expect(formatDuration(59)).toBe('1 min');
    expect(formatDuration(3600)).toBe('1 hour');
    expect(formatDuration(7 * 3600)).toBe('7 hours');
    expect(formatDuration(86400)).toBe('1 day');
    expect(formatDuration(6.24 * 86400)).toBe('6.2 days');
    expect(formatDuration(27.6 * 86400)).toBe('28 days');
  });
  it('relative wording', () => {
    expect(formatRelative(1000 + 2 * 86400, 1000)).toBe('in 2 days');
    expect(formatRelative(1000 - 3 * 3600, 1000)).toBe('3 hours ago');
  });
});

describe('misc', () => {
  it('signs with a real minus', () => {
    expect(formatSigned(54)).toBe('+54');
    expect(formatSigned(-120)).toBe('−120');
    expect(formatSigned(0)).toBe('0');
  });
  it('shortens addresses and hashes', () => {
    expect(shortAddress('XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62')).toBe('XdWkmF…sa62');
    expect(shortHash('a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901')).toBe('a5465cdb…11419901');
  });
  it('dates in UTC', () => {
    expect(formatDate(1798946946, 'en-US', 'UTC')).toBe('Jan 3, 2027');
  });
  it('only http(s) URLs have a host', () => {
    expect(urlHost('https://www.dashcentral.org/p/x')).toBe('www.dashcentral.org');
    expect(urlHost('javascript:alert(1)')).toBeNull();
    expect(urlHost('not a url')).toBeNull();
  });
});
