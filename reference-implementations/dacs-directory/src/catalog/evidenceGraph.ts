import { contentHash } from "@kynesyslabs/dacs/canonical";
import { MAX_DACS_ARTIFACT_BYTES } from "./artifactLimits.js";
import { bundleSignerPolicy } from "./bundleSignerPolicy.js";
import { verifyListing } from "./listingVerification.js";
import { canonicalSignatureBytes } from "./signatureValue.js";
import {
  canonicalSigningIdentity,
  resolveDemosPrimaryClaimKey,
  verifyPrimaryClaimSignature,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";

export type ArtifactKind = "agreement" | "evidence" | "verify-result" | "composite" | "rating" | "listing" | "bundle" | "attestation";
export interface CurrentRef { anchor: { kind: string; locator: string }; contentHash: string; [key: string]: unknown }
export interface ResolvedEvidence { kind: ArtifactKind; ref?: CurrentRef; locator: string; raw: Record<string, unknown>; contentHash: string }
export interface EvidenceGraph {
  profile: "dacs-v0.1";
  ok: boolean;
  reason?: string;
  bundle: Record<string, unknown>;
  bundleContentHash: string;
  signaturesVerified: boolean;
  refsVerified: boolean;
  artifacts: ResolvedEvidence[];
  agreement?: Record<string, unknown>;
  listing?: Record<string, unknown>;
  ratings: Record<string, unknown>[];
}
export interface EvidenceGraphDeps {
  read: (locator: string) => Promise<Record<string, unknown> | null>;
  resolveListing: (ref: Record<string, unknown>) => Promise<{ locator: string; raw: Record<string, unknown> } | null>;
  resolvePrimaryClaimKey?: ResolvePrimaryClaimKey;
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const arr = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(rec).filter(Boolean) as Record<string, unknown>[] : [];
const sameSigningIdentity = (left: unknown, right: unknown): boolean =>
  typeof left === "string" && typeof right === "string" &&
  canonicalSigningIdentity(left) === canonicalSigningIdentity(right);
const OUTCOMES = new Set(["completed", "failed-perm", "failed-counterparty", "failed-substrate", "aborted-by-self", "aborted-by-other"]);
const PHASE_OUTCOMES = new Set(["ok", "fail"]);
const ERROR_CLASSES = new Set(["permanent", "transient", "counterparty", "substrate", "settlement-atomicity"]);
const MAX_GRAPH_ARTIFACTS = 64;
const withinArtifactLimit = (raw: Record<string, unknown>): boolean => Buffer.byteLength(JSON.stringify(raw), "utf8") <= MAX_DACS_ARTIFACT_BYTES;
const priceTermOk = (value: unknown): boolean => {
  const price = rec(value); const amount = String(price?.amount ?? "");
  return Boolean(price && /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(amount) && /[1-9]/.test(amount) &&
    typeof price.currency === "string" && price.currency.length > 0 && price.currency.length <= 64);
};
const SEPARATORS: Record<Exclude<ArtifactKind, "attestation">, string> = {
  agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", "verify-result": "dacs-verifyresult:v1:",
  composite: "dacs-composite:v1:", rating: "dacs-rating:v1:", listing: "dacs-listing:v1:", bundle: "dacs-bundle:v1:",
};
const PAYEE_BOUND_AGREEMENT_SEPARATOR = "dacs-payee-bound-agreement:v1:";
const FAULT_BUNDLE_SEPARATOR = "dacs-fault-bundle:v1:";

type AgreementProfile = "legacy" | "payee-bound";

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
function agreementMatchesListing(agreement: Record<string, unknown>, listing: Record<string, unknown>): boolean {
  const profile = agreementProfile(agreement);
  const terms = rec(agreement.terms);
  const pipeline = arr(listing.pipeline);
  if (!profile || !terms || !Array.isArray(listing.pipeline) || pipeline.length !== listing.pipeline.length) return false;

  const commitmentKinds = pipeline.map((phase) => phase.kind).filter((kind) =>
    kind === "commit-agreement" || kind === "commit-payee-bound-agreement");
  const expectedCommitment = profile === "legacy" ? "commit-agreement" : "commit-payee-bound-agreement";
  if (commitmentKinds.length !== 1 || commitmentKinds[0] !== expectedCommitment) return false;

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
/** bandCenter × (100 ± pct) / 100, rounded half-up to the centre's fractional digits (§8.5.2 check 2). */
function bandBound(center: unknown, pct: unknown, direction: 1n | -1n): Decimal | null {
  if (typeof pct !== "number" || !/^\d+(?:\.\d+)?$/.test(String(pct))) return null;
  const centre = decimal(center);
  const percent = decimal(pct);
  const denominator = 100n * 10n ** BigInt(percent.scale);
  const numerator = centre.units * (denominator + direction * percent.units);
  return numerator < 0n ? null : { units: (2n * numerator + denominator) / (2n * denominator), scale: centre.scale };
}
const AGREEMENT_PATTERNS: Record<string, string> = {
  "negotiate-fixed-price": "fixed-price",
  "negotiate-rfq": "rfq",
  "negotiate-sealed-envelope": "sealed-envelope",
  "negotiate-sealed-envelope-procurement": "sealed-envelope",
};

/**
 * DACS-3 §8.5.2 listing conformance, checks 1-4 and 7-9 in order; returns the first failed check.
 * Checks 5 (deadline) and 6 (not expired) compare against the CommitmentRecord's anchored
 * committedAt, which a bundle does not reference, so they are not evaluated here.
 */
export function agreementListingConformance(
  agreement: Record<string, unknown>,
  listing: Record<string, unknown>,
  publisher: string,
): string | null {
  const terms = rec(agreement.terms);
  const pricing = rec(listing.pricing);
  const price = rec(terms?.price);
  const pipeline = arr(listing.pipeline);
  if (!terms || !pricing || !price || !priceTermOk(price)) return "terms";
  const listed = pricing.kind === "fixed" ? rec(pricing.price) : pricing.kind === "negotiable" ? rec(pricing.bandCenter)
    : pricing.kind === "metered" ? rec(pricing.unitPrice) : pricing.kind === "auction" ? rec(pricing.reservePrice) : null;
  // 1. Currency, before any amount comparison.
  if (listed && price.currency !== listed.currency) return "currency";
  // 2. Price, by the recognised pricing kind (MTR-5 rejects any other).
  const amount = decimal(price.amount);
  if (pricing.kind === "fixed" || (pricing.kind === "negotiable" && agreement.derivedFromPattern === "fixed-price")) {
    if (!listed || compareDecimals(amount, decimal(listed.amount)) !== 0) return "price";
  } else if (pricing.kind === "negotiable") {
    const lower = listed ? bandBound(listed.amount, pricing.minPct, -1n) : null;
    const upper = listed ? bandBound(listed.amount, pricing.maxPct, 1n) : null;
    if (!lower || !upper || lower.units <= 0n || compareDecimals(amount, lower) < 0 || compareDecimals(amount, upper) > 0) return "price";
  } else if (pricing.kind === "metered") {
    const metered = rec(terms.meteredQuantity);
    if (!listed || !metered || metered.unit !== pricing.unit ||
        typeof metered.quantity !== "string" || !/^(?:0|[1-9]\d*)$/.test(metered.quantity)) return "price";
    const unitPrice = decimal(listed.amount);
    const total = { units: unitPrice.units * BigInt(metered.quantity), scale: unitPrice.scale };
    const minimum = rec(pricing.minTotal) ? decimal(rec(pricing.minTotal)!.amount) : null;
    if (compareDecimals(amount, minimum && compareDecimals(minimum, total) > 0 ? minimum : total) !== 0) return "price";
  } else if (pricing.kind !== "auction") return "unrecognized-pricing-kind";
  // 3. Rail: present exactly when the pipeline pays, and one the listing accepts.
  const rail = rec(terms.rail);
  const pays = pipeline.some((phase) => typeof phase.kind === "string" && phase.kind.startsWith("pay-"));
  if (pays ? !rail : terms.rail !== undefined) return "rail";
  if (rail && !arr(listing.acceptedRails).some((accepted) => accepted.railId === rail.railId &&
      (accepted.railVersion === undefined || rail.railVersion === undefined || accepted.railVersion === rail.railVersion))) return "rail";
  // 4. Deliverable: the canonical DeliverableRef of the listed DeliverableSpec.
  const deliverable = rec(terms.deliverable);
  const offered = rec(rec(listing.offering)?.deliverable);
  if (!deliverable || !offered || deliverable.deliverableType !== offered.kind ||
      normalizedHash(deliverable.hash) !== contentHash(offered) || deliverable.schemaUrl !== offered.schemaUrl) return "deliverable";
  // 7. Pattern. An RFQ step declaring fixedPriceFallback also admits the fixed-price fallback,
  // whose price check 2 already held to the band centre.
  const negotiation = pipeline.find((phase) => typeof phase.kind === "string" && phase.kind.startsWith("negotiate-"));
  const fallback = negotiation?.kind === "negotiate-rfq" && rec(negotiation.parameters)?.fixedPriceFallback === true &&
    agreement.derivedFromPattern === "fixed-price";
  if (!negotiation || (!fallback && agreement.derivedFromPattern !== AGREEMENT_PATTERNS[String(negotiation.kind)])) return "pattern";
  // 8. Role direction: the publisher is the agreement seller, or the buyer of a procurement (SE-8).
  const publisherRole = negotiation.kind === "negotiate-sealed-envelope-procurement" ? "buyer" : "seller";
  if (!arr(agreement.parties).some((party) => party.role === publisherRole && sameSigningIdentity(party.primaryClaim, publisher))) {
    return "role-direction";
  }
  // 9. Artifact type and payout bindings match the commitment phase.
  return agreementMatchesListing(agreement, listing) ? null : "commitment-artifact";
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
export const artifactHash = (raw: Record<string, unknown>, kind: ArtifactKind): string => contentHash(signedScope(raw, kind));
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

function faultAttributionOk(raw: Record<string, unknown>, parties: Record<string, unknown>[]): boolean {
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
      arr(raw.parties).length >= 2 && terms && priceTermOk(terms.price) &&
      (profile === "legacy"
        ? terms.payoutBindings === undefined
        : Array.isArray(terms.payoutBindings) && terms.payoutBindings.every(payoutBindingShapeOk)));
  }
  if (kind === "evidence") return raw.evidenceVersion === "1" && typeof raw.jobId === "string" && typeof raw.phase === "string" && (raw.outcome === "success" || raw.outcome === "failure") && typeof raw.observedAt === "number" && (raw.amendmentRefs === undefined || Array.isArray(raw.amendmentRefs)) && (raw.attestationRef === undefined || isCurrentRef(raw.attestationRef));
  // DACS-2 §7.5 VerifyResult and §7.7 CompositeVerificationRecord required members.
  if (kind === "verify-result") return raw.resultVersion === "1" && typeof raw.scheme === "string" && typeof raw.identifier === "string" && Number.isSafeInteger(raw.recipeVersion) && typeof raw.method === "string" && typeof raw.reason === "string" && typeof raw.fetchedAt === "number" && typeof raw.verifiedAt === "number" && ["pass", "fail", "indeterminate", "error"].includes(String(raw.decision)) && isCurrentRef(raw.attestation);
  if (kind === "composite") {
    const supplementary = arr(raw.supplementary);
    return raw.recordVersion === "1" && typeof raw.jobId === "string" && typeof raw.evaluatedParty === "string" && /^[0-9a-f]{64}$/.test(normalizedHash(raw.bundleHash)) && /^[0-9a-f]{64}$/.test(normalizedHash(raw.requirementHash)) && typeof raw.generatedAt === "number" && ["pass", "fail", "indeterminate", "error"].includes(String(raw.overallDecision)) && Array.isArray(raw.freshness) && Array.isArray(raw.dealSpecific) && Array.isArray(raw.supplementary) && supplementary.length === raw.supplementary.length && supplementary.every((signal) => typeof signal.source === "string" && typeof signal.signalType === "string" && (typeof signal.value === "number" || typeof signal.value === "string") && typeof signal.observedAt === "number" && (signal.attestation === undefined ? signal.source !== "external" : isCurrentRef(signal.attestation)));
  }
  if (kind === "rating") return raw.ratingVersion === "1" && typeof raw.jobId === "string" && typeof raw.rater === "string" && typeof raw.target === "string" && (raw.targetRole === "buyer" || raw.targetRole === "seller") && Number.isInteger(raw.value) && Number(raw.value) >= 1 && Number(raw.value) <= 5 && typeof raw.ratedAt === "number" && (typeof raw.freeText !== "string" || raw.freeText.length <= 1000);
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

async function resolveRef(kind: ArtifactKind, ref: unknown, deps: EvidenceGraphDeps): Promise<ResolvedEvidence | null> {
  if (kind === "attestation") {
    if (!isCurrentRef(ref)) return null;
    const hash = normalizedHash(ref.contentHash);
    const raw = await deps.read(ref.anchor.locator);
    if (!raw || !withinArtifactLimit(raw) || contentHash(raw) !== hash) return null;
    return { kind, ref, locator: ref.anchor.locator, raw, contentHash: hash };
  }
  if (!isCurrentRef(ref)) return null;
  const hash = normalizedHash(ref.contentHash);
  const raw = await deps.read(ref.anchor.locator);
  if (!raw || !withinArtifactLimit(raw) || !shapeOk(raw, kind) || artifactHash(raw, kind) !== hash ||
      !(await signatureOk(raw, kind, deps.resolvePrimaryClaimKey ?? resolveDemosPrimaryClaimKey))) return null;
  return { kind, ref, locator: ref.anchor.locator, raw, contentHash: hash };
}

export async function buildCurrentEvidenceGraph(bundleLocator: string, deps: EvidenceGraphDeps): Promise<EvidenceGraph> {
  const raw = await deps.read(bundleLocator);
  // A failed graph carries no content hash: a rejected bundle is never hashed again.
  const fail = (reason: string): EvidenceGraph => ({ profile: "dacs-v0.1", ok: false, reason, bundle: raw ?? {}, bundleContentHash: "", signaturesVerified: false, refsVerified: false, artifacts: [], ratings: [] });
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
  if (!raw || !withinArtifactLimit(raw) || raw.signature !== undefined || !bundleProfile(raw) || typeof raw.jobId !== "string" || !OUTCOMES.has(String(raw.outcome)) || !["buyer", "seller", "orchestrator"].includes(String(raw.anchoredByRole)) || !rec(raw.listingRef) || arr(raw.parties).length < 2 || !Array.isArray(raw.phaseSummary) || phases.length !== raw.phaseSummary.length || phases.some((phase) => !Number.isSafeInteger(phase.index) || Number(phase.index) < 0 || typeof phase.kind !== "string" || !PHASE_OUTCOMES.has(String(phase.outcome)) || (phase.errorClass !== undefined && !ERROR_CLASSES.has(String(phase.errorClass)))) || new Set(phaseIndexes).size !== phaseIndexes.length || !Array.isArray(raw.vetRecords) || !Array.isArray(raw.settlementEvidence) || (raw.ratingRefs !== undefined && !Array.isArray(raw.ratingRefs)) || (raw.amendments !== undefined && (!Array.isArray(raw.amendments) || raw.amendments.length > 0)) || !Number.isSafeInteger(raw.recipeRegistryVersion) || Number(raw.recipeRegistryVersion) < 1 || !Number.isSafeInteger(raw.railRegistryVersion) || Number(raw.railRegistryVersion) < 1 || typeof raw.finalisedAt !== "number") return fail("invalid current DACS-5 bundle shape");
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

  const abort = raw.outcome === "aborted-by-self" || raw.outcome === "aborted-by-other";

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
    if (reserveTopLevelRef("agreement", raw.agreementRef) !== "new") return { ...fail("duplicate or invalid top-level reference"), signaturesVerified };
    const resolved = await resolveRef("agreement", raw.agreementRef, deps); if (!resolved) return { ...fail("agreement reference failed"), signaturesVerified };
    if (resolved.raw.jobId !== raw.jobId) return { ...fail("agreement belongs to another job"), signaturesVerified };
    artifacts.push(resolved); agreement = resolved.raw;
  } else if (!abort) return { ...fail("non-abort bundle has no agreement"), signaturesVerified };
  for (const [kind, refs] of [["evidence", raw.settlementEvidence], ["composite", raw.vetRecords], ["rating", raw.ratingRefs]] as Array<[ArtifactKind, unknown]>) {
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (artifacts.length >= MAX_GRAPH_ARTIFACTS) return { ...fail("evidence graph exceeds size limit"), signaturesVerified };
      const reserved = reserveTopLevelRef(kind, ref);
      if (reserved === "invalid") return { ...fail("duplicate or invalid top-level reference"), signaturesVerified };
      if (reserved === "duplicate-rating") continue;
      const resolved = await resolveRef(kind, ref, deps); if (!resolved) return { ...fail(`${kind} reference failed`), signaturesVerified };
      if ((kind === "evidence" || kind === "rating" || kind === "composite") && resolved.raw.jobId !== raw.jobId) return { ...fail(`${kind} belongs to another job`), signaturesVerified };
      if (kind === "rating") {
        const target = parties.find((party) => sameSigningIdentity(party.primaryClaim, resolved.raw.target));
        if (!parties.some((party) => sameSigningIdentity(party.primaryClaim, resolved.raw.rater)) ||
            !target || target.role !== resolved.raw.targetRole) {
          return { ...fail("rating party binding failed"), signaturesVerified };
        }
      }
      if (kind === "evidence" && !parties.some((party) =>
        sameSigningIdentity(party.primaryClaim, rec(resolved.raw.signature)?.signer))) {
        return { ...fail("evidence signer is not a session party"), signaturesVerified };
      }
      if (kind === "composite") {
        // bundleHash and evaluatedParty bind the vet to one session party's IdentityBundle (DACS-2 §7.7).
        const evaluated = parties.find((party) => sameSigningIdentity(party.primaryClaim, resolved.raw.evaluatedParty));
        if (!evaluated || normalizedHash(evaluated.bundleHash) !== normalizedHash(resolved.raw.bundleHash)) {
          return { ...fail("composite record is not bound to a session party's bundle"), signaturesVerified };
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
  const addNested = async (kind: ArtifactKind, value: unknown): Promise<boolean> => {
    if (!isCurrentRef(value)) return false;
    // A VerifyResultRef's recipeVersion is load-bearing (CORE §B.3) and must equal the resolved result's.
    const recipeOk = (artifact: ResolvedEvidence) => kind !== "verify-result" ||
      (Number.isSafeInteger(value.recipeVersion) && artifact.raw.recipeVersion === value.recipeVersion);
    const key = `${kind}\n${value.anchor.locator}`;
    const hash = normalizedHash(value.contentHash);
    const known = seen.get(key);
    if (known) return known.contentHash === hash && recipeOk(known);
    if (artifacts.length >= MAX_GRAPH_ARTIFACTS) { graphLimitExceeded = true; return false; }
    const nested = await resolveRef(kind, value, deps); if (!nested || !recipeOk(nested)) return false;
    if ((kind === "evidence" || kind === "composite") && nested.raw.jobId !== raw.jobId) return false;
    if (kind === "evidence" && !parties.some((party) =>
      sameSigningIdentity(party.primaryClaim, rec(nested.raw.signature)?.signer))) return false;
    seen.set(key, nested); artifacts.push(nested); return true;
  };
  for (let index = 0; index < artifacts.length; index++) {
    const artifact = artifacts[index];
    if (artifact.kind === "composite") {
      for (const key of ["freshness", "dealSpecific"] as const) for (const value of Array.isArray(artifact.raw[key]) ? artifact.raw[key] as unknown[] : []) {
        if (!(await addNested("verify-result", value))) return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "nested VerifyResult reference failed"), signaturesVerified };
      }
      for (const signal of arr(artifact.raw.supplementary)) if (signal.attestation !== undefined && !(await addNested("attestation", signal.attestation))) {
        return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "supplementary attestation reference failed"), signaturesVerified };
      }
    }
    if (artifact.kind === "evidence") {
      if (artifact.raw.attestationRef !== undefined && !(await addNested("attestation", artifact.raw.attestationRef))) {
        return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "delivery attestation reference failed"), signaturesVerified };
      }
      for (const value of Array.isArray(artifact.raw.amendmentRefs) ? artifact.raw.amendmentRefs as unknown[] : []) {
        if (!(await addNested("evidence", value))) return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "settlement amendment reference failed"), signaturesVerified };
      }
      for (const key of ["supersedesEvidenceRef", "amendsEvidenceRef"] as const) if (artifact.raw[key] !== undefined && !(await addNested("evidence", artifact.raw[key]))) {
        return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "settlement evidence chain failed"), signaturesVerified };
      }
    }
    if (artifact.kind === "verify-result" && !(await addNested("attestation", artifact.raw.attestation))) {
      return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "VerifyResult attestation reference failed"), signaturesVerified };
    }
  }
  const verifiedPhaseRefs = new Set(artifacts.filter((artifact) => artifact.ref &&
    (artifact.kind === "evidence" || artifact.kind === "verify-result" || artifact.kind === "composite")).map((artifact) =>
    `${artifact.ref!.anchor.locator}\n${normalizedHash(artifact.ref!.contentHash)}`));
  const composites = artifacts.filter((artifact) => artifact.kind === "composite");
  const compositeDecisions = new Map(composites.map((artifact) => [
    `${artifact.ref!.anchor.locator}\n${normalizedHash(artifact.ref!.contentHash)}`, artifact.raw.overallDecision,
  ]));
  for (const phase of arr(raw.phaseSummary)) {
    if (phase.attestationRef === undefined) continue;
    if (!isCurrentRef(phase.attestationRef) ||
        !verifiedPhaseRefs.has(`${phase.attestationRef.anchor.locator}\n${normalizedHash(phase.attestationRef.contentHash)}`)) {
      return { ...fail("phase attestation reference is outside the verified graph"), signaturesVerified };
    }
    // DACS-2 VPC-4: a vet phase whose decision is not pass fails, so it cannot have succeeded.
    const decision = compositeDecisions.get(`${phase.attestationRef.anchor.locator}\n${normalizedHash(phase.attestationRef.contentHash)}`);
    if (phase.outcome === "ok" && decision !== undefined && decision !== "pass") {
      return { ...fail("a successful vet phase rests on a composite record that did not pass"), signaturesVerified };
    }
  }
  // A session that reached its agreement passed vet for every party it vetted (VPC-2, VPC-4);
  // a failed attempt may sit beside the passing one.
  const passed = new Set(composites.filter((artifact) => artifact.raw.overallDecision === "pass")
    .map((artifact) => canonicalSigningIdentity(String(artifact.raw.evaluatedParty))));
  if (agreement && composites.some((artifact) => !passed.has(canonicalSigningIdentity(String(artifact.raw.evaluatedParty))))) {
    return { ...fail("a committed session has a vetted party with no passing composite record"), signaturesVerified };
  }
  if (artifacts.length >= MAX_GRAPH_ARTIFACTS) return { ...fail("evidence graph exceeds size limit"), signaturesVerified };
  const listingRef = rec(raw.listingRef)!;
  const listed = await deps.resolveListing(listingRef);
  const listingHash = normalizedHash(listingRef.contentHash);
  const verifiedListing = listed && artifactHash(listed.raw, "listing") === listingHash
    ? await verifyListing(listed.raw, resolveKey) : null;
  if (!listed || !verifiedListing) return { ...fail("listing reference failed"), signaturesVerified };
  // DACS-2 §7.7: requirementHash binds a vet to the listing's BundleRequirement, which gates the
  // publisher's counterparty. The publisher itself is vetted against requirements the listing omits.
  const requirement = rec(listed.raw.buyerRequirement);
  if (requirement && composites.some((artifact) =>
    !sameSigningIdentity(artifact.raw.evaluatedParty, verifiedListing.sellerClaim) &&
    normalizedHash(artifact.raw.requirementHash) !== contentHash(requirement))) {
    return { ...fail("composite record is not bound to the listing's requirement"), signaturesVerified };
  }
  if (agreement && JSON.stringify(agreement.listingRef) !== JSON.stringify(raw.listingRef)) return { ...fail("agreement listing binding failed"), signaturesVerified };
  if (agreement) {
    const agreementParties = arr(agreement.parties);
    if (!["buyer", "seller"].every((role) => agreementParties.some((candidate) =>
      candidate.role === role && parties.some((party) =>
        party.role === role && sameSigningIdentity(party.primaryClaim, candidate.primaryClaim))))) {
      return { ...fail("agreement party binding failed"), signaturesVerified };
    }
    const nonconforming = agreementListingConformance(agreement, listed.raw, verifiedListing.sellerClaim);
    if (nonconforming) return { ...fail(`agreement fails listing conformance check: ${nonconforming}`), signaturesVerified };
  }
  artifacts.push({ kind: "listing", locator: listed.locator, raw: listed.raw, contentHash: listingHash });
  return { profile: "dacs-v0.1", ok: true, bundle: raw, bundleContentHash: artifactHash(raw, "bundle"), signaturesVerified, refsVerified: true, artifacts, agreement, listing: listed.raw, ratings: artifacts.filter((artifact) => artifact.kind === "rating").map((artifact) => artifact.raw) };
}

export function agreementPrice(agreement: Record<string, unknown> | undefined): { amount: string; currency: string } | null {
  const price = rec(rec(agreement?.terms)?.price);
  return priceTermOk(price) ? { amount: price!.amount as string, currency: price!.currency as string } : null;
}
