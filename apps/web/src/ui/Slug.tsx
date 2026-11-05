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
