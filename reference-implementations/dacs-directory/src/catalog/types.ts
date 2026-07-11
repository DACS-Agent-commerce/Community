/**
 * Catalog data model — the §6.3.6 shapes plus the registration input.
 * Everything the catalog *asserts* is either read from chain and re-verifiable,
 * or explicitly labelled a hint (§6.3.6: consumers MUST NOT treat hints as
 * authoritative without deriving from the underlying bundles themselves).
 */

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
   * Optional owner signature: ed25519 over the canonical registration message
   * (see register route) by the primaryClaim's key, produced by the Demos
   * wallet extension. Verified server-side; grants the "owner-registered"
   * badge. Unsigned submissions remain allowed (third-party, still
   * chain-verified).
   */
  ownerSignature?: { message: string; signature: string; signedAt: number };
}

export interface RegisteredDeal {
  jobId: string;
  rail: string;
  buyerBundleRef: string;
  sellerBundleRef?: string;
  owners: { buyer: string; seller: string };
}

/** §6.3.6 ListingSummary (subset the MVP populates; shape per spec). */
export interface ListingSummary {
  listingId: string;
  version: number;
  contentHash: string;
  anchor: { kind: string; locator: string };
  seller: { primaryClaim: string; displayName: string };
  /** Which signed artifact contract was verified at the anchor. */
  artifactProfile?: "dacs-v0.1" | "legacy-sdk-v0.1";
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
    kind?: "fixed" | "negotiable" | "auction";
    priceHint?: string;
    currency?: string;
    unit?: string;
    minPct?: number;
    maxPct?: number;
    selectionRule?: string;
  };
  buyerRequirement?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  status: "active" | "revoked";
  catalogObservedAt: number;
  reputationHint?: ReputationHint;
}

/** §6.3.6 ReputationHint — advisory; derived, never authoritative. */
export interface ReputationHint {
  categoryScope: string;
  completionRate: number | null;
  averageSellerRating?: number | null;
  bundleCount: number;
  windowStart: number;
  windowEnd: number;
  computedAt: number;
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
  category?: string;
  /** Outcome interpreted from this catalog seller's perspective. */
  sellerOutcome?: string;
  anchoredByRole?: "buyer" | "seller" | "orchestrator";
  bundleContentHash?: string;
  /** True only when the outcome belongs to the current DACS-5 closed set. */
  reputationEligible?: boolean;
  /** Established ST-10 policy cancellation; neutral in fault denominators. */
  cancellationNeutral?: boolean;
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
    totalAgreements: number;
    completionRate: number | null;
    counterpartyAdjustedCompletionRate?: number | null;
    counterpartyFaultRate?: number | null;
    averageBuyerRating?: number | null;
    averageSellerRating?: number | null;
    bundleRefs?: Array<{ kind: "dacs-5-bundle"; id: string; contentHash: string; anchor: { kind: "storage-program"; locator: string } }>;
    windowStart?: number;
    windowEnd?: number;
    windowingBasis?: "finalisedAt" | "sr2-anchor-timestamp";
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
  schemaVersion?: 3;
  lastSeenTxId: number;
  /** owner + programName → observed native address (nonce-safe binding). */
  programs?: Record<string, string>;
  /** listing content hash → every observed revocation marker candidate. */
  revocations?: Record<string, string[] | string>;
  /** listing anchor address → owner address */
  listings: Record<string, string>;
  /** jobId → discovered deal */
  deals: Record<string, RegisteredDeal>;
}
