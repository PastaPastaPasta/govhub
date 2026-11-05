import { describe, expect, it } from 'vitest';
import { readableName, titleIndex, titleOf } from './Slug.tsx';

describe('reading titles', () => {
  it('reads a name as words: separators become spaces, the first letter a capital, nothing else changes', () => {
    expect(readableName('Dash-Music-MVP-Application-Developing')).toBe('Dash Music MVP Application Developing');
    expect(readableName('dashcentral-operations4')).toBe('Dashcentral operations4');
    expect(readableName('BTCBACKPORTSVIJAY_04')).toBe('BTCBACKPORTSVIJAY 04');
    expect(readableName('OrchardPay')).toBe('OrchardPay');
  });

  it('keeps the exact name when another name on show reads the same', () => {
    const idx = titleIndex(['Dash-Core-Group', 'Dash_Core_Group', 'dash-growth-q4-2026']);
    expect(titleOf('Dash-Core-Group', idx)).toBe('Dash-Core-Group');
    expect(titleOf('Dash_Core_Group', idx)).toBe('Dash_Core_Group');
    expect(titleOf('dash-growth-q4-2026', idx)).toBe('Dash growth q4 2026');
    expect(titleOf('not-listed', idx)).toBe('Not listed');
  });
});
