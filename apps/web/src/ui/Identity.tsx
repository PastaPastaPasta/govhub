// Who wrote something: avatar, display name (self-chosen, so never trusted for identity), the DPNS name when the
// identity has one (unique, proof-verified), and the short identity id. Avatars from arbitrary URLs are never
// loaded (privacy and the CSP); only small inline data: images are shown, everything else gets an identicon.
import { useMemo } from 'react';
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
      <b className="author-name">{a.dpns ? <bdi>{a.dpns}</bdi> : (name ?? shortHash(id, 5))}</b>
      {a.dpns && name && <span className="author-alias">{name}</span>}
      {(a.dpns || a.name) && (
        <span className="author-id mono-ish" title={id}>
          {a.shortId}
        </span>
      )}
    </span>
  );
}
