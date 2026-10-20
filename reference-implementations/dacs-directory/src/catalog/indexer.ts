/**
 * The indexer — turns a Registration into a verified SellerRecord.
 *
 * Nothing is taken on trust:
 *  - listings are read from chain, signature-verified, owner-bound and checked
 *    against any well-known content-hash declaration;
 *  - CCI badges are resolved from the on-chain GCR (dacs-sdk #13), never from
 *    the registration payload;
 *  - every registered deal's AttestationBundle is dereferenced from chain and
 *    verified with required-party coverage plus referenced-artifact signatures
 *    and hash integrity.
 *
 * The catalog then serves these as §6.3.6 summaries with `reputationHint`s —
 * advisory by spec; browser verification repeats cryptographic checks but does
 * not independently prove chain inclusion while RPC bytes traverse the server.
 */
import { ownArray } from "./scanState.js";
// Pure vendored subpaths only; no substrate client dependency.
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { contentHash } from "./canonical.js";
import { parseCciRecord } from "@kynesyslabs/dacs/identity";
// verifyBundleCore is exported from the SDK's agent barrel, but that barrel
// also re-exports createAgent/Agent.js, which pulls in the substrate/bridge
// dependency chain (rubic-sdk → cetus-sui-clmm-sdk → a broken @mysten/bcs
// import) and breaks the production webpack build. Reach into the leaf
// module directly to keep this file free of the substrate client.
import { verifyBundleCore } from "../../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
// The SDK at SDK_REV (2026-07-04) doesn't export sessionAnchorName from its public
// barrel; upstream fixed that after the pin (dacs-sdk#178, follow-up to #14), so
// reach into the vendored build until the pin moves.
import { sessionAnchorName } from "../../vendor/dacs-sdk/dist/agent/runSessionCore.js";
import { readAnchor, readAnchorRecord, readAnchorResult, readSettlementNode } from "./chain.js";
import { gcrGetIdentities } from "./gcr.js";
import {
  findValidListingRevocation,
  ownerClaim,
  REVOCATION_VERIFICATIONS_PER_PASS,
  verifyStoredListing,
  type RevocationCandidateProgress,
} from "./listingVerification.js";
import { canonicalDemosAgentClaim } from "./claimRef.js";
import { resolveDemosPrimaryClaimKey } from "./primaryClaimKey.js";
import { listingPresentation } from "./listingMetadata.js";
import { verifyOwnerSignature } from "./registrationSig.js";
import {
  artifactAnchorTime,
  clearListingRejection,
  observedRevocationCandidate,
  retainedListingRevocation,
  retainListingRevocation,
  hasIncompleteWellKnownWithdrawal,
  boundWellKnownRevocations,
  wellKnownWithdrawalRevision,
  admitWellKnownRevocationCandidates,
  nextRevocationCandidates,
  resolveProgramAddress,
  loadScanState,
  recordListingRejection,
  recordRevocationProgress,
  type ListingRejectionCode,
  throwIfInfrastructureError,
} from "./store.js";
import { categoryReputationHint, deriveSellerReputation, flipOutcome, isNeutralCancellation } from "./reputation.js";
import { agreementPrice, buildCurrentEvidenceGraph, paymentTxRefsOk, type EvidenceGraph, type ResolvedEvidence } from "./evidenceGraph.js";
import { legacySettlementTxId, settlementTxId } from "./settlementKey.js";
import { fullSignatureStanding } from "./bundleSignerPolicy.js";
import { agreementRail } from "./agreementMetadata.js";
import { currentBundleCopiesDiverge, reconcileCurrentCopies } from "./currentReconciliation.js";
import {
  boundedBundleBindings,
  bundleBindingOverflowKey,
  resolveBundleSide,
  verifyBundleBinding,
} from "./bundleBinding.js";
import { safePublicEndpoint } from "./publicEndpoint.js";
import { publisherListingAnchors, type ResolvePublisherListingAnchors } from "./publisherListings.js";
import { deriveIdentityTier, sellerIdentityTier, type ResolveRecipe } from "./identityVerification.js";
import {
  bundleMatchesRegisteredDeal,
  bundleCategory,
  dedupeVerifiedDeals,
  hasRequiredBundleSignatures,
  legacyFullSignatureStanding,
  legacyListingSettlementIndeterminate,
  refsPassStrictPolicy,
  verifiedListingTerms,
  type ResolvedArtifact,
} from "./bundlePolicy.js";

import type {
  CciBadge,
  DealRecord,
  BundleBinding,
  ListingSummary,
  Registration,
  RegisteredDeal,
  RevocationCheck,
  SellerRecord,
} from "./types.js";

const verify = (b: Uint8Array, s: Uint8Array, p: Uint8Array): boolean =>
  ed25519Verify(b, s, publicKeyFromRaw(p));

type SettlementTxIds = NonNullable<DealRecord["settlementTxIds"]>;

/**
 * DACS-4 SB-1 claims of a current bundle's successful payment evidence, keyed on
 * (settlement-tx-id, jobId, phaseIndex). The phase index is recovered from the verified
 * payment-evidence anchor. Null means a claim could not be keyed (`error`).
 */
function currentSettlementClaims(settlement: ResolvedEvidence[]): SettlementTxIds | null {
  const claims: SettlementTxIds = [];
  for (const evidence of settlement) {
    if (evidence.raw.outcome !== "success" || typeof evidence.raw.phase !== "string" || !evidence.raw.phase.startsWith("pay-")) continue;
    if (!paymentTxRefsOk(evidence.raw)) return null;
    const refs = Array.isArray(evidence.raw.paymentTxRefs) ? evidence.raw.paymentTxRefs : [];
    if (evidence.phaseIndex === undefined || refs.length === 0) return null;
    for (const ref of refs) {
      const id = settlementTxId(ref);
      if (!id) return null;
      claims.push({ id, observedAt: Number(evidence.raw.observedAt), phaseIndex: evidence.phaseIndex, evidenceHash: evidence.contentHash });
    }
  }
  return claims;
}

/** The pinned SDK's legacy evidence carries its own phaseIndex and pre-SB-1 TxRefs. */
function legacySettlementClaims(artifacts: ResolvedArtifact[]): SettlementTxIds | null {
  const claims: SettlementTxIds = [];
  for (const artifact of artifacts) {
    const raw = artifact.raw;
    if (artifact.kind !== "dacs-4-evidence" || raw.outcome !== "success") continue;
    const refs = Array.isArray(raw.paymentTxRefs) ? raw.paymentTxRefs : [];
    if (!Number.isSafeInteger(raw.phaseIndex) || Number(raw.phaseIndex) < 0 || refs.length === 0) return null;
    for (const ref of refs) {
      const id = legacySettlementTxId(raw.phase, ref);
      if (!id) return null;
      claims.push({ id, observedAt: Number(raw.observedAt), phaseIndex: Number(raw.phaseIndex), evidenceHash: contentHash(raw) });
    }
  }
  return claims;
}

/** Resolve the raw GCR identity payload for a bare-hex Demos address. */
export type ResolveIdentities = (addressHex: string) => Promise<unknown>;

/** Missing or unavailable current bytes cannot reject an older candidate (RB-5/6). */
async function readRevocationCandidate(locator: string): Promise<Record<string, unknown> | null> {
  const read = await readAnchorResult(locator);
  return read.status === "present" ? read.record.data : read.status === "invalid" ? {} : null;
}

export function listingBindingRejection(
  sellerClaim: string,
  anchorOwner: string | undefined,
  registrationClaim: string,
): ListingRejectionCode | null {
  // §6.3.1 canonical comparison: only the `did` scheme token is case-forgiven.
  // An uppercase key component, `did:DEMOS:…` method casing, or `demos:0x…`
  // address notation never canonicalises, so it never binds.
  const expected = canonicalDemosAgentClaim(registrationClaim);
  if (expected === null || canonicalDemosAgentClaim(sellerClaim) !== expected) {
    return "SELLER_CLAIM_BINDING";
  }
  if (ownerClaim(anchorOwner) !== expected) return "OWNER_CLAIM_BINDING";
  return null;
}

export type { ResolvePublisherListingAnchors } from "./publisherListings.js";

/** Work bound per publisher and discovery tier when resolving another registration's sessions. */
export const MAX_PUBLISHER_LISTING_READS = 32;

/**
 * Index one registration into a verified SellerRecord.
 *
 * `resolveIdentities` defaults to the narrow authenticated GCR call in gcr.ts;
 * tests may inject a deterministic resolver. `listingAnchorsFor` names other
 * publishers' anchors, for sessions pinned to a listing this seller did not publish.
 */
export async function indexRegistration(
  reg: Registration,
  prior?: SellerRecord,
  resolveIdentities: ResolveIdentities = gcrGetIdentities,
  resolveRecipe?: ResolveRecipe,
  onOmitted?: (kind: "bindings" | "deals", count: number) => void,
  listingAnchorsFor: ResolvePublisherListingAnchors = publisherListingAnchors(),
): Promise<SellerRecord> {
  const now = Date.now();

  // ── CCI badges: from the on-chain GCR, never from the payload ────────────
  const hex = canonicalDemosAgentClaim(reg.primaryClaim)?.slice(-64) ?? reg.primaryClaim;
  let cci: CciBadge[] = prior?.cci ?? [];
  try {
    const resolved = await resolveIdentities(hex);
    const record = parseCciRecord(reg.primaryClaim, resolved);
    // Proof URLs live in the raw GCR payload (web2.<platform>[].proof).
    const rawWeb2 = ((resolved as { response?: { web2?: Record<string, Array<{ username?: string; proof?: string }>> } })
      ?.response?.web2) ?? {};
    const proofFor = (platform: string, handle: string): string | undefined =>
      rawWeb2[platform]?.find((e) => e?.username?.toLowerCase() === handle.toLowerCase())?.proof;
    const profileFor = (platform: string, handle: string): string | undefined =>
      platform === "github" ? `https://github.com/${handle}` :
      platform === "twitter" ? `https://x.com/${handle}` : undefined;
    const explorerFor = (chainType: string, address: string): string | undefined =>
      chainType === "evm" ? `https://etherscan.io/address/${address}` :
      chainType === "solana" ? `https://solscan.io/account/${address}` : undefined;
    cci = record.claims.map((c) => c.kind === "web2"
      ? { kind: c.kind, platform: c.platform, handle: c.handle, ref: c.ref,
          proofUrl: proofFor(c.platform, c.handle), linkUrl: profileFor(c.platform, c.handle) }
      : { kind: c.kind, platform: c.chainType, handle: c.address, ref: c.ref,
          linkUrl: explorerFor(c.chainType, c.address) });
  } catch {
    /* keep prior badges on transient failure */
  }

  // ── Listings: read from chain, validate shape ─────────────────────────────
  const listings: ListingSummary[] = [];
  const listingArtifacts = new Map<string, { locator: string; raw: Record<string, unknown> }>();
  const categoriesByListing = new Map<string, string>();
  let identityBundle: Record<string, unknown> | undefined;
  const identityBundles: Record<string, unknown>[] = [];
  const { verifiedRevocations } = loadScanState();
  for (const anchor of reg.listingAnchors) {
    const anchored = await readAnchorRecord(anchor);
    if (!anchored) continue;
    // A listing with no canonical form throws while hashing; skip it like any invalid one.
    const verified = await verifyStoredListing(anchored.data, anchor).catch(() => null);
    if (!verified) continue;
    const { scope } = verified;
    const bindingRejection = listingBindingRejection(
      verified.sellerClaim,
      anchored.owner,
      reg.primaryClaim,
    );
    if (bindingRejection) {
      recordListingRejection(anchor, reg.primaryClaim, bindingRejection);
      continue;
    }
    clearListingRejection(anchor, reg.primaryClaim);
    const declaredHash = reg.listingContentHashes?.[anchor]?.replace(/^sha256-/, "").toLowerCase();
    if (declaredHash && declaredHash !== verified.contentHash) continue;
    const listingId = typeof scope.listingId === "string" ? scope.listingId
      : typeof scope.serviceId === "string" ? scope.serviceId : "";
    if (!listingId) continue;
    const rawVersion = scope.listingVersion ?? scope.version ?? 1;
    const version = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion > 0
      ? rawVersion
      : 1;
    // DACS-1 validation step 3: notBefore ≤ now ≤ notAfter (if set).
    const validity = scope.validity as { notBefore?: unknown; notAfter?: unknown } | undefined;
    if (typeof validity?.notBefore === "number" && validity.notBefore > now) continue;
    if (typeof validity?.notAfter === "number" && validity.notAfter < now) continue;
    // Verification work is bounded per pass: markers already verified come first (even when
    // an older snapshot omitted them from the queue), then the next pending candidates,
    // those anchored by the listing's own owner first. Only one batch is ever selected.
    const limit = REVOCATION_VERIFICATIONS_PER_PASS;
    // Resolve authenticated carriage against this very same verified listing
    // read. An earlier discovery pre-read failure cannot discard a withdrawal,
    // and a foreign publisher cannot create globally hash-scoped pending work.
    const sourceRevision = wellKnownWithdrawalRevision();
    const carriedBindings = boundWellKnownRevocations(reg.primaryClaim, verified.contentHash, listingId, version);
    admitWellKnownRevocationCandidates(verified.contentHash, carriedBindings.map((binding) => binding.markerAnchor.locator));
    const progress: RevocationCandidateProgress = { unread: [], rejected: [] };
    const readMarkers = new Map<string, Record<string, unknown>>();
    const found = await findValidListingRevocation(
      [
        ...(verifiedRevocations[verified.contentHash] ?? []).slice(0, limit),
        ...nextRevocationCandidates(verified.contentHash, anchored.owner ?? null, limit),
      ],
      verified,
      version,
      async (locator) => {
        const marker = observedRevocationCandidate(locator);
        if (marker) readMarkers.set(locator, marker);
        return marker;
      },
      undefined,
      progress,
      limit,
      async (locator) => {
        // Cached invalid bytes cannot adjudicate either a repaired marker or
        // its current source binding, even if only its signature has changed.
        const marker = await readRevocationCandidate(locator);
        if (marker) readMarkers.set(locator, marker);
        return marker;
      },
    );
    recordRevocationProgress(verified.contentHash, progress, carriedBindings, sourceRevision);
    // RB-3: a revocation verified on an earlier pass is retained, whatever its marker reads now.
    if (found) {
      const marker = readMarkers.get(found.markerAnchor.locator);
      if (marker) retainListingRevocation(found, marker);
    }
    const retained = retainedListingRevocation(verified.contentHash);
    const boundRetained = retained?.sellerPrimaryClaim === verified.sellerClaim && retained.listingId === listingId &&
      retained.listingVersion === version ? retained : null;
    const revocationBinding = found ?? boundRetained ?? prior?.listings.find((listing) => listing.status === "revoked" &&
      listing.contentHash === verified.contentHash)?.revocation ?? null;
    // Raw chain hints have no withdrawal authority. Only an authenticated source
    // can leave an unresolved hold; a verified marker is retained above (RB-3).
    const revocation: RevocationCheck = revocationBinding ? "revoked"
      : hasIncompleteWellKnownWithdrawal(reg.primaryClaim, verified.contentHash) ? "indeterminate" : "absent";
    const presentation = listingPresentation(scope);
    const signedSeller = scope.seller && typeof scope.seller === "object" && !Array.isArray(scope.seller)
      ? scope.seller as Record<string, unknown> : null;
    if (verified.profile === "dacs-v0.1" && signedSeller?.identity && typeof signedSeller.identity === "object") {
      identityBundle = signedSeller.identity as Record<string, unknown>;
      identityBundles.push(identityBundle);
    }
    // Past sessions still verify against the listing whatever its revocation state.
    listingArtifacts.set(`${listingId}\n${version}\n${verified.contentHash}`, { locator: anchor, raw: anchored.data });
    categoriesByListing.set(listingId, presentation.category);
    // The catalog can publish neither "active" for an indeterminate check (a reader would take it
    // as absent, RB-6) nor "revoked" without a binding (RB-3), so the listing waits for a later pass.
    if (revocation === "indeterminate") continue;
    listings.push({
      listingId,
      version,
      contentHash: verified.contentHash,
      anchor: { kind: "storage-program", locator: anchor },
      seller: { primaryClaim: reg.primaryClaim, displayName: reg.displayName },
      artifactProfile: verified.profile,
      publicEndpoint: safePublicEndpoint(signedSeller?.publicEndpoint),
      offering: {
        title: presentation.title,
        // Strip the [github:<login>] claim-tag (the interim identity carrier
        // until IdentityBundle lands — dacs-sdk#9); the badge shows the claim.
        description: presentation.description.replace(/\s*\[github:[^\]]+\]\s*/g, " ").trim(),
        category: presentation.category,
        tags: presentation.tags,
        rails: presentation.rails,
        delivery: presentation.delivery,
        negotiation: presentation.negotiation,
        deliverable: presentation.deliverable,
      },
      pricing: presentation.pricing,
      buyerRequirement: scope.buyerRequirement && typeof scope.buyerRequirement === "object"
        ? scope.buyerRequirement as Record<string, unknown> : undefined,
      terms: scope.terms && typeof scope.terms === "object"
        ? scope.terms as Record<string, unknown> : undefined,
      status: revocation === "revoked" ? "revoked" : "active",
      ...(revocationBinding ? { revocation: revocationBinding } : {}),
      catalogObservedAt: now,
    });
  }

  // ── Deals: dereference + verify each bundle from chain ────────────────────
  const dealCandidates: DealRecord[] = [];
  const scanState = loadScanState();
  const overflowBindings = new Set(scanState.bundleBindingOverflow ?? []);
  const relevantJobs = new Set((reg.deals ?? []).map((deal) => deal.jobId));
  // Only bindings signed by a deal's own buyer or seller are verified, so other signers'
  // bindings for the same jobId add no work here (BB-6).
  const holders = new Set((reg.deals ?? []).flatMap((deal) => [deal.owners.buyer, deal.owners.seller]
    .map((claim) => `${deal.jobId}\n${canonicalDemosAgentClaim(claim)}`)));
  const signedByHolder = (binding: BundleBinding) => typeof binding?.signer === "string" &&
    canonicalDemosAgentClaim(binding.signer) !== null && holders.has(`${binding.jobId}\n${canonicalDemosAgentClaim(binding.signer)}`);
  // The catalog keeps every binding; the Directory's own BB-6 work is capped per signer, and a
  // signer over the cap leaves its side indeterminate (sticky overflow).
  const workCapped = boundedBundleBindings([
    ...[...relevantJobs].flatMap((jobId) => ownArray(scanState.bundleBindings, jobId)),
    ...(reg.bundleBindings ?? []).filter((binding) => relevantJobs.has(binding.jobId)),
  ].filter(signedByHolder));
  for (const key of workCapped.overflowKeys) overflowBindings.add(key);
  const rawBindings = workCapped.bindings;
  const verifiedBindings = (await Promise.all(rawBindings.map((binding) => verifyBundleBinding(binding))))
    .filter((binding): binding is BundleBinding => binding !== null);
  onOmitted?.("bindings", rawBindings.length - verifiedBindings.length);
  // DACS-3 SE-8: a procurement session pins a listing its buyer published, so the agreement seller
  // scored here does not hold it. Its publisher's own owner-bound current listings resolve it, apart
  // from this seller's; the graph then checks the publisher's role (§8.5.2 check 8). Over the read
  // bound, that discovery tier stays unresolved. Unsigned registrations have a separate
  // bounded fallback, tried only when trusted candidates miss the session's pinned tuple.
  const publisherListings = new Map<string, Promise<Map<string, { locator: string; raw: Record<string, unknown> }> | null>>();
  const listingsPublishedBy = (claim: string, unsigned = false) => {
    const publisher = canonicalDemosAgentClaim(claim);
    if (publisher === null) return Promise.resolve(null);
    const cacheKey = `${publisher}\n${unsigned ? "unsigned" : "trusted"}`;
    let pending = publisherListings.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const trusted = new Set(listingAnchorsFor(publisher));
        const anchors = unsigned
          ? [...new Set(listingAnchorsFor.unsigned?.(publisher) ?? [])].filter((anchor) => !trusted.has(anchor))
          : [...trusted];
        if (anchors.length > MAX_PUBLISHER_LISTING_READS) return null;
        const found = new Map<string, { locator: string; raw: Record<string, unknown> }>();
        for (const anchor of anchors) {
          const anchored = await readAnchorRecord(anchor);
          const verified = anchored ? await verifyStoredListing(anchored.data, anchor).catch(() => null) : null;
          if (!anchored || verified?.profile !== "dacs-v0.1" ||
              listingBindingRejection(verified.sellerClaim, anchored.owner, publisher) !== null) continue;
          found.set(`${verified.scope.listingId}\n${verified.scope.listingVersion}\n${verified.contentHash}`, { locator: anchor, raw: anchored.data });
        }
        return found;
      })();
      publisherListings.set(cacheKey, pending);
    }
    return pending;
  };
  const indexDeal = async (deal: RegisteredDeal): Promise<void> => {
    // Only bindings signed by this deal's role holders are discovery for it (BB-6).
    const roleHolder = (role: string) => role === "buyer" ? deal.owners.buyer : role === "seller" ? deal.owners.seller : null;
    const jobBindings = verifiedBindings.filter((binding) => {
      const holder = roleHolder(binding.role);
      return binding.jobId === deal.jobId && holder !== null &&
        canonicalDemosAgentClaim(binding.signer) !== null &&
        canonicalDemosAgentClaim(binding.signer) === canonicalDemosAgentClaim(holder);
    });
    const buyerInitial = await readAnchor(deal.buyerBundleRef);
    const resolveListing = async (ref: Record<string, unknown>) => {
      const id = String(ref.listingId ?? "");
      const version = Number(ref.version ?? ref.listingVersion ?? 0);
      const hash = String(ref.contentHash ?? "").replace(/^sha256:/, "").toLowerCase();
      const key = `${id}\n${version}\n${hash}`;
      return listingArtifacts.get(key) ?? (await listingsPublishedBy(deal.owners.buyer))?.get(key)
        ?? (await listingsPublishedBy(deal.owners.buyer, true))?.get(key) ?? null;
    };
    const graphFor = (locator: string) => buildCurrentEvidenceGraph(locator, { read: readAnchor, readAnchorRecord, resolveListing, readSettlementNode });
    const buyerIsCurrent = buyerInitial?.bundleVersion === "1" || buyerInitial?.faultBundleVersion === "1";
    const sellerCurrentProbe = buyerIsCurrent || jobBindings.length > 0 || !deal.sellerBundleRef
      ? null
      : await graphFor(deal.sellerBundleRef);
    // Profile selection is based on the signed format discriminator, not on
    // whether verification succeeds. A malformed current bundle must fail in
    // the current verifier instead of being retried by the legacy verifier.
    if (jobBindings.length > 0 || buyerIsCurrent || sellerCurrentProbe?.bundle.bundleVersion === "1" || sellerCurrentProbe?.bundle.faultBundleVersion === "1") {
      const graphCache = new Map<string, Promise<EvidenceGraph>>();
      if (sellerCurrentProbe && deal.sellerBundleRef) {
        graphCache.set(deal.sellerBundleRef, Promise.resolve(sellerCurrentProbe));
      }
      const inspect = async (binding: BundleBinding) => {
        let pending = graphCache.get(binding.nativeAddress);
        if (!pending) {
          pending = graphFor(binding.nativeAddress);
          graphCache.set(binding.nativeAddress, pending);
        }
        const graph = await pending;
        const parties = Array.isArray(graph.bundle.parties)
          ? graph.bundle.parties.filter((party): party is Record<string, unknown> =>
            Boolean(party && typeof party === "object" && !Array.isArray(party)))
          : [];
        const roleHolder = parties.find((party) => party.role === binding.role)?.primaryClaim;
        if (
          !graph.ok || graph.bundle.jobId !== binding.jobId ||
          graph.bundle.anchoredByRole !== binding.role ||
          typeof roleHolder !== "string" ||
          canonicalDemosAgentClaim(roleHolder) !== canonicalDemosAgentClaim(binding.signer)
        ) return null;
        return {
          value: graph,
          bundleContentHash: graph.bundleContentHash,
          // Standing counts only signatures the graph verified, never the parties a bundle presents.
          fullSignatureStanding: fullSignatureStanding(parties, graph.signedParties),
        };
      };
      const buyerResolution = await resolveBundleSide({
        jobId: deal.jobId,
        role: "buyer",
        expectedSigner: deal.owners.buyer,
        bindings: jobBindings,
        overflow: overflowBindings.has(bundleBindingOverflowKey(deal.jobId, "buyer", deal.owners.buyer)),
        inspect,
      });
      const sellerResolution = await resolveBundleSide({
        jobId: deal.jobId,
        role: "seller",
        expectedSigner: deal.owners.seller,
        bindings: jobBindings,
        overflow: overflowBindings.has(bundleBindingOverflowKey(deal.jobId, "seller", deal.owners.seller)),
        inspect,
      });
      if (buyerResolution.disposition !== "present" || sellerResolution.disposition !== "present") {
        dealCandidates.push({
          ...deal,
          signatureVerified: false,
          refsVerified: false,
          reputationEligible: false,
          verifiedAt: now,
        });
        return;
      }
      const resolvedDeal = {
        ...deal,
        buyerBundleRef: buyerResolution.binding.nativeAddress,
        sellerBundleRef: sellerResolution.binding.nativeAddress,
      };
      const buyerGraph = buyerResolution.inspected.value;
      const sellerGraph = sellerResolution.inspected.value;
      const { authoritative, buyerOk, sellerOk, refsVerified, sellerOutcome, orchestratorFaultNeutral, selectedLocator } =
        reconcileCurrentCopies(resolvedDeal, reg.primaryClaim, buyerGraph, sellerGraph);
      const parties = Array.isArray(authoritative?.bundle.parties) ? authoritative.bundle.parties as Array<Record<string, unknown>> : [];
      const ratings = (authoritative?.ratings ?? []).filter((rating) =>
        rating.jobId === deal.jobId && parties.some((party) => party.primaryClaim === rating.rater),
      ).map((rating) => ({
        rater: String(rating.rater), target: String(rating.target),
        targetRole: rating.targetRole as "buyer" | "seller", value: Number(rating.value),
        ratedAt: Number(rating.ratedAt),
        contentHash: authoritative!.artifacts.find((artifact) => artifact.raw === rating)?.contentHash ?? "",
      })).filter((rating) => (rating.targetRole === "buyer" || rating.targetRole === "seller") && Number.isFinite(rating.ratedAt));
      const settlement = currentSettlementClaims(authoritative?.settlement ?? []);
      // ST-10: either verified copy can establish neutral cancellation. A refuted
      // marker on one copy must not hide an established marker on the other.
      const cancellationNeutral = [sellerOk ? sellerGraph : undefined, buyerOk ? buyerGraph : undefined]
        .some((graph) => graph && isNeutralCancellation(sellerOutcome,
          graph.bundle.cancellation as Record<string, unknown> | undefined,
          graph.listing?.terms, graph.bundle.phaseSummary, graph.bundle.agreementRef));
      dealCandidates.push({
        ...resolvedDeal, signatureVerified: Boolean(authoritative?.signaturesVerified), refsVerified,
        rail: agreementRail(authoritative?.agreement) ?? "unknown",
        outcome: String(authoritative?.bundle.outcome ?? "") || undefined, sellerOutcome,
        anchoredByRole: authoritative?.bundle.anchoredByRole as DealRecord["anchoredByRole"],
        bundleContentHash: authoritative?.bundleContentHash,
        fullSignatureStanding: (authoritative === sellerGraph ? sellerResolution : buyerResolution).inspected.fullSignatureStanding,
        // SB-1: a settlement the deal cites without a canonical key is `error`, so the deal is not counted.
        reputationEligible: refsVerified && settlement !== null,
        cancellationNeutral, orchestratorFaultNeutral,
        finalisedAt: typeof authoritative?.bundle.finalisedAt === "number" ? authoritative.bundle.finalisedAt : undefined,
        anchorTimestamp: artifactAnchorTime(selectedLocator),
        agreementPrice: agreementPrice(authoritative?.agreement) ?? undefined,
        ratings, settlementTxIds: settlement ?? [],
        category: typeof (authoritative?.listing?.offering as Record<string, unknown> | undefined)?.category === "string"
          ? (authoritative!.listing!.offering as Record<string, unknown>).category as string : undefined,
        verifiedAt: now,
      });
      return;
    }
    const verifyCopy = async (ref: string, expectedRole: "buyer" | "seller") => {
      const resolvedArtifacts: ResolvedArtifact[] = [];
      let rawBundle: Record<string, unknown> | null = null;
      const verification = await verifyBundleCore(ref, {
        readArtifact: async (r) => {
          const raw = await readAnchor(r);
          if (r === ref) rawBundle = raw;
          if (raw && r !== ref) resolvedArtifacts.push({ kind: "dacs-1-listing", raw, locator: r });
          return raw;
        },
        resolveRef: async (kind, jobId) => {
          const name = kind === "dacs-3-agreement" ? sessionAnchorName.agreement(jobId)
            : kind === "dacs-4-evidence" ? sessionAnchorName.evidence(jobId)
              : kind === "dacs-2-verifyresult" ? sessionAnchorName.vet(jobId) : null;
          if (!name) return null;
          const address = resolveProgramAddress(deal.owners.buyer, name);
          if (!address) return null;
          const raw = await readAnchor(address);
          if (raw) resolvedArtifacts.push({ kind, raw });
          return raw;
        },
        resolvePublicKey: async (claim) =>
          (await resolveDemosPrimaryClaimKey(claim, "ed25519"))?.publicKey ?? null,
        verify,
      }).catch(() => null);
      const bundle = verification?.bundle;
      const signaturesOk = verification ? hasRequiredBundleSignatures(
        verification,
        rawBundle,
      ) : false;
      const bindingOk = bundleMatchesRegisteredDeal(bundle, deal, reg.primaryClaim);
      const refsOk = verification && signaturesOk && bindingOk && bundle?.anchoredByRole === expectedRole
        ? await refsPassStrictPolicy(verification, resolvedArtifacts) : false;
      return { verification, bundle, signaturesOk, refsOk, rawBundle, resolvedArtifacts };
    };

    const buyerCopy = await verifyCopy(deal.buyerBundleRef, "buyer");
    const sellerCopy = deal.sellerBundleRef ? await verifyCopy(deal.sellerBundleRef, "seller") : null;
    const divergent = Boolean(
      buyerCopy.refsOk && sellerCopy?.refsOk &&
      buyerCopy.bundle && sellerCopy.bundle && currentBundleCopiesDiverge(
        buyerCopy.bundle as unknown as Record<string, unknown>,
        sellerCopy.bundle as unknown as Record<string, unknown>,
      ),
    );
    const authoritative = sellerCopy?.refsOk ? sellerCopy : buyerCopy;
    const bundle = authoritative.bundle;
    // §10.5.1: the pinned listing, never the outcome, decides what this profile cannot verify.
    const strictRefsVerified = buyerCopy.refsOk && Boolean(sellerCopy?.refsOk) && !divergent &&
      !legacyListingSettlementIndeterminate(authoritative.verification, authoritative.resolvedArtifacts);
    const selectedRaw = authoritative.rawBundle as Record<string, unknown> | null;
    const signedBundleScope: Record<string, unknown> | null = selectedRaw ? Object.assign({}, selectedRaw) : null;
    if (signedBundleScope) {
      delete signedBundleScope.signatures;
      delete signedBundleScope.anchoredByRole;
    }
    const sellerOutcome = authoritative === sellerCopy ? bundle?.outcome : flipOutcome(bundle?.outcome);
    const currentOutcomes = new Set(["completed", "failed-perm", "failed-counterparty", "failed-substrate", "aborted-by-self", "aborted-by-other"]);
    const cancellation = selectedRaw?.cancellation as { claimedPolicy?: unknown } | undefined;
    const listingTerms = verifiedListingTerms(
      authoritative.verification,
      authoritative.resolvedArtifacts,
      strictRefsVerified,
    );
    const cancellationNeutral = isNeutralCancellation(sellerOutcome, cancellation, listingTerms, bundle?.phaseSummary, bundle?.agreementRef);
    const selectedLocator = authoritative === sellerCopy ? deal.sellerBundleRef! : deal.buyerBundleRef;
    const settlement = legacySettlementClaims(authoritative.resolvedArtifacts);
    dealCandidates.push({
      ...deal,
      signatureVerified: authoritative.signaturesOk,
      refsVerified: strictRefsVerified,
      outcome: bundle?.outcome,
      sellerOutcome,
      anchoredByRole: bundle?.anchoredByRole === "buyer" || bundle?.anchoredByRole === "seller" || bundle?.anchoredByRole === "orchestrator"
        ? bundle.anchoredByRole : undefined,
      // Only a bundle the verifier already hashed is hashed again; a rejected raw bundle gets no hash.
      bundleContentHash: bundle && signedBundleScope ? contentHash(signedBundleScope) : undefined,
      fullSignatureStanding: legacyFullSignatureStanding(authoritative.verification),
      reputationEligible: strictRefsVerified && currentOutcomes.has(sellerOutcome ?? "") && settlement !== null,
      cancellationNeutral,
      orchestratorFaultNeutral: false,
      finalisedAt: bundle?.finalisedAt,
      anchorTimestamp: artifactAnchorTime(selectedLocator),
      settlementTxIds: settlement ?? [],
      category: bundleCategory(bundle, categoriesByListing),
      verifiedAt: now,
    });
  };
  for (const deal of reg.deals ?? []) {
    // One deal's artifacts can never stop the next deal: a failure is an explicit unverified record.
    try {
      await indexDeal(deal);
    } catch (error) {
      throwIfInfrastructureError(error);
      onOmitted?.("deals", 1);
      dealCandidates.push({ ...deal, signatureVerified: false, refsVerified: false, reputationEligible: false, verifiedAt: now });
    }
  }
  const deals = dedupeVerifiedDeals(dealCandidates);

  // ── Reputation: derived ONLY from verified bundles ────────────────────────
  const counted = deals.filter((d) => d.refsVerified && d.reputationEligible);
  const reputation = deriveSellerReputation(deals, 0, now);
  const completed = reputation.completed;
  const windowStart = 0;
  const windowEnd = now;
  const listingsWithHint = listings.map((l) => ({
    ...l,
    reputationHint: categoryReputationHint(l.offering.category, counted, windowStart, windowEnd, now),
  }));

  // Owner badge: re-verify the stored signature each pass (freshness is a
  // submission-time replay gate only — the cryptographic binding must hold).
  const ownerRegistered = reg.ownerSignature
    ? await verifyOwnerSignature(reg, { ignoreFreshness: true }).catch(() => false)
    : false;
  const identityTier = sellerIdentityTier(await Promise.all(identityBundles.map((bundle) => deriveIdentityTier(bundle, resolveRecipe))));

  return {
    primaryClaim: reg.primaryClaim,
    ownerRegistered,
    displayName: reg.displayName,
    identityTier,
    identityLinksPresent: cci.length > 0,
    identityBundle,
    cci,
    listings: listingsWithHint,
    deals,
    reputation,
    registeredAt: prior?.registeredAt ?? now,
    lastIndexedAt: now,
  };
}
