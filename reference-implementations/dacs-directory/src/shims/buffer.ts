/**
 * Browser Buffer with base64url support — the feross `buffer` polyfill
 * doesn't know the `base64url` encoding that the SDK uses for signature
 * bytes. Wrap `from` to translate base64url → base64, and `toString` to give
 * unpadded base64url (the SDK's bundle verifier encodes a placeholder
 * signature when its module loads).
 */
import { Buffer as B } from "buffer";

/** Teach a Buffer class `base64url` in `from` and `toString`; returns it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addBase64url(Buf: any) {
  const origFrom = Buf.from.bind(Buf);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Buf.from = (value: any, enc?: any, ...rest: any[]) => {
    if (typeof value === "string" && enc === "base64url") {
      const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
      return origFrom(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64");
    }
    return origFrom(value, enc, ...rest);
  };
  const origToString = Buf.prototype.toString;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Buf.prototype.toString = function (enc?: any, ...rest: any[]) {
    if (enc === "base64url") {
      return origToString.call(this, "base64", ...rest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    return origToString.call(this, enc, ...rest);
  };
  return Buf;
}

addBase64url(B);

export { B as Buffer };
export default { Buffer: B };
