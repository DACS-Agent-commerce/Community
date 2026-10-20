import { authenticateAuthorityAttestation, type VerifyAuthorityAttestation } from "./authorityAttestation.js";
import { boundLogicalAddress, cf4Segment, deliverableLogicalAddress, parsePaymentLogicalAddress, verifyAnchorBindings } from "./anchorBinding.js";
import { canonicalize, contentHash, sha256Hex } from "./canonical.js";
import { MAX_DACS_ARTIFACT_BYTES } from "./artifactLimits.js";
import { bundleSignerPolicy } from "./bundleSignerPolicy.js";
import { verifyIdentityPresentation, verifyStoredListing } from "./listingVerification.js";
import { canonicalSignatureBytes } from "./signatureValue.js";
import { settlementTxId } from "./settlementKey.js";
import { matchesVetRequirement, type VerifyPrimaryClaimControl } from "./vetClaimRules.js";
import { resolveConfiguredRecipeSnapshot, validateRecipeResult, type RecipePolicy, type ResolveRecipeSnapshot } from "./recipePolicy.js";
import { canonicalDemosAgentClaim } from "./claimRef.js";
import type { AnchorRecord } from "./chain.js";
import { nativeRailAdmission } from "./railPolicy.js";
import { verifyNativePayment, type SettlementNodeRead } from "./nativePayment.js";
import {
  canonicalSigningIdentity,
  resolveDemosPrimaryClaimKey,
  verifyPrimaryClaimSignature,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";

export type ArtifactKind = "agreement" | "evidence" | "amendment" | "verify-result" | "composite" | "rating" | "listing" | "bundle" | "attestation";
export interface CurrentRef { anchor: { kind: string; locator: string }; contentHash: string; [key: string]: unknown }
export interface ResolvedEvidence {
  kind: ArtifactKind; ref?: CurrentRef; locator: string; raw: Record<string, unknown>; contentHash: string;
  /** SB-1 pipeline index independently recovered from the payment-evidence anchor's published binding. */
  phaseIndex?: number;
  /** SB-1 settlement-tx-id of the one transfer the node confirmed for this successful payment; set only
   * by the graph after verification, so it is the only settlement a claim may cite. */
  verifiedSettlementId?: string;
}
export interface EvidenceGraph {
  profile: "dacs-v0.1";
  ok: boolean;
  reason?: string;
  bundle: Record<string, unknown>;
  bundleContentHash: string;
  signaturesVerified: boolean;
  /** Canonical claims of the parties whose bundle signatures verified; standing is computed from these only. */
  signedParties: string[];
  refsVerified: boolean;
  artifacts: ResolvedEvidence[];
  /** The bundle's settlementEvidence entries, with payment indices recovered from their anchors. */
  settlement: ResolvedEvidence[];
  agreement?: Record<string, unknown>;
  listing?: Record<string, unknown>;
  ratings: Record<string, unknown>[];
  /** DACS-4 AMEND-4: amendments that fail AMEND-1..3 are flagged, kept for audit, and never an unwind. */
  flaggedAmendments: Array<{ locator: string; reason: string }>;
}
export interface HistoricalSessionChallenge {
  jobId: string;
  party: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** Authenticated time of the first consuming attempt; presentedAt is diagnostic only. */
  consumedAt: number;
  /** sha256Hex(canonicalize(identity)) of the complete first attempted IdentityBundle,
   * including presentation and its signatures, even if verification failed. The signed bundle
   * scope hash (which omits presentation) cannot identify the consuming attempt. */
  consumedByPresentationHash: string;
}
export interface EvidenceGraphDeps {
  verifyAttestation?: VerifyAuthorityAttestation;
  resolveRecipeSnapshot?: ResolveRecipeSnapshot;
  readSettlementNode?: SettlementNodeRead;
  /** Authenticate verifier issuance, job binding, bounded lifetime and the first consuming
   * presentation attempt (CORE SN-1..4). Record its complete digest before verification,
   * including on failure; do not derive it from the requested party's signed scope hash.
   * Historical reads are idempotent; they never issue or consume a challenge.
   * Return null for unavailable evidence or a replay attempt. */
  resolveSessionChallenge?: (jobId: string, party: Record<string, unknown>) => Promise<HistoricalSessionChallenge | null>;
  /** Trusted control verifier for the presented primary claim (DACS-2 §7.12). Without one,
   * session vet admission stays fail-closed: a verified primary claim alone is not control proof. */
  verifyPrimaryClaimControl?: VerifyPrimaryClaimControl;
  readAnchorRecord?: (locator: string) => Promise<AnchorRecord | null>;
  /** Authenticated reader for restricted StorageProgram records, the only way to open a buyer-only
   * payload (DACS-4 §9.6.1). The pinned node denies anonymous restricted reads (ac8f45f
   * checkReadPermission), so the catalog installs none and buyer-only delivery is indeterminate
   * for every outcome. */
  readRestrictedAnchorRecord?: (locator: string) => Promise<AnchorRecord | null>;
  read: (locator: string) => Promise<Record<string, unknown> | null>;
  resolveListing: (ref: Record<string, unknown>) => Promise<{ locator: string; raw: Record<string, unknown> } | null>;
  resolvePrimaryClaimKey?: ResolvePrimaryClaimKey;
  /** Resolve historical IdentityBundle bytes; the graph independently checks hash and presentation. */
  resolveIdentityBundle?: (party: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const arr = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(rec).filter(Boolean) as Record<string, unknown>[] : [];
const sameSigningIdentity = (left: unknown, right: unknown): boolean =>
  typeof left === "string" && typeof right === "string" &&
  canonicalSigningIdentity(left) === canonicalSigningIdentity(right);
const OUTCOMES = new Set(["completed", "failed-perm", "failed-counterparty", "failed-substrate", "aborted-by-self", "aborted-by-other"]);
const FAILURE_OUTCOMES = new Set(["failed-perm", "failed-counterparty", "failed-substrate"]);
const PHASE_OUTCOMES = new Set(["ok", "fail"]);
const ERROR_CLASSES = new Set(["permanent", "transient", "counterparty", "substrate", "settlement-atomicity"]);
const MAX_GRAPH_ARTIFACTS = 64;
const withinArtifactLimit = (raw: Record<string, unknown>): boolean => Buffer.byteLength(JSON.stringify(raw), "utf8") <= MAX_DACS_ARTIFACT_BYTES;
const priceTermOk = (value: unknown): boolean => {
  const price = rec(value); const amount = price?.amount;
  return Boolean(price && typeof amount === "string" && /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(amount) && /[1-9]/.test(amount) &&
    typeof price.currency === "string" && price.currency.length > 0 && price.currency.length <= 64);
};
const SEPARATORS: Record<Exclude<ArtifactKind, "attestation">, string> = {
  agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", amendment: "dacs-amendment:v1:", "verify-result": "dacs-verifyresult:v1:",
  composite: "dacs-composite:v1:", rating: "dacs-rating:v1:", listing: "dacs-listing:v1:", bundle: "dacs-bundle:v1:",
};
/** DACS-4 §9.7 PaymentPhaseType and DeliveryPhaseType: the phases that produce SettlementEvidence. */
const PAYMENT_PHASES = new Set(["pay-evm-erc20", "pay-solana-spl", "pay-cross-chain-htlc", "pay-cross-chain-liquidity-tank", "pay-ap2", "pay-x402", "pay-dem"]);
const DELIVERY_PHASES = new Set(["deliver-storage-program", "deliver-entitlement", "deliver-attested-payload"]);
const settlesPhase = (kind: unknown): boolean => PAYMENT_PHASES.has(String(kind)) || DELIVERY_PHASES.has(String(kind));
/** DACS-4 §9.14: a payment phase cannot substitute another rail's ChainTxRef. */
export function paymentTxRefsOk(raw: Record<string, unknown>): boolean {
  if (!PAYMENT_PHASES.has(String(raw.phase)) || !Array.isArray(raw.paymentTxRefs)) return false;
  if (raw.outcome === "success" && raw.paymentTxRefs.length === 0) return false;
  // DACS-4 §9.5.9 / SB-1: a pay-dem settlement is one native transfer, so its paymentAmount, the
  // transfer the node confirms and its demos:{txHash} key describe one payment.
  if (raw.phase === "pay-dem" && raw.outcome === "success" && raw.paymentTxRefs.length !== 1) return false;
  // DACS-4 §9.14 / ST-8: a refund is the failed path. Success needs all
  // three stages, rather than merely one individually well-shaped reference.
  if (raw.phase === "pay-cross-chain-htlc" && raw.outcome === "success") {
    const kinds = new Set(arr(raw.paymentTxRefs).map((ref) => ref.kind));
    if (kinds.has("htlc-refund") || !["htlc-lock", "htlc-reveal", "htlc-claim"].every((kind) => kinds.has(kind))) return false;
  }
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const hash = (value: unknown): boolean => typeof value === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/.test(value);
  const chain = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
  return raw.paymentTxRefs.every((value) => {
    const ref = rec(value);
    if (!ref) return false;
    switch (raw.phase) {
      case "pay-dem": return ref.kind === "demos" && hash(ref.txHash) &&
        (raw.outcome !== "success" || Number.isSafeInteger(ref.blockNumber) && Number(ref.blockNumber) > 0);
      case "pay-evm-erc20": return ref.kind === "evm" && chain(ref.chainId) && hash(ref.txHash);
      // SB-1: the canonical key needs the instructionIndex; a reference without it is an error, never index 0.
      case "pay-solana-spl": return ref.kind === "solana" && settlementTxId(ref) !== null;
      case "pay-x402": return ref.kind === "x402" && text(ref.httpResource) &&
        typeof ref.paymentReceiptHash === "string" && /^[0-9a-f]{64}$/.test(ref.paymentReceiptHash) &&
        (ref.protocolVersion === "1" || ref.protocolVersion === "2") &&
        (ref.settlementTxHash === undefined ? ref.chainId === undefined : hash(ref.settlementTxHash) && chain(ref.chainId));
      case "pay-ap2": return ref.kind === "ap2" && text(ref.mandateId) && text(ref.providerRef) && text(ref.protocolVersion) &&
        (ref.receiptAttestation === undefined ? raw.outcome !== "success" : isCurrentRef(ref.receiptAttestation));
      case "pay-cross-chain-htlc": {
        const field = new Map([
          ["htlc-lock", "lockTxHash"], ["htlc-reveal", "revealTxHash"], ["htlc-claim", "claimTxHash"], ["htlc-refund", "refundTxHash"],
        ]).get(String(ref.kind));
        return field !== undefined && chain(ref.chainId) && text(ref.contractAddress) && hash(ref[field]);
      }
      case "pay-cross-chain-liquidity-tank": return ref.kind === "liquidity-tank" && text(ref.bridgeId) && chain(ref.sourceChainId) && chain(ref.destChainId) &&
        hash(ref.lockTxHash) && (ref.releaseTxHash === undefined ? raw.outcome !== "success" : hash(ref.releaseTxHash));
      default: return false;
    }
  });
}
/** DACS-4 §9.7: model and parameters describe the finality actually applied on this rail. */
export function paymentFinalityOk(raw: Record<string, unknown>): boolean {
  const finality = rec(raw.settlementFinality);
  if (!finality || typeof finality.finalityObservedAt !== "number" || !Number.isFinite(finality.finalityObservedAt)) return false;
  const expected: Record<string, string> = {
    "pay-dem": "bft-final", "pay-evm-erc20": "block-depth", "pay-solana-spl": "commitment-level",
    "pay-ap2": "provider-receipt", "pay-cross-chain-htlc": "htlc-reveal", "pay-cross-chain-liquidity-tank": "liquidity-tank",
  };
  // x402 uses its settlement chain when a transaction is returned, and only otherwise a provider receipt.
  const model = raw.phase === "pay-x402"
    ? arr(raw.paymentTxRefs).some((ref) => ref.settlementTxHash !== undefined) ? "block-depth" : "provider-receipt"
    : expected[String(raw.phase)];
  if (!model || finality.model !== model) return false;
  if (model === "block-depth" && (!Number.isSafeInteger(finality.finalityBlocks) || Number(finality.finalityBlocks) < 1)) return false;
  if (model === "commitment-level" && !["processed", "confirmed", "finalized"].includes(String(finality.finalityCommitmentLevel))) return false;
  return true;
}
const AMENDMENT_TYPES = new Set(["refund", "partial-refund", "correction"]);
const PAYEE_BOUND_AGREEMENT_SEPARATOR = "dacs-payee-bound-agreement:v1:";
const FAULT_BUNDLE_SEPARATOR = "dacs-fault-bundle:v1:";

type AgreementProfile = "legacy" | "payee-bound";
const AGREEMENT_PATTERNS = new Set(["fixed-price", "rfq", "sealed-envelope"]);

/** Select the agreement type before interpreting fields; never strip-and-retry. */
function agreementProfile(raw: Record<string, unknown>): AgreementProfile | null {
  const hasLegacy = Object.prototype.hasOwnProperty.call(raw, "agreementVersion");
  const hasPayeeBound = Object.prototype.hasOwnProperty.call(raw, "payeeBoundAgreementVersion");
  if (hasLegacy === hasPayeeBound) return null;
  if (hasLegacy) return raw.agreementVersion === "1" ? "legacy" : null;
  return raw.payeeBoundAgreementVersion === "1" ? "payee-bound" : null;
}

function separatorFor(raw: Record<string, unknown>, kind: Exclude<ArtifactKind, "attestation">): string | null {
  if (kind !== "agreement") return SEPARATORS[kind];
  const profile = agreementProfile(raw);
  return profile === "legacy" ? SEPARATORS.agreement
    : profile === "payee-bound" ? PAYEE_BOUND_AGREEMENT_SEPARATOR : null;
}

function payoutBindingShapeOk(value: unknown): boolean {
  const binding = rec(value);
  return Boolean(binding && typeof binding.railId === "string" && binding.railId.length > 0 &&
    Number.isSafeInteger(binding.phaseIndex) && Number(binding.phaseIndex) >= 0 &&
    typeof binding.payeeAddress === "string" && binding.payeeAddress.length > 0);
}

/** DACS-3 §8.5: bind the artifact type and every payout destination to the pinned pipeline. */
export function agreementMatchesListing(agreement: Record<string, unknown>, listing: Record<string, unknown>): boolean {
  const profile = agreementProfile(agreement);
  const terms = rec(agreement.terms);
  const pipeline = arr(listing.pipeline);
  if (!profile || !terms || !Array.isArray(listing.pipeline) || pipeline.length !== listing.pipeline.length) return false;

  const commitmentKinds = pipeline.map((phase) => phase.kind).filter((kind) =>
    kind === "commit-agreement" || kind === "commit-payee-bound-agreement");
  const expectedCommitment = profile === "legacy" ? "commit-agreement" : "commit-payee-bound-agreement";
  if (commitmentKinds.length !== 1 || commitmentKinds[0] !== expectedCommitment) return false;

  // DACS-3 §8.5.2 check 7: a valid pattern must also name this listing's
  // negotiation phase, including an explicitly enabled RFQ fixed-price fallback.
  const negotiations = pipeline.filter((phase) => typeof phase.kind === "string" && phase.kind.startsWith("negotiate-"));
  if (negotiations.length !== 1) return false;
  const negotiation = negotiations[0];
  const pricing = rec(listing.pricing);
  const fixedPriceFallback = negotiation.kind === "negotiate-rfq" &&
    rec(negotiation.parameters)?.fixedPriceFallback === true && agreement.derivedFromPattern === "fixed-price" &&
    pricing?.kind === "negotiable";
  if (agreement.derivedFromPattern !== NEGOTIATION_PATTERNS[String(negotiation.kind)] && !fixedPriceFallback) return false;

  // DACS-3 §8.5.2: fixed-price negotiation over a negotiable band selects
  // exactly its center. Canonical decimal strings avoid floating-point loss.
  if (pricing?.kind === "negotiable" && agreement.derivedFromPattern === "fixed-price") {
    const center = rec(pricing.bandCenter);
    const price = rec(terms.price);
    if (!priceTermOk(center) || !priceTermOk(price) ||
        price!.amount !== center!.amount || price!.currency !== center!.currency) return false;
  }

  if (profile === "legacy") return terms.payoutBindings === undefined;
  if (!Array.isArray(terms.payoutBindings) || !terms.payoutBindings.every(payoutBindingShapeOk)) return false;

  const expected = pipeline.flatMap((phase, phaseIndex) => {
    if (typeof phase.kind !== "string" || !phase.kind.startsWith("pay-")) return [];
    const railId = rec(phase.parameters)?.rail;
    return typeof railId === "string" ? [JSON.stringify([railId, phaseIndex])] : [];
  });
  const actual = terms.payoutBindings.map((value) => {
    const binding = rec(value)!;
    return JSON.stringify([binding.railId, binding.phaseIndex]);
  });
  return expected.length === actual.length && new Set(actual).size === actual.length &&
    expected.every((key) => actual.includes(key));
}

/** A CD-1 decimal as an integer count of 10^-scale units. */
interface Decimal { units: bigint; scale: number }
const decimal = (amount: unknown): Decimal => {
  const [whole, fraction = ""] = String(amount).split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
};
const compareDecimals = (left: Decimal, right: Decimal): number => {
  const scale = Math.max(left.scale, right.scale);
  const a = left.units * 10n ** BigInt(scale - left.scale);
  const b = right.units * 10n ** BigInt(scale - right.scale);
  return a < b ? -1 : a > b ? 1 : 0;
};
/** DACS-4 §9.7: paymentAmount is the actual settled amount, so it must equal the agreed CD-1 amount in the
 * agreed currency. PriceTerm.unit is an optional qualifier (§9.3) and binds only when both terms state it. */
const settlesAgreedPrice = (paid: unknown, agreed: unknown): boolean => {
  const settled = rec(paid); const price = rec(agreed);
  return Boolean(settled && price && priceTermOk(settled) && priceTermOk(price) && settled.currency === price.currency &&
    compareDecimals(decimal(settled.amount), decimal(price.amount)) === 0 &&
    (settled.unit === undefined || price.unit === undefined || settled.unit === price.unit));
};
/** bandCenter × (100 ± pct) / 100, rounded half-up to the centre's fractional digits (§8.5.2 check 2). */
function bandBound(center: unknown, pct: unknown, direction: 1n | -1n): Decimal | null {
  if (typeof pct !== "number" || !/^\d+(?:\.\d+)?$/.test(String(pct))) return null;
  const centre = decimal(center);
  const percent = decimal(pct);
  const denominator = 100n * 10n ** BigInt(percent.scale);
  const numerator = centre.units * (denominator + direction * percent.units);
  return numerator < 0n ? null : { units: (2n * numerator + denominator) / (2n * denominator), scale: centre.scale };
}
const NEGOTIATION_PATTERNS: Record<string, string> = {
  "negotiate-fixed-price": "fixed-price",
  "negotiate-rfq": "rfq",
  "negotiate-sealed-envelope": "sealed-envelope",
  "negotiate-sealed-envelope-procurement": "sealed-envelope",
};

/** The PriceTerm a listing names for its pricing kind, which fixes an agreement's currency (DACS-3
 * §8.5.2 check 1); none for an auction without a reserve. */
function listedPrice(pricing: Record<string, unknown> | null): Record<string, unknown> | null {
  return pricing?.kind === "fixed" ? rec(pricing.price) : pricing?.kind === "negotiable" ? rec(pricing.bandCenter)
    : pricing?.kind === "metered" ? rec(pricing.unitPrice) : pricing?.kind === "auction" ? rec(pricing.reservePrice) : null;
}

/** PA-1 and PC-5 for one payment phase under one agreement choice: the phase pays through the chosen
 * rail, whose pinned definition the session's rail registry admits, at a price in the rail's asset.
 * A committed session is checked with its agreed rail and price. Listing admission checks every rail
 * the listing accepts with the price it lists, which is null when it lists none, so the agreed currency
 * is open. A choice refused here is therefore refused for every outcome. */
function paymentPhaseAdmission(phase: Record<string, unknown>, registryVersion: unknown, rail: Record<string, unknown> | null, price: unknown): string | null {
  if (rec(phase.parameters)?.rail !== rail?.railId) return "payment phase rail does not match the agreement rail";
  return nativeRailAdmission(registryVersion, rail, phase.kind, price);
}

/** Returned when every evaluated check passed but check 5 or 6 needs a committedAt that was not supplied. */
export const COMMITTED_AT_INDETERMINATE = "committed-at-indeterminate";

/**
 * DACS-3 §8.5.2 listing conformance, checks 1-9 in order; returns the first failed check.
 * Checks 5 (deadline) and 6 (not expired) compare against the CommitmentRecord's anchored
 * `committedAt`. Without it they are vacuous only when the listing sets neither bound; otherwise
 * a later failure still wins, and if nothing fails the result is COMMITTED_AT_INDETERMINATE,
 * which a caller must never read as conformance.
 */
export function agreementListingConformance(
  agreement: Record<string, unknown>,
  listing: Record<string, unknown>,
  publisher: string,
  committedAt: number | null = null,
): string | null {
  const terms = rec(agreement.terms);
  const pricing = rec(listing.pricing);
  const price = rec(terms?.price);
  const pipeline = arr(listing.pipeline);
  if (!terms || !pricing || !price || !priceTermOk(price)) return "terms";
  const listed = listedPrice(pricing);
  // 1. Currency, before any amount comparison.
  if (listed && price.currency !== listed.currency) return "currency";
  // 2. Price, by the recognised pricing kind (MTR-5 rejects any other).
  const amount = decimal(price.amount);
  if (pricing.kind === "fixed" || (pricing.kind === "negotiable" && agreement.derivedFromPattern === "fixed-price")) {
    if (!listed || compareDecimals(amount, decimal(listed.amount)) !== 0) return "price";
    // The band still has to be a valid one: a listing whose lower bound is ≤ 0 is rejected (DACS-4).
    if (pricing.kind === "negotiable") {
      const lower = bandBound(listed.amount, pricing.minPct, -1n);
      if (!lower || lower.units <= 0n) return "price";
    }
  } else if (pricing.kind === "auction") {
    // DACS-4 PricingSpec: the reserve is an inclusive ceiling for lowest-price and an inclusive
    // floor for every other selection rule (§8.4.3 step 5).
    if (listed) {
      const order = compareDecimals(amount, decimal(listed.amount));
      if (pricing.selectionRule === "lowest-price" ? order > 0 : order < 0) return "price";
    }
  } else if (pricing.kind === "negotiable") {
    const lower = listed ? bandBound(listed.amount, pricing.minPct, -1n) : null;
    const upper = listed ? bandBound(listed.amount, pricing.maxPct, 1n) : null;
    if (!lower || !upper || lower.units <= 0n || compareDecimals(amount, lower) < 0 || compareDecimals(amount, upper) > 0) return "price";
  } else if (pricing.kind === "metered") {
    const metered = rec(terms.meteredQuantity);
    if (!listed || !metered || typeof pricing.unit !== "string" || !pricing.unit.trim() ||
        (rec(pricing.minTotal) && rec(pricing.minTotal)!.currency !== listed.currency) || metered.unit !== pricing.unit ||
        typeof metered.quantity !== "string" || !/^(?:0|[1-9]\d*)$/.test(metered.quantity)) return "price";
    const unitPrice = decimal(listed.amount);
    const total = { units: unitPrice.units * BigInt(metered.quantity), scale: unitPrice.scale };
    const minimum = rec(pricing.minTotal) ? decimal(rec(pricing.minTotal)!.amount) : null;
    if (compareDecimals(amount, minimum && compareDecimals(minimum, total) > 0 ? minimum : total) !== 0) return "price";
  } else return "unrecognized-pricing-kind";
  if (pricing.kind !== "metered" && terms.meteredQuantity !== undefined) return "price";
  // 3. Rail: present exactly when the pipeline pays, and one the listing accepts.
  const rail = rec(terms.rail);
  const pays = pipeline.some((phase) => typeof phase.kind === "string" && phase.kind.startsWith("pay-"));
  if (pays ? !rail : terms.rail !== undefined) return "rail";
  if (rail && !arr(listing.acceptedRails).some((accepted) => canonicalize(accepted) === canonicalize(rail))) return "rail";
  // 4. Deliverable: the canonical DeliverableRef of the listed DeliverableSpec.
  const deliverable = rec(terms.deliverable);
  const offered = rec(rec(listing.offering)?.deliverable);
  if (!deliverable || !offered || deliverable.deliverableType !== offered.kind ||
      normalizedHash(deliverable.hash) !== sha256Hex(canonicalize(offered)) || deliverable.schemaUrl !== offered.schemaUrl) return "deliverable";
  // 5. Deadline: terms.deadline ≤ committedAt + deadlineSecAfterCommit (unix ms against seconds).
  // 6. Not expired: validity.notAfter ≥ committedAt.
  const window = rec(listing.terms)?.deadlineSecAfterCommit;
  const notAfter = rec(listing.validity)?.notAfter;
  let unresolved = false;
  if (window !== undefined) {
    if (typeof window !== "number" || typeof terms.deadline !== "number") return "deadline";
    if (committedAt === null) unresolved = true;
    else if (terms.deadline > committedAt + window * 1000) return "deadline";
  }
  if (notAfter !== undefined) {
    if (typeof notAfter !== "number") return "not-expired";
    if (committedAt === null) unresolved = true;
    else if (notAfter < committedAt) return "not-expired";
  }
  // 7. Pattern. An RFQ step declaring fixedPriceFallback also admits the fixed-price fallback,
  // whose price check 2 already held to the band centre.
  const negotiation = pipeline.find((phase) => typeof phase.kind === "string" && phase.kind.startsWith("negotiate-"));
  const fallback = negotiation?.kind === "negotiate-rfq" && rec(negotiation.parameters)?.fixedPriceFallback === true &&
    agreement.derivedFromPattern === "fixed-price";
  if (!negotiation || (!fallback && agreement.derivedFromPattern !== NEGOTIATION_PATTERNS[String(negotiation.kind)])) return "pattern";
  // 8. Role direction: the publisher is the agreement seller, or the buyer of a procurement (SE-8).
  const publisherRole = negotiation.kind === "negotiate-sealed-envelope-procurement" ? "buyer" : "seller";
  if (!arr(agreement.parties).some((party) => party.role === publisherRole && sameSigningIdentity(party.primaryClaim, publisher))) {
    return "role-direction";
  }
  // 9. Artifact type and payout bindings match the commitment phase.
  if (!agreementMatchesListing(agreement, listing)) return "commitment-artifact";
  return unresolved ? COMMITTED_AT_INDETERMINATE : null;
}

export function signedScope(raw: Record<string, unknown>, kind: ArtifactKind): Record<string, unknown> {
  if (kind === "attestation") return { ...raw };
  const scope = { ...raw };
  if (kind === "bundle") {
    delete scope.signatures;
    delete scope.anchoredByRole;
  } else if (kind === "agreement") delete scope.signatures;
  else delete scope.signature;
  return scope;
}
export const artifactHash = (raw: Record<string, unknown>, kind: ArtifactKind): string => kind === "attestation" ? sha256Hex(canonicalize(raw)) : contentHash(signedScope(raw, kind));
export const normalizedHash = (value: unknown): string => typeof value === "string" ? value.replace(/^sha256[:-]/i, "").toLowerCase() : "";

export async function verifyComponentSignature(
  raw: Record<string, unknown>,
  kind: ArtifactKind,
  signature: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<boolean> {
  if (kind === "attestation") return false;
  if (signature.algorithm !== "ed25519" || typeof signature.signer !== "string") return false;
  const value = canonicalSignatureBytes(signature.value);
  const separator = separatorFor(raw, kind);
  if (!value || !separator) return false;
  return Boolean(await verifyPrimaryClaimSignature(
    Buffer.from(separator + artifactHash(raw, kind), "utf8"),
    value,
    signature.signer,
    signature.algorithm,
    resolveKey,
  ));
}
type BundleProfile = "legacy" | "fault";

function bundleProfile(raw: Record<string, unknown>): BundleProfile | null {
  const legacy = Object.prototype.hasOwnProperty.call(raw, "bundleVersion");
  const fault = Object.prototype.hasOwnProperty.call(raw, "faultBundleVersion");
  if (legacy === fault) return null;
  if (legacy) return raw.bundleVersion === "1" && raw.faultedParty === undefined ? "legacy" : null;
  return raw.faultBundleVersion === "1" ? "fault" : null;
}

async function verifyBundleSignature(
  raw: Record<string, unknown>,
  signature: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<boolean> {
  const party = signature.party;
  if (signature.algorithm !== "ed25519" || typeof party !== "string") return false;
  const value = canonicalSignatureBytes(signature.value);
  const profile = bundleProfile(raw);
  if (!value || !profile) return false;
  const separator = profile === "fault" ? FAULT_BUNDLE_SEPARATOR : SEPARATORS.bundle;
  return Boolean(await verifyPrimaryClaimSignature(
    Buffer.from(separator + artifactHash(raw, "bundle"), "utf8"),
    value,
    party,
    signature.algorithm,
    resolveKey,
  ));
}

export function faultAttributionOk(raw: Record<string, unknown>, parties: Record<string, unknown>[]): boolean {
  if (bundleProfile(raw) !== "fault") return true;
  const anchored = raw.anchoredByRole;
  const faulted = raw.faultedParty;
  const roles = new Set(parties.map((party) => party.role));
  if (raw.outcome === "completed" || raw.outcome === "failed-substrate") return faulted === "none";
  if (raw.outcome === "failed-perm" || raw.outcome === "aborted-by-self") return faulted === anchored;
  if (raw.outcome === "failed-counterparty" || raw.outcome === "aborted-by-other") {
    return typeof faulted === "string" && roles.has(faulted) && faulted !== anchored;
  }
  return false;
}

export function isCurrentRef(value: unknown): value is CurrentRef {
  const ref = rec(value); const anchor = rec(ref?.anchor);
  return Boolean(anchor && anchor.kind === "storage-program" && typeof anchor.locator === "string" && /^stor-[0-9a-f]{40}$/.test(anchor.locator) && /^[0-9a-f]{64}$/.test(normalizedHash(ref?.contentHash)));
}
function shapeOk(raw: Record<string, unknown>, kind: ArtifactKind): boolean {
  if (kind === "agreement") {
    const profile = agreementProfile(raw);
    const terms = rec(raw.terms);
    return Boolean(profile && typeof raw.jobId === "string" && rec(raw.listingRef) !== null &&
      typeof raw.derivedFromPattern === "string" && AGREEMENT_PATTERNS.has(raw.derivedFromPattern) &&
      arr(raw.parties).length >= 2 && terms && priceTermOk(terms.price) &&
      (profile === "legacy"
        ? terms.payoutBindings === undefined
        : Array.isArray(terms.payoutBindings) && terms.payoutBindings.every(payoutBindingShapeOk)));
  }
  if (kind === "evidence") {
    const payment = PAYMENT_PHASES.has(String(raw.phase));
    const storageDelivery = raw.phase === "deliver-storage-program" && raw.outcome === "success";
    const deliveryAnchor = rec(raw.deliverableAnchor);
    return raw.evidenceVersion === "1" && typeof raw.jobId === "string" && typeof raw.phase === "string" && settlesPhase(raw.phase) &&
      (raw.outcome === "success" || raw.outcome === "failure") && typeof raw.observedAt === "number" &&
      (!storageDelivery || (/^[0-9a-f]{64}$/.test(normalizedHash(raw.deliverableContentHash)) &&
        deliveryAnchor?.kind === "storage-program" && typeof deliveryAnchor.locator === "string" &&
        /^stor-[0-9a-f]{40}$/.test(deliveryAnchor.locator))) &&
      (raw.paymentTxRefs === undefined || Array.isArray(raw.paymentTxRefs)) &&
      (!payment || (raw.paymentTxRefs === undefined ? raw.outcome === "failure" : paymentTxRefsOk(raw))) &&
      (raw.amendmentRefs === undefined || Array.isArray(raw.amendmentRefs)) && (raw.attestationRef === undefined || isCurrentRef(raw.attestationRef)) &&
      // DACS-4 §9.7 and PC-6: a successful payment states its settled amount, its finality model and the
      // transactions it cites; delivery evidence and a failed payment carry no finality record.
      (payment && raw.outcome === "success"
        ? priceTermOk(raw.paymentAmount) && paymentFinalityOk(raw) &&
          Array.isArray(raw.paymentTxRefs) && raw.paymentTxRefs.length > 0
        : raw.settlementFinality === undefined);
  }
  // DACS-4 §9.7.1 SettlementAmendment; AMEND-1..3 are evaluated against the amended evidence in the graph.
  if (kind === "amendment") return raw.amendmentVersion === "1" && typeof raw.jobId === "string" && isCurrentRef(raw.amendsEvidenceRef) &&
    AMENDMENT_TYPES.has(String(raw.amendmentType)) && (raw.refundAmount === undefined || priceTermOk(raw.refundAmount)) &&
    (raw.refundTxRefs === undefined || Array.isArray(raw.refundTxRefs)) && typeof raw.reason === "string" && typeof raw.observedAt === "number";
  // DACS-2 §7.5 VerifyResult and §7.7 CompositeVerificationRecord required members.
  if (kind === "verify-result") return raw.resultVersion === "1" && typeof raw.scheme === "string" && typeof raw.identifier === "string" && Number.isSafeInteger(raw.recipeVersion) && typeof raw.method === "string" && typeof raw.reason === "string" && typeof raw.fetchedAt === "number" && typeof raw.verifiedAt === "number" && ["pass", "fail", "indeterminate", "error"].includes(String(raw.decision)) && isCurrentRef(raw.attestation);
  if (kind === "composite") {
    const supplementary = arr(raw.supplementary);
    return raw.recordVersion === "1" && typeof raw.jobId === "string" && typeof raw.evaluatedParty === "string" && /^[0-9a-f]{64}$/.test(normalizedHash(raw.bundleHash)) && /^[0-9a-f]{64}$/.test(normalizedHash(raw.requirementHash)) && typeof raw.generatedAt === "number" && ["pass", "fail", "indeterminate", "error"].includes(String(raw.overallDecision)) && Array.isArray(raw.freshness) && Array.isArray(raw.dealSpecific) && Array.isArray(raw.supplementary) && supplementary.length === raw.supplementary.length && supplementary.every((signal) => typeof signal.source === "string" && typeof signal.signalType === "string" && (typeof signal.value === "number" || typeof signal.value === "string") && typeof signal.observedAt === "number" && (signal.attestation === undefined ? signal.source !== "external" : isCurrentRef(signal.attestation)));
  }
  if (kind === "rating") return raw.ratingVersion === "1" && typeof raw.jobId === "string" && typeof raw.rater === "string" && typeof raw.target === "string" && (raw.targetRole === "buyer" || raw.targetRole === "seller") && Number.isInteger(raw.value) && Number(raw.value) >= 1 && Number(raw.value) <= 5 && typeof raw.ratedAt === "number" && (raw.freeText === undefined || (typeof raw.freeText === "string" && raw.freeText.length <= 1000));
  return true;
}
async function signatureOk(
  raw: Record<string, unknown>,
  kind: ArtifactKind,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<boolean> {
  if (kind === "agreement") {
    const signatures = arr(raw.signatures);
    if (raw.signature !== undefined || !Array.isArray(raw.signatures) || signatures.length !== raw.signatures.length) return false;
    const checks = await Promise.all(signatures.map((signature) => verifyComponentSignature(
      raw, kind, { ...signature, signer: signature.signer ?? signature.party }, resolveKey,
    )));
    if (!checks.every(Boolean)) return false;
    const parties = arr(raw.parties);
    const required = parties.filter((party) => party.role === "buyer" || party.role === "seller")
      .map((party) => typeof party.primaryClaim === "string" ? canonicalSigningIdentity(party.primaryClaim) : null);
    const valid = new Set(signatures.map((signature) => signature.signer ?? signature.party)
      .filter((claim): claim is string => typeof claim === "string")
      .map(canonicalSigningIdentity));
    return required.length === 2 && required.every((claim) => claim !== null && valid.has(claim));
  }
  if (raw.signatures !== undefined) return false;
  const signature = rec(raw.signature);
  if (kind === "rating" && (
    typeof signature?.signer !== "string" || typeof raw.rater !== "string" ||
    canonicalSigningIdentity(signature.signer) !== canonicalSigningIdentity(raw.rater)
  )) return false;
  return Boolean(signature && await verifyComponentSignature(raw, kind, signature, resolveKey));
}

/** Discovery uses the same agreement shape and required-party signature gates as graph resolution. */
export async function verifiedDiscoveryAgreement(raw: Record<string, unknown>): Promise<boolean> {
  try {
    return shapeOk(raw, "agreement") && await signatureOk(raw, "agreement", resolveDemosPrimaryClaimKey);
  } catch { return false; }
}

async function resolveRef(kind: ArtifactKind, ref: unknown, deps: EvidenceGraphDeps, authorityResult?: Record<string, unknown>): Promise<ResolvedEvidence | null> {
  if (kind === "attestation") {
    if (!isCurrentRef(ref)) return null;
    const hash = normalizedHash(ref.contentHash);
    const raw = await deps.read(ref.anchor.locator);
    if (!raw || !withinArtifactLimit(raw) || (!authorityResult || !(await authenticateAuthorityAttestation(raw, ref, authorityResult, deps.verifyAttestation)))) return null;
    return { kind, ref, locator: ref.anchor.locator, raw, contentHash: hash };
  }
  if (!isCurrentRef(ref)) return null;
  const hash = normalizedHash(ref.contentHash);
  const raw = await deps.read(ref.anchor.locator);
  if (!raw || !withinArtifactLimit(raw) || !shapeOk(raw, kind) || artifactHash(raw, kind) !== hash ||
      !(await signatureOk(raw, kind, deps.resolvePrimaryClaimKey ?? resolveDemosPrimaryClaimKey))) return null;
  return { kind, ref, locator: ref.anchor.locator, raw, contentHash: hash };
}

// The ACL members as the node's validator stores them (ac8f45f validateACLStructure): address lists of
// strings, and groups that each hold a members list and a list of known permissions. Anything else did
// not come from that node, so it is null and the read fails closed.
const ACL_PERMISSIONS = new Set(["read", "write", "delete"]);
const addressList = (value: unknown): string[] | null => value === undefined ? [] :
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
const aclGroups = (value: unknown): Array<{ members: unknown[]; permissions: unknown[] }> | null => {
  if (value === undefined) return [];
  if (!value || typeof value !== "object") return null;
  const groups = Object.values(value).map(rec);
  return groups.every((group) => group && Array.isArray(group.members) && Array.isArray(group.permissions) &&
    group.permissions.every((permission) => ACL_PERMISSIONS.has(permission))) ? groups as Array<{ members: unknown[]; permissions: unknown[] }> : null;
};
/** The pinned node's read decision for the buyer's canonical address (ac8f45f checkReadPermission). The node
 * compares address strings exactly, lets a restricted program's owner past its blacklist, and lets a group
 * with read permission grant access. A stricter rule here would drop deliveries the buyer can read, while
 * failures on the same listing still count. */
function buyerMayRead(acl: Record<string, unknown>, owner: unknown, buyerAddress: string): boolean {
  const allowed = addressList(acl.allowed), blacklisted = addressList(acl.blacklisted), groups = aclGroups(acl.groups);
  if (!allowed || !blacklisted || !groups) return false;
  if (acl.mode === "public") return !blacklisted.includes(buyerAddress);
  if (acl.mode === "owner") return owner === buyerAddress;
  if (acl.mode !== "restricted") return false;
  if (owner === buyerAddress) return true;
  if (blacklisted.includes(buyerAddress)) return false;
  return allowed.includes(buyerAddress) || groups.some((group) => group.members.includes(buyerAddress) && group.permissions.includes("read"));
}

/**
 * DACS-5 §10.5.1: exclusion must neither help nor harm. What this deployment cannot verify is
 * therefore decided from the pinned listing, the session's signed profile and the configured
 * adapters, never from how far the session got. Every session on such a listing is indeterminate,
 * pre-commit failures and aborts included; a check that ran only once a session committed, paid
 * or delivered would drop unverifiable completions while still counting failures. The payment and
 * delivery checks below therefore use the same helpers as the success path, for every choice the
 * listing leaves open to an agreement (each accepted rail, in the listed price's currency) or to its
 * delivery (the declared size).
 * Returns null when every phase the listing's pipeline can reach is verifiable here.
 */
export async function deploymentVerifiability(
  listing: Record<string, unknown>,
  bundle: Record<string, unknown>,
  deps: Pick<EvidenceGraphDeps, "readSettlementNode" | "readAnchorRecord" | "readRestrictedAnchorRecord" | "resolveSessionChallenge" |
    "verifyPrimaryClaimControl" | "resolveRecipeSnapshot">,
): Promise<string | null> {
  const pipeline = arr(listing.pipeline);
  const kinds = pipeline.map((phase) => String(phase.kind));
  const unsupportedPayment = kinds.find((kind) => PAYMENT_PHASES.has(kind) && kind !== "pay-dem");
  if (unsupportedPayment) return `payment rail ${unsupportedPayment} has no authoritative adapter`;
  const unsupportedDelivery = kinds.find((kind) => DELIVERY_PHASES.has(kind) && kind !== "deliver-storage-program");
  if (unsupportedDelivery) return `delivery ${unsupportedDelivery} has no authoritative attestation or entitlement adapter`;
  if (kinds.includes("pay-dem")) {
    if (!deps.readSettlementNode) return "the native payment node reader is unavailable";
    // An agreement may choose any rail the listing accepts (DACS-3 §8.5.2 check 3), in the currency of
    // the price the listing names (check 1). A pre-commit failure never says which rail or currency,
    // so every such choice must pass the same admission a committed session does (paymentPhaseAdmission),
    // non-DEM rails and an unlisted currency included.
    const accepted = arr(listing.acceptedRails);
    if (accepted.length === 0 || accepted.length !== (listing.acceptedRails as unknown[]).length) {
      return "the listing's accepted rails are not a list of rail references";
    }
    const listed = listedPrice(rec(listing.pricing));
    for (const rail of accepted) for (const phase of pipeline.filter((entry) => entry.kind === "pay-dem")) {
      const refused = paymentPhaseAdmission(phase, bundle.railRegistryVersion, rail, listed);
      if (refused) return `accepted rail ${canonicalize(rail)} at the listed price: ${refused}`;
    }
  }
  if (kinds.includes("deliver-storage-program")) {
    const deliverable = rec(rec(listing.offering)?.deliverable);
    if (deliverable?.kind !== "storage-program") return "storage delivery has no storage-program deliverable";
    const accessModel = deliverable.accessModel ?? "public";
    if (accessModel === "encrypt-to-buyer") return "storage delivery is encrypted to the buyer";
    // DACS-4 §9.6.1: a payload above the Standard's 128 KB storage limit MUST be an extended pointer,
    // and this deployment cannot read external cleartext.
    if (Number(deliverable.expectedSizeBytes) > MAX_DACS_ARTIFACT_BYTES) return "the declared payload exceeds the inline storage cap";
    if (accessModel === "buyer-only" && !deps.readRestrictedAnchorRecord) return "buyer-only payloads need an authenticated restricted reader";
    if (accessModel !== "buyer-only" && !deps.readAnchorRecord) return "the storage payload reader is unavailable";
  }
  // SB-1 keys a settlement on the phaseIndex of its PC-2 anchor address, which the signed pipeline fixes
  // only for a lone pay-dem phase. Nothing every outcome carries fixes it for a repeated one: a session
  // that fails before paying binds no anchor, so no anchorBindings member, absent, empty or full, shows
  // how its completion would have been bound. Every session on such a listing is neutral.
  if (kinds.filter((kind) => kind === "pay-dem").length > 1) {
    return "a repeated pay-dem phase leaves no listed phase index for each payment";
  }
  if (kinds.includes("vet-credentials")) {
    if (!deps.resolveSessionChallenge) return "authenticated historical session challenges are unavailable";
    const requirement = rec(listing.buyerRequirement);
    const hasRequirements = requirement && (arr(requirement.required).length > 0 ||
      (Array.isArray(requirement.oneOf) && requirement.oneOf.length > 0) || requirement.primaryClaimSelector !== undefined);
    if (hasRequirements && !deps.verifyPrimaryClaimControl) return "primary-claim control verification is unavailable";
    // Vet records, passing or failing, are judged under the session's recipe registry snapshot.
    const snapshot = await (deps.resolveRecipeSnapshot ?? resolveConfiguredRecipeSnapshot)(Number(bundle.recipeRegistryVersion));
    if (!snapshot || snapshot.registryVersion !== bundle.recipeRegistryVersion) return "the session's recipe registry snapshot is unavailable";
  }
  // DACS-3 §8.5.2 checks 5 and 6 need the CommitmentRecord's anchored committedAt, which no bundle carries.
  if (rec(listing.terms)?.deadlineSecAfterCommit !== undefined || rec(listing.validity)?.notAfter !== undefined) {
    return "commitment-time bounds need the commitment's committedAt";
  }
  // Fixed-price agreements on a negotiable listing have no settlement semantics here. With
  // negotiate-fixed-price every agreement is one; an RFQ step that enables the fixed-price fallback
  // lets any session choose one, and a pre-commit failure never says whether it would have.
  const negotiation = pipeline.find((phase) => String(phase.kind).startsWith("negotiate-"));
  if (rec(listing.pricing)?.kind === "negotiable" && (negotiation?.kind === "negotiate-fixed-price" ||
      (negotiation?.kind === "negotiate-rfq" && rec(negotiation.parameters)?.fixedPriceFallback === true))) {
    return "fixed-price agreements on negotiable listings have no settlement semantics";
  }
  return null;
}

export async function buildCurrentEvidenceGraph(bundleLocator: string, deps: EvidenceGraphDeps): Promise<EvidenceGraph> {
  const raw = await deps.read(bundleLocator);
  // A failed graph carries no content hash: a rejected bundle is never hashed again.
  const fail = (reason: string): EvidenceGraph => ({ profile: "dacs-v0.1", ok: false, reason, bundle: raw ?? {}, bundleContentHash: "", signaturesVerified: false, signedParties: [], refsVerified: false, artifacts: [], settlement: [], ratings: [], flaggedAmendments: [] });
  try {
    return await verifyCurrentEvidenceGraph(raw, deps, fail);
  } catch {
    // Untrusted bundle or referenced content that cannot be canonicalized or read fails closed.
    return fail("bundle or a referenced artifact could not be processed");
  }
}

async function verifyCurrentEvidenceGraph(
  raw: Record<string, unknown> | null,
  deps: EvidenceGraphDeps,
  fail: (reason: string) => EvidenceGraph,
): Promise<EvidenceGraph> {
  const resolveKey = deps.resolvePrimaryClaimKey ?? resolveDemosPrimaryClaimKey;
  const phases = arr(raw?.phaseSummary);
  const phaseIndexes = phases.map((phase) => phase.index);
  if (!raw || !withinArtifactLimit(raw) || raw.signature !== undefined || !bundleProfile(raw) || typeof raw.jobId !== "string" || !OUTCOMES.has(String(raw.outcome)) || !["buyer", "seller", "orchestrator"].includes(String(raw.anchoredByRole)) || !rec(raw.listingRef) || arr(raw.parties).length < 2 || !Array.isArray(raw.phaseSummary) || phases.length !== raw.phaseSummary.length || phases.some((phase) => !Number.isSafeInteger(phase.index) || Number(phase.index) < 0 || typeof phase.kind !== "string" || !PHASE_OUTCOMES.has(String(phase.outcome)) || (phase.errorClass !== undefined && !ERROR_CLASSES.has(String(phase.errorClass)))) || new Set(phaseIndexes).size !== phaseIndexes.length || !Array.isArray(raw.vetRecords) || !Array.isArray(raw.settlementEvidence) || (raw.ratingRefs !== undefined && !Array.isArray(raw.ratingRefs)) || (raw.amendments !== undefined && !Array.isArray(raw.amendments)) || (raw.anchorBindings !== undefined && !Array.isArray(raw.anchorBindings)) || !Number.isSafeInteger(raw.recipeRegistryVersion) || Number(raw.recipeRegistryVersion) < 1 || !Number.isSafeInteger(raw.railRegistryVersion) || Number(raw.railRegistryVersion) < 1 || typeof raw.finalisedAt !== "number") return fail("invalid current DACS-5 bundle shape");
  const signatures = arr(raw.signatures); const parties = arr(raw.parties);
  if (new Set(parties.map((party) => party.role)).size !== parties.length ||
      !parties.some((party) => party.role === "buyer") || !parties.some((party) => party.role === "seller") ||
      parties.some((party) => !["buyer", "seller", "orchestrator"].includes(String(party.role)) || typeof party.primaryClaim !== "string" || !/^[0-9a-f]{64}$/.test(normalizedHash(party.bundleHash)))) return fail("invalid or duplicate bundle parties");
  if (!faultAttributionOk(raw, parties)) return fail("invalid fault attribution");
  if (!Array.isArray(raw.signatures) || signatures.length !== raw.signatures.length) {
    return fail("bundle signatures contain malformed entries");
  }
  const signatureChecks = await Promise.all(signatures.map(async (signature) => ({
    party: signature.party,
    valid: await verifyBundleSignature(raw, signature, resolveKey),
  })));
  const validParties = signatureChecks.filter((check) => check.valid && typeof check.party === "string")
    .map((check) => check.party as string);
  const signaturesVerified = bundleSignerPolicy(raw, validParties,
    signatureChecks.length > 0 && signatureChecks.every((check) => check.valid));
  if (!signaturesVerified) return fail("required current bundle signatures are missing or invalid");
  const signedParties = [...new Set(validParties.map(canonicalSigningIdentity))];
  // Every later failure keeps the verified signature facts, so a caller can tell the two apart.
  const failSigned = (reason: string): EvidenceGraph => ({ ...fail(reason), signaturesVerified, signedParties });

  const abort = raw.outcome === "aborted-by-self" || raw.outcome === "aborted-by-other";
  // DACS-5 §10.3.1 / ST-2 / ST-7: a failure outcome is the terminal state of a failed phase, classified by
  // its errorClass; substrate is failed-substrate in both copies, regardless of which party anchors. The
  // other classes are a party fault whose role-relative spelling flips between the two copies of one
  // phaseSummary (§10.4.3), so only the class is checkable here. A recovered earlier failure is not terminal.
  const terminalPhase = phases.filter((phase) => phase.kind !== "rate")
    .sort((a, b) => Number(b.index) - Number(a.index))[0];
  const terminalClass = terminalPhase?.outcome === "fail" ? terminalPhase.errorClass : undefined;
  if (!abort && ((terminalClass === "substrate") !== (raw.outcome === "failed-substrate") ||
      (FAILURE_OUTCOMES.has(String(raw.outcome)) && terminalClass === undefined))) {
    return failSigned("terminal phase classification contradicts the bundle outcome");
  }
  // The anchorBindings member is judged here, whatever the outcome; below, each anchor only looks up its
  // own signer's entries. A member a completion could not carry is refused on a failure too.
  const carriedBindings = Array.isArray(raw.anchorBindings) ? raw.anchorBindings as unknown[] : [];
  if (carriedBindings.length > MAX_GRAPH_ARTIFACTS) return failSigned("evidence graph exceeds size limit");
  const anchorBindings = await verifyAnchorBindings(carriedBindings, String(raw.jobId), resolveKey);
  if (!anchorBindings) return failSigned("an anchor binding is unauthenticated or binds no address of this job");

  const artifacts: ResolvedEvidence[] = [];
  const topLevelLocators = new Map<string, { kind: ArtifactKind; hash: string }>();
  const strictTopLevelHashes = new Set<string>();
  const reserveTopLevelRef = (kind: ArtifactKind, value: unknown): "new" | "duplicate-rating" | "invalid" => {
    if (!isCurrentRef(value)) return "invalid";
    const locator = value.anchor.locator;
    const hash = normalizedHash(value.contentHash);
    const existing = topLevelLocators.get(locator);
    if (existing) {
      return kind === "rating" && existing.kind === "rating" && existing.hash === hash
        ? "duplicate-rating" : "invalid";
    }
    if (kind !== "rating" && strictTopLevelHashes.has(hash)) return "invalid";
    topLevelLocators.set(locator, { kind, hash });
    if (kind !== "rating") strictTopLevelHashes.add(hash);
    return "new";
  };
  let agreement: Record<string, unknown> | undefined;
  if (raw.agreementRef !== undefined) {
    if (reserveTopLevelRef("agreement", raw.agreementRef) !== "new") return failSigned("duplicate or invalid top-level reference");
    const resolved = await resolveRef("agreement", raw.agreementRef, deps); if (!resolved) return failSigned("agreement reference failed");
    if (resolved.raw.jobId !== raw.jobId) return failSigned("agreement belongs to another job");
    artifacts.push(resolved); agreement = resolved.raw;
  }
  // Agreement refs become mandatory only after successful commitment. Earlier terminal
  // failures still belong in reputation denominators (DACS-5 §10.3/§10.4).
  const committed = phases.some((phase) => String(phase.kind).startsWith("commit-") && phase.outcome === "ok");
  const settled = phases.some((phase) => settlesPhase(phase.kind));
  if (agreement && phases.some((phase) => String(phase.kind).startsWith("commit-") && phase.outcome === "fail")) {
    return failSigned("agreement contradicts failed commitment");
  }
  if (!agreement && (raw.outcome === "completed" || committed || settled || raw.settlementEvidence.length > 0)) {
    return failSigned("committed or settled bundle has no agreement");
  }
  if (!agreement && !abort && (!terminalPhase || terminalPhase.outcome !== "fail" ||
      !["vet-credentials", "negotiate-fixed-price", "negotiate-rfq", "negotiate-sealed-envelope", "negotiate-sealed-envelope-procurement", "commit-agreement", "commit-payee-bound-agreement"].includes(String(terminalPhase.kind)))) {
    return failSigned("pre-commit failure has no failed terminal phase");
  }
  const topLevelEvidence: ResolvedEvidence[] = [];
  for (const [kind, refs] of [["evidence", raw.settlementEvidence], ["composite", raw.vetRecords], ["rating", raw.ratingRefs], ["amendment", raw.amendments]] as Array<[ArtifactKind, unknown]>) {
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (artifacts.length >= MAX_GRAPH_ARTIFACTS) return failSigned("evidence graph exceeds size limit");
      const reserved = reserveTopLevelRef(kind, ref);
      if (reserved === "invalid") return failSigned("duplicate or invalid top-level reference");
      if (reserved === "duplicate-rating") continue;
      const resolved = await resolveRef(kind, ref, deps); if (!resolved) return failSigned(`${kind} reference failed`);
      if (resolved.raw.jobId !== raw.jobId) return failSigned(`${kind} belongs to another job`);
      if (kind === "rating") {
        const target = parties.find((party) => sameSigningIdentity(party.primaryClaim, resolved.raw.target));
        if (!parties.some((party) => sameSigningIdentity(party.primaryClaim, resolved.raw.rater)) ||
            !target || target.role !== resolved.raw.targetRole) {
          return failSigned("rating party binding failed");
        }
      }
      if ((kind === "evidence" || kind === "amendment") && !parties.some((party) =>
        sameSigningIdentity(party.primaryClaim, rec(resolved.raw.signature)?.signer))) {
        return failSigned(`${kind} signer is not a session party`);
      }
      if (kind === "evidence") topLevelEvidence.push(resolved);
      if (kind === "composite") {
        // bundleHash and evaluatedParty bind the vet to one session party's IdentityBundle (DACS-2 §7.7).
        const evaluated = parties.find((party) => sameSigningIdentity(party.primaryClaim, resolved.raw.evaluatedParty));
        if (!evaluated || normalizedHash(evaluated.bundleHash) !== normalizedHash(resolved.raw.bundleHash)) {
          return failSigned("composite record is not bound to a session party's bundle");
        }
      }
      artifacts.push(resolved);
    }
  }
  // Resolve the transitive evidence graph, not only the bundle's first-level
  // pointers. Cycles and repeated refs collapse only when kind, locator, and
  // content hash all agree.
  const seen = new Map(artifacts.map((artifact) => [`${artifact.kind}\n${artifact.locator}`, artifact]));
  let graphLimitExceeded = false;
  const addNested = async (kind: ArtifactKind, value: unknown, authorityResult?: Record<string, unknown>): Promise<boolean> => {
    if (!isCurrentRef(value)) return false;
    // A VerifyResultRef's recipeVersion is load-bearing (CORE §B.3) and must equal the resolved result's.
    const recipeOk = (artifact: ResolvedEvidence) => kind !== "verify-result" ||
      (Number.isSafeInteger(value.recipeVersion) && artifact.raw.recipeVersion === value.recipeVersion);
    const key = `${kind}\n${value.anchor.locator}`;
    const hash = normalizedHash(value.contentHash);
    const known = seen.get(key);
    if (known) return known.contentHash === hash && recipeOk(known) &&
      (kind !== "attestation" || Boolean(authorityResult && await authenticateAuthorityAttestation(known.raw, value, authorityResult, deps.verifyAttestation)));
    if (artifacts.length >= MAX_GRAPH_ARTIFACTS) { graphLimitExceeded = true; return false; }
    const nested = await resolveRef(kind, value, deps, authorityResult); if (!nested || !recipeOk(nested)) return false;
    if ((kind === "evidence" || kind === "composite" || kind === "amendment") && nested.raw.jobId !== raw.jobId) return false;
    if ((kind === "evidence" || kind === "amendment") && !parties.some((party) =>
      sameSigningIdentity(party.primaryClaim, rec(nested.raw.signature)?.signer))) return false;
    seen.set(key, nested); artifacts.push(nested); return true;
  };
  const flaggedAmendments: EvidenceGraph["flaggedAmendments"] = [];
  const amendedEvidence = new Map<ResolvedEvidence, ResolvedEvidence>();
  for (let index = 0; index < artifacts.length; index++) {
    const artifact = artifacts[index];
    if (artifact.kind === "composite") {
      for (const key of ["freshness", "dealSpecific"] as const) for (const value of Array.isArray(artifact.raw[key]) ? artifact.raw[key] as unknown[] : []) {
        if (!(await addNested("verify-result", value))) return failSigned(graphLimitExceeded ? "evidence graph exceeds size limit" : "nested VerifyResult reference failed");
      }
      for (const signal of arr(artifact.raw.supplementary)) if (signal.attestation !== undefined && !(await addNested("attestation", signal.attestation, { ...signal, method: signal.source }))) {
        return failSigned(graphLimitExceeded ? "evidence graph exceeds size limit" : "supplementary attestation reference failed");
      }
    }
    if (artifact.kind === "evidence") {
      if (artifact.raw.attestationRef !== undefined && !(await addNested("attestation", artifact.raw.attestationRef, { ...artifact.raw, method: artifact.raw.phase }))) {
        return failSigned(graphLimitExceeded ? "evidence graph exceeds size limit" : "delivery attestation reference failed");
      }
      // amendmentRefs name SettlementAmendment records (DACS-4 §9.7.1), never more evidence.
      for (const value of Array.isArray(artifact.raw.amendmentRefs) ? artifact.raw.amendmentRefs as unknown[] : []) {
        if (!(await addNested("amendment", value))) return failSigned(graphLimitExceeded ? "evidence graph exceeds size limit" : "settlement amendment reference failed");
      }
      // An ST-8 supersession is a same-phase evidence chain, not an amendment.
      if (artifact.raw.supersedesEvidenceRef !== undefined && !(await addNested("evidence", artifact.raw.supersedesEvidenceRef))) {
        return failSigned(graphLimitExceeded ? "evidence graph exceeds size limit" : "settlement evidence chain failed");
      }
    }
    if (artifact.kind === "amendment") {
      // AMEND-1: the amended record resolves to SettlementEvidence of this job. A failure flags the
      // amendment (AMEND-4) rather than failing the session.
      const target = artifact.raw.amendsEvidenceRef as CurrentRef;
      if (await addNested("evidence", target)) {
        amendedEvidence.set(artifact, seen.get(`evidence\n${target.anchor.locator}`)!);
      } else if (graphLimitExceeded) return failSigned("evidence graph exceeds size limit");
      else flaggedAmendments.push({ locator: artifact.locator, reason: "AMEND-1: the amended evidence does not resolve for this job" });
    }
    if (artifact.kind === "verify-result" && !(await addNested("attestation", artifact.raw.attestation, artifact.raw))) {
      return failSigned(graphLimitExceeded ? "evidence graph exceeds size limit" : "VerifyResult attestation reference failed");
    }
  }
  const verifiedPhaseRefs = new Set(artifacts.filter((artifact) => artifact.ref &&
    (artifact.kind === "evidence" || artifact.kind === "verify-result" || artifact.kind === "composite")).map((artifact) =>
    `${artifact.ref!.anchor.locator}\n${normalizedHash(artifact.ref!.contentHash)}`));
  const composites = artifacts.filter((artifact) => artifact.kind === "composite");
  const recipeSnapshot = artifacts.some((artifact) => artifact.kind === "verify-result" || artifact.kind === "composite")
    ? await (deps.resolveRecipeSnapshot ?? resolveConfiguredRecipeSnapshot)(Number(raw.recipeRegistryVersion)) : null;
  if (artifacts.some((artifact) => artifact.kind === "verify-result" || artifact.kind === "composite") &&
      (!recipeSnapshot || recipeSnapshot.registryVersion !== raw.recipeRegistryVersion)) return failSigned("recipe registry snapshot is unavailable");
  const recipePolicies = new Map<ResolvedEvidence, RecipePolicy | null>();
  for (const result of artifacts.filter((artifact) => artifact.kind === "verify-result")) {
    const policy = await validateRecipeResult(result.raw, async (scheme, version) => recipeSnapshot?.recipes.find((recipe) => recipe.scheme === scheme && recipe.recipeVersion === version) ?? null, resolveKey);
    recipePolicies.set(result, policy);
    // RAV-2/3: until per-result availability is disclosed, even optional results
    // need a valid live policy before giving the graph verified standing.
    if (!policy || policy.availability !== "live") return failSigned(`vet recipe availability is indeterminate: ${policy?.availability ?? "invalid policy"}`);
  }
  const vetDecisions = new Map(artifacts.filter((artifact) => artifact.kind === "composite" || artifact.kind === "verify-result").map((artifact) => [
    `${artifact.ref!.anchor.locator}\n${normalizedHash(artifact.ref!.contentHash)}`,
    artifact.kind === "composite" ? artifact.raw.overallDecision : artifact.raw.decision,
  ]));
  for (const phase of arr(raw.phaseSummary)) {
    if (phase.attestationRef === undefined) continue;
    if (!isCurrentRef(phase.attestationRef) ||
        !verifiedPhaseRefs.has(`${phase.attestationRef.anchor.locator}\n${normalizedHash(phase.attestationRef.contentHash)}`)) {
      return failSigned("phase attestation reference is outside the verified graph");
    }
    // DACS-2 VPC-4: a vet phase whose decision is not pass fails, so it cannot have succeeded.
    const decision = vetDecisions.get(`${phase.attestationRef.anchor.locator}\n${normalizedHash(phase.attestationRef.contentHash)}`);
    if (phase.outcome === "ok" && ((phase.kind === "vet-credentials" && decision !== "pass") ||
        (decision !== undefined && decision !== "pass"))) {
      return failSigned("a successful vet phase rests on verification that did not pass");
    }
  }
  // DACS-5 §10.4.3: settlementEvidence holds one record per executed settle-phase invocation and
  // nothing else, so a completed payment phase cannot stand on missing or borrowed evidence.
  const refKey = (ref: CurrentRef) => `${ref.anchor.locator}\n${normalizedHash(ref.contentHash)}`;
  const settlePhases = phases.filter((phase) => settlesPhase(phase.kind));
  const tally = (kinds: unknown[]) => kinds.reduce<Map<string, number>>((counts, kind) =>
    counts.set(String(kind), (counts.get(String(kind)) ?? 0) + 1), new Map());
  const phaseCounts = tally(settlePhases.map((phase) => phase.kind));
  const evidenceCounts = tally(topLevelEvidence.map((evidence) => evidence.raw.phase));
  if (phaseCounts.size !== evidenceCounts.size || [...phaseCounts].some(([kind, count]) => evidenceCounts.get(kind) !== count)) {
    return failSigned("settlement evidence does not match the executed settle phases");
  }
  // Pair each record with its phase entry: by the entry's attestationRef, else as the only entry of
  // its kind. The phase outcome and the evidence outcome must agree. The pairing gives SB-1 its
  // phaseIndex; below, a payment's must be the listed one, and so must any address its signer bound.
  const outcomesAgree = (phase: Record<string, unknown>, evidence: ResolvedEvidence) =>
    (phase.outcome === "ok") === (evidence.raw.outcome === "success");
  const paired = new Map<ResolvedEvidence, number>();
  for (const phase of settlePhases) {
    if (phase.attestationRef === undefined) continue;
    const evidence = topLevelEvidence.find((candidate) => refKey(candidate.ref!) === refKey(phase.attestationRef as CurrentRef));
    if (!evidence || evidence.raw.phase !== phase.kind || paired.has(evidence) || !outcomesAgree(phase, evidence)) {
      return failSigned("a settle phase's attestationRef does not name its own settlement evidence");
    }
    paired.set(evidence, Number(phase.index));
  }
  for (const evidence of topLevelEvidence) {
    const same = settlePhases.filter((phase) => phase.kind === evidence.raw.phase);
    if (!paired.has(evidence) && same.length === 1 && same[0].attestationRef === undefined) {
      if (!outcomesAgree(same[0], evidence)) return failSigned("a settle phase's outcome contradicts its settlement evidence");
      paired.set(evidence, Number(same[0].index));
    }
    evidence.phaseIndex = paired.get(evidence);
  }
  // AMEND-2 and AMEND-3, in observation order so the record that overdraws is the one flagged.
  const refunded = new Map<ResolvedEvidence, Decimal>();
  const amendments = artifacts.filter((artifact) => artifact.kind === "amendment" && amendedEvidence.has(artifact))
    .sort((a, b) => Number(a.raw.observedAt) - Number(b.raw.observedAt) || (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0));
  for (const amendment of amendments) {
    const evidence = amendedEvidence.get(amendment)!;
    const refund = rec(amendment.raw.refundAmount);
    const paid = rec(evidence.raw.paymentAmount);
    const flag = (reason: string) => flaggedAmendments.push({ locator: amendment.locator, reason });
    if (amendment.raw.amendmentType === "correction") {
      if (refund) flag("AMEND-2: a correction carries a refundAmount");
      continue;
    }
    if (evidence.raw.outcome !== "success") { flag("AMEND-2: a refund amends evidence that did not succeed"); continue; }
    if (!refund || !paid || refund.currency !== paid.currency) { flag("AMEND-3: the refund is not in the settled currency"); continue; }
    const before = refunded.get(evidence) ?? { units: 0n, scale: 0 };
    const total = decimal(refund.amount);
    const scale = Math.max(before.scale, total.scale);
    const sum = { units: before.units * 10n ** BigInt(scale - before.scale) + total.units * 10n ** BigInt(scale - total.scale), scale };
    if (compareDecimals(sum, decimal(paid.amount)) > 0) { flag("AMEND-3: refunds exceed the settled amount"); continue; }
    refunded.set(evidence, sum);
  }
  // A session that reached its agreement passed vet for every party it vetted (VPC-2, VPC-4);
  // a failed attempt may sit beside the passing one.
  const passed = new Set(composites.filter((artifact) => artifact.raw.overallDecision === "pass")
    .map((artifact) => canonicalSigningIdentity(String(artifact.raw.evaluatedParty))));
  if (agreement && composites.some((artifact) => !passed.has(canonicalSigningIdentity(String(artifact.raw.evaluatedParty))))) {
    return failSigned("a committed session has a vetted party with no passing composite record");
  }
  if (artifacts.length >= MAX_GRAPH_ARTIFACTS) return failSigned("evidence graph exceeds size limit");
  const listingRef = rec(raw.listingRef)!;
  const listed = await deps.resolveListing(listingRef);
  const listingHash = normalizedHash(listingRef.contentHash);
  // DACS-1 LR-1: the session pins the whole (listingId, listingVersion, contentHash) tuple.
  const pinnedVersion = listingRef.version ?? listingRef.listingVersion;
  const tupleOk = listed && listed.raw.listingId === listingRef.listingId &&
    Number.isSafeInteger(pinnedVersion) && listed.raw.listingVersion === pinnedVersion;
  const verifiedListing = listed && tupleOk && artifactHash(listed.raw, "listing") === listingHash
    ? await verifyStoredListing(listed.raw, listed.locator, resolveKey) : null;
  if (!listed || verifiedListing?.profile !== "dacs-v0.1") return failSigned("listing reference failed");
  // A summary entry is an invocation of the signed pipeline at this exact index. A completed
  // session executed every mandatory phase. ST-5 permits rate to be declined.
  const pipeline = arr(listed.raw.pipeline);
  if (phases.some((phase) => pipeline[Number(phase.index)]?.kind !== phase.kind)) {
    return failSigned("phase summary does not match the listing pipeline");
  }
  if (raw.outcome === "completed" && pipeline.some((phase, index) => phase.kind !== "rate" &&
      !phases.some((entry) => entry.index === index))) {
    return failSigned("completed session omits a mandatory phase from the listing pipeline");
  }
  // ST-2 / ST-8: completion requires successful mandatory phases and settlement evidence.
  // ST-5 explicitly permits a failed or declined rate phase without failing the session.
  if (raw.outcome === "completed" && (phases.some((phase) => phase.outcome === "fail" && phase.kind !== "rate") ||
      topLevelEvidence.some((evidence) => evidence.raw.outcome !== "success"))) {
    return failSigned("completed session contains a failed mandatory phase");
  }
  // DACS-2 §7.7: requirementHash binds a vet to the listing's BundleRequirement, which gates the
  // publisher's counterparty. The publisher itself is vetted against requirements the listing omits.
  const requirement = rec(listed.raw.buyerRequirement);
  if (requirement && composites.some((artifact) =>
    !sameSigningIdentity(artifact.raw.evaluatedParty, verifiedListing.sellerClaim) &&
    normalizedHash(artifact.raw.requirementHash) !== sha256Hex(canonicalize(requirement)))) {
    return failSigned("composite record is not bound to the listing's requirement");
  }
  const hasRequirements = requirement && (arr(requirement.required).length > 0 ||
    (Array.isArray(requirement.oneOf) && requirement.oneOf.length > 0) || requirement.primaryClaimSelector !== undefined);
  const vets = pipeline.some((phase) => phase.kind === "vet-credentials");
  if (agreement && hasRequirements && (!vets || !phases.some((phase) => phase.kind === "vet-credentials" && phase.outcome === "ok"))) {
    return failSigned("committed session has identity requirements without a successful vet phase");
  }
  // VPC-2 / VPC-3: the party's signed bundleHash must resolve to its actual
  // presented claims. A composite's assertion about a hash cannot replace those bytes.
  const identities = new Map<string, Record<string, unknown>>();
  if (agreement && vets) {
    for (const party of parties.filter((party) => party.role === "buyer" || party.role === "seller")) {
      if (!passed.has(canonicalSigningIdentity(String(party.primaryClaim)))) {
        return failSigned("committed session lacks passing vet records for both parties");
      }
      let identity = rec(party.identityBundle);
      if (!identity && party.identityBundleRef !== undefined) {
        if (!isCurrentRef(party.identityBundleRef) ||
            normalizedHash(party.identityBundleRef.contentHash) !== normalizedHash(party.bundleHash)) {
          return failSigned("party IdentityBundle reference failed");
        }
        identity = await deps.read(party.identityBundleRef.anchor.locator);
      }
      identity ??= await deps.resolveIdentityBundle?.(party) ?? null;
      if (!identity || !withinArtifactLimit(identity)) return failSigned("party IdentityBundle is unavailable");
      const scope = { ...identity }; delete scope.presentation;
      if (identity.bundleVersion !== "1" || typeof identity.presentedAt !== "number" || !Number.isFinite(identity.presentedAt) || contentHash(scope) !== normalizedHash(party.bundleHash) ||
          !sameSigningIdentity(identity.presentedBy, party.primaryClaim) || !Array.isArray(identity.claims) ||
          arr(identity.claims).length !== identity.claims.length || !arr(identity.claims).some((claim) =>
            sameSigningIdentity(claim.ref, party.primaryClaim)) ||
          !(await verifyIdentityPresentation(identity, String(party.primaryClaim), resolveKey))) {
        return failSigned("party IdentityBundle hash or presentation failed");
      }
      const challenge: HistoricalSessionChallenge | null | undefined = await deps.resolveSessionChallenge?.(String(raw.jobId), party);
      if (!challenge || challenge.jobId !== raw.jobId || !sameSigningIdentity(challenge.party, party.primaryClaim) ||
          typeof challenge.nonce !== "string" || challenge.nonce.length === 0 || identity.sessionNonce !== challenge.nonce ||
          normalizedHash(challenge.consumedByPresentationHash) !== sha256Hex(canonicalize(identity)) ||
          !Number.isFinite(challenge.issuedAt) || !Number.isFinite(challenge.expiresAt) || !Number.isFinite(challenge.consumedAt) ||
          challenge.consumedAt < challenge.issuedAt || challenge.consumedAt > challenge.expiresAt ||
          challenge.consumedAt > Number(raw.finalisedAt)) {
        return failSigned("session authorization is indeterminate: authenticated historical challenge is unavailable or mismatched");
      }
      identities.set(String(party.role), identity);
    }
  }
  if (agreement && requirement && vets) {
    const seller = parties.find((party) => party.role === "seller")!;
    const counterpartyRole = sameSigningIdentity(seller.primaryClaim, verifiedListing.sellerClaim) ? "buyer" : "seller";
    const counterparty = parties.find((party) => party.role === counterpartyRole)!;
    const provesRequirement = async (record: ResolvedEvidence): Promise<boolean> => {
      const results = [...arr(record.raw.freshness), ...arr(record.raw.dealSpecific)]
        .map((ref) => seen.get(`verify-result\n${rec(ref.anchor)?.locator}`)).filter((value): value is ResolvedEvidence => Boolean(value));
      // A correctly signed pass decision is usable only under its pinned deployment policy.
      // RAV-2: this catalog does not yet disclose per-result availability. Non-live
      // policies therefore remain indeterminate rather than granting verified standing.
      const eligible = results.filter((result) => recipePolicies.get(result)?.availability === "live");
      return matchesVetRequirement(identities.get(counterpartyRole)!, requirement,
        eligible, record.raw.generatedAt, raw.finalisedAt, recipeSnapshot?.recipes, deps.verifyPrimaryClaimControl);
    };
    if (!(await Promise.all(composites.map(async (record) => sameSigningIdentity(record.raw.evaluatedParty, counterparty.primaryClaim) &&
        record.raw.overallDecision === "pass" && await provesRequirement(record)))).some(Boolean)) {
      return failSigned("committed vet lacks passing verification evidence for the listing's requirements");
    }
  }
  if (agreement && canonicalize(agreement.listingRef) !== canonicalize(raw.listingRef)) return failSigned("agreement listing binding failed");
  if (agreement) {
    const agreementParties = arr(agreement.parties);
    if (!["buyer", "seller"].every((role) => agreementParties.some((candidate) =>
      candidate.role === role && parties.some((party) =>
        party.role === role && sameSigningIdentity(party.primaryClaim, candidate.primaryClaim))))) {
      return failSigned("agreement party binding failed");
    }
    // The bundle references no CommitmentRecord, so its anchored committedAt is not available here:
    // checks 5 and 6 decide only when the listing sets neither bound, and otherwise leave the
    // session indeterminate, which is never counted (DACS-3 §8.5.2 ordering note).
    const nonconforming = agreementListingConformance(agreement, listed.raw, verifiedListing.sellerClaim, null);
    if (nonconforming === COMMITTED_AT_INDETERMINATE) {
      return failSigned("agreement listing conformance is indeterminate: checks 5 and 6 need the commitment's committedAt");
    }
    if (nonconforming) return failSigned(`agreement fails listing conformance check: ${nonconforming}`);
  }
  // Discovery compatibility does not establish settlement semantics. This
  // pairing needs agreement/deliverable, payment/finality and delivery adapters
  // before either signed copy can contribute a verified outcome or volume.
  // Include the RFQ fixed-price fallback and both agreement/bundle profiles.
  if (rec(listed.raw.pricing)?.kind === "negotiable" && agreement?.derivedFromPattern === "fixed-price") {
    return { ...failSigned("semantic settlement verification is unsupported for fixed-price agreements on negotiable listings"),
      artifacts, agreement, listing: listed.raw };
  }
  // The agreed rail and price are fixed at commitment, so every committed session is held to them,
  // whatever its outcome. Checking them only once a payment succeeded would drop completions on an
  // agreement that failed sessions still count on. Listing admission runs this same check for every
  // choice an agreement could make.
  if (agreement) for (const phase of pipeline.filter((entry) => PAYMENT_PHASES.has(String(entry.kind)))) {
    const refused = paymentPhaseAdmission(phase, raw.railRegistryVersion, rec(rec(agreement.terms)?.rail), rec(agreement.terms)?.price);
    if (refused) return failSigned(refused);
  }
  // SB-1 / PC-2: a Demos StorageProgram name is an opaque write input, never a resolution key
  // (DEMOS-MAPPING §A.2, DACS-1 §6.3.4), and it is never read. PC-2 leaves a payment record whose kind
  // the signed pipeline names once that phase's address. The pairing above already holds the record to
  // that phase: summary entries match the pipeline, and one entry of a kind takes its one record. A
  // repeated kind has no listed address, and deploymentVerifiability leaves that listing neutral for
  // every outcome. A carried AnchorBinding is never needed. One the record's own signer published for
  // this anchor must name the same address, or the session contradicts itself.
  const signerBinding = (evidence: ResolvedEvidence, nativeAddress: string, hash: string) =>
    boundLogicalAddress(anchorBindings, { nativeAddress, contentHash: hash, signer: String(rec(evidence.raw.signature)?.signer) });
  for (const evidence of topLevelEvidence) {
    if (!PAYMENT_PHASES.has(String(evidence.raw.phase))) continue;
    const indexes = pipeline.flatMap((phase, index) => phase.kind === evidence.raw.phase ? [index] : []);
    const rail = rec(pipeline[indexes[0]]?.parameters)?.rail;
    const bound = signerBinding(evidence, evidence.locator, evidence.contentHash);
    const tuple = typeof bound === "string" ? parsePaymentLogicalAddress(bound) : null;
    if (indexes.length !== 1 || (bound !== undefined && (!tuple || tuple.jobId !== raw.jobId || typeof rail !== "string" ||
        tuple.encodedRail !== cf4Segment(rail) || tuple.phaseIndex !== indexes[0]))) {
      return failSigned("payment evidence anchor binding failed");
    }
  }
  // Success assertions must settle this agreement's price. Receipt-only rails stay
  // indeterminate until this profile can authenticate their authoritative responses.
  for (const evidence of topLevelEvidence) {
    if (!PAYMENT_PHASES.has(String(evidence.raw.phase)) || evidence.raw.outcome !== "success") continue;
    if (!agreement || !settlesAgreedPrice(evidence.raw.paymentAmount, rec(agreement.terms)?.price)) {
      return failSigned("payment amount does not match the agreement price");
    }
    if (evidence.raw.phase === "pay-ap2" || evidence.raw.phase === "pay-x402") {
      return failSigned("payment verification is indeterminate: authenticated provider receipt is unavailable");
    }
    if (evidence.raw.phase !== "pay-dem") {
      return failSigned("payment verification is indeterminate: authoritative rail adapter is unavailable");
    }
    // The shape admits exactly one transfer for a pay-dem success (DACS-4 §9.5.9).
    const ref = arr(evidence.raw.paymentTxRefs)[0];
    const verdict = await verifyNativePayment(ref, agreement, evidence.phaseIndex!, deps.readSettlementNode);
    if (verdict !== "pass") return failSigned(`native payment verification is ${verdict}: terminal inclusion and transfer binding required`);
    evidence.verifiedSettlementId = settlementTxId(ref) ?? undefined;
  }
  // DV-1..3: a signed success assertion alone does not establish storage delivery.
  // Use the hash-bound listing specification, never self-described payload access metadata.
  for (const evidence of topLevelEvidence) {
    if (!DELIVERY_PHASES.has(String(evidence.raw.phase)) || evidence.raw.outcome !== "success") continue;
    if (evidence.raw.phase !== "deliver-storage-program") {
      return failSigned("delivery verification is indeterminate: authoritative attestation or entitlement adapter is unavailable");
    }
    const deliverable = rec(rec(listed.raw.offering)?.deliverable);
    if (!agreement || deliverable?.kind !== "storage-program") return failSigned("storage delivery does not match the agreement");
    const accessModel = deliverable.accessModel ?? "public";
    // Anonymous catalog verification cannot open a buyer's sealed payload or verify its cleartext hash/key binding.
    if (accessModel === "encrypt-to-buyer") return failSigned("storage delivery is indeterminate: encrypted cleartext is unavailable");
    const anchor = rec(evidence.raw.deliverableAnchor)!;
    const deliverableHash = normalizedHash(evidence.raw.deliverableContentHash);
    // The payload is read at the deliverableAnchor its evidence signer put in this job's evidence (DACS-4
    // §9.6.1 step 5). A binding that signer published for that anchor must name this job's deliverable.
    const bound = signerBinding(evidence, String(anchor.locator), deliverableHash);
    if (bound !== undefined && bound !== deliverableLogicalAddress(String(raw.jobId))) {
      return failSigned("storage delivery payload binding failed");
    }
    // A buyer-only payload is node-enforced private: only an authenticated restricted reader opens it.
    const reader = accessModel === "buyer-only" ? deps.readRestrictedAnchorRecord : deps.readAnchorRecord;
    const delivered = await reader?.(String(anchor.locator));
    if (!delivered) return failSigned("storage delivery is indeterminate: payload or access metadata is unavailable");
    if (delivered.data.externalUrl !== undefined) return failSigned("storage delivery is indeterminate: external cleartext is unavailable");
    // DV-1 hashes the complete payload; artifact contentHash omits signature fields.
    if (!withinArtifactLimit(delivered.data) || sha256Hex(canonicalize(delivered.data)) !== deliverableHash) {
      return failSigned("storage delivery payload binding failed");
    }
    const acl = rec(delivered.acl);
    if (!acl || !["public", "restricted", "owner"].includes(String(acl.mode))) {
      return failSigned("storage delivery is indeterminate: access metadata is unavailable");
    }
    const buyer = arr(agreement.parties).find((party) => party.role === "buyer");
    const claim = typeof buyer?.primaryClaim === "string" ? canonicalDemosAgentClaim(buyer.primaryClaim) : null;
    const buyerAddress = claim ? `0x${claim.slice(-64)}` : null;
    // A payload the agreement-bound buyer cannot read was not delivered to it, whatever the declared mode.
    if (!buyerAddress || !buyerMayRead(acl, delivered.owner, buyerAddress)) {
      return failSigned("storage delivery is indeterminate: the buyer cannot read the delivered payload");
    }
    // DV-3: the ACL's one allowed entry is the agreement-bound buyer, and no group grants another reader.
    if (accessModel === "buyer-only" && (acl.mode !== "restricted" || !Array.isArray(acl.allowed) || acl.allowed.length !== 1 ||
        acl.allowed[0] !== buyerAddress || !(acl.groups === undefined || (rec(acl.groups) && Object.keys(acl.groups as object).length === 0)))) {
      return failSigned("storage delivery is indeterminate: buyer-only access binding failed");
    }
  }
  // Last, so every specific evidence failure above keeps its own reason; any session still standing
  // here, whatever its outcome, is excluded when its listing is not verifiable by this deployment.
  const unverifiable = await deploymentVerifiability(listed.raw, raw, deps);
  if (unverifiable) return failSigned(`session verification is indeterminate for every outcome on this listing: ${unverifiable}`);
  artifacts.push({ kind: "listing", locator: listed.locator, raw: listed.raw, contentHash: listingHash });
  return { profile: "dacs-v0.1", ok: true, bundle: raw, bundleContentHash: artifactHash(raw, "bundle"), signaturesVerified, signedParties, refsVerified: true, artifacts, settlement: topLevelEvidence, agreement, listing: listed.raw, ratings: artifacts.filter((artifact) => artifact.kind === "rating").map((artifact) => artifact.raw), flaggedAmendments };
}

export function agreementPrice(agreement: Record<string, unknown> | undefined): { amount: string; currency: string } | null {
  const price = rec(rec(agreement?.terms)?.price);
  return priceTermOk(price) ? { amount: price!.amount as string, currency: price!.currency as string } : null;
}
