/**
 * CORE §B.7 SIG-6 signature `value` wire encoding.
 *
 * Every DACS signature envelope (ListingSignature, RevocationSignature,
 * AgreementSignature, ComponentSignature, BundleSignature, BundleBinding)
 * carries the raw signature bytes as unpadded Base64URL. A conforming verifier
 * rejects every other spelling before cryptographic verification and never
 * auto-detects by trying decoders. Dependency-free so the browser can use it.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INDEX = new Map([...ALPHABET].map((character, index) => [character, index]));

export const ED25519_SIGNATURE_BYTES = 64;

/** Unpadded Base64URL of raw bytes: the only conforming signature `value`. */
export function canonicalSignatureValue(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    const characters = Math.min(4, Math.ceil(((bytes.length - index) * 8) / 6));
    for (let position = 0; position < characters; position++) out += ALPHABET[(chunk >> (18 - 6 * position)) & 63];
  }
  return out;
}

/**
 * Strictly decode a conforming signature `value`, or null. Padding,
 * whitespace, `+` or `/`, impossible lengths and non-zero residual bits are
 * all rejected by the exact re-encoding comparison; `length` is the
 * algorithm-specific decoded size (64 bytes for Ed25519).
 */
export function canonicalSignatureBytes(value: unknown, length = ED25519_SIGNATURE_BYTES): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 === 1) return null;
  const sextets: number[] = [];
  for (const character of value) {
    const sextet = INDEX.get(character);
    if (sextet === undefined) return null;
    sextets.push(sextet);
  }
  const bytes = new Uint8Array(Math.floor((sextets.length * 6) / 8));
  for (let index = 0; index < bytes.length; index++) {
    const bit = index * 8;
    const first = sextets[Math.floor(bit / 6)];
    const second = sextets[Math.floor(bit / 6) + 1] ?? 0;
    bytes[index] = ((first << 6 | second) >> (4 - (bit % 6))) & 255;
  }
  return bytes.length === length && canonicalSignatureValue(bytes) === value ? bytes : null;
}

/** Source encodings the SIG-6 legacy-import path accepts when declared out of band. */
export type LegacySignatureEncoding = "lowercase-hex" | "standard-base64-padded";

/**
 * The SIG-6 legacy-import path: strictly decode a value in its declared source
 * encoding and emit the canonical value, or null. Nothing is auto-detected; an
 * undeclared encoding is rejected. The publisher uses it for wallet hex.
 */
export function importLegacySignatureValue(
  value: string,
  declared: LegacySignatureEncoding | undefined,
  length = ED25519_SIGNATURE_BYTES,
): string | null {
  if (declared === "lowercase-hex") {
    if (value.length !== length * 2 || !/^[0-9a-f]*$/.test(value)) return null;
    return canonicalSignatureValue(Uint8Array.from({ length }, (_, index) => parseInt(value.slice(index * 2, index * 2 + 2), 16)));
  }
  if (declared === "standard-base64-padded") {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    const bytes = canonicalSignatureBytes(value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), length);
    if (!bytes) return null;
    const canonical = canonicalSignatureValue(bytes);
    const padded = canonical.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (canonical.length % 4)) % 4);
    return padded === value ? canonical : null;
  }
  return null;
}

/**
 * legacy-sdk-v0.1 compatibility reader only. Draft SDK producers wrote hex,
 * `0x` hex or Base64URL into signature values; this path accepts those
 * spellings for that profile's artifacts and must never be used to verify a
 * dacs-v0.1 artifact (SIG-6: no auto-detection on the conforming path).
 */
export function legacySignatureBytes(value: string): Uint8Array | null {
  const hex = value.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === ED25519_SIGNATURE_BYTES ? Uint8Array.from(decoded) : null;
  } catch {
    return null;
  }
}
