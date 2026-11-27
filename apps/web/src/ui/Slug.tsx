// A proposal name exactly as submitted, allowed to wrap after its hyphens, underscores and dots (names are slugs such as
// "Dash-Music-MVP-Application-Developing", which otherwise break mid-word or overflow a phone). Copying it gives the same text.
import { Fragment } from 'react';

export function Slug({ name }: { name: string }) {
  const parts = name.split(/(?<=[-_.])/);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A proposal's on-chain name as a reading title: its hyphens and underscores as spaces, the first letter capitalised, nothing else
 * changed ("Dash-Music-MVP-Application-Developing" reads "Dash Music MVP Application Developing"). Shown only beside the exact
 * name, never instead of it.
 */
export function readableName(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/**
 * The reading title of `name` among `others` (the proposals on show): its words, unless another, different name reads the same
 * ("Dash-Core-Group" beside "Dash_Core_Group"), when the exact name is the only honest title.
 */
export function titleOf(name: string, others: TitleIndex): string {
  const words = readableName(name);
  const same = others.get(words);
  return same && [...same].some((o) => o !== name) ? name : words;
}

/** The names on show by their reading title, built once per list for titleOf. */
export type TitleIndex = ReadonlyMap<string, ReadonlySet<string>>;
export function titleIndex(names: Iterable<string>): TitleIndex {
  const out = new Map<string, Set<string>>();
  for (const n of names) {
    const w = readableName(n);
    out.set(w, (out.get(w) ?? new Set()).add(n));
  }
  return out;
}
