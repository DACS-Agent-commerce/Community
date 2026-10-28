import { canonicalSigningIdentity } from "./primaryClaimKey.js";
import type { ListingEvidence } from "./commitmentFinality.js";

type Obj = Record<string, unknown>;
const MILLISECONDS_PER_SECOND = 1_000;
const record = (v: unknown): Obj | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const nonnegativeInteger = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Immutable credit inputs projected only after authenticating the agreement and exact Listing. */
export interface CommitmentContext {
  readonly jobId: string;
  readonly listingRef: Readonly<Obj> & { readonly listingId: string; readonly version: number; readonly contentHash: string };
  readonly agreementHash: string;
  readonly pattern: "fixed-price" | "rfq" | "sealed-envelope";
  readonly parties: readonly [string, string];
  readonly deadline: number;
  readonly validity: Readonly<{ notBefore: number; notAfter?: number }>;
  readonly durationMs?: number;
}

/** Check ID/version as well as the hash already authenticated by the Listing reader. */
export function exactListingTuple(pin: Obj, listing: Obj): boolean {
  return pin.listingId === (listing.listingId ?? listing.serviceId) &&
    pin.version === (listing.listingVersion ?? listing.version ?? 1) && typeof pin.contentHash === "string";
}

/** Normalize authenticated current roles or legacy scalar parties; return null for invalid joins/timing. */
export function makeCommitmentContext(bundle: Obj, agreement: Obj, listing: ListingEvidence,
  agreementHash: string, legacy = false): CommitmentContext | null {
  const pin = record(bundle.listingRef);
  const validity = record(listing.raw.validity);
  const terms = record(agreement.terms);
  const deadline = legacy && typeof agreement.expiresAt === "string" ? Date.parse(agreement.expiresAt) : terms?.deadline;
  const duration = record(listing.raw.terms)?.deadlineSecAfterCommit;
  const pattern = legacy ? agreement.pattern : agreement.derivedFromPattern;
  const roles = legacy ? [{ role: "buyer", primaryClaim: agreement.buyer }, { role: "seller", primaryClaim: agreement.seller }]
    : Array.isArray(agreement.parties) ? agreement.parties.map(record) : [];
  const claims = ["buyer", "seller"].map(role => roles.filter(p => p?.role === role));
  const identities = claims.map(ps => ps.length === 1 && typeof ps[0]?.primaryClaim === "string"
    ? canonicalSigningIdentity(ps[0].primaryClaim) : null);
  if (typeof bundle.jobId !== "string" || agreement.jobId !== bundle.jobId || !pin || !exactListingTuple(pin, listing.raw) ||
      typeof pin.listingId !== "string" || !nonnegativeInteger(pin.version) || pin.version === 0 ||
      typeof pin.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(agreementHash) ||
      (pattern !== "fixed-price" && pattern !== "rfq" && pattern !== "sealed-envelope") ||
      !identities[0] || !identities[1] || identities[0] === identities[1] || !nonnegativeInteger(deadline) ||
      !validity || !nonnegativeInteger(validity.notBefore) ||
      (validity.notAfter !== undefined && (!nonnegativeInteger(validity.notAfter) || validity.notAfter < validity.notBefore)) ||
      (duration !== undefined && (!nonnegativeInteger(duration) || duration === 0 || !Number.isSafeInteger(duration * MILLISECONDS_PER_SECOND)))) return null;
  return Object.freeze({ jobId: bundle.jobId,
    listingRef: Object.freeze({ ...structuredClone(pin), listingId: pin.listingId, version: pin.version, contentHash: pin.contentHash }),
    agreementHash, pattern, parties: Object.freeze([identities[0], identities[1]] as const), deadline,
    validity: Object.freeze({ notBefore: validity.notBefore, ...(typeof validity.notAfter === "number" ? { notAfter: validity.notAfter } : {}) }),
    ...(typeof duration === "number" ? { durationMs: duration * MILLISECONDS_PER_SECOND } : {}) });
}

/** Classify signed current terminal facts against the Listing's unique commitment boundary. */
export function currentLifecycle(bundle: Obj, listing: Obj): "pre-commit" | "committed" | "refused" {
  const pipeline = Array.isArray(listing.pipeline) ? listing.pipeline.map(record) : [];
  const boundaries = pipeline.flatMap((p, i) => p?.kind === "commit-agreement" || p?.kind === "commit-payee-bound-agreement" ? [i] : []);
  const phases = Array.isArray(bundle.phaseSummary) ? bundle.phaseSummary.map(record) : [];
  if (boundaries.length !== 1 || pipeline.some(p => !p) || phases.some(p => !p || !nonnegativeInteger(p.index) ||
      p.kind !== pipeline[p.index]?.kind || (p.outcome !== "ok" && p.outcome !== "fail"))) return "refused";
  const boundary = boundaries[0];
  const failed = phases.filter(p => p?.outcome === "fail");
  if (failed.length > 1 || (failed[0] && phases.some(p => Number(p?.index) > Number(failed[0]?.index)))) return "refused";
  const abort = bundle.outcome === "aborted-by-self" || bundle.outcome === "aborted-by-other";
  const reached = phases.some(p => p?.index === boundary && p.outcome === "ok");
  if (!reached && phases.some(p => Number(p?.index) > boundary)) return "refused";
  const empty = [bundle.settlementEvidence, bundle.amendments ?? [], bundle.ratingRefs ?? []]
    .every(value => Array.isArray(value) && value.length === 0);
  return abort && !reached ? empty ? "pre-commit" : "refused" : "committed";
}
