import { safePublicEndpoint } from "../catalog/publicEndpoint.js";
import type { IdentityTier, ListingSummary, SellerRecord } from "../catalog/types.js";

export const UNMEASURED_REACHABILITY_LABEL = "Not measured by Directory";

export type DirectoryEvidenceState = Readonly<{
  listing: Readonly<{
    kind: "fixture" | "current" | "legacy";
    label: "fixture listing" | "current DACS listing" | "legacy SDK listing";
  }>;
  endpoint: Readonly<{
    kind: "declared" | "not-declared" | "unsafe-declaration";
    label: "Declared HTTPS endpoint" | "No endpoint declared" | "Endpoint declaration not shown";
    explanation: string;
    url?: string;
  }>;
  reachability: Readonly<{
    kind: "not-measured";
    label: typeof UNMEASURED_REACHABILITY_LABEL;
  }>;
  identityTier: IdentityTier;
  deals: Readonly<{
    completed: number;
    total: number;
    label: string;
    explanation: string;
  }>;
}>;

export function directoryEvidenceState(
  listing: ListingSummary,
  seller: Pick<SellerRecord, "identityTier" | "reputation">,
): DirectoryEvidenceState {
  const endpoint = safePublicEndpoint(listing.publicEndpoint);
  const hasEndpointDeclaration = typeof listing.publicEndpoint === "string" && listing.publicEndpoint.length > 0;
  const listingState = listing.anchor.kind === "fixture"
    ? { kind: "fixture" as const, label: "fixture listing" as const }
    : listing.artifactProfile === "dacs-v0.1"
      ? { kind: "current" as const, label: "current DACS listing" as const }
      : { kind: "legacy" as const, label: "legacy SDK listing" as const };
  const completed = seller.reputation.completed;
  const total = seller.reputation.totalAgreements;

  return Object.freeze({
    listing: Object.freeze(listingState),
    endpoint: Object.freeze(endpoint
      ? {
        kind: "declared" as const,
        label: "Declared HTTPS endpoint" as const,
        explanation: "A safe HTTPS contact route is declared in the listing",
        url: endpoint,
      }
      : hasEndpointDeclaration
        ? {
          kind: "unsafe-declaration" as const,
          label: "Endpoint declaration not shown" as const,
          explanation: "The declared endpoint is not a safe HTTPS URL and is not linked",
        }
        : {
          kind: "not-declared" as const,
          label: "No endpoint declared" as const,
          explanation: "The listing declares no engagement endpoint",
        }),
    reachability: Object.freeze({ kind: "not-measured" as const, label: UNMEASURED_REACHABILITY_LABEL }),
    identityTier: seller.identityTier ?? "self-declared",
    deals: Object.freeze({
      completed,
      total,
      label: `${completed} strict-verified / ${total} agreement${total === 1 ? "" : "s"}`,
      explanation: total === 0
        ? "No verified two-sided bundle history yet"
        : "Both parties' signed copies must verify and agree before a bundle counts",
    }),
  });
}
