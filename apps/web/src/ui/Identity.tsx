// Who wrote something: avatar, display name (self-chosen, so never trusted for identity), the DPNS name when the
// identity has one (unique, proof-verified), and the short identity id. Avatars from arbitrary URLs are never
// loaded (privacy and the CSP); only small inline data: images are shown, everything else gets an identicon.
import { useEffect, useId, useMemo, useRef } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Profile } from '@govhub/forum';
import { shortHash, urlHost } from '../lib/format.ts';
import { authorLabel } from '../lib/social.ts';

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/** A 5×5 mirrored identicon from the identity id. Hues avoid the violet band. */
export function Identicon({ id, size = 28 }: { id: string; size?: number }) {
  const { cells, color } = useMemo(() => {
    const h = sha256(new TextEncoder().encode(id));
    const v = Math.round((h[0]! / 255) * 289); // 0..289, then skip 250..319
    const hue = v < 250 ? v : v + 70;
    const cells: Array<[number, number]> = [];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (h[1 + y * 3 + x]! & 1) cells.push([x, y], ...(x < 2 ? [[4 - x, y] as [number, number]] : []));
    return { cells, color: `hsl(${hue} 55% 42%)` };
  }, [id]);
  return (
    <svg className="avatar" width={size} height={size} viewBox="-0.5 -0.5 6 6" aria-hidden="true">
      <rect x="-0.5" y="-0.5" width="6" height="6" rx="1" className="avatar-bg" />
      {cells.map(([x, y]) => (
        <rect key={`${x},${y}`} x={x + 0.5} y={y + 0.5} width="1" height="1" fill={color} />
      ))}
    </svg>
  );
}

export function Avatar({ id, profile, size = 28 }: { id: string; profile?: Profile | undefined; size?: number }) {
  const url = profile?.avatarUrl;
  if (url && DATA_IMAGE.test(url)) return <img className="avatar" src={url} width={size} height={size} alt="" />;
  return (
    <span title={url ? `avatar at ${urlHost(url) ?? 'an unsupported URL'} not loaded` : undefined} className="avatar-wrap">
      <Identicon id={id} size={size} />
    </span>
  );
}

/**
 * The author's names: the DPNS name first when there is one, the self-chosen display name cleaned of invisible characters (and
 * quoted when it imitates a govhub label such as "owner" or a check mark), each isolated with <bdi>, and the short identity id
 * next to any name, so a look-alike name never stands alone.
 */
export function AuthorName({ id, profile, dpns }: { id: string; profile?: Profile | undefined; dpns?: string | undefined }) {
  const a = authorLabel(id, profile, dpns);
  const name = a.name && (
    <bdi className={a.quoted ? 'author-quoted' : undefined} title={a.quoted ? 'Self-chosen name; it is not a govhub label' : 'Self-chosen name'}>
      {a.quoted ? `“${a.name}”` : a.name}
    </bdi>
  );
  return (
    <span className="author">
      <b className="author-name">
        {a.dpns ? (
          <bdi className="author-dpns-name" title="DPNS username, proven by Platform">
            {a.dpns}
          </bdi>
        ) : (
          (name ?? shortHash(id, 5))
        )}
      </b>
      {a.dpns && name && <span className="author-alias">{name}</span>}
      {(a.dpns || a.name) && (
        <span className="author-id mono-ish" title={id}>
          {a.shortId}
        </span>
      )}
      {a.name && <NameInfo name={a.name} dpns={a.dpns} />}
    </span>
  );
}

/**
 * The "i" next to a self-chosen name: what that name is and isn't. A native popover (Esc and a click outside close it), placed
 * under its button when it opens and closed again on scroll, since it is positioned for the viewport.
 */
function NameInfo({ name, dpns }: { name: string; dpns: string | null }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const p = pop.current;
    const b = btn.current;
    if (!p || !b) return;
    const place = (e: Event) => {
      if ((e as Event & { newState?: string }).newState !== 'open') return;
      const r = b.getBoundingClientRect();
      const w = Math.min(304, window.innerWidth - 16);
      p.style.inlineSize = `${w}px`;
      p.style.top = `${r.bottom + 6}px`;
      p.style.left = `${Math.max(8, Math.min(r.left - 12, window.innerWidth - w - 8))}px`;
    };
    const close = () => {
      if (p.matches(':popover-open')) p.hidePopover();
    };
    p.addEventListener('beforetoggle', place);
    window.addEventListener('scroll', close, { passive: true });
    return () => {
      p.removeEventListener('beforetoggle', place);
      window.removeEventListener('scroll', close);
    };
  }, []);
  return (
    <>
      <button ref={btn} type="button" className="name-info" popoverTarget={id} aria-label="About this name" data-testid="name-info">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7.25v4.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.85" r="1" fill="currentColor" />
        </svg>
      </button>
      <div ref={pop} id={id} popover="auto" className="name-info-pop" role="note">
        <p>
          <b>
            <bdi>“{name}”</bdi> is a name the poster chose.
          </b>{' '}
          Anyone can pick any name, and two people can pick the same one. Nobody checks it.
        </p>
        {dpns ? (
          <p>
            The underlined <bdi>{dpns}</bdi> is their Dash username, which is unique and proven by Dash Platform.
          </p>
        ) : (
          <p>It isn’t a Dash username. The short code next to it is the account’s ID, which is unique.</p>
        )}
        <p className="muted">When govhub supports signing in with a Dash wallet, names will come from Dash usernames.</p>
      </div>
    </>
  );
}
