/**
 * Logical→native bindings for DACS-4 SR-2 anchors.
 *
 * Demos folds write inputs (deployer, StorageProgram name, nonce, salt) into a
 * native address, so the name is an opaque write input and never a resolution
 * key; the implementation publishes a logical→native binding instead
 * (DEMOS-MAPPING §A.2, DACS-1 §6.3.4). The pinned Standard defines that object
 * only for listings, revocations (RB-2) and bundles (BB-1..BB-8). Payment
 * evidence (PC-2) and storage deliverables (§9.6.1) use this BundleBinding-shaped
 * profile object, signed under a SIG-4 extension domain until the Standard
 * registers one. Like a BundleBinding it is self-authenticating, so any carrier
 * may serve it verbatim.
 */
import { boundedJson } from "./artifactLimits.js";
import { contentHash } from "./canonical.js";
import {
  canonicalSigningIdentity,
  resolveDemosPrimaryClaimKey,
  resolvePrimaryClaimKey,
  sameResolvedPrimaryClaim,
  verifyResolvedPrimaryClaimSignature,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
import { canonicalSignatureBytes } from "./signatureValue.js";

export const ANCHOR_BINDING_DOMAIN = "dacs-x-anchor-binding:v1:";

export interface AnchorBinding {
  anchorBindingVersion: "1";
  jobId: string;
  /** `dacs4:payment:{jobId}:{railId}:{phaseIndex}[:resolved]` or `dacs4:deliverable:{jobId}`. */
  logicalAddress: string;
  nativeAddress: string;
  /** The AttestationRef contentHash of payment evidence; the DV-1 cleartext hash of a deliverable. */
  contentHash: string;
  anchorTx?: string;
  signer: string;
  signature: { algorithm: "ed25519"; signer: string; value: string };
}

const NATIVE_ADDRESS = /^stor-[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const PAYMENT_ADDRESS = /^dacs4:payment:([^:]+):([^:]+):(0|[1-9]\d*)(?::resolved)?$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** PC-2 logical address. `railId` is a CF-4 variable segment; jobId (a ULID) is not encoded. */
export function paymentLogicalAddress(jobId: string, railId: string, phaseIndex: number, resolved = false): string {
  return `dacs4:payment:${jobId}:${encodeURIComponent(railId)}:${phaseIndex}${resolved ? ":resolved" : ""}`;
}

export function parsePaymentLogicalAddress(address: string): { jobId: string; encodedRail: string; phaseIndex: number } | null {
  const match = address.match(PAYMENT_ADDRESS);
  const phaseIndex = match ? Number(match[3]) : NaN;
  return match && Number.isSafeInteger(phaseIndex) ? { jobId: match[1], encodedRail: match[2], phaseIndex } : null;
}

/** §9.6.1 step 3 logical address of a storage deliverable. */
export const deliverableLogicalAddress = (jobId: string): string => `dacs4:deliverable:${jobId}`;

/**
 * The BB-4 equivalent plus structural ingress: `signature.signer` equals
 * `signer` and verifies over the domain-separated canonical form. Unknown
 * members stay in the signed scope. Total over untrusted JSON.
 */
export async function verifyAnchorBinding(
  value: unknown,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<AnchorBinding | null> {
  const raw = record(value);
  const signature = record(raw?.signature);
  if (
    !raw || boundedJson(raw, 16_384) === null ||
    raw.anchorBindingVersion !== "1" || typeof raw.jobId !== "string" ||
    raw.jobId.length < 1 || raw.jobId.length > 160 ||
    typeof raw.logicalAddress !== "string" || !raw.logicalAddress.startsWith("dacs4:") || raw.logicalAddress.length > 512 ||
    typeof raw.nativeAddress !== "string" || !NATIVE_ADDRESS.test(raw.nativeAddress) ||
    typeof raw.contentHash !== "string" || !HASH.test(raw.contentHash) ||
    (raw.anchorTx !== undefined && (typeof raw.anchorTx !== "string" || raw.anchorTx.length > 256)) ||
    typeof raw.signer !== "string" || !signature || signature.algorithm !== "ed25519" ||
    typeof signature.signer !== "string" || typeof signature.value !== "string"
  ) return null;

  const signer = await resolvePrimaryClaimKey(raw.signer, signature.algorithm, resolveKey);
  const signatureSigner = await resolvePrimaryClaimKey(signature.signer, signature.algorithm, resolveKey);
  if (!signer || !signatureSigner || !sameResolvedPrimaryClaim(signer, signatureSigner)) return null;
  const sig = canonicalSignatureBytes(signature.value);
  if (!sig) return null;

  const scope = { ...raw };
  delete scope.signature;
  let hash: string;
  try {
    hash = contentHash(scope);
  } catch {
    return null;
  }
  return verifyResolvedPrimaryClaimSignature(Buffer.from(ANCHOR_BINDING_DOMAIN + hash, "utf8"), sig, signer)
    ? raw as unknown as AnchorBinding
    : null;
}

/**
 * The logical address that carried bindings publish for one native anchor.
 * Only bindings signed by `signer`, the party that signed the anchored record,
 * for this job and content hash count; others are inert. None, or two that
 * disagree, leaves the anchor unbound (null). Raw candidates are pre-filtered
 * on the native address so unrelated entries cost no signature work.
 */
export async function boundLogicalAddress(
  carried: readonly unknown[],
  anchor: { jobId: string; nativeAddress: string; contentHash: string; signer: unknown },
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<string | null> {
  if (typeof anchor.signer !== "string") return null;
  const signer = canonicalSigningIdentity(anchor.signer);
  const addresses = new Set<string>();
  for (const candidate of carried) {
    if (record(candidate)?.nativeAddress !== anchor.nativeAddress) continue;
    const binding = await verifyAnchorBinding(candidate, resolveKey);
    if (!binding || binding.jobId !== anchor.jobId || binding.contentHash !== anchor.contentHash ||
        canonicalSigningIdentity(binding.signer) !== signer) continue;
    addresses.add(binding.logicalAddress);
  }
  return addresses.size === 1 ? [...addresses][0] : null;
}
