import { canonicalize } from "./canonical.js";
type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj | null => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;

/** Operator-installed, authenticated registry snapshots, never values from a listing/bundle/RPC.
 * PA-1 bootstrap trust is explicit: no snapshot is installed by default. An operator must
 * authenticate the registry index and rail definitions before provisioning this configuration.
 */
function railDefinitions(registryVersion: unknown): Array<Obj | null> {
  let snapshots: unknown;
  try { snapshots = JSON.parse(process.env.DACS_RAIL_SNAPSHOTS ?? "[]"); } catch { snapshots = []; }
  const snapshot = Array.isArray(snapshots) ? snapshots.map(rec).find((item) => item?.registryVersion === registryVersion) : null;
  return Array.isArray(snapshot?.rails) ? snapshot.rails.map(rec) : [];
}

const MISMATCH = "payment verification is indeterminate: pinned rail handler, asset or network does not match";

/** PA-1 for one RailRef: the operator's authenticated, live native DEM definition at its pinned
 * railVersion, else the latest (§9.4.2 step 4), with the same parameters. This is a deployment
 * capability, the same for every session that may choose the rail, whatever its outcome. Through
 * nativeRailAdmission, listing admission runs it for every rail the listing accepts, and payment
 * admission runs it for the agreed one. */
export function nativeRailDefinitionAdmission(registryVersion: unknown, rail: Obj | null): string | null {
  const definitions = railDefinitions(registryVersion);
  const matching = definitions.filter((item) => item?.railId === rail?.railId && Number.isSafeInteger(item?.railVersion) && Number(item?.railVersion) >= 1);
  const version = rail?.railVersion ?? Math.max(0, ...matching.map((item) => Number(item!.railVersion)));
  const selected = matching.filter((item) => item?.railVersion === version);
  const definition = selected.length === 1 ? selected[0] : null;
  if (!definition) return "payment verification is indeterminate: authenticated pinned rail definition is unavailable";
  // This consumer implements just the native DEM adapter. Other rails remain indeterminate.
  if (definition.availability !== "live") return "payment verification is indeterminate: pinned rail is not live";
  const asset = rec(definition.asset), network = rec(definition.network);
  if (rail?.railId !== "demos-native:DEM" || definition.railType !== "demos-native" || definition.phaseHandler !== "pay-dem" ||
      asset?.kind !== "native-dem" || asset.symbol !== "DEM" || asset.decimals !== 9 || network?.kind !== "demos" ||
      canonicalize(rail?.parameters ?? {}) !== canonicalize(definition.parameters ?? {})) {
    return MISMATCH;
  }
  return null;
}

/** The agreed rail on one payment phase: its definition, a pay-dem handler, and a price in the
 * rail's asset (PC-5). */
export function nativeRailAdmission(registryVersion: unknown, rail: Obj | null, phase: unknown, price: unknown): string | null {
  return nativeRailDefinitionAdmission(registryVersion, rail) ??
    (phase !== "pay-dem" || rec(price)?.currency !== "DEM" ? MISMATCH : null);
}
