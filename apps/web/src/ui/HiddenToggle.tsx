// The "show hidden" switch: hidden things (blocked comments, proposals and claims that failed verification) are never deleted,
// only kept behind this toggle.
export function HiddenToggle({ count, shown, onToggle, show, hide, testId = 'toggle-hidden' }: { count: number; shown: boolean; onToggle(): void; show: string; hide: string; testId?: string }) {
  if (count === 0) return null;
  return (
    <button type="button" className="btn btn-quiet" aria-pressed={shown} onClick={onToggle} data-testid={testId}>
      {shown ? hide : show}
    </button>
  );
}

/** "1 proposal" / "3 proposals". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The toggle under the Active and Past lists for the proposals that failed verification. */
export function FailedProposalsToggle({ count, shown, onToggle }: { count: number; shown: boolean; onToggle(): void }) {
  const what = `${plural(count, 'proposal')} that failed verification`;
  return (
    <p className="center">
      <HiddenToggle count={count} shown={shown} onToggle={onToggle} show={`Show ${what}`} hide={`Hide ${what}`} testId="toggle-failed" />
    </p>
  );
}

/** Why a listed proposal failed verification. */
export function FailedNote({ reason }: { reason: string }) {
  return (
    <p className="invalid-note small" data-testid="invalid-reason">
      <span className="chip chip-bad">Failed verification</span> {reason}
    </p>
  );
}
