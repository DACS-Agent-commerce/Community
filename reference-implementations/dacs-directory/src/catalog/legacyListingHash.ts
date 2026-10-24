import { assertValidUnicode, canonicalize, sha256Hex } from "./canonical.js";

/**
 * Frozen SDK 44d8ff2 artifact hash profile, shared by Listings and historical
 * delivery attestations. That draft NFC-normalized member names before sorting
 * as well as string values, and refuses numbers that are not safe integers.
 * It is written out here, independent of the pinned SDK, so a pin change
 * cannot move a historical hash.
 */
export function legacyListingHash(scope: Record<string, unknown>): string {
  assertValidUnicode(scope);
  const serialize = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value).filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key.normalize("NFC"), child] as const)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([key, child]) => `${canonicalize(key)}:${serialize(child)}`).join(",")}}`;
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("legacy canonical form requires safe integers");
    }
    return canonicalize(value);
  };
  return sha256Hex(serialize(scope));
}
