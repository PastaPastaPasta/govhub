// The search, sort and filter controls above the proposal lists, and the query-in-the-URL hook behind them.
import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A view's state read from the URL query, and a setter that writes it back. Typing replaces the history entry (one Back undoes the
 * whole search, not one letter); every other change pushes one, so Back steps through sorts and filters.
 */
export function useQueryState<T>(read: (sp: URLSearchParams) => T, write: (sp: URLSearchParams, v: T) => URLSearchParams): [T, (patch: Partial<T>, o?: { replace?: boolean }) => void] {
  const [sp, setSp] = useSearchParams();
  const state = useMemo(() => read(sp), [sp, read]);
  const update = useCallback(
    (patch: Partial<T>, o?: { replace?: boolean }) => setSp((cur) => write(cur, { ...read(cur), ...patch }), { replace: !!o?.replace }),
    [setSp, read, write],
  );
  return [state, update];
}

export function SearchField({ value, onChange, label, placeholder }: { value: string; onChange(v: string): void; label: string; placeholder: string }) {
  return (
    <label className="list-search">
      <span className="visually-hidden">{label}</span>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
        data-testid="list-search"
      />
    </label>
  );
}

/** One choice of several, as a row of chips (radio buttons: arrow keys move between them). */
export function ChipChoice<T extends string>({ name, label, options, value, onChange }: { name: string; label: string; options: readonly { value: T; text: ReactNode }[]; value: T; onChange(v: T): void }) {
  return (
    <fieldset className="list-chips" data-testid={`chips-${name}`}>
      <legend className="visually-hidden">{label}</legend>
      {options.map((o) => (
        <label key={o.value} className={`list-chip${o.value === value ? ' on' : ''}`}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
          {o.text}
        </label>
      ))}
    </fieldset>
  );
}

/** An on/off chip (a checkbox). */
export function ChipToggle({ checked, onChange, children, title, testId }: { checked: boolean; onChange(v: boolean): void; children: ReactNode; title?: string; testId?: string }) {
  return (
    <label className={`list-chip${checked ? ' on' : ''}`} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {children}
    </label>
  );
}

export function SortSelect<T extends string>({ value, options, onChange }: { value: T; options: readonly { value: T; text: string }[]; onChange(v: T): void }) {
  return (
    <label className="list-sort">
      <span>Sort</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} data-testid="list-sort">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "3 of 21 shown" with a way back to the whole list; announced politely as the results change. */
export function ResultCount({ shown, total, what, onClear }: { shown: number; total: number; what: string; onClear?: (() => void) | undefined }) {
  return (
    <p className="list-count small muted" role="status" data-testid="list-count">
      {shown === total ? `${total} ${what}` : `${shown} of ${total} ${what}`}
      {onClear && (
        <>
          {' · '}
          <button type="button" className="linkish" onClick={onClear} data-testid="list-clear">
            Clear filters
          </button>
        </>
      )}
    </p>
  );
}

export function NoMatches({ query, onClear }: { query: string; onClear(): void }) {
  return (
    <div className="empty" data-testid="list-no-matches">
      <p>{query.trim() ? <>No proposals match “{query.trim()}” with these filters.</> : 'No proposals match these filters.'}</p>
      <button type="button" className="btn btn-quiet" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}
