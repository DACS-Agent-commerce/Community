import { legacyListingHash } from "./legacyListingHash.js";
import { canonicalize, contentHash, stripSignature } from "./canonical.js";
import type { LegacyMvpListing as Listing } from "@kynesyslabs/dacs/artifacts";
import { isHistoricalListing } from "./legacyListingShape.js";
import { safePublicEndpoint } from "./publicEndpoint.js";
import {
  canonicalSigningIdentity,
  resolvePrimaryClaimKey,
  resolveDemosPrimaryClaimKey,
  sameResolvedPrimaryClaim,
  verifyPrimaryClaimSignature,
  type ResolvedPrimaryClaimKey,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
import { canonicalSignatureBytes, importLegacySignatureValue, legacySignatureBytes } from "./signatureValue.js";
import type { RevocationBinding } from "./types.js";

const SEPARATOR = "dacs-listing:v1:";
/** DACS-1 LR-2: the canonical form (signature omitted) of a listing is at most 16 KB. */
export const MAX_LISTING_CANONICAL_BYTES = 16_384;

/** Compute a stored Listing hash, optionally matching an already authenticated pin; does not verify signatures. */
export function storedListingHash(raw: Record<string, unknown>, expectedHash?: string): string {
  const scope = stripSignature(raw);
  if (expectedHash !== undefined) {
    try { if (legacyListingHash(scope) === expectedHash) return expectedHash; } catch { /* Current scopes may contain fractions. */ }
  }
  const value = record(raw.signature)?.value;
  return "dacsVersion" in raw && !(typeof value === "string" && /^[0-9a-f]{128}$/.test(value))
    ? contentHash(scope) : legacyListingHash(scope);
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
// Procurement remains outside this reader profile until reconciliation can resolve
// the publisher as buyer and attribute supplier history to the agreement seller.
const PHASES = new Set([
  "vet-credentials", "negotiate-fixed-price", "negotiate-rfq", "negotiate-sealed-envelope",
  "commit-agreement", "commit-payee-bound-agreement",
  "pay-evm-erc20", "pay-solana-spl", "pay-cross-chain-htlc", "pay-cross-chain-liquidity-tank", "pay-ap2", "pay-x402", "pay-dem",
  "deliver-storage-program", "deliver-entitlement", "deliver-attested-payload", "rate",
]);
/** DACS-3 PS-3: the pricing kinds each negotiation pattern accepts. */
const NEGOTIATION_PRICING: Record<string, ReadonlySet<string>> = {
  "negotiate-fixed-price": new Set(["fixed", "negotiable", "metered"]),
  "negotiate-rfq": new Set(["negotiable", "metered"]),
  "negotiate-sealed-envelope": new Set(["auction"]),
  "negotiate-sealed-envelope-procurement": new Set(["auction"]),
};
/** DACS-4 PricingSpec auction `selectionRule`: a closed enum plus content-hash-bound rule refs. */
const SELECTION_RULES = new Set(["lowest-price", "highest-price", "first-acceptable"]);
const validSelectionRule = (value: unknown): boolean =>
  typeof value === "string" && (SELECTION_RULES.has(value) || /^rule-ref:[0-9a-f]{64}:\S+$/.test(value));

// Schema conformance (DACS-1 validation step 1) for the recognised members. Members a later
// minor may add stay open-world, as below; a recognised member must have its defined type.
const optional = (value: unknown, valid: (value: unknown) => boolean): boolean => value === undefined || valid(value);
const isString = (value: unknown): boolean => typeof value === "string";
const nonNegative = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0;
const oneOf = (...values: string[]) => (value: unknown): boolean => typeof value === "string" && values.includes(value);
const CAPABILITIES = oneOf("SR-1", "SR-2", "SR-3", "SR-4", "SR-5");

/** DACS-4 DeliverableSpec. */
function validDeliverable(value: unknown): boolean {
  const deliverable = record(value);
  const sizeOk = optional(deliverable?.expectedSizeBytes, (size) => Number.isSafeInteger(size) && Number(size) >= 0);
  return deliverable?.kind === "storage-program"
    ? optional(deliverable.schemaUrl, isString) && sizeOk && optional(deliverable.accessModel, oneOf("public", "buyer-only", "encrypt-to-buyer"))
    : deliverable?.kind === "entitlement" ? nonNegative(deliverable.durationSec) && typeof deliverable.renewable === "boolean"
      : deliverable?.kind === "attested-payload"
        ? typeof deliverable.payloadFormat === "string" && deliverable.payloadFormat.length > 0 && sizeOk &&
          optional(deliverable.verificationMethod, (method) => typeof record(method)?.kind === "string")
        : deliverable?.kind === "external"
          ? typeof deliverable.description === "string" &&
            optional(deliverable.verificationMethod, (method) => typeof record(method)?.kind === "string")
          : false;
}

/** DACS-1 §6.3.3 BundleRequirement and ClaimRequirement. */
function validClaimRequirement(value: unknown): boolean {
  const requirement = record(value);
  return Boolean(requirement && typeof requirement.scheme === "string" && requirement.scheme.length > 0 &&
    typeof requirement.verificationRequired === "boolean" && optional(requirement.maxAge, nonNegative) &&
    optional(requirement.recipeVersion, (version) => Number.isSafeInteger(version) && Number(version) >= 1) &&
    optional(requirement.parameters, (parameters) => record(parameters) !== null));
}
function validBundleRequirement(value: unknown): boolean {
  const requirement = record(value);
  return Boolean(requirement && requirement.requirementVersion === "1" &&
    Array.isArray(requirement.required) && requirement.required.every(validClaimRequirement) &&
    optional(requirement.oneOf, (groups) => Array.isArray(groups) && groups.every((group) =>
      Array.isArray(group) && group.length > 0 && group.every(validClaimRequirement))) &&
    optional(requirement.preferredPresentation, oneOf("siwd", "sr1-root", "per-claim", "session-key", "any")) &&
    optional(requirement.primaryClaimSelector, isString));
}

/** DACS-1 ListingTerms. */
function validTerms(value: unknown): boolean {
  const terms = record(value);
  return Boolean(terms && optional(terms.termsOfServiceUrl, isString) && optional(terms.termsOfServiceHash, isString) &&
    optional(terms.jurisdictions, (codes) => Array.isArray(codes) && codes.every((code) => typeof code === "string" && /^[A-Z]{2}$/.test(code))) &&
    optional(terms.conflictOfLawsRule, (rule) => oneOf("buyer-jurisdiction", "seller-jurisdiction")(rule) ||
      (typeof rule === "string" && /^rule-ref:\S+$/.test(rule))) &&
    optional(terms.deadlineSecAfterCommit, nonNegative) && optional(terms.acceptanceModel, oneOf("auto-accept")) &&
    optional(terms.cancellationPolicy, oneOf("none", "pre-commit", "with-fee")) && optional(terms.retentionYears, nonNegative) &&
    optional(terms.transcriptDisclosurePolicy, oneOf("none", "encrypted-anchored-recommended", "encrypted-anchored-required")));
}

/** DACS-4 PaymentRailRef. */
const validRail = (value: unknown): boolean => {
  const rail = record(value);
  return Boolean(rail && typeof rail.railId === "string" && rail.railId.length > 0 &&
    optional(rail.railVersion, (version) => Number.isSafeInteger(version) && Number(version) >= 1) &&
    optional(rail.parameters, (parameters) => record(parameters) !== null));
};

/**
 * DACS-1 PhaseStep per-kind parameters (DACS-3 §8.4.2-§8.4.3). A sealed-envelope step's
 * selectionRule is authoritative and the auction PricingSpec's must equal it.
 */
function validPhaseParameters(step: Record<string, unknown>, pricing: Record<string, unknown> | null): boolean {
  if (step.parameters === undefined) return !["negotiate-rfq", "negotiate-sealed-envelope", "negotiate-sealed-envelope-procurement"].includes(String(step.kind)) &&
    !String(step.kind).startsWith("pay-");
  const parameters = record(step.parameters);
  if (!parameters) return false;
  if (step.kind === "negotiate-rfq") {
    return Number.isSafeInteger(parameters.maxTurns) && Number(parameters.maxTurns) >= 2 &&
      typeof parameters.timeoutSec === "number" && parameters.timeoutSec > 0 &&
      optional(parameters.channelSubnet, isString) && optional(parameters.rfqInitiator, oneOf("buyer", "seller")) &&
      optional(parameters.fixedPriceFallback, (fallback) => typeof fallback === "boolean");
  }
  if (step.kind === "negotiate-sealed-envelope" || step.kind === "negotiate-sealed-envelope-procurement") {
    const procurement = step.kind === "negotiate-sealed-envelope-procurement";
    return typeof parameters.commitDeadline === "number" && Number.isSafeInteger(parameters.commitDeadline) &&
      typeof parameters.revealWindow === "number" && parameters.revealWindow >= 60 &&
      validSelectionRule(parameters.selectionRule) && parameters.selectionRule === pricing?.selectionRule &&
      (procurement ? parameters.auctionMode === "procurement" : optional(parameters.auctionMode, oneOf("demand"))) &&
      optional(parameters.channelSubnet, isString);
  }
  if (step.kind === "rate") return optional(parameters.required, (required) => typeof required === "boolean");
  // The remaining recognized kinds have no required parameter members. Preserve
  // object-valued additions in the signed scope; the caller checks the phase kind.
  return true;
}
// NOTE (open-world listing shape): the directory does NOT reject a listing that carries
// unknown top-level fields. §11.1.2 (additivity) lets a later minor add top-level listing
// fields, and the older-reads-newer contract (CORE.md) requires an older reader to consume a
// newer-minor artifact correctly; SIG-5 (preserve-unknown) is the mechanism that makes that
// safe — a verifier MAY ignore the *meaning* of unknown fields but MUST preserve them (it must
// not strip them from the signed content). This validator only reads the recognised fields
// below, so unknown fields are neither indexed nor interpreted, and verifyListing() hashes the
// whole scope (contentHash) so they remain signature-bound — a field injected after signing
// still fails the hash. A closed top-level
// allowlist here would reject every listing produced under the first minor that adds a
// top-level field, breaking forward compatibility.

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
      : pricing?.kind === "auction" ? (!pricing.reservePrice || validPriceTerm(pricing.reservePrice)) && validSelectionRule(pricing.selectionRule)
        : pricing?.kind === "metered" ? validPriceTerm(pricing.unitPrice) &&
          typeof pricing.unit === "string" && pricing.unit.length > 0 && pricing.unit.length <= 64 &&
          (pricing.minTotal === undefined || (
            validPriceTerm(pricing.minTotal) &&
            record(pricing.minTotal)?.currency === record(pricing.unitPrice)?.currency
          )) : false;
  const hasPayPhase = pipeline.some((step) => typeof step.kind === "string" && step.kind.startsWith("pay-"));
  const rails = Array.isArray(scope.acceptedRails) ? scope.acceptedRails.map(record).filter(Boolean) : [];
  const schemaOk = Array.isArray(scope.pipeline) && pipeline.length === scope.pipeline.length &&
    pipeline.every((step) => validPhaseParameters(step, pricing)) &&
    optional(scope.acceptedRails, (value) => Array.isArray(value) && value.every(validRail)) &&
    optional(scope.requiredCapabilities, (value) => Array.isArray(value) && value.every(CAPABILITIES)) &&
    optional(offering?.extendedDescriptionUrl, isString) && optional(offering?.extendedDescriptionHash, isString) &&
    validDeliverable(offering?.deliverable) && validBundleRequirement(scope.buyerRequirement) && validTerms(scope.terms) &&
    optional(validity?.notAfter, (notAfter) => typeof notAfter === "number");
  const railIds = new Set(rails.map((rail) => rail?.railId).filter((rail): rail is string => typeof rail === "string"));
  const payBindingsOk = pipeline.filter((step) => typeof step.kind === "string" && step.kind.startsWith("pay-"))
    .every((step) => { const parameters = record(step.parameters); return typeof parameters?.rail === "string" && railIds.has(parameters.rail); });
  const negotiationKinds = pipeline.map((step) => step.kind).filter((kind) => typeof kind === "string" && kind.startsWith("negotiate-"));
  const negotiationIndex = pipeline.findIndex((step) => typeof step.kind === "string" && step.kind.startsWith("negotiate-"));
  const commitmentIndexes = pipeline.flatMap((step, index) =>
    step.kind === "commit-agreement" || step.kind === "commit-payee-bound-agreement" ? [index] : []);
  const commitmentOk = commitmentIndexes.length === 1 && commitmentIndexes[0] === negotiationIndex + 1;
  const negotiationOk = negotiationKinds.length === 1 && typeof pricing?.kind === "string" &&
    Boolean(NEGOTIATION_PRICING[negotiationKinds[0] as string]?.has(pricing.kind));
  // PIPE-1 and VPC-1/2: delivery is mandatory, and vet authorization precedes negotiation.
  const pipelineOk = pipeline.some((step) => String(step.kind).startsWith("deliver-")) &&
    pipeline.every((step, index) => step.kind !== "vet-credentials" || index < negotiationIndex);
  const identityOk = identity?.bundleVersion === "1" && typeof identity.presentedAt === "number" &&
    Number.isFinite(identity.presentedAt) && Array.isArray(identity.claims) && claims.length === identity.claims.length &&
    claims.every((claim) => typeof claim.ref === "string" && claim.ref.length > 0);
  const signer = typeof signature?.signer === "string" ? signature.signer : "";
  const sellerClaim = typeof identity?.presentedBy === "string" ? identity.presentedBy : "";
  const signerIdentity = canonicalSigningIdentity(signer);
  const sellerIdentity = canonicalSigningIdentity(sellerClaim);
  if (
    scope.dacsVersion !== "1" || !Number.isSafeInteger(scope.listingVersion) || Number(scope.listingVersion) < 1 ||
    typeof scope.listingId !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(scope.listingId) ||
    typeof seller?.displayName !== "string" || seller.displayName.length > 200 ||
    (seller.publicEndpoint !== undefined && !safePublicEndpoint(seller.publicEndpoint)) || !sellerClaim || claims.length === 0 ||
    !claims.some((claim) => typeof claim.ref === "string" &&
      canonicalSigningIdentity(claim.ref) === sellerIdentity) ||
    !claims.some((claim) => typeof claim.ref === "string" &&
      canonicalSigningIdentity(claim.ref) === signerIdentity) ||
    typeof offering?.title !== "string" || offering.title.length > 200 || typeof offering.description !== "string" || offering.description.length > 2000 ||
    typeof offering.category !== "string" || !/^[a-z0-9.-]{1,64}$/.test(offering.category) || !Array.isArray(offering.tags) || tags.length > 16 || tags.some((tag) => typeof tag !== "string" || tag.length > 32) ||
    pipeline.length === 0 || pipeline.some((step) => typeof step.kind !== "string" || !PHASES.has(step.kind)) ||
    !pricingOk || !negotiationOk || !commitmentOk || !pipelineOk || !identityOk || !schemaOk ||
    (hasPayPhase && (rails.length === 0 || !payBindingsOk)) || typeof validity?.notBefore !== "number" ||
    (typeof validity.notAfter === "number" && validity.notAfter < validity.notBefore) || !signature
  ) return null;
  return { signer, sellerClaim, signature };
}

async function verifyEd25519(
  message: Uint8Array,
  signer: string,
  sig: Uint8Array | null,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<ResolvedPrimaryClaimKey | null> {
  return sig
    ? verifyPrimaryClaimSignature(message, sig, signer, "ed25519", resolveKey)
    : null;
}

export async function verifyIdentityPresentation(
  identity: Record<string, unknown>,
  sellerClaim: string,
  resolveKey: ResolvePrimaryClaimKey,
  hashScope = contentHash,
): Promise<ResolvedPrimaryClaimKey | null> {
  const presentation = record(identity.presentation);
  if (presentation?.kind !== "per-claim" || !Array.isArray(presentation.signatures)) return null;
  const sellerIdentity = canonicalSigningIdentity(sellerClaim);
  const signature = presentation.signatures.map(record).find((item) =>
    typeof item?.ref === "string" && canonicalSigningIdentity(item.ref) === sellerIdentity);
  if (!signature) return null;
  const bundleScope = { ...identity };
  delete bundleScope.presentation;
  const message = Buffer.from(`dacs-bundle-presentation:v1:${hashScope(bundleScope)}`, "utf8");
  // A per-claim PresentationSignature carries a bare `signature` string, not a
  // SIG-6 envelope `value`; the Directory's publisher writes the wallet's hex.
  const value = typeof signature.signature === "string" ? legacySignatureBytes(signature.signature) : null;
  return verifyEd25519(message, sellerClaim, value, resolveKey);
}

/** Verify either the current normative Listing or the pinned SDK compatibility profile. */
export async function verifyListing(
  raw: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<VerifiedListing | null> {
  return verifyListingUsingHash(raw, resolveKey, contentHash);
}

async function verifyListingUsingHash(
  raw: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey,
  hashScope: typeof contentHash,
): Promise<VerifiedListing | null> {
  if (raw.signatures !== undefined) return null;
  // Select the profile before validating it. A failed current artifact must
  // never acquire the looser legacy contract by adding draft SDK fields.
  if ("dacsVersion" in raw) {
    const current = currentListing(raw);
    if (!current) return null;
    const scope = { ...raw };
    delete scope.signature;
    if (Buffer.byteLength(canonicalize(scope), "utf8") > MAX_LISTING_CANONICAL_BYTES) return null;
    if (current.signature.algorithm !== "ed25519") return null;
    const hash = hashScope(scope);
    const verifiedSigner = await verifyEd25519(
      Buffer.from(SEPARATOR + hash, "utf8"), current.signer, canonicalSignatureBytes(current.signature.value), resolveKey,
    );
    const seller = record(raw.seller);
    const identity = record(seller?.identity);
    const verifiedSeller = identity
      ? await verifyIdentityPresentation(identity, current.sellerClaim, resolveKey, hashScope)
      : null;
    if (!verifiedSigner || !verifiedSeller) return null;
    return {
      listing: raw,
      scope,
      contentHash: hash,
      signer: verifiedSigner.canonicalClaim,
      sellerClaim: verifiedSeller.canonicalClaim,
      profile: "dacs-v0.1",
    };
  }

  let scope: Record<string, unknown>;
  try { scope = stripSignature(raw); } catch { return null; }
  if (!isHistoricalListing(scope)) return null;
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
    typeof s.value !== "string"
  ) return null;
  // Draft SDK listings predate SIG-6; this profile is read through the legacy decoder only.
  const sig = legacySignatureBytes(s.value);
  if (!sig) return null;
  let hash: string;
  try { hash = legacyListingHash(scope); } catch { return null; }
  const message = Buffer.from(SEPARATOR + hash, "utf8");
  const verifiedSigner = await verifyPrimaryClaimSignature(
    message, sig, s.signer, s.algorithm, resolveKey,
  );
  const verifiedAgent = await resolvePrimaryClaimKey(listing.agentId, s.algorithm, resolveKey);
  if (!verifiedSigner || !verifiedAgent || !sameResolvedPrimaryClaim(verifiedSigner, verifiedAgent)) return null;
  return {
    listing,
    scope,
    contentHash: hash,
    signer: verifiedSigner.canonicalClaim,
    sellerClaim: verifiedSigner.canonicalClaim,
    profile: "legacy-sdk-v0.1",
  };
}

/**
 * Read immutable history without weakening SIG-6 admission. Only an operator's
 * out-of-band pre-upgrade inventory can select the old Directory hex importer;
 * artifact fields and timestamps never grant hex-import authority. Canonical
 * Base64URL stored Listings may authenticate either supported hash profile;
 * both the Listing and its embedded presentation must verify with that profile.
 * Pins bind the exact native pointer, unsigned hash, seller and listing tuple.
 * Every read still verifies the complete current schema and both signatures.
 */
export async function verifyStoredListing(
  raw: Record<string, unknown>,
  nativeAddress: string,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<VerifiedListing | null> {
  const signature = record(raw.signature);
  if (!("dacsVersion" in raw)) return verifyListing(raw, resolveKey);
  if (canonicalSignatureBytes(signature?.value)) {
    const current = await verifyListing(raw, resolveKey);
    if (current) return current;
    // Read the previous SDK's canonical Base64URL records without changing
    // current admission or granting authority to another signature encoding.
    try { return await verifyListingUsingHash(raw, resolveKey, legacyListingHash); } catch { return null; }
  }
  if (!/^stor-[0-9a-f]{40}$/.test(nativeAddress)) return null;
  const configured = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
  if (!configured || Buffer.byteLength(configured, "utf8") > 65_536) return null;
  try {
    const pins = record(JSON.parse(configured));
    if (!pins || Object.keys(pins).length > 256 || !Object.hasOwn(pins, nativeAddress)) return null;
    const pin = record(pins[nativeAddress]);
    if (!pin || pin.encoding !== "lowercase-hex" || typeof pin.contentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(pin.contentHash) || typeof pin.sellerPrimaryClaim !== "string" ||
        pin.listingId !== raw.listingId || pin.listingVersion !== raw.listingVersion) return null;
    const value = typeof signature?.value === "string"
      ? importLegacySignatureValue(signature.value, "lowercase-hex") : null;
    if (!value) return null;
    // Only the unsigned envelope changes in memory. Keep the native bytes,
    // signed scope and pinned hash intact; never re-sign or write a replacement.
    const verified = await verifyListingUsingHash({ ...raw, signature: { ...signature, value } }, resolveKey, legacyListingHash);
    return verified && verified.contentHash === pin.contentHash &&
      verified.sellerClaim === pin.sellerPrimaryClaim && verified.signer === pin.sellerPrimaryClaim
      ? verified : null;
  } catch {
    return null;
  }
}

/** A bogus candidate must never shadow another valid owner-signed marker. */
export async function hasValidListingRevocation(
  candidateRefs: string[],
  listing: VerifiedListing,
  expectedVersion: number,
  readCandidate: (ref: string) => Promise<Record<string, unknown> | null>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<boolean> {
  return Boolean(await findValidListingRevocation(
    candidateRefs,
    listing,
    expectedVersion,
    readCandidate,
    resolveKey,
  ));
}

/** Encode the delimiter-bearing ClaimReference segment required by CF-4. */
export function revocationLogicalAddress(
  sellerPrimaryClaim: string,
  listingId: string,
  listingVersion: number,
): string {
  const encodedClaim = sellerPrimaryClaim.replace(
    /[:?&=%]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `dacs1-revoked:${encodedClaim}:${listingId}:v${listingVersion}`;
}

/** Per-listing, per-pass candidate bound; each may check cached and current bytes. */
export const REVOCATION_VERIFICATIONS_PER_PASS = 16;

/** Candidates examined by one call: unreadable ones are retried later, rejected ones were read and failed RB-4. */
export interface RevocationCandidateProgress {
  unread: string[];
  rejected: string[];
}

/**
 * Fully verify discovered candidates, in the given order and at most `limit`
 * of them, and return the RB-2 binding this catalog can publish. A bogus
 * candidate never shadows a later valid marker; unexamined candidates are
 * left for a later call. When the first reader supplies cached observations,
 * a failed check must use the current reader before recording a rejection.
 * This bounds work to `limit` current reads and at most `2 * limit` checks.
 */
export async function findValidListingRevocation(
  candidateRefs: string[],
  listing: VerifiedListing,
  expectedVersion: number,
  readCandidate: (ref: string) => Promise<Record<string, unknown> | null>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
  progress: RevocationCandidateProgress = { unread: [], rejected: [] },
  limit = REVOCATION_VERIFICATIONS_PER_PASS,
  readCurrentCandidate?: (ref: string) => Promise<Record<string, unknown> | null>,
): Promise<RevocationBinding | null> {
  for (const ref of [...new Set(candidateRefs)].slice(0, limit)) {
    let candidate = await readCandidate(ref);
    let markerHash = candidate ? await authenticatedRevocationHash(candidate, listing, expectedVersion, resolveKey) : null;
    if (!markerHash && readCurrentCandidate) {
      candidate = await readCurrentCandidate(ref);
      markerHash = candidate ? await authenticatedRevocationHash(candidate, listing, expectedVersion, resolveKey) : null;
    }
    if (!candidate) {
      progress.unread.push(ref);
      continue;
    }
    if (!markerHash) {
      progress.rejected.push(ref);
      continue;
    }
    const scope = stripSignature(candidate);
    return {
      sellerPrimaryClaim: listing.sellerClaim,
      listingId: String(scope.listingId),
      listingVersion: expectedVersion,
      listingContentHash: listing.contentHash,
      logicalAddress: revocationLogicalAddress(listing.sellerClaim, String(scope.listingId), expectedVersion),
      markerAnchor: { kind: "storage-program", locator: ref },
      markerContentHash: markerHash,
    };
  }
  return null;
}

export function ownerClaim(owner: string | undefined): string | null {
  const hex = owner?.match(/([0-9a-fA-F]{64})$/)?.[1];
  return hex ? `did:demos:agent:${hex.toLowerCase()}` : null;
}

/** Verify a tuple-bound withdrawal under the current or previous SDK hash, retaining strict SIG-6 encoding. */
export async function verifyListingRevocation(
  raw: Record<string, unknown>,
  listing: VerifiedListing,
  expectedVersion: number,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<boolean> {
  return (await authenticatedRevocationHash(raw, listing, expectedVersion, resolveKey)) !== null;
}

async function authenticatedRevocationHash(
  raw: Record<string, unknown>,
  listing: VerifiedListing,
  expectedVersion: number,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<string | null> {
  let scope: Record<string, unknown>;
  try { scope = stripSignature(raw); } catch { return null; }
  if (
    scope.listingId !== (listing.scope.listingId ?? (listing.listing as Listing).serviceId) ||
    scope.listingVersion !== expectedVersion ||
    typeof scope.listingContentHash !== "string" ||
    scope.listingContentHash.toLowerCase() !== listing.contentHash ||
    // DACS-1 types revokedAt as a number; CORE §B.2 bounds only its magnitude.
    typeof scope.revokedAt !== "number" || !(Math.abs(scope.revokedAt) <= Number.MAX_SAFE_INTEGER)
  ) return null;
  const signature = raw.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) return null;
  const s = signature as Record<string, unknown>;
  if (
    s.algorithm !== "ed25519" || typeof s.signer !== "string" ||
    typeof s.value !== "string"
  ) return null;
  // A marker is a current-profile artifact whatever the listing's profile: SIG-6 applies.
  const sig = canonicalSignatureBytes(s.value);
  if (!sig) return null;
  const verifiedEnvelopeSigner = await resolvePrimaryClaimKey(s.signer, s.algorithm, resolveKey);
  if (!verifiedEnvelopeSigner) return null;
  // The previous SDK normalized member names. Signature encoding does not
  // distinguish that profile, so authenticate the complete scope under each
  // supported hash and carry the exact one that verified into the binding.
  for (const hashScope of [contentHash, legacyListingHash]) {
    let hash: string;
    try { hash = hashScope(scope); } catch { continue; }
    const verifiedSigner = await verifyPrimaryClaimSignature(
      Buffer.from(`dacs-revocation:v1:${hash}`, "utf8"), sig, listing.signer, s.algorithm, resolveKey,
    );
    if (verifiedSigner && sameResolvedPrimaryClaim(verifiedSigner, verifiedEnvelopeSigner)) return hash;
  }
  return null;
}
