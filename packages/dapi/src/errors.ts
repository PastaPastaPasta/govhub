export { GrpcError } from './grpcweb.ts';

/** A node's answer was internally inconsistent or did not check out (bad merkle proof, wrong hash, invalid signature...). */
export class VerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
  }
}

/** Every node that was tried failed. `errors` has one entry per attempt, in order. */
export class AllNodesFailedError extends Error {
  readonly errors: { node: string; error: unknown }[];
  constructor(errors: { node: string; error: unknown }[]) {
    const last = errors[errors.length - 1]?.error;
    super(`all ${errors.length} node attempts failed${last ? `: ${(last as Error).message ?? String(last)}` : ''}`);
    this.name = 'AllNodesFailedError';
    this.errors = errors;
  }
}
