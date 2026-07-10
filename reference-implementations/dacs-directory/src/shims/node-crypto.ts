/**
 * Browser shim for the slice of `node:crypto` the SDK's PURE verification
 * chain uses (canonical/hash.js: createHash; crypto/ed25519.js:
 * createPublicKey + verify). Implemented over audited @noble primitives, so
 * the SDK's own verification code runs UNMODIFIED in the browser.
 * Signing-side functions throw — the browser verifies, it never signs.
 */
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";

// @noble/ed25519 v2 needs a sync sha512 provider.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(ed.etc as any).sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const SPKI_PREFIX_LEN = 12; // 302a300506032b6570032100 — raw key = last 32 bytes

export function createHash(alg: string) {
  if (alg !== "sha256") throw new Error(`shim: unsupported hash ${alg}`);
  const h = sha256.create();
  return {
    update(data: Uint8Array | string) {
      h.update(typeof data === "string" ? new TextEncoder().encode(data) : data);
      return this;
    },
    digest(enc?: string) {
      const out = h.digest();
      if (enc === "hex") return Array.from(out).map((b) => b.toString(16).padStart(2, "0")).join("");
      return Buffer.from(out);
    },
  };
}

interface ShimKey { __raw: Uint8Array }

export function createPublicKey(input: { key: Uint8Array; format?: string; type?: string } | ShimKey): ShimKey {
  if ("__raw" in input) return input;
  const der = input.key;
  if (der.length < 32) throw new Error("shim: bad SPKI key");
  return { __raw: Uint8Array.from(der.slice(der.length - 32)) };
}

export function verify(
  _alg: unknown,
  data: Uint8Array,
  key: ShimKey,
  signature: Uint8Array,
): boolean {
  try {
    return ed.verify(Uint8Array.from(signature), Uint8Array.from(data), key.__raw);
  } catch {
    return false;
  }
}

export function createPrivateKey(): never {
  throw new Error("shim: private keys are not available in the browser (verify-only)");
}
export function sign(): never {
  throw new Error("shim: signing is not available in the browser (verify-only)");
}
export default { createHash, createPublicKey, createPrivateKey, sign, verify };
