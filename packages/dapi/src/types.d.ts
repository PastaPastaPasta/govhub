declare module '@dashevo/x11-hash-js' {
  interface X11 {
    /** UTF-8 string in, lowercase hex out. */
    digest(input: string): string;
    /** inputFormat 1 = 8-bit array, outputFormat 1 = 8-bit array (32 bytes). */
    digest(input: number[], inputFormat: 1, outputFormat: 1): number[];
  }
  const x11: X11;
  export default x11;
}
