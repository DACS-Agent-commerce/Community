import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  isLegacyMvpListing,
  isListing,
  type ComponentSignature,
} from "@kynesyslabs/dacs/artifacts";
import type { BundleVerification } from "@kynesyslabs/dacs";

import type { DealRecord, RegisteredDeal } from "./types.js";

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
  const hex = /^did:demos:agent:([0-9a-f]{64})$/.exec(claim)?.[1] ??
    /^key:([0-9a-f]{64})$/.exec(claim)?.[1];
  if (!hex) return null;
  try {
    return publicKeyFromRaw(Uint8Array.from(Buffer.from(hex, "hex")));
  } catch {
    return null;
  }
}

async function verifyListingArtifactSignature(raw: Record<string, unknown>): Promise<boolean> {
  const scope = stripSignature(raw);
  let publisher: string;
  if (isListing(raw)) publisher = raw.seller.identity.presentedBy;
  else if (isLegacyMvpListing(scope)) publisher = scope.agentId;
  else return false;
  const entry = typeof raw.signature === "string"
    ? { algorithm: "ed25519", signer: publisher, value: raw.signature }
    : raw.signature as ComponentSignature;
  if (
    !entry ||
    entry.algorithm !== "ed25519" ||
    entry.signer !== publisher ||
    typeof entry.value !== "string"
  ) return false;
  const key = keyFor(publisher);
  const signature = decode(entry.value);
  if (!key || !signature) return false;
  return ed25519Verify(
    Buffer.from(`dacs-listing:v1:${contentHash(scope)}`, "utf8"),
    signature,
    key,
  );
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

/**
 * Bind a catalog-submitted deal pointer to the identities and job id covered by
 * the verified bundle signatures. Registration fields are routing hints only;
 * they must never be allowed to reassign somebody else's bundle/reputation.
 */
export function bundleMatchesRegisteredDeal(
  bundle: BundleVerification["bundle"],
  deal: RegisteredDeal,
  catalogSeller: string,
): boolean {
  if (!bundle || bundle.jobId !== deal.jobId) return false;
  const buyers = bundle.parties.filter((p) => p.role === "buyer");
  const sellers = bundle.parties.filter((p) => p.role === "seller");
  return buyers.length === 1 && sellers.length === 1 &&
    buyers[0].primaryClaim === deal.owners.buyer &&
    sellers[0].primaryClaim === deal.owners.seller &&
    sellers[0].primaryClaim === catalogSeller;
}

/** Keep at most one verified reputation record per signed job and bundle ref. */
export function dedupeVerifiedDeals(deals: DealRecord[]): DealRecord[] {
  const jobs = new Set<string>();
  const refs = new Set<string>();
  return deals.filter((deal) => {
    if (!deal.refsVerified) return true;
    const ref = deal.buyerBundleRef.toLowerCase();
    if (jobs.has(deal.jobId) || refs.has(ref)) return false;
    jobs.add(deal.jobId);
    refs.add(ref);
    return true;
  });
}

export interface ResolvedArtifact {
  kind: string;
  raw: Record<string, unknown>;
}

/**
 * Signature validation layered on top of the SDK's shape/hash ref checks.
 *
 * `partyClaims` is the set of primaryClaims on the bundle. It binds signer
 * IDENTITY (not just "some valid signature"):
 *  - dacs-3-agreement: buyer AND seller (named in the artifact) must sign.
 *  - dacs-4-evidence: this helper cannot establish the authenticated phase
 *    orchestrator, so it fails closed. Current verification belongs in the
 *    SDK `verifyEvidence` callback with session authority context.
 *  - dacs-2-verifyresult: the vetting record may be signed by an external
 *    verifier not listed as a party, so we require a valid signature but do
 *    NOT constrain the signer to the party set. Integrity is still anchored
 *    by the parent bundle's hash-binding of this ref.
 */
export async function verifyReferencedArtifactSignature(
  artifact: ResolvedArtifact,
  partyClaims: Set<string> = new Set(),
): Promise<boolean> {
  if (artifact.kind === "dacs-1-listing") return verifyListingArtifactSignature(artifact.raw);
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
  if (artifact.kind === "dacs-4-evidence") {
    return false;
  }
  return true;
}

export async function refsPassStrictPolicy(
  verification: BundleVerification,
  artifacts: ResolvedArtifact[],
): Promise<boolean> {
  if (!verification.ok || verification.refs.some((r) => r.verdict !== "ok")) return false;
  if (artifacts.length < verification.refs.length) return false;
  const partyClaims = new Set((verification.bundle?.parties ?? []).map((p) => p.primaryClaim));
  const checks = await Promise.all(
    artifacts.map((a) => verifyReferencedArtifactSignature(a, partyClaims)),
  );
  return checks.every(Boolean);
}

export function bundleCategory(
  bundle: BundleVerification["bundle"],
  categoriesByListing: Map<string, string>,
): string | undefined {
  return bundle ? categoriesByListing.get(String(bundle.listingRef.listingId)) : undefined;
}
