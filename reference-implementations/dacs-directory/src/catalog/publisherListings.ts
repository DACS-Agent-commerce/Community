import { canonicalDemosAgentClaim } from "./claimRef.js";
import { ownerClaim } from "./listingVerification.js";
import { loadRegistrations, loadScanState } from "./store.js";
import type { Registration, ScanState } from "./types.js";

/** Candidate anchors only: the indexer still verifies each listing's signer, owner and tuple. */
export type ResolvePublisherListingAnchors = (publisherClaim: string) => readonly string[];

/** Share discovery across batch indexing and immediate refresh, without another domain crawl. */
export function publisherListingAnchors(
  registrations: readonly Registration[] = loadRegistrations(),
  state: ScanState = loadScanState(),
): ResolvePublisherListingAnchors {
  const byPublisher = new Map<string, Set<string>>();
  const add = (claim: string | null, anchors: readonly string[]) => {
    if (claim === null) return;
    const known = byPublisher.get(claim) ?? new Set<string>();
    for (const anchor of anchors) if (typeof anchor === "string") known.add(anchor);
    byPublisher.set(claim, known);
  };
  for (const reg of registrations) {
    // Unsigned submissions are candidates for their own listing verification,
    // but cannot spend another publisher's bounded historical-resolution work.
    if (reg?.ownerSignature && Array.isArray(reg.listingAnchors)) {
      add(canonicalDemosAgentClaim(reg.primaryClaim), reg.listingAnchors);
    }
  }
  for (const [anchor, owner] of Object.entries(state.listings)) {
    add(ownerClaim(owner), [anchor]);
  }
  // Discovery survives a crawl outage or an unpublished listing independently
  // of active catalog rows. Current chain owner, signature and tuple are still
  // checked on every use; a successful crawl replaces its domain's old hints.
  for (const discovery of Object.values(state.publisherListingDiscoveries ?? {})) {
    add(canonicalDemosAgentClaim(discovery.publisherClaim), discovery.listingAnchors);
  }
  return (claim) => [...(byPublisher.get(canonicalDemosAgentClaim(claim) ?? "") ?? [])];
}
