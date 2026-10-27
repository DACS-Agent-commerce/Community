import { boundedJson, MAX_STORAGE_NAME_LENGTH } from "./artifactLimits.js";
import { readAnchorResult, type OwnedAnchorResolution } from "./chain.js";

const OCCUPANCY_TIMEOUT_MS = 15_000;
const MAX_OCCUPANCY_BYTES = 4096;
const MAX_CAUSE_LENGTH = 200;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uncertain = (reason: string): OwnedAnchorResolution => ({ status: "indeterminate", reason });

/**
 * Server-owned logical-version resolution, independent of producer program names.
 * Returns {status:"complete", logicalAddress, chainIdentity, nativeAddresses}
 * only after establishing complete occupancy on the requested chain, including
 * qualified absence for an empty list. Otherwise returns {status:"indeterminate",
 * reason} or throws with the real cause. Catalog/name-index absence is insufficient.
 * Implementations must bound network bytes before decoding and honor signal.
 * Request fields and artifact metadata must never supply this callback.
 */
export type ResolveListingVersion = (logicalAddress: string, chainIdentity: string, signal: AbortSignal) => Promise<unknown>;

/** Resolve complete logical occupancy and freshly read its sole native binding.
 * Returns absent only for qualified complete emptiness; failures never throw and
 * remain indeterminate. A present result still requires Listing authentication.
 */
export async function resolveListingVersionOccupancy(logicalAddress: string, chainIdentity: string,
  owner: string, resolve?: ResolveListingVersion): Promise<OwnedAnchorResolution> {
  if (!resolve) return uncertain("no complete logical-version resolver is configured; producer-name absence cannot establish an unused version");
  const controller = new AbortController();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error("logical-version resolution timed out")), OCCUPANCY_TIMEOUT_MS);
  try {
    return await Promise.race([resolveBinding(logicalAddress, chainIdentity, owner, resolve, controller.signal), aborted]);
  } catch (error) {
    let cause = "unknown resolver failure";
    if (error instanceof Error) {
      if (error.name === "TimeoutError") cause = "timed out";
      else if (error.name === "AbortError") cause = "aborted";
      else cause = "resolver error";
      if (error.message) cause += `: ${error.message}`;
    }
    return uncertain(`logical-version resolution failed: ${cause.slice(0, MAX_CAUSE_LENGTH)}`);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

async function resolveBinding(logicalAddress: string, chainIdentity: string, owner: string,
  resolve: ResolveListingVersion, signal: AbortSignal): Promise<OwnedAnchorResolution> {
  const reply = await resolve(logicalAddress, chainIdentity, signal);
  signal.throwIfAborted();
  const json = boundedJson(reply, MAX_OCCUPANCY_BYTES);
  if (!json) return uncertain("logical-version resolver reply exceeds the size or depth limit");
  const result = record(JSON.parse(json));
  if (result?.status === "indeterminate" && typeof result.reason === "string") {
    return uncertain(result.reason.slice(0, MAX_CAUSE_LENGTH));
  }
  if (result?.status !== "complete" || result.logicalAddress !== logicalAddress || result.chainIdentity !== chainIdentity ||
      !Array.isArray(result.nativeAddresses)) return uncertain("logical-version resolver returned an incomplete or invalid binding");
  if (result.nativeAddresses.length > 1) return uncertain("multiple native bindings occupy this logical listing version");
  const address: unknown = result.nativeAddresses[0];
  if (result.nativeAddresses.length === 0) return { status: "absent" };
  if (typeof address !== "string" || !/^stor-[0-9a-f]{40}$/.test(address)) return uncertain("logical-version resolver returned an invalid native locator");
  const read = await readAnchorResult(address, signal);
  signal.throwIfAborted();
  if (read.status !== "present") return uncertain(read.status === "unavailable" ? read.reason
    : `the logically resolved listing anchor is ${read.status}; occupancy remains unresolved`);
  const stored = read.record;
  const metadata = record(stored.metadata);
  const bindings = [metadata?.logicalAddress, metadata?.logical_address].filter((value) => value !== undefined);
  if (typeof stored.owner !== "string" || stored.owner.toLowerCase() !== owner.toLowerCase() ||
      typeof stored.programName !== "string" || !stored.programName || stored.programName.length > MAX_STORAGE_NAME_LENGTH ||
      stored.programName.includes(":") || (stored.storageAddress !== undefined && stored.storageAddress !== address) ||
      bindings.length === 0 || bindings.some((value) => value !== logicalAddress)) {
    return uncertain("the logically resolved listing anchor has conflicting owner or address metadata");
  }
  return { status: "present", address, record: stored };
}
