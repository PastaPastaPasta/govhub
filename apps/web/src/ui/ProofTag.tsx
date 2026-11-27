// What a figure rests on, said beside it as the family's source tag (DESIGN.md §6, sources beside figures): checked in this browser
// (solid), reported by a source (dotted), or read but not proven (dashed). It goes after a label or a complete value, never inside a
// sentence. Not a control: a record's one proof badge (TrustBadge, ChainShield) is what opens the checks.
import type { ReactNode } from 'react';

type ProofState = 'ok' | 'reported' | 'unverified';
const SRC: Record<ProofState, string> = { ok: ' dh-src--ok', reported: '', unverified: ' dh-src--warn' };

/** `said`: the label already says it was checked here ("Verified…"), so screen readers aren't told twice. */
export function ProofTag({ state, title, said, children }: { state: ProofState; title?: string; said?: boolean; children: ReactNode }) {
  return (
    <span className={`dh-src${SRC[state]}`} title={title} data-proof={state}>
      {children}
      {state === 'ok' && !said && <span className="dh-sr">, checked in this browser</span>}
    </span>
  );
}

/** Figures read from superblocks in the chain this browser checked; Testnet's chain is consistent but not proven. */
export function ChainProof({ weak }: { weak: boolean }) {
  return weak ? (
    <ProofTag state="unverified" title="Read from Testnet's chain, which this browser can check only for consistency (proof of work), not prove">
      Read from the chain, not proven
    </ProofTag>
  ) : (
    <ProofTag state="ok" said title="Read from each superblock in the chain this browser verified">
      Verified from the chain
    </ProofTag>
  );
}
