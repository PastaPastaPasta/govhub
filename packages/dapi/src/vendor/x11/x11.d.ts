export function digest(bytes: number[]): number[];
type Stage = (input: number[], inputFormat: 1 | 2, outputFormat: 1 | 2) => number[];
export const stages: Record<'blake' | 'bmw' | 'groestl' | 'skein' | 'jh' | 'luffa' | 'cubehash' | 'shavite' | 'simd' | 'echo', Stage>;
