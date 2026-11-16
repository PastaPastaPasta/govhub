// The search, sort and filter controls above the proposal lists, and the query-in-the-URL hook behind them.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A view's state read from the URL query, and a setter that writes it back. Every change pushes a history entry, so Back steps
 * through sorts and filters, except further typing in a search: that replaces it, so one Back undoes the whole search.
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

/**
 * The search box. It keeps its own text: the URL lags a keystroke behind (the router updates it in a transition), and an input
 * driven by it would drop fast typing and lose the caret. The URL's value is taken over only when it changes from outside (Back,
 * Clear filters). `onChange`'s `replace` is false for the first letter of a search, so Back returns to the list without one.
 */
export function SearchField({ value, onChange, label, placeholder }: { value: string; onChange(v: string, replace: boolean): void; label: string; placeholder: string }) {
  const [text, setText] = useState(value);
  const sent = useRef<string[]>([]);
  useEffect(() => {
    const i = sent.current.indexOf(value);
    if (i >= 0) sent.current = sent.current.slice(i + 1);
    else {
      sent.current = [];
      setText(value);
    }
  }, [value]);
  const change = (v: string) => {
    sent.current.push(v);
    setText(v);
    onChange(v, text !== '');
  };
  return (
    <label className="list-search">
      <span className="visually-hidden">{label}</span>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && text) {
            e.preventDefault();
            change('');
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

/** "3 of 21 proposals" with a way back to the whole list. Always mounted (empty when not filtering) so screen readers announce it. */
export function ResultCount({ active = true, shown, total, what, onClear }: { active?: boolean; shown: number; total: number; what: string; onClear?: (() => void) | undefined }) {
  return (
    <p className="list-count small muted" role="status" data-testid={active ? 'list-count' : undefined}>
      {active && (shown === total ? `${total} ${what}` : `${shown} of ${total} ${what}`)}
      {active && onClear && (
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
