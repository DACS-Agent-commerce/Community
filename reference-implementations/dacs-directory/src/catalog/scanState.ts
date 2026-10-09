import type { ScanState } from "./types.js";
import { boundedJson } from "./artifactLimits.js";

export function ownArray<T>(value: Record<string, T[]> | undefined, key: string): T[] {
  return value && Object.hasOwn(value, key) && Array.isArray(value[key]) ? value[key] : [];
}

const dictionary = <T>(value: unknown, accept: (value: unknown) => boolean): Record<string, T> => {
  const result = Object.create(null) as Record<string, T>;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) if (accept(entry)) result[key] = entry as T;
  }
  return result;
};
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
const string = (value: unknown): boolean => typeof value === "string";

/** Demos owners appear as both 0x addresses and did:demos:agent claims. */
export const canonicalProgramOwner = (owner: string): string => {
  const hex = owner.match(/([0-9a-fA-F]{64})$/)?.[1];
  return hex ? `0x${hex.toLowerCase()}` : owner.toLowerCase();
};

/**
 * A discovered deal belongs to the buyer that anchored its bundle and signed
 * its agreement (DACS-5 §10.4.2, DACS-3 CA-7), so it is keyed by that owner
 * and the jobId: another owner's program with the same jobId is a separate entry.
 */
export const discoveredDealKey = (buyer: string, jobId: string): string => `${canonicalProgramOwner(buyer)}\n${jobId}`;

/** JSON/SQLite restore prototypes: rebuild every attacker-keyed dictionary on ingress. */
export type NormalizedScanState = ScanState & Required<Pick<ScanState, "programs" | "revocations" | "verifiedRevocations" | "bundleBindings" | "bundleBindingOverflow">>;

export function normalizeScanState(state: ScanState): NormalizedScanState {
  const deals = dictionary<ScanState["deals"][string]>(state.deals, (v) => {
    if (!v || typeof v !== "object") return false;
    const deal = v as ScanState["deals"][string];
    return typeof deal.jobId === "string" && typeof deal.rail === "string" &&
      typeof deal.buyerBundleRef === "string" && !!deal.owners &&
      typeof deal.owners.buyer === "string" && typeof deal.owners.seller === "string" && boundedJson(v) !== null;
  });
  return {
    ...state,
    listings: dictionary(state.listings, string),
    // Entries are rekeyed from their own buyer and jobId, which also migrates jobId-keyed state in place.
    deals: dictionary(Object.fromEntries(Object.values(deals)
      .map((deal) => [discoveredDealKey(deal.owners.buyer, deal.jobId), deal])), () => true),
    programs: dictionary(state.programs, (v) => v === null || typeof v === "string"),
    revocations: dictionary(state.revocations, (v) => typeof v === "string" || strings(v)),
    verifiedRevocations: dictionary(state.verifiedRevocations, strings),
    bundleBindings: dictionary(state.bundleBindings, (v) => Array.isArray(v)),
    bundleBindingOverflow: strings(state.bundleBindingOverflow) ? state.bundleBindingOverflow : [],
  };
}
