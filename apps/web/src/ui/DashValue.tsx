// A stat value with its unit set smaller (DESIGN.md §6, stats): "1,635 DASH".
import { dashUnit, formatDashAmount } from '../lib/format.ts';

export const DashValue = ({ duffs }: { duffs: number | bigint }) => (
  <>
    {formatDashAmount(Number(duffs))} <small>{dashUnit()}</small>
  </>
);
