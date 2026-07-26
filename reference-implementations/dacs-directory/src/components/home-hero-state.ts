export type HomeCatalogDisplayState = "indexing" | "empty" | "summary";

export function homeCatalogDisplayState(
  indexed: boolean,
  activeListingCount: number,
): HomeCatalogDisplayState {
  if (!indexed) return "indexing";
  return activeListingCount > 0 ? "summary" : "empty";
}
