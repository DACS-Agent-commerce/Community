import type { ResolveListingVersion } from "../../src/catalog/listingVersionOccupancy.js";

/** Model a trusted complete empty logical index for tests exercising other publication gates. */
export const emptyListingOccupancy: ResolveListingVersion = async (logicalAddress, chainIdentity) => ({
  status: "complete", logicalAddress, chainIdentity, nativeAddresses: [],
});
