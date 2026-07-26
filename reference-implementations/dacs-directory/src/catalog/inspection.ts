import type {
  DirectoryInspectionAffordance,
  DirectoryServiceMaturity,
  ListingSummary,
} from "./types.js";

export type DirectoryServiceProfile = {
  profileKind: "directory-service-profile";
  profileVersion: "0.1";
  listing: {
    listingId: string;
    version: number;
    seller: string;
    sellerDisplayName: string;
    artifactProfile: string;
    contentHash: string;
    anchor: ListingSummary["anchor"];
  };
  maturityProfile: {
    maturity: DirectoryServiceMaturity;
    noReputationClaim: true;
    noLivePaymentClaim: true;
    reason: string;
  };
  service: {
    title: string;
    category: string;
    tags: string[];
    rails: string[];
    delivery: string[];
    negotiation: string[];
  };
  links: {
    listingJson: string;
    servicePage: string;
  };
  limitations: ["roster maturity hint", "not reputation evidence", "not source truth"];
};

export type DirectoryServiceInspectionEnvelope = {
  artifactType: "directory-service-profile";
  source: {
    kind: "directory-api";
    label: string;
    url: string;
  };
  artifact: DirectoryServiceProfile;
  expectations: {
    listingId: string;
    listingVersion: number;
    expectedMaturity: DirectoryServiceMaturity;
  };
};

const limitations: DirectoryServiceProfile["limitations"] = [
  "roster maturity hint",
  "not reputation evidence",
  "not source truth",
];

const encode = encodeURIComponent;

export function servicePath(listing: ListingSummary): string {
  return `/service/${encode(listing.seller.primaryClaim)}/${encode(listing.listingId)}/${listing.version}`;
}

export function listingJsonPath(listing: ListingSummary): string {
  return `/api/dacs/listings/${encode(listing.listingId)}/${listing.version}?seller=${encode(listing.seller.primaryClaim)}`;
}

export function inspectServicePath(listing: ListingSummary): string {
  return `/api/dacs/inspect-service/${encode(listing.listingId)}/${listing.version}?seller=${encode(listing.seller.primaryClaim)}`;
}

export function inspectServiceUrl(origin: string, listing: ListingSummary): string {
  return `${origin}${inspectServicePath(listing)}`;
}

export function directoryInspectionAffordance(listing: ListingSummary): DirectoryInspectionAffordance {
  return {
    artifactType: "directory-service-profile",
    maturity: "listed",
    href: inspectServicePath(listing),
  };
}

export function withDirectoryInspectionAffordance<T extends ListingSummary>(listing: T): T {
  return {
    ...listing,
    inspection: directoryInspectionAffordance(listing),
  };
}

export function buildDirectoryServiceProfile(origin: string, listing: ListingSummary): DirectoryServiceProfile {
  return {
    profileKind: "directory-service-profile",
    profileVersion: "0.1",
    listing: {
      listingId: listing.listingId,
      version: listing.version,
      seller: listing.seller.primaryClaim,
      sellerDisplayName: listing.seller.displayName,
      artifactProfile: listing.artifactProfile ?? "legacy-sdk-v0.1",
      contentHash: listing.contentHash,
      anchor: listing.anchor,
    },
    maturityProfile: {
      maturity: "listed",
      noReputationClaim: true,
      noLivePaymentClaim: true,
      reason: "Directory observed a listing contract; sample receipts, strict bundle history, and live payment evidence require separate verifier adapters.",
    },
    service: {
      title: listing.offering.title,
      category: listing.offering.category,
      tags: listing.offering.tags,
      rails: listing.offering.rails ?? [],
      delivery: listing.offering.delivery ?? [],
      negotiation: listing.offering.negotiation ?? [],
    },
    links: {
      listingJson: `${origin}${listingJsonPath(listing)}`,
      servicePage: `${origin}${servicePath(listing)}`,
    },
    limitations,
  };
}

export function buildDirectoryServiceInspectionEnvelope(
  origin: string,
  listing: ListingSummary,
): DirectoryServiceInspectionEnvelope {
  return {
    artifactType: "directory-service-profile",
    source: {
      kind: "directory-api",
      label: "DACS Directory service inspection profile",
      url: inspectServiceUrl(origin, listing),
    },
    artifact: buildDirectoryServiceProfile(origin, listing),
    expectations: {
      listingId: listing.listingId,
      listingVersion: listing.version,
      expectedMaturity: "listed",
    },
  };
}
