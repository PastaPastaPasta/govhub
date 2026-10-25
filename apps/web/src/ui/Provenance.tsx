// The glyph of a check's basis, used in the verification drawer's detail rows: proven (tick), reported (ring), failed (cross),
// Platform proof (diamond), fixture (dashed square).
import type { ProvenanceKind } from '../data/types.ts';

export function ProvGlyph({ kind }: { kind: ProvenanceKind }) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: false } as const;
  switch (kind) {
    case 'proof':
      return (
        <svg {...common} className="glyph glyph-proof">
          <path d="M6 1 11 6 6 11 1 6Z" />
        </svg>
      );
    case 'verified':
      return (
        <svg {...common} className="glyph glyph-verified">
          <circle cx="6" cy="6" r="5.5" />
          <path d="M3.4 6.2 5.2 8l3.4-3.8" fill="none" strokeWidth="1.6" />
        </svg>
      );
    case 'mismatch':
      return (
        <svg {...common} className="glyph glyph-mismatch">
          <circle cx="6" cy="6" r="5.5" />
          <path d="M4 4l4 4M8 4 4 8" fill="none" strokeWidth="1.6" />
        </svg>
      );
    case 'fixture':
      return (
        <svg {...common} className="glyph glyph-fixture">
          <rect x="1.5" y="1.5" width="9" height="9" fill="none" strokeDasharray="2 1.5" />
        </svg>
      );
    default:
      return (
        <svg {...common} className="glyph glyph-reported">
          <circle cx="6" cy="6" r="4.25" fill="none" strokeWidth="1.5" />
        </svg>
      );
  }
}
