import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { isListing, type Listing } from "@kynesyslabs/dacs/artifacts";

const SEPARATOR = "dacs-listing:v1:";

function decodeSignature(value: string): Uint8Array | null {
  const hex = value.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 64 ? Uint8Array.from(decoded) : null;
  } catch {
    return null;
  }
}

export interface VerifiedListing {
  listing: Listing;
  scope: Record<string, unknown>;
  contentHash: string;
  signer: string;
}

/** Verify the normative Listing signature and bind its signer to agentId. */
export async function verifyListing(raw: Record<string, unknown>): Promise<VerifiedListing | null> {
  const scope = stripSignature(raw);
  if (!isListing(scope)) return null;
  const listing = scope as unknown as Listing;
  const signature = raw.signature;
  // Early SDK listings stored only the Ed25519 value. Their signer is still
  // unambiguous because agentId is inside the signed scope and is also checked
  // against the substrate owner by the indexer.
  const s: Record<string, unknown> = typeof signature === "string"
    ? { algorithm: "ed25519", signer: listing.agentId, value: signature }
    : signature && typeof signature === "object" && !Array.isArray(signature)
      ? signature as Record<string, unknown>
      : {};
  if (
    s.algorithm !== "ed25519" ||
    typeof s.signer !== "string" ||
    typeof s.value !== "string" ||
    s.signer !== listing.agentId
  ) return null;
  const keyHex = s.signer.match(/([0-9a-fA-F]{64})$/)?.[1];
  const sig = decodeSignature(s.value);
  if (!keyHex || !sig) return null;
  const hash = contentHash(scope);
  const message = Buffer.from(SEPARATOR + hash, "utf8");
  try {
    const key = publicKeyFromRaw(Uint8Array.from(Buffer.from(keyHex, "hex")));
    if (!(await ed25519Verify(message, sig, key))) return null;
  } catch {
    return null;
  }
  return { listing, scope, contentHash: hash, signer: s.signer };
}

/** A bogus candidate must never shadow another valid owner-signed marker. */
export async function hasValidListingRevocation(
  candidateRefs: string[],
  listing: VerifiedListing,
  expectedVersion: number,
  readCandidate: (ref: string) => Promise<Record<string, unknown> | null>,
): Promise<boolean> {
  for (const ref of candidateRefs) {
    const candidate = await readCandidate(ref);
    if (candidate && await verifyListingRevocation(candidate, listing, expectedVersion)) return true;
  }
  return false;
}

export function ownerClaim(owner: string | undefined): string | null {
  const hex = owner?.match(/([0-9a-fA-F]{64})$/)?.[1];
  return hex ? `did:demos:agent:${hex.toLowerCase()}` : null;
}

export async function verifyListingRevocation(
  raw: Record<string, unknown>,
  listing: VerifiedListing,
  expectedVersion: number,
): Promise<boolean> {
  const scope = stripSignature(raw);
  if (
    scope.listingId !== (listing.scope.listingId ?? listing.listing.serviceId) ||
    scope.listingVersion !== expectedVersion ||
    typeof scope.listingContentHash !== "string" ||
    scope.listingContentHash.toLowerCase() !== listing.contentHash ||
    typeof scope.revokedAt !== "number"
  ) return false;
  const signature = raw.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) return false;
  const s = signature as Record<string, unknown>;
  if (
    s.algorithm !== "ed25519" || s.signer !== listing.signer ||
    typeof s.value !== "string"
  ) return false;
  const keyHex = listing.signer.match(/([0-9a-fA-F]{64})$/)?.[1];
  const sig = decodeSignature(s.value);
  if (!keyHex || !sig) return false;
  try {
    const key = publicKeyFromRaw(Uint8Array.from(Buffer.from(keyHex, "hex")));
    const message = Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`, "utf8");
    return await ed25519Verify(message, sig, key);
  } catch {
    return false;
  }
}
