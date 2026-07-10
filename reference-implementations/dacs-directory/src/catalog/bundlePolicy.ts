import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import type { AttestationBundle } from "@kynesyslabs/dacs/artifacts";
import type { BundleVerification } from "../../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";

import { verifyListing } from "./listingVerification.js";

const SEPARATORS: Record<string, string> = {
  "dacs-3-agreement": "dacs-agreement:v1:",
  "dacs-4-evidence": "dacs-evidence:v1:",
  "dacs-2-verifyresult": "dacs-composite:v1:",
};

function decode(value: string): Uint8Array | null {
  const hex = value.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 64 ? Uint8Array.from(bytes) : null;
  } catch {
    return null;
  }
}

function keyFor(claim: string): ReturnType<typeof publicKeyFromRaw> | null {
  const hex = claim.match(/([0-9a-fA-F]{64})$/)?.[1];
  if (!hex) return null;
  try {
    return publicKeyFromRaw(Uint8Array.from(Buffer.from(hex, "hex")));
  } catch {
    return null;
  }
}

export function hasRequiredBundleSignatures(result: BundleVerification): boolean {
  const bundle = result.bundle;
  if (!bundle) return false;
  const valid = new Set(result.signatures.filter((s) => s.verdict === "valid").map((s) => s.party));
  if (result.signatures.some((s) => s.verdict !== "valid")) return false;
  const partyClaims = new Set(bundle.parties.map((p) => p.primaryClaim));
  if ([...valid].some((s) => !partyClaims.has(s))) return false;
  if (bundle.outcome === "aborted-by-self" || bundle.outcome === "aborted-by-other") {
    return valid.size === 1;
  }
  const requiredRoles = new Set(["buyer", "seller"]);
  if (bundle.parties.some((p) => p.role === "orchestrator")) requiredRoles.add("orchestrator");
  for (const role of requiredRoles) {
    const party = bundle.parties.find((p) => p.role === role);
    if (!party || !valid.has(party.primaryClaim)) return false;
  }
  return true;
}

export interface ResolvedArtifact {
  kind: string;
  raw: Record<string, unknown>;
}

/** Signature validation layered on top of the SDK's shape/hash ref checks. */
export async function verifyReferencedArtifactSignature(
  artifact: ResolvedArtifact,
): Promise<boolean> {
  if (artifact.kind === "dacs-1-listing") return (await verifyListing(artifact.raw)) !== null;
  const separator = SEPARATORS[artifact.kind];
  if (!separator) return false;
  const raw = artifact.raw;
  const scope = { ...stripSignature(raw) };
  delete scope.signatures;
  const entries = Array.isArray(raw.signatures)
    ? raw.signatures
    : raw.signature && typeof raw.signature === "object" && !Array.isArray(raw.signature)
      ? [raw.signature]
      : [];
  if (entries.length === 0) return false;
  const validSigners = new Set<string>();
  const message = Buffer.from(separator + contentHash(scope), "utf8");
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const s = entry as Record<string, unknown>;
    const signer = typeof s.signer === "string" ? s.signer : typeof s.party === "string" ? s.party : null;
    if (s.algorithm !== "ed25519" || !signer || typeof s.value !== "string") return false;
    const key = keyFor(signer);
    const signature = decode(s.value);
    if (!key || !signature || !(await ed25519Verify(message, signature, key))) return false;
    validSigners.add(signer);
  }
  if (artifact.kind === "dacs-3-agreement") {
    const buyer = scope.buyer;
    const seller = scope.seller;
    return typeof buyer === "string" && typeof seller === "string" &&
      validSigners.has(buyer) && validSigners.has(seller);
  }
  return true;
}

export async function refsPassStrictPolicy(
  verification: BundleVerification,
  artifacts: ResolvedArtifact[],
): Promise<boolean> {
  if (!verification.ok || verification.refs.some((r) => r.verdict !== "ok")) return false;
  if (artifacts.length < verification.refs.length) return false;
  const checks = await Promise.all(artifacts.map(verifyReferencedArtifactSignature));
  return checks.every(Boolean);
}

export function bundleCategory(
  bundle: AttestationBundle | undefined,
  categoriesByListing: Map<string, string>,
): string | undefined {
  return bundle ? categoriesByListing.get(String(bundle.listingRef.listingId)) : undefined;
}
