/** Browser subset used by the SDK's pure verification modules. */
export const types = {
  // Artifacts arrive through Response.json(), and dependency objects are
  // constructed inside the component, so no caller-owned Proxy crosses this
  // browser verification boundary.
  isProxy: (_value: unknown): boolean => false,
  isUint8Array: (value: unknown): value is Uint8Array => value instanceof Uint8Array,
};
