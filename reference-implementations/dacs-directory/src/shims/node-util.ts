/** Browser-only subset used by the SDK's verification modules. */
export const types = {
  // JavaScript has no browser API equivalent to util.types.isProxy. Inputs are
  // synchronously snapshotted by the SDK before callbacks, which remains the
  // browser mutation boundary.
  isProxy: (_value: unknown): boolean => false,
  isUint8Array: (value: unknown): value is Uint8Array => value instanceof Uint8Array,
};

export default { types };
