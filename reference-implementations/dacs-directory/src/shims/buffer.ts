/**
 * Browser Buffer with base64url support — the feross `buffer` polyfill
 * doesn't know the `base64url` encoding that the SDK uses for signature
 * bytes. Wrap `from` to translate base64url → base64.
 */
import { Buffer as B } from "buffer";

const origFrom = B.from.bind(B);
const origToString = B.prototype.toString;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(B as any).from = (value: any, enc?: any, ...rest: any[]) => {
  if (typeof value === "string" && enc === "base64url") {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return origFrom(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64");
  }
  return origFrom(value, enc, ...rest);
};

// The SDK also emits canonical base64url with Buffer#toString. Feross Buffer
// supports base64 but not the Node base64url alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(B.prototype as any).toString = function (enc?: any, ...rest: any[]) {
  if (enc === "base64url") {
    return origToString.call(this, "base64", ...rest)
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }
  return origToString.call(this, enc, ...rest);
};

export { B as Buffer };
export default { Buffer: B };
