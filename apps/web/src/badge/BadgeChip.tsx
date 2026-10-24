// "MN · vouched by X" next to an author: one chip per trusted issuer, never a count, never the MN or its type (PLAN §8.6).
export function MnBadges({ issuers }: { issuers: readonly string[] | undefined }) {
  if (!issuers?.length) return null;
  return (
    <>
      {issuers.map((name) => (
        <span key={name} className="chip chip-mn" title={`${name} vouches that this identity controls the voting key of a valid masternode. Nothing else about the masternode is shown.`}>
          MN · vouched by {name}
        </span>
      ))}
    </>
  );
}
