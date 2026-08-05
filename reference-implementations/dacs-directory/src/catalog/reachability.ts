import { boundedPublicHttpsRequest, OutboundTargetError } from "./boundedHttps.js";
import { safePublicEndpoint } from "./publicEndpoint.js";
import {
  effectiveReachabilityStatus,
  reachabilityHintIsFresh,
  REACHABILITY_FRESH_MS,
} from "./reachabilityStatus.js";
import type { ListingSummary, ReachabilityHint, SellerRecord } from "./types.js";

export { effectiveReachabilityStatus, REACHABILITY_FRESH_MS };

const boundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

/** Probe only network reachability; an HTTP error response still proves reachability. */
export async function probeReachabilitySurface(surface: string): Promise<ReachabilityHint> {
  const checkedAt = Date.now();
  try {
    const response = await boundedPublicHttpsRequest(surface, {
      method: "HEAD",
      accept: "*/*",
      maxBytes: 1_024,
      maxRedirects: 3,
      timeoutMs: 5_000,
    });
    return {
      status: response.status >= 100 && response.status <= 599 ? "reachable" : "unreachable",
      checkedAt,
      surface,
    };
  } catch (error) {
    return {
      // A target rejected by outbound policy was deliberately not contacted;
      // do not claim it is unreachable or disclose internal network details.
      status: error instanceof OutboundTargetError ? "unknown" : "unreachable",
      checkedAt,
      surface,
    };
  }
}

const listingKey = (seller: string, listing: ListingSummary): string =>
  `${seller}\n${listing.listingId}\n${listing.version}\n${listing.contentHash}`;

export interface ReachabilityRefreshOptions {
  now?: number;
  cursor?: number;
  maxProbes?: number;
  concurrency?: number;
  probe?: (surface: string) => Promise<ReachabilityHint>;
}

/**
 * Attach independently-derived hints after all listing verification. Results
 * never participate in listing inclusion, revocation, identity or reputation.
 * Returns the round-robin cursor for the next bounded refresh pass.
 */
export async function refreshReachabilityHints(
  sellers: SellerRecord[],
  priorSellers: SellerRecord[],
  options: ReachabilityRefreshOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const maxProbes = boundedInt(options.maxProbes ?? process.env.DACS_REACHABILITY_MAX_PROBES, 20, 1, 100);
  const concurrency = boundedInt(options.concurrency ?? process.env.DACS_REACHABILITY_CONCURRENCY, 5, 1, 10);
  const probe = options.probe ?? probeReachabilitySurface;
  const prior = new Map<string, ListingSummary>();
  for (const seller of priorSellers) {
    for (const listing of seller.listings) prior.set(listingKey(seller.primaryClaim, listing), listing);
  }

  const due: Array<{ key: string; listing: ListingSummary; surface: string }> = [];
  for (const seller of sellers) {
    for (const listing of seller.listings) {
      const surface = safePublicEndpoint(listing.publicEndpoint);
      if (!surface || listing.status !== "active") {
        listing.reachabilityHint = undefined;
        continue;
      }
      const previous = prior.get(listingKey(seller.primaryClaim, listing))?.reachabilityHint;
      if (previous?.surface === surface && reachabilityHintIsFresh(previous, now)) {
        listing.reachabilityHint = previous;
        continue;
      }
      if (previous?.surface === surface) listing.reachabilityHint = { ...previous, status: "unknown" };
      due.push({ key: listingKey(seller.primaryClaim, listing), listing, surface });
    }
  }
  if (due.length === 0) return 0;
  due.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const start = boundedInt(options.cursor, 0, 0, Number.MAX_SAFE_INTEGER) % due.length;
  const selected = Array.from({ length: Math.min(maxProbes, due.length) }, (_, index) => due[(start + index) % due.length]);
  let next = 0;
  const bySurface = new Map<string, Promise<ReachabilityHint>>();
  const probeOnce = (surface: string): Promise<ReachabilityHint> => {
    let pending = bySurface.get(surface);
    if (!pending) {
      pending = probe(surface);
      bySurface.set(surface, pending);
    }
    return pending;
  };
  const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= selected.length) return;
      const candidate = selected[index];
      candidate.listing.reachabilityHint = await probeOnce(candidate.surface);
    }
  });
  await Promise.all(workers);
  return (start + selected.length) % due.length;
}
