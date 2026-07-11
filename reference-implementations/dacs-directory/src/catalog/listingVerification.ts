import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { isListing, type Listing } from "@kynesyslabs/dacs/artifacts";
import { safePublicEndpoint } from "./publicEndpoint.js";

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
  listing: Listing | Record<string, unknown>;
  scope: Record<string, unknown>;
  contentHash: string;
  signer: string;
  sellerClaim: string;
  profile: "dacs-v0.1" | "legacy-sdk-v0.1";
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const PHASES = new Set([
  "vet-credentials", "negotiate-fixed-price", "negotiate-rfq", "negotiate-sealed-envelope", "commit-agreement",
  "pay-evm-erc20", "pay-solana-spl", "pay-cross-chain-htlc", "pay-cross-chain-liquidity-tank", "pay-ap2", "pay-x402", "pay-dem",
  "deliver-storage-program", "deliver-entitlement", "deliver-attested-payload", "rate",
]);
const CURRENT_LISTING_KEYS = new Set([
  "dacsVersion", "listingVersion", "listingId", "requiredCapabilities", "seller", "offering",
  "buyerRequirement", "pipeline", "pricing", "acceptedRails", "terms", "validity", "signature",
]);

function validPriceTerm(value: unknown): boolean {
  const term = record(value);
  return Boolean(term && typeof term.amount === "string" && /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(term.amount) &&
    Number.isFinite(Number(term.amount)) && Number(term.amount) > 0 && typeof term.currency === "string" && term.currency.length > 0 && term.currency.length <= 64 &&
    (term.unit === undefined || (typeof term.unit === "string" && term.unit.length > 0 && term.unit.length <= 64)));
}

function currentListing(scope: Record<string, unknown>): {
  signer: string; sellerClaim: string; signature: Record<string, unknown>;
} | null {
  const seller = record(scope.seller);
  const identity = record(seller?.identity);
  const offering = record(scope.offering);
  const pricing = record(scope.pricing);
  const validity = record(scope.validity);
  const signature = record((scope as Record<string, unknown>).signature);
  const claims = Array.isArray(identity?.claims) ? identity.claims.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  const pipeline = Array.isArray(scope.pipeline) ? scope.pipeline.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  const tags = Array.isArray(offering?.tags) ? offering.tags : [];
  const pricingOk = pricing?.kind === "fixed" ? validPriceTerm(pricing.price)
    : pricing?.kind === "negotiable" ? validPriceTerm(pricing.bandCenter) && typeof pricing.minPct === "number" && pricing.minPct >= 0 && pricing.minPct < 100 && typeof pricing.maxPct === "number" && pricing.maxPct >= 0
      : pricing?.kind === "auction" ? (!pricing.reservePrice || validPriceTerm(pricing.reservePrice)) && typeof pricing.selectionRule === "string" : false;
  const hasPayPhase = pipeline.some((step) => typeof step.kind === "string" && step.kind.startsWith("pay-"));
  const rails = Array.isArray(scope.acceptedRails) ? scope.acceptedRails.map(record).filter(Boolean) : [];
  const railIds = new Set(rails.map((rail) => rail?.railId).filter((rail): rail is string => typeof rail === "string"));
  const payBindingsOk = pipeline.filter((step) => typeof step.kind === "string" && step.kind.startsWith("pay-"))
    .every((step) => { const parameters = record(step.parameters); return typeof parameters?.rail === "string" && railIds.has(parameters.rail); });
  const negotiationKinds = pipeline.map((step) => step.kind).filter((kind) => typeof kind === "string" && kind.startsWith("negotiate-"));
  const expectedNegotiation = pricing?.kind === "fixed" ? "negotiate-fixed-price"
    : pricing?.kind === "negotiable" ? "negotiate-rfq" : pricing?.kind === "auction" ? "negotiate-sealed-envelope" : "";
  const signer = typeof signature?.signer === "string" ? signature.signer : "";
  const sellerClaim = typeof identity?.presentedBy === "string" ? identity.presentedBy : "";
  if (
    scope.dacsVersion !== "1" || !Number.isSafeInteger(scope.listingVersion) || Number(scope.listingVersion) < 1 ||
    typeof scope.listingId !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(scope.listingId) ||
    [...Object.keys(scope)].some((key) => !CURRENT_LISTING_KEYS.has(key)) ||
    typeof seller?.displayName !== "string" || seller.displayName.length > 200 ||
    (seller.publicEndpoint !== undefined && !safePublicEndpoint(seller.publicEndpoint)) || !sellerClaim || claims.length === 0 ||
    !claims.some((claim) => claim.ref === sellerClaim) || !claims.some((claim) => claim.ref === signer) ||
    typeof offering?.title !== "string" || offering.title.length > 200 || typeof offering.description !== "string" || offering.description.length > 2000 ||
    typeof offering.category !== "string" || !/^[a-z0-9.-]{1,64}$/.test(offering.category) || tags.length > 16 || tags.some((tag) => typeof tag !== "string" || tag.length > 32) || !record(offering.deliverable) ||
    !record(scope.buyerRequirement) || pipeline.length === 0 || pipeline.some((step) => typeof step.kind !== "string" || !PHASES.has(step.kind)) ||
    !pricingOk || negotiationKinds.length !== 1 || negotiationKinds[0] !== expectedNegotiation ||
    (hasPayPhase && (rails.length === 0 || !payBindingsOk)) || !record(scope.terms) || typeof validity?.notBefore !== "number" ||
    (typeof validity.notAfter === "number" && validity.notAfter < validity.notBefore) || !signature
  ) return null;
  return { signer, sellerClaim, signature };
}

async function verifyEd25519(message: Uint8Array, signer: string, value: unknown): Promise<boolean> {
  const keyHex = signer.match(/([0-9a-fA-F]{64})$/)?.[1];
  const sig = typeof value === "string" ? decodeSignature(value) : null;
  if (!keyHex || !sig) return false;
  try {
    const key = publicKeyFromRaw(Uint8Array.from(Buffer.from(keyHex, "hex")));
    return await ed25519Verify(message, sig, key);
  } catch {
    return false;
  }
}

async function verifyIdentityPresentation(identity: Record<string, unknown>, sellerClaim: string): Promise<boolean> {
  const presentation = record(identity.presentation);
  if (presentation?.kind !== "per-claim" || !Array.isArray(presentation.signatures)) return false;
  const signature = presentation.signatures.map(record).find((item) => item?.ref === sellerClaim);
  if (!signature) return false;
  const bundleScope = { ...identity };
  delete bundleScope.presentation;
  const message = Buffer.from(`dacs-bundle-presentation:v1:${contentHash(bundleScope)}`, "utf8");
  return verifyEd25519(message, sellerClaim, signature.signature);
}

/** Verify either the current normative Listing or the pinned SDK compatibility profile. */
export async function verifyListing(raw: Record<string, unknown>): Promise<VerifiedListing | null> {
  const current = currentListing(raw);
  if (current) {
    const scope = { ...raw };
    delete scope.signature;
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 16_384) return null;
    if (current.signature.algorithm !== "ed25519" || typeof current.signature.value !== "string") return null;
    const hash = contentHash(scope);
    const signatureOk = await verifyEd25519(
      Buffer.from(SEPARATOR + hash, "utf8"), current.signer, current.signature.value,
    );
    const seller = record(raw.seller);
    const identity = record(seller?.identity);
    if (!signatureOk || !identity || !(await verifyIdentityPresentation(identity, current.sellerClaim))) return null;
    return {
      listing: raw,
      scope,
      contentHash: hash,
      signer: current.signer,
      sellerClaim: current.sellerClaim,
      profile: "dacs-v0.1",
    };
  }

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
  return {
    listing,
    scope,
    contentHash: hash,
    signer: s.signer,
    sellerClaim: listing.agentId,
    profile: "legacy-sdk-v0.1",
  };
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
    scope.listingId !== (listing.scope.listingId ?? (listing.listing as Listing).serviceId) ||
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
