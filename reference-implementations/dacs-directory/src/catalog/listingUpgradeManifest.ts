import invalidLiveListings from "../../test/fixtures/live-invalid-verification-methods.json";

export interface ListingUpgradeReplacement {
  sourceListingId: string;
  replacementListingId: string;
  replacementLocator: string;
  replacementVersion: number;
  supportedPayloadMethods: string[];
}

/** Malformed occupied versions are replaced under fresh IDs; no continuity is claimed. */
export function parseListingUpgradeManifest(parsed: unknown): ListingUpgradeReplacement[] {
  if (!Array.isArray(parsed) || parsed.length !== invalidLiveListings.length) {
    throw new Error(`replacement manifest must contain exactly ${invalidLiveListings.length} entries`);
  }
  const keys = new Set(["sourceListingId", "replacementListingId", "replacementLocator", "replacementVersion", "supportedPayloadMethods"]);
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !keys.has(key)) ||
        typeof item.sourceListingId !== "string" || typeof item.replacementListingId !== "string" ||
        !/^[A-Za-z0-9._~-]{1,128}$/.test(item.replacementListingId) ||
        invalidLiveListings.some((old) => old.listingId === item.replacementListingId) ||
        typeof item.replacementLocator !== "string" || !/^stor-[0-9a-f]{40}$/.test(item.replacementLocator) ||
        !Number.isSafeInteger(item.replacementVersion) || item.replacementVersion < 1 ||
        !Array.isArray(item.supportedPayloadMethods) || !item.supportedPayloadMethods.every((kind: unknown) => typeof kind === "string")) {
      throw new Error("replacement manifest contains an invalid entry; replacements need a new Listing ID");
    }
  }
  const manifest = parsed as ListingUpgradeReplacement[];
  for (const old of invalidLiveListings) {
    if (manifest.filter((replacement) => replacement.sourceListingId === old.listingId).length !== 1) {
      throw new Error(`replacement manifest must map ${old.listingId} exactly once`);
    }
  }
  if (new Set(manifest.map((item) => item.replacementListingId)).size !== manifest.length ||
      new Set(manifest.map((item) => item.replacementLocator)).size !== manifest.length) {
    throw new Error("replacement IDs and locators must be distinct");
  }
  return manifest;
}
