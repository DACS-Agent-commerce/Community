import { activeCatalogListings } from "./discovery.js";
import type { Catalog } from "./types.js";
import { DACS_SDK_REVISION } from "./sdkProfile.js";

export const DACS_MARKET_MEDIA_TYPE = "application/vnd.dacs.market+json";

const absolute = (origin: string, path: string) => new URL(path, `${origin}/`).href;
const absoluteTemplate = (origin: string, path: string) =>
  absolute(origin, path).replaceAll("%7B", "{").replaceAll("%7D", "}");

/** Machine-readable entry point advertised by the human directory. */
export function buildAgentMarketManifest(origin: string, catalog: Catalog) {
  const listings = activeCatalogListings(catalog);
  const rails = [...new Set(listings.flatMap((listing) => listing.offering.rails ?? []))].sort();
  const delivery = [...new Set(listings.flatMap((listing) => listing.offering.delivery ?? []))].sort();
  const negotiation = [...new Set(listings.flatMap((listing) => listing.offering.negotiation ?? []))].sort();

  return {
    dacsVersion: "1",
    kind: "dacs-market-manifest",
    name: "DACS Directory",
    description: "The open market protocol for autonomous agents.",
    generatedAt: catalog.generatedAt,
    network: {
      id: process.env.DACS_NETWORK ?? "demos-devnet",
      confirmedDataOnly: true,
    },
    catalog: {
      listingCount: listings.length,
      endpoint: absolute(origin, "/api/dacs/listings"),
      method: "GET",
      mediaType: "application/json",
      pagination: "cursor",
      filters: [
        "category",
        "tag",
        "rail",
        "credential",
        "primaryClaim",
        "priceMax",
        "minCompletionRate",
        "minRating",
        "identityTier",
        "limit",
        "cursor",
      ],
    },
    endpoints: {
      status: absolute(origin, "/api/dacs/status"),
      listing: absoluteTemplate(origin, "/api/dacs/listings/{listingId}/{version}"),
      seller: absoluteTemplate(origin, "/api/dacs/sellers/{primaryClaimRef}"),
      publish: absolute(origin, "/api/dacs/build-listing"),
    },
    capabilities: {
      paymentRails: rails,
      deliveryMethods: delivery,
      negotiationModes: negotiation,
    },
    operations: {
      discover: { status: "available", endpoint: absolute(origin, "/api/dacs/listings") },
      inspectListing: { status: "available", endpointTemplate: absoluteTemplate(origin, "/api/dacs/listings/{listingId}/{version}") },
      publishListing: { status: "available", endpoint: absolute(origin, "/api/dacs/build-listing"), method: "POST" },
      negotiate: { status: "planned" },
      settle: { status: "declared-per-listing" },
    },
    sdk: {
      package: "@kynesyslabs/dacs",
      revision: DACS_SDK_REVISION,
    },
    human: {
      marketplace: absolute(origin, "/#services"),
      publish: absolute(origin, "/register"),
    },
  } as const;
}
