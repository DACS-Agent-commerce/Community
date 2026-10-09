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

/** JSON/SQLite restore prototypes: rebuild every attacker-keyed dictionary on ingress. */
export type NormalizedScanState = ScanState & Required<Pick<ScanState, "programs" | "revocations" | "verifiedRevocations" | "bundleBindings" | "bundleBindingOverflow">>;

export function normalizeScanState(state: ScanState): NormalizedScanState {
  return {
    ...state,
    listings: dictionary(state.listings, string),
    deals: dictionary(state.deals, (v) => {
      if (!v || typeof v !== "object") return false;
      const deal = v as ScanState["deals"][string];
      return typeof deal.jobId === "string" && typeof deal.rail === "string" &&
        typeof deal.buyerBundleRef === "string" && !!deal.owners &&
        typeof deal.owners.buyer === "string" && typeof deal.owners.seller === "string" && boundedJson(v) !== null;
    }),
    programs: dictionary(state.programs, (v) => v === null || typeof v === "string"),
    revocations: dictionary(state.revocations, (v) => typeof v === "string" || strings(v)),
    verifiedRevocations: dictionary(state.verifiedRevocations, strings),
    bundleBindings: dictionary(state.bundleBindings, (v) => Array.isArray(v)),
    bundleBindingOverflow: strings(state.bundleBindingOverflow) ? state.bundleBindingOverflow : [],
  };
}
