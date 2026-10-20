/** Shared server/browser guard for the pinned SDK canonicalizer (RFC 8785). */
import * as sdk from "@kynesyslabs/dacs/canonical";

export function assertValidUnicode(value: unknown): void {
  const check = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("invalid Unicode: lone surrogate");
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid Unicode: lone surrogate");
    }
  };
  if (typeof value === "string") check(value);
  else if (Array.isArray(value)) value.forEach(assertValidUnicode);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { check(key); assertValidUnicode(child); }
  }
}
export const canonicalize: typeof sdk.canonicalize = (value) => { assertValidUnicode(value); return sdk.canonicalize(value); };
export const contentHash: typeof sdk.contentHash = (value) => { assertValidUnicode(value); return sdk.contentHash(value); };
export const sha256Hex: typeof sdk.sha256Hex = (value) => { assertValidUnicode(value); return sdk.sha256Hex(value); };
export const stripSignature = sdk.stripSignature;
export const listingAddress: typeof sdk.listingAddress = (...args) => { assertValidUnicode(args); return sdk.listingAddress(...args); };
