import { createHash } from "node:crypto";
import { assertValidUnicode } from "./canonical.js";

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t",
};
const FIRST_PRINTABLE_CODE_POINT = 0x20;

/** Frozen string form: NFC, then only the JCS-required escapes; "/" and non-ASCII stay literal. */
function serializeString(text: string): string {
  let out = '"';
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    out += SHORT_ESCAPES[char] ?? (code < FIRST_PRINTABLE_CODE_POINT ? `\\u${code.toString(16).padStart(4, "0")}` : char);
  }
  return `${out}"`;
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return serializeString(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("legacy canonical form requires safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key.normalize("NFC"), child] as const)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, child]) => `${serializeString(key)}:${serialize(child)}`).join(",")}}`;
  }
  throw new Error(`legacy canonical form: unsupported value type (${typeof value})`);
}

/**
 * Frozen SDK 44d8ff2 serialization of a scope, used to measure historical
 * scopes against size limits. Throws on lone surrogates, non-safe-integer
 * numbers and unsupported values.
 */
export function legacyCanonicalize(scope: Record<string, unknown>): string {
  assertValidUnicode(scope);
  return serialize(scope);
}

/**
 * Frozen SDK 44d8ff2 artifact hash profile, shared by Listings and historical
 * delivery attestations. That draft NFC-normalized member names before sorting
 * as well as string values, and refuses numbers that are not safe integers.
 * Member ordering, string escaping, number formatting and the digest are all
 * written out here and use no pinned-SDK code, so a pin change cannot move a
 * historical hash. Returns the lowercase hex SHA-256 of the serialized scope;
 * throws on lone surrogates, non-safe-integer numbers and unsupported values.
 */
export function legacyListingHash(scope: Record<string, unknown>): string {
  return createHash("sha256").update(legacyCanonicalize(scope), "utf8").digest("hex");
}
