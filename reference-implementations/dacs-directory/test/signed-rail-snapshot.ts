import { PUBLISHER_IN_CODE_RAIL_DEFINITIONS } from "../src/catalog/listingOptions.js";

/**
 * Model a release whose PA-1 table is a verified, signed snapshot (LRR-6), so
 * a test can reach the publication steps behind the LP-6 gate. The shipped
 * table is unsigned and the publisher refuses; call the returned function to
 * restore it.
 */
export function modelSignedRailSnapshot(): () => void {
  for (const definition of PUBLISHER_IN_CODE_RAIL_DEFINITIONS) definition.signatureValid = true;
  return () => {
    for (const definition of PUBLISHER_IN_CODE_RAIL_DEFINITIONS) definition.signatureValid = false;
  };
}
