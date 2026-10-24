import { describe, expect, it } from 'vitest';
import { pacedRandomDelays } from './KeyringContext.tsx';

describe('pacedRandomDelays (deferred submissions)', () => {
  it('keeps every request after the tenth at least 2.5 s after the previous one', () => {
    for (const n of [1, 9, 10, 11, 45, 120]) {
      const d = pacedRandomDelays(n);
      expect(d).toHaveLength(n);
      const sorted = [...d].sort((a, b) => a - b);
      for (let k = 10; k < n; k++) expect(sorted[k]! - sorted[k - 1]!).toBeGreaterThanOrEqual(2500);
      expect(d.every((x) => x >= 0)).toBe(true);
    }
  });
});
