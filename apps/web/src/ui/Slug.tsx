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
