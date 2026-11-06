import { expect, it } from 'vitest';
import { keptSearch } from './Link.tsx';
it('keeps masternode context with the network across proposal views', () => {
  const mn = 'd353cdcae53071401345c38ab482935cb62442be2174a1d3210ca356c9017eff';
  const search = new URLSearchParams(keptSearch(`?network=mainnet&mn=${mn}&q=old-search`));
  expect(search.get('network')).toBe('mainnet');
  expect(search.get('mn')).toBe(mn);
  expect(search.has('q')).toBe(false);
});
