// What a figure rests on, said beside it with the family's proof badge (DESIGN.md §6): proven in this browser, reported by a
// source, or read but not proven. Not a control: the proposal page's badge is the one that opens the checks.
import type { ReactNode } from 'react';

type ProofState = 'ok' | 'reported' | 'unverified';

export function ProofTag({ state, title, children }: { state: ProofState; title?: string; children: ReactNode }) {
  return (
    <span className={`dh-proof dh-proof--${state} proof-tag`} title={title} data-proof={state}>
      {children}
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
    <ProofTag state="ok" title="Read from each superblock in the chain this browser verified">
      Verified from the chain
    </ProofTag>
  );
}

/** Figures as Governance's bridge publishes them on Platform: each proposal's own page checks its share. */
export function ReportedProof({ what }: { what: string }) {
  return (
    <ProofTag state="reported" title="As Governance's bridge publishes them on Platform; each proposal's page recounts its own votes and budget place in this browser">
      {what}
    </ProofTag>
  );
}
