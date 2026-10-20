import { canonicalDemosAgentClaim } from "./claimRef.js";
import { ownerClaim } from "./listingVerification.js";
import { loadRegistrations, loadScanState } from "./store.js";
import type { Registration, ScanState } from "./types.js";

/** Candidate anchors only: the indexer still verifies each listing's signer, owner and tuple. */
export type ResolvePublisherListingAnchors = ((publisherClaim: string) => readonly string[]) & {
  /** Independently bounded candidates, read only after trusted sources miss the pinned tuple. */
  unsigned?: (publisherClaim: string) => readonly string[];
};

/** Share discovery across batch indexing and immediate refresh, without another domain crawl. */
export function publisherListingAnchors(
  registrations: readonly Registration[] = loadRegistrations(),
  state: ScanState = loadScanState(),
): ResolvePublisherListingAnchors {
  const byPublisher = new Map<string, Set<string>>();
  const unsignedByPublisher = new Map<string, Set<string>>();
  const add = (target: Map<string, Set<string>>, claim: string | null, anchors: readonly string[]) => {
    if (claim === null) return;
    const known = target.get(claim) ?? new Set<string>();
    for (const anchor of anchors) if (typeof anchor === "string") known.add(anchor);
    target.set(claim, known);
  };
  for (const reg of registrations) {
    // Unsigned submissions can discover a missed listing, but cannot spend
    // the budget reserved for authenticated publisher candidates.
    if (Array.isArray(reg?.listingAnchors)) {
      add(reg.ownerSignature ? byPublisher : unsignedByPublisher,
        canonicalDemosAgentClaim(reg.primaryClaim), reg.listingAnchors);
    }
  }
  for (const [anchor, owner] of Object.entries(state.listings)) {
    add(byPublisher, ownerClaim(owner), [anchor]);
  }
  // Discovery survives a crawl outage or an unpublished listing independently
  // of active catalog rows. Current chain owner, signature and tuple are still
  // checked on every use; a successful crawl replaces its domain's old hints.
  for (const discovery of Object.values(state.publisherListingDiscoveries ?? {})) {
    add(byPublisher, canonicalDemosAgentClaim(discovery.publisherClaim), discovery.listingAnchors);
  }
  const anchorsFor = (source: Map<string, Set<string>>, claim: string) =>
    [...(source.get(canonicalDemosAgentClaim(claim) ?? "") ?? [])];
  return Object.assign((claim: string) => anchorsFor(byPublisher, claim), {
    unsigned: (claim: string) => anchorsFor(unsignedByPublisher, claim),
  });
}
