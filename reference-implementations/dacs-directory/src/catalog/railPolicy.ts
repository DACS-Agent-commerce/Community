import { canonicalize } from "./canonical.js";
type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj | null => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;

/** Operator-installed, authenticated registry snapshots, never values from a listing/bundle/RPC.
 * PA-1 bootstrap trust is explicit: no snapshot is installed by default. An operator must
 * authenticate the registry index and rail definitions before provisioning this configuration.
 */
export function nativeRailAdmission(registryVersion: unknown, rail: Obj | null, phase: unknown, price: unknown): string | null {
  let snapshots: unknown;
  try { snapshots = JSON.parse(process.env.DACS_RAIL_SNAPSHOTS ?? "[]"); } catch { snapshots = []; }
  const snapshot = Array.isArray(snapshots) ? snapshots.map(rec).find((item) => item?.registryVersion === registryVersion) : null;
  const definitions = Array.isArray(snapshot?.rails) ? snapshot.rails.map(rec) : [];
  const matching = definitions.filter((item) => item?.railId === rail?.railId && Number.isSafeInteger(item?.railVersion) && Number(item?.railVersion) >= 1);
  const version = rail?.railVersion ?? Math.max(0, ...matching.map((item) => Number(item!.railVersion)));
  const selected = matching.filter((item) => item?.railVersion === version);
  const definition = selected.length === 1 ? selected[0] : null;
  if (!definition) return "payment verification is indeterminate: authenticated pinned rail definition is unavailable";
  // This consumer implements just the native DEM adapter. Other rails remain indeterminate.
  if (definition.availability !== "live") return "payment verification is indeterminate: pinned rail is not live";
  const asset = rec(definition.asset), network = rec(definition.network);
  if (rail?.railId !== "demos-native:DEM" || definition.railType !== "demos-native" || phase !== "pay-dem" ||
      definition.phaseHandler !== phase || asset?.kind !== "native-dem" || asset.symbol !== "DEM" || asset.decimals !== 9 ||
      network?.kind !== "demos" || rec(price)?.currency !== asset.symbol ||
      canonicalize(rail?.parameters ?? {}) !== canonicalize(definition.parameters ?? {})) {
    return "payment verification is indeterminate: pinned rail handler, asset or network does not match";
  }
  return null;
}
