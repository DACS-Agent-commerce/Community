import { PUBLISHER_IN_CODE_RAIL_DEFINITIONS } from "../src/catalog/listingOptions.js";

/** A test-only signed PA-1 snapshot, injected without changing the shipped table. */
export const signedRailSnapshot = PUBLISHER_IN_CODE_RAIL_DEFINITIONS.map((definition) => ({
  ...definition, signatureValid: true,
}));
