import { canonicalDemosAgentClaim } from "./claimRef.js";
import { ownerClaim } from "./listingVerification.js";
import { loadCatalog, loadRegistrations, loadScanState } from "./store.js";
import type { Registration } from "./types.js";

/** Candidate anchors only: the indexer still verifies each listing's signer, owner and tuple. */
export type ResolvePublisherListingAnchors = (publisherClaim: string) => readonly string[];

/** Share discovery across batch indexing and immediate refresh, without another domain crawl. */
export function publisherListingAnchors(
  registrations: readonly Registration[] = loadRegistrations(),
): ResolvePublisherListingAnchors {
  const byPublisher = new Map<string, Set<string>>();
  const add = (claim: string | null, anchors: readonly string[]) => {
    if (claim === null) return;
    const known = byPublisher.get(claim) ?? new Set<string>();
    for (const anchor of anchors) if (typeof anchor === "string") known.add(anchor);
    byPublisher.set(claim, known);
  };
  for (const reg of registrations) {
    if (reg && Array.isArray(reg.listingAnchors)) {
      add(canonicalDemosAgentClaim(reg.primaryClaim), reg.listingAnchors);
    }
  }
  for (const [anchor, owner] of Object.entries(loadScanState().listings)) {
    add(ownerClaim(owner), [anchor]);
  }
  // Authenticated well-known discoveries survive in the verified catalog even
  // when their publisher has neither a registration nor a chain-scan entry.
  // These are discovery hints; stale or changed chain bytes are reverified.
  for (const seller of loadCatalog().sellers) {
    add(canonicalDemosAgentClaim(seller.primaryClaim), seller.listings.flatMap((listing) =>
      listing.anchor?.kind === "storage-program" ? [listing.anchor.locator] : []));
  }
  return (claim) => [...(byPublisher.get(canonicalDemosAgentClaim(claim) ?? "") ?? [])];
}
