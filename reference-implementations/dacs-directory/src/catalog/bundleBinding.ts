import { createHash } from "node:crypto";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentClaim } from "./claimRef.js";
import type { BundleBinding } from "./types.js";

const BINDING_DOMAIN = "dacs-bundle-binding:v1:";
const NATIVE_ADDRESS = /^stor-[0-9a-f]{40}$/;
const LOGICAL_ADDRESS = /^stor-[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const ROLES = new Set(["buyer", "seller", "orchestrator"]);

export const MAX_BUNDLE_BINDING_CANDIDATES_PER_SIGNER = 8;
export const MAX_BUNDLE_BINDINGS_PER_JOB_ROLE = 32;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** DACS-5 §10.4.2 logical address, derived without any Demos write inputs. */
export function logicalBundleAddress(jobId: string, role: BundleBinding["role"]): string {
  return `stor-${createHash("sha256").update(`${jobId}-bundle-${role}`, "utf8").digest("hex")}`;
}

export function bundleBindingRoleKey(jobId: string, role: BundleBinding["role"]): string {
  return `${jobId}\n${role}`;
}

function strictSignatureBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 64 && bytes.toString("base64url") === value
      ? Uint8Array.from(bytes)
      : null;
  } catch {
    return null;
  }
}

/**
 * BB-4 plus structural ingress. Unknown top-level members remain in the
 * signed scope so a newer-minor field can never be silently stripped.
 */
export async function verifyBundleBinding(value: unknown): Promise<BundleBinding | null> {
  const raw = record(value);
  const signature = record(raw?.signature);
  if (
    !raw || Buffer.byteLength(JSON.stringify(raw), "utf8") > 16_384 ||
    raw.bindingVersion !== "1" || typeof raw.jobId !== "string" ||
    raw.jobId.length < 1 || raw.jobId.length > 160 ||
    typeof raw.role !== "string" || !ROLES.has(raw.role) ||
    typeof raw.logicalAddress !== "string" || !LOGICAL_ADDRESS.test(raw.logicalAddress) ||
    typeof raw.nativeAddress !== "string" || !NATIVE_ADDRESS.test(raw.nativeAddress) ||
    typeof raw.bundleContentHash !== "string" || !HASH.test(raw.bundleContentHash) ||
    (raw.anchorTx !== undefined && (typeof raw.anchorTx !== "string" || raw.anchorTx.length > 256)) ||
    typeof raw.signer !== "string" || !signature || signature.algorithm !== "ed25519" ||
    typeof signature.signer !== "string" || typeof signature.value !== "string"
  ) return null;

  const signer = canonicalDemosAgentClaim(raw.signer);
  const signatureSigner = canonicalDemosAgentClaim(signature.signer);
  if (!signer || !signatureSigner || signer !== signatureSigner) return null;
  const keyHex = signer.slice(-64);
  const sig = strictSignatureBytes(signature.value);
  if (!sig) return null;

  const scope = { ...raw };
  delete scope.signature;
  const hash = contentHash(scope);
  let ok = false;
  try {
    ok = await ed25519Verify(
      Buffer.from(BINDING_DOMAIN + hash, "utf8"),
      sig,
      publicKeyFromRaw(Uint8Array.from(Buffer.from(keyHex, "hex"))),
    );
  } catch {
    return null;
  }
  return ok ? raw as BundleBinding : null;
}

const bindingOrder = (left: BundleBinding, right: BundleBinding): number =>
  left.signer.localeCompare(right.signer) ||
  left.bundleContentHash.localeCompare(right.bundleContentHash) ||
  left.nativeAddress.localeCompare(right.nativeAddress) ||
  contentHash(left).localeCompare(contentHash(right));

/**
 * Deterministic total-work ceiling. Overflow is sticky in ScanState and must
 * make that side indeterminate; truncation can never manufacture absence.
 */
export function boundedBundleBindings(
  bindings: Iterable<BundleBinding>,
  limit = MAX_BUNDLE_BINDINGS_PER_JOB_ROLE,
): { bindings: BundleBinding[]; overflowKeys: string[] } {
  const unique = new Map<string, BundleBinding>();
  for (const binding of bindings) unique.set(contentHash(binding), binding);
  const byRole = new Map<string, BundleBinding[]>();
  for (const binding of unique.values()) {
    const key = bundleBindingRoleKey(binding.jobId, binding.role);
    const values = byRole.get(key) ?? [];
    values.push(binding);
    byRole.set(key, values);
  }
  const kept: BundleBinding[] = [];
  const overflowKeys: string[] = [];
  for (const [key, values] of [...byRole].sort(([a], [b]) => a.localeCompare(b))) {
    values.sort(bindingOrder);
    kept.push(...values.slice(0, limit));
    if (values.length > limit) overflowKeys.push(key);
  }
  return { bindings: kept, overflowKeys };
}

export interface InspectedBundle<T> {
  value: T;
  bundleContentHash: string;
  /** True when every declared buyer/seller/distinct-orchestrator signed. */
  fullSignatureStanding: boolean;
}

export type BundleSideResolution<T> =
  | { disposition: "present"; binding: BundleBinding; inspected: InspectedBundle<T> }
  | { disposition: "indeterminate"; reason: string };

/**
 * BB-5/BB-6 selection for a reputation derivation, where the authenticated
 * role holder is already known and outsider signers must be pruned pre-fetch.
 */
export async function resolveBundleSide<T>(options: {
  jobId: string;
  role: BundleBinding["role"];
  expectedSigner: string;
  bindings: readonly BundleBinding[];
  overflow?: boolean;
  inspect: (binding: BundleBinding) => Promise<InspectedBundle<T> | null>;
  budget?: number;
}): Promise<BundleSideResolution<T>> {
  const expectedSigner = canonicalDemosAgentClaim(options.expectedSigner);
  if (!expectedSigner) return { disposition: "indeterminate", reason: "role holder is not a supported canonical claim" };
  if (options.overflow) return { disposition: "indeterminate", reason: "bundle-binding discovery cap exhausted" };
  const logicalAddress = logicalBundleAddress(options.jobId, options.role);
  const candidates = options.bindings.filter((binding) =>
    binding.jobId === options.jobId && binding.role === options.role &&
    binding.logicalAddress === logicalAddress &&
    canonicalDemosAgentClaim(binding.signer) === expectedSigner,
  ).sort(bindingOrder);
  if (candidates.length === 0) {
    return { disposition: "indeterminate", reason: "no verified BundleBinding for role" };
  }

  const budget = options.budget ?? MAX_BUNDLE_BINDING_CANDIDATES_PER_SIGNER;
  const distinctNative = new Set(candidates.map((binding) => binding.nativeAddress));
  if (distinctNative.size > budget) {
    return { disposition: "indeterminate", reason: "BB-6 per-signer fetch budget exhausted" };
  }

  const accepted: Array<{ binding: BundleBinding; inspected: InspectedBundle<T> }> = [];
  for (const binding of candidates) {
    const inspected = await options.inspect(binding);
    if (inspected?.bundleContentHash === binding.bundleContentHash) {
      accepted.push({ binding, inspected });
    }
  }
  if (accepted.length === 0) {
    return { disposition: "indeterminate", reason: "every BundleBinding failed BB-5 post-fetch checks" };
  }

  // Canonically equal copies collapse. Prefer a fully-signed representative
  // inside a group, then apply the full-over-lesser standing ladder to groups.
  const groups = new Map<string, typeof accepted>();
  for (const candidate of accepted) {
    const values = groups.get(candidate.inspected.bundleContentHash) ?? [];
    values.push(candidate);
    groups.set(candidate.inspected.bundleContentHash, values);
  }
  const representatives = [...groups.values()].map((values) =>
    values.find((candidate) => candidate.inspected.fullSignatureStanding) ?? values[0]);
  if (representatives.length === 1) {
    return { disposition: "present", ...representatives[0] };
  }
  const full = representatives.filter((candidate) => candidate.inspected.fullSignatureStanding);
  if (full.length === 1) return { disposition: "present", ...full[0] };
  return { disposition: "indeterminate", reason: "authorized equal-standing bundle copies diverge" };
}
