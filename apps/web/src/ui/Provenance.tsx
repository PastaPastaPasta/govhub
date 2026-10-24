// Provenance marks: a small glyph after every number saying where it came from. Clicking (or
// keyboard-activating) it opens a native popover with the source and detail.
import { useId } from 'react';
import type { Provenance, ProvenanceKind } from '../data/types.ts';

export const PROV_LABEL: Record<ProvenanceKind, string> = {
  proof: 'Platform proof',
  reported: 'Reported, not verified',
  verified: 'Verified against the chain',
  mismatch: 'Verification failed',
  fixture: 'Fixture snapshot',
};

export const PROV_HELP: Record<ProvenanceKind, string> = {
  proof: 'Read from Dash Platform. evo-sdk checked the GroveDB proof against the quorum signature.',
  reported: 'Supplied by a bridge, DAPI node or feed. Nothing has checked it yet.',
  verified: 'Recomputed in your browser from Core data fetched over DAPI: hashes and signatures checked, chain facts proven with merkle proofs and BLS-signed ChainLocks where the detail says so.',
  mismatch: 'Your browser checked this and it did not match.',
  fixture: 'Recorded mainnet data used for development. Not live.',
};

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

export function ProvMark({ prov }: { prov: Provenance }) {
  const id = useId();
  return (
    <>
      <button type="button" className={`prov prov-${prov.kind}`} popoverTarget={id} aria-label={`Source: ${PROV_LABEL[prov.kind]}, ${prov.source}`} data-prov={prov.kind}>
        <ProvGlyph kind={prov.kind} />
      </button>
      <div id={id} popover="auto" className="prov-pop" role="note">
        <p className="prov-pop-title">
          <ProvGlyph kind={prov.kind} /> {PROV_LABEL[prov.kind]}
        </p>
        <p>{prov.source}</p>
        {prov.detail && <p className="muted">{prov.detail}</p>}
        <p className="muted small">{PROV_HELP[prov.kind]}</p>
      </div>
    </>
  );
}

export function ProvLegend() {
  return (
    <dl className="legend">
      {(Object.keys(PROV_LABEL) as ProvenanceKind[]).map((k) => (
        <div key={k}>
          <dt>
            <ProvGlyph kind={k} /> {PROV_LABEL[k]}
          </dt>
          <dd>{PROV_HELP[k]}</dd>
        </div>
      ))}
    </dl>
  );
}
