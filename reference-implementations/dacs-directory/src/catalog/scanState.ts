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
 * Discovered deals are namespaced by the storage owner of the bundle program
 * and the jobId, because jobId uniqueness is a producer obligation a consumer
 * cannot rely on across unrelated writers. The key is an indexing namespace
 * only: buyer attribution still comes from the validated agreement and its
 * role evidence (DACS-5 §10.4.2, DACS-3 CA-7), never from storage ownership.
 */
export const discoveredDealKey = (buyer: string, jobId: string): string => `${canonicalProgramOwner(buyer)}\n${jobId}`;

/**
 * v10 replays the full deal history so entries that jobId-keyed state could
 * not hold are rebuilt under their owner key. A pass records the version only
 * after its complete replay is saved; an interrupted replay simply runs again.
 */
export const SCAN_STATE_SCHEMA_VERSION = 10;

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
    // Legacy carriage only: the candidate queue lives in SQLite (store.ts).
    revocations: dictionary(state.revocations, (v) => typeof v === "string" || strings(v)),
    verifiedRevocations: dictionary(state.verifiedRevocations, strings),
    bundleBindings: dictionary(state.bundleBindings, (v) => Array.isArray(v)),
    bundleBindingOverflow: strings(state.bundleBindingOverflow) ? state.bundleBindingOverflow : [],
  };
}
