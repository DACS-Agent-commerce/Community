/**
 * Catalog data model — the §6.3.6 shapes plus the registration input.
 * Everything the catalog *asserts* is either read from chain and re-verifiable,
 * or explicitly labelled a hint (§6.3.6: consumers MUST NOT treat hints as
 * authoritative without deriving from the underlying bundles themselves).
 */
import type { RateRange } from "./rateRange.js";
import type { UndecidedKind } from "./verificationUnavailable.js";

/** What an agent (or its operator) submits to appear in the catalog. */
export interface Registration {
  /** The agent's primary claim (self-describing DID / Demos pubkey hex). */
  primaryClaim: string;
  displayName: string;
  /** Storage addresses of the agent's anchored listings. */
  listingAnchors: string[];
  /** Trusted only when populated by the hash-verified well-known crawler. */
  listingContentHashes?: Record<string, string>;
  /**
   * Deals offered as reputation evidence: bundle refs + the anchor owners
   * (needed to resolve owner-scoped referenced-artifact addresses on the real
   * substrate). Self-reported; the catalog verifies each cryptographically
   * before counting it, and the UI re-verifies in the visitor's browser.
   */
  deals?: RegisteredDeal[];
  /**
   * Signed DACS-5 logical-to-native bundle mappings carried by this catalog
   * registration. The carrier is not trusted: every record is independently
   * verified under BB-4 before it can be persisted, served, or used.
   */
  bundleBindings?: BundleBinding[];
  /**
   * Optional owner signature: ed25519 over the canonical registration message
   * (see register route) by the primaryClaim's key, produced by the Demos
   * wallet extension. Verified server-side; grants the "owner-registered"
   * badge. Unsigned submissions remain allowed (third-party, still
   * chain-verified).
   */
  ownerSignature?: { message: string; signature: string; signedAt: number };
}

/** DACS-5 §10.4.2 signed logical-to-native mapping for one anchored copy. */
export interface BundleBinding {
  bindingVersion: "1";
  jobId: string;
  role: "buyer" | "seller" | "orchestrator";
  logicalAddress: string;
  nativeAddress: string;
  bundleContentHash: string;
  anchorTx?: string;
  signer: string;
  signature: {
    algorithm: "ed25519";
    signer: string;
    value: string;
  };
  /** Preserve signed additive fields even when this reader does not interpret them. */
  [key: string]: unknown;
}

export interface RegisteredDeal {
  jobId: string;
  rail: string;
  buyerBundleRef: string;
  sellerBundleRef?: string;
  owners: { buyer: string; seller: string };
}

export type ArtifactProfile = "dacs-v0.1" | "legacy-sdk-v0.1" | "fixture-listing";

/** DACS-1 RB-2/RB-3 logical-to-native discovery record for a revocation marker. */
export interface RevocationBinding {
  sellerPrimaryClaim: string;
  listingId: string;
  listingVersion: number;
  listingContentHash: string;
  logicalAddress: string;
  markerAnchor: { kind: string; locator: string };
  markerContentHash: string;
}

export type RevocationCheck = "absent" | "revoked" | "indeterminate";

/** §6.3.6 ListingSummary (subset the MVP populates; shape per spec). */
export interface ListingSummary {
  listingId: string;
  version: number;
  contentHash: string;
  anchor: { kind: string; locator: string };
  seller: { primaryClaim: string; displayName: string };
  /** Which signed artifact contract was verified at the anchor. */
  artifactProfile?: ArtifactProfile;
  /** Optional seller endpoint from a current-spec listing. */
  publicEndpoint?: string;
  offering: {
    title: string;
    description?: string;
    category: string;
    tags: string[];
    /** §9.5 payment rails the listing accepts (from supportedPaymentRails). */
    rails?: string[];
    /** §9.6 delivery methods the listing offers (from supportedDelivery). */
    delivery?: string[];
    /** Negotiation modes the seller supports (from supportedNegotiation). */
    negotiation?: string[];
    /** Current-spec structured deliverable. Absent on legacy SDK listings. */
    deliverable?: Record<string, unknown>;
  };
  pricing: {
    kind?: "fixed" | "negotiable" | "auction" | "metered";
    priceHint?: string;
    currency?: string;
    unit?: string;
    minTotalHint?: string;
    minPct?: number;
    maxPct?: number;
    selectionRule?: string;
  };
  buyerRequirement?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  status: "active" | "revoked";
  /** Required for revoked records; forbidden on active records (DACS-1 RB-3). */
  revocation?: RevocationBinding;
  catalogObservedAt: number;
  /** Optional catalog observation; never a listing validity or trust signal. */
  reachabilityHint?: ReachabilityHint;
  reputationHint?: ReputationHint;
  /** Directory extension: machine-readable pointer to a verifier profile envelope. */
  inspection?: DirectoryInspectionAffordance;
}

export interface ReachabilityHint {
  status: "reachable" | "unreachable" | "unknown";
  checkedAt: number;
  surface?: string;
}

export type DirectoryServiceMaturity =
  | "listed"
  | "sample-backed"
  | "callable"
  | "strict-bundle-history"
  | "live-paid";

export interface DirectoryInspectionAffordance {
  artifactType: "directory-service-profile";
  maturity: DirectoryServiceMaturity;
  href: string;
}

/** §6.3.6 ReputationHint — advisory; derived, never authoritative. */
export interface ReputationHint {
  categoryScope: string;
  /** Null as well when undecided sessions could change it; completionRateRange then says what it can be. */
  completionRate: number | null;
  averageSellerRating?: number | null;
  bundleCount: number;
  windowStart: number;
  windowEnd: number;
  computedAt: number;
  /** Directory extension: sessions in this scope this pass could not decide (DealRecord.undecided). They are in
   * neither bundleCount nor the rate. Absent when there are none. */
  undecidedSessions?: number;
  /** Directory extension, present with undecidedSessions: the values completionRate can take once they are decided. */
  completionRateRange?: RateRange;
  /** Directory extension, present with undecidedSessions: the same for averageSellerRating, which is null when
   * their ratings could change it. */
  averageSellerRatingRange?: RateRange;
}

export interface VerifiedRating {
  rater: string;
  target: string;
  targetRole: "buyer" | "seller";
  value: number;
  ratedAt: number;
  contentHash: string;
}

/**
 * §6.3.2.1 identity tier — derived, never self-reported (IT-1..IT-3).
 * Only fresh resolved DACS-2 `verifiedBy` results may elevate this value.
 * GCR/CCI links are presented separately and never elevate the tier alone.
 */
export type IdentityTier = "institutional" | "verified" | "self-declared";

/** A CCI badge — a Web2/wallet claim read from the on-chain GCR. */
export interface CciBadge {
  kind: "web2" | "wallet";
  platform: string;
  handle: string;
  ref: string;
  /** The on-chain ownership proof (e.g. the GitHub gist) — the receipts. */
  proofUrl?: string;
  /** Where the claim lives (profile page / block explorer). */
  linkUrl?: string;
}

/** Verification snapshot for one registered deal. */
export interface DealRecord extends RegisteredDeal {
  /** Bundle signature layer: did every signature verify against its party's key? */
  signatureVerified: boolean;
  /** Referenced-artifact integrity (agreement/evidence/vet hash-checks). */
  refsVerified: boolean;
  outcome?: string;
  finalisedAt?: number;
  verifiedAt: number;
  /** The offering.category of the session's own listing, shown with the deal; no figure is scoped by it. */
  category?: string;
  /** DACS-5 §10.5.4 fetch_category: the offering.category of the listing the session's agreement pins. Set only when
   * the authoritative copy carries an agreementRef and this pass resolved that agreement and its listing, so a
   * pre-commit session, or one whose agreement or listing went unread, is in no ReputationHint (categoryReputationHint). */
  agreementCategory?: string;
  /** Outcome interpreted from this catalog seller's perspective. */
  sellerOutcome?: string;
  anchoredByRole?: "buyer" | "seller" | "orchestrator";
  bundleContentHash?: string;
  /** Every declared buyer/seller/orchestrator signed the authoritative copy (§10.4.1); BB-6 precedence. */
  fullSignatureStanding?: boolean;
  /** Verified evidence, keyable settlements and a current DACS-5 outcome, before catalog admission. */
  reputationEligible?: boolean;
  /** This pass could not decide the session (DACS-5 §10.5.1 at run time): its seller copy, which the seller signed,
   * and its buyer copy each verified or stopped at a check that gave no verdict, at least one stopped, nothing
   * refuted either and they do not diverge. It counts neither as completed nor as failed; the rates it could change
   * are published as ranges. `kind` says whether a later pass may decide it (no-answer) or not (lasting),
   * sellerOutcomes are the seller-relative outcomes its copies claim, and ratingsAtMost is the most ratings of the
   * seller it could add once decided (0 when neither copy cites a rating). */
  undecided?: { kind: UndecidedKind; reason: string; sellerOutcomes: string[]; ratingsAtMost: number };
  /** Recomputed catalog-wide SB-2 rejection; never overwrites evidence eligibility. */
  settlementRejected?: boolean;
  /** Established ST-10 policy cancellation; neutral in fault denominators. */
  cancellationNeutral?: boolean;
  /** Authoritative FAB faults the orchestrator; retained in bundleCount, neutral in party rates. */
  orchestratorFaultNeutral?: boolean;
  /** Consensus-observed SR-2 write time, preferred to producer wall-clock. */
  anchorTimestamp?: number;
  /** Verified agreement price; only completed sessions contribute to volume. */
  agreementPrice?: { amount: string; currency: string };
  /** Signature/hash/session-bound DACS-5 ratings. */
  ratings?: VerifiedRating[];
  /** Settlement ids used for the SB-2 cross-job uniqueness gate, with the content hash of the evidence citing each.
   * nodeVerified marks a transfer this deployment confirmed on the node; only such a claim enters the
   * catalog-wide ledger, and a deal citing any other (as an earlier release persisted) is not admitted. */
  settlementTxIds?: Array<{ id: string; observedAt: number; phaseIndex: number; evidenceHash?: string; nodeVerified?: boolean }>;
}

export interface SellerRecord {
  primaryClaim: string;
  /** True when the agent was found by the chain scanner, not registered. */
  discovered?: boolean;
  /** True when the registration was signed by the primaryClaim's own key. */
  ownerRegistered?: boolean;
  /** Domain(s) whose §6.3.5 well-known surface declared this agent. */
  wellKnownDomains?: string[];
  displayName: string;
  /** §6.3.2.1 derived tier (see IdentityTier note above). */
  identityTier?: IdentityTier;
  /** True when GCR exposes identity links; this is not DACS-2 verification. */
  identityLinksPresent?: boolean;
  /** Last verified current-spec IdentityBundle embedded by this seller. */
  identityBundle?: Record<string, unknown>;
  cci: CciBadge[];
  listings: ListingSummary[];
  deals: DealRecord[];
  reputation: {
    completed: number;
    bundleCount?: number;
    totalAgreements: number;
    completionRate: number | null;
    counterpartyAdjustedCompletionRate?: number | null;
    counterpartyFaultRate?: number | null;
    averageBuyerRating?: number | null;
    averageSellerRating?: number | null;
    observedTransactionalVolume?: Array<{ amount: string; currency: string }>;
    transactionCountByCurrency?: Array<{ currency: string; count: number }>;
    bundleRefs?: Array<{ kind: "dacs-5-bundle"; id: string; contentHash: string; anchor: { kind: "storage-program"; locator: string } }>;
    windowStart?: number;
    windowEnd?: number;
    windowingBasis?: "finalisedAt" | "sr2-anchor-timestamp";
    /** Directory extension: sessions this pass could not decide (DealRecord.undecided), in no other figure.
     * When present, each of the three rates and averageSellerRating is null if they could change it, and its
     * range says what it can be. Volume counts decided completions only. */
    undecidedSessions?: number;
    completionRateRange?: RateRange;
    counterpartyAdjustedCompletionRateRange?: RateRange;
    counterpartyFaultRateRange?: RateRange;
    averageSellerRatingRange?: RateRange;
  };
  registeredAt: number;
  lastIndexedAt: number;
}

export interface Catalog {
  catalogVersion: "1";
  generatedAt: number;
  sellers: SellerRecord[];
}

/** Persisted scanner memory: cursor + accumulated discoveries. */
export interface ScanState {
  /** Historic values remain readable so migrations can trigger a full replay. */
  schemaVersion?: number;
  lastSeenTxId: number;
  lastChainTip?: number;
  /** Wall-clock time when lastSeenTxId most recently increased. */
  cursorAdvancedAt?: number;
  /** Descending transaction cursor for the bounded SR-2 consensus-time backfill. */
  anchorBackfillCursor?: number;
  /** Hash of the unresolved bundle locator/content-hash set for this backfill cycle. */
  anchorBackfillTargetKey?: string;
  /** True when the current unresolved target set has been searched to genesis. */
  anchorBackfillComplete?: boolean;
  /** Round-robin cursor for bounded engagement-surface probes. */
  reachabilityCursor?: number;
  /** owner + programName → observed native address (nonce-safe binding). */
  programs?: Record<string, string | null>;
  /** Legacy: listing content hash → revocation candidates. Moved into SQLite on load or save. */
  revocations?: Record<string, string[] | string>;
  /** RB-4-verified marker locators that candidate pruning must preserve. */
  verifiedRevocations?: Record<string, string[]>;
  /** jobId → BB-4-verified BundleBindings known to the catalog. */
  bundleBindings?: Record<string, BundleBinding[]>;
  /** jobId + role keys whose total discovery cap was exhausted (BB-7 indeterminate). */
  bundleBindingOverflow?: string[];
  /** listing anchor address → owner address */
  listings: Record<string, string>;
  /** Domain → authenticated publisher listing hints, independent of active catalog rows. */
  publisherListingDiscoveries?: Record<string, { publisherClaim: string; listingAnchors: string[] }>;
  /** buyer owner + jobId (discoveredDealKey) → discovered deal */
  deals: Record<string, RegisteredDeal>;
}
