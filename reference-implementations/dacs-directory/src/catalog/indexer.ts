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
import { legacyListingHash } from "./legacyListingHash.js";
import { usesCurrentBundleProfile } from "./bundleProfile.js";
import { parseCciRecord } from "@kynesyslabs/dacs/identity";
import { isLegacyMvpAttestationBundle } from "@kynesyslabs/dacs/artifacts";
// verifyBundleCore is exported from the SDK's agent barrel, but that barrel
// also re-exports createAgent/Agent.js, which pulls in the substrate/bridge
// dependency chain (rubic-sdk → cetus-sui-clmm-sdk → a broken @mysten/bcs
// import) and breaks the production webpack build. Reach into the leaf
// module directly to keep this file free of the substrate client.
import { verifyBundleCore } from "../../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
import { readAnchor, readAnchorRecord, readAnchorResult } from "./chain.js";
import { gcrGetIdentities } from "./gcr.js";
import {
  findValidListingRevocation,
  ownerClaim,
  REVOCATION_VERIFICATIONS_PER_PASS,
  revocationSellerClaim,
  verifyStoredListingResult,
  type RevocationCandidateProgress,
} from "./listingVerification.js";
import { MAX_CLAIM_QUERY_BYTES } from "./discovery.js";
import { DIRECTORY_TRANSACTION_READINESS } from "./inspection.js";
import { listingDiagnosticCoordinates } from "./listingAdmission.js";
import { canonicalDemosAgentClaim, canonicalDemosAgentReference, canonicalSigningIdentity } from "./claimRef.js";
import { resolveDemosPrimaryClaimKey } from "./primaryClaimKey.js";
import { listingPresentation } from "./listingMetadata.js";
import { verifyOwnerSignature } from "./registrationSig.js";
import {
  artifactAnchorTime,
  clearListingRejection,
  listingRejectionNoticeCode,
  pruneRegistrationListingRejections,
  hasPendingOwnerRevocationCandidate,
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
import { deriveSellerReputation, isNeutralCancellation } from "./reputation.js";
import { agreementPrice, buildCurrentEvidenceGraph, type EvidenceGraph } from "./evidenceGraph.js";
import { agreementRail } from "./agreementMetadata.js";
import { legacyCopyCanVerifyRefs, reconcileLegacyCopies, reconcileCurrentCopies } from "./currentReconciliation.js";
import {
  boundedBundleBindings,
  bundleBindingOverflowKey,
  resolveBundleSide,
  verifyBundleBinding,
} from "./bundleBinding.js";
import { safePublicEndpoint } from "./publicEndpoint.js";
import { legacySessionAnchorName } from "./legacySessionAnchorName.js";
import { deriveIdentityTier, type ResolveRecipe } from "./identityVerification.js";
import {
  bundleMatchesRegisteredDeal,
  bundleCategory,
  dedupeVerifiedDeals,
  hasRequiredBundleSignatures,
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

/** Resolve the raw GCR identity payload for a bare-hex Demos address. */
export type ResolveIdentities = (addressHex: string) => Promise<unknown>;

/**
 * Missing or unavailable current bytes cannot reject an older candidate (RB-5/6).
 * Every read that yields no artifact, a storage `not found` included, is noted
 * in `unavailable`.
 */
async function readRevocationCandidate(
  locator: string,
  unavailable: Set<string>,
): Promise<Record<string, unknown> | null> {
  const read = await readAnchorResult(locator);
  if (read.status === "absent" || read.status === "unavailable") unavailable.add(locator);
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

/** DACS-1 reader step 3: only currently effective Listings are discoverable. */
export function listingIsCurrentlyEffective(
  scope: Record<string, unknown>,
  now: number,
): boolean {
  const validity = scope.validity && typeof scope.validity === "object" && !Array.isArray(scope.validity)
    ? scope.validity as { notBefore?: unknown; notAfter?: unknown }
    : undefined;
  if (!validity) return true; // Explicit legacy profile has no validity window.
  if (typeof validity.notBefore === "number" && now < validity.notBefore) return false;
  if (typeof validity.notAfter === "number" && now > validity.notAfter) return false;
  return true;
}

/**
 * Index one registration into a verified SellerRecord.
 *
 * `resolveIdentities` defaults to the narrow authenticated GCR call in gcr.ts;
 * tests may inject a deterministic resolver.
 */
export async function indexRegistration(
  reg: Registration,
  prior?: SellerRecord,
  resolveIdentities: ResolveIdentities = gcrGetIdentities,
  resolveRecipe?: ResolveRecipe,
  onOmitted?: (kind: "bindings" | "deals", count: number) => void,
  verifyLegacyBundle: typeof verifyBundleCore = verifyBundleCore,
): Promise<SellerRecord> {
  const now = Date.now();
  const ownerRegistered = reg.ownerSignatureVerified ?? (reg.ownerSignature
    ? await verifyOwnerSignature(reg, { ignoreFreshness: true }).catch(() => false)
    : false);
  // Only an anchor the owner signed is the owner's pointer; the crawl may add others.
  const ownerSignedAnchors = new Set(reg.ownerSignedAnchors ?? reg.listingAnchors);
  const rejectedListingAnchors = new Set<string>();

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
    cci = record.claims.filter((c) => c.kind === "web2" || c.kind === "wallet").map((c) => c.kind === "web2"
      ? { kind: c.kind, platform: c.platform, handle: c.handle, ref: c.ref,
          proofUrl: proofFor(c.platform, c.handle), linkUrl: profileFor(c.platform, c.handle) }
      : { kind: c.kind, platform: c.chainType, handle: c.address, ref: c.ref,
          linkUrl: explorerFor(c.chainType, c.address) });
  } catch {
    /* keep prior badges on transient failure */
  }

  // ── Listings: read from chain, validate shape ─────────────────────────────
  const listings: ListingSummary[] = [];
  const listingArtifacts = new Map<string, { locator: string; raw: Record<string, unknown>; expiredAt?: number }>();
  const categoriesByListing = new Map<string, string>();
  let identityBundle: Record<string, unknown> | undefined;
  const identityBundles: Record<string, unknown>[] = [];
  const { verifiedRevocations } = loadScanState();
  const normalizedHash = (hash: string) => hash.replace(/^sha256-/, "").toLowerCase();
  for (const anchor of reg.listingAnchors) {
    const anchored = await readAnchorRecord(anchor);
    if (!anchored) {
      // An unread anchor cannot clear an earlier rejection or reset its history.
      rejectedListingAnchors.add(anchor);
      continue;
    }
    const sourceDeclarations = Object.values(reg.authenticatedHashDeclarations ?? {});
    const authenticatedHashes = sourceDeclarations.flatMap((source) => source?.hashes[anchor] ? [normalizedHash(source.hashes[anchor])] : []);
    const currentDeclaration = sourceDeclarations.some((source) => source?.current && source.hashes[anchor]);
    const unsignedHash = reg.listingContentHashes?.[anchor];
    const declaredHashes = authenticatedHashes.length > 0 ? authenticatedHashes : unsignedHash ? [normalizedHash(unsignedHash)] : [];
    const heldNotice = listingRejectionNoticeCode(anchor, reg.primaryClaim);
    // A held hash notice waits until this pass knows every authenticated declaration of the anchor: a current
    // source declares it, every saved source was accepted in this pass, or a complete pass finds no declaration.
    const declarationsKnown = !sourceDeclarations.includes(null) && (currentDeclaration ||
      (sourceDeclarations.length > 0 && sourceDeclarations.every((source) => source?.current)) ||
      (!reg.discoveryIncomplete && declaredHashes.length === 0));
    if (heldNotice === "DECLARED_CONTENT_HASH_MISMATCH" && !declarationsKnown) {
      rejectedListingAnchors.add(anchor);
      continue;
    }
    // A held public notice stands until a read refutes it: the owner notice yields to any verified listing,
    // the hash notice once every authenticated declaration of the anchor matches the verified hash or is withdrawn.
    const heldNoticeStands = (verifiedHash?: string): boolean => heldNotice === "OWNER_CLAIM_BINDING"
      ? verifiedHash === undefined
      : heldNotice === "DECLARED_CONTENT_HASH_MISMATCH" && authenticatedHashes.some((hash) => hash !== verifiedHash);
    // Fails closed: a listing with no canonical form is rejected like any invalid one.
    const verification = await verifyStoredListingResult(anchored.data, anchor);
    if (!verification.ok) {
      rejectedListingAnchors.add(anchor);
      if (!heldNoticeStands()) recordListingRejection(anchor, reg.primaryClaim, verification.code);
      continue;
    }
    const verified = verification.value;
    const { scope } = verified;
    const bindingRejection = listingBindingRejection(
      verified.sellerClaim,
      anchored.owner,
      reg.primaryClaim,
    );
    if (bindingRejection) {
      rejectedListingAnchors.add(anchor);
      if (!heldNoticeStands(verified.contentHash)) {
        recordListingRejection(
          anchor,
          reg.primaryClaim,
          bindingRejection,
          bindingRejection === "SELLER_CLAIM_BINDING" ? undefined : listingDiagnosticCoordinates(verified.scope),
          ownerRegistered && bindingRejection !== "SELLER_CLAIM_BINDING" && ownerSignedAnchors.has(anchor),
        );
      }
      continue;
    }
    if (declaredHashes.some((hash) => hash !== verified.contentHash)) {
      rejectedListingAnchors.add(anchor);
      recordListingRejection(
        anchor,
        reg.primaryClaim,
        "DECLARED_CONTENT_HASH_MISMATCH",
        listingDiagnosticCoordinates(verified.scope),
        authenticatedHashes.length > 0,
      );
      continue;
    }
    clearListingRejection(anchor, reg.primaryClaim);
    const listingId = typeof scope.listingId === "string" ? scope.listingId
      : typeof scope.serviceId === "string" ? scope.serviceId : "";
    if (!listingId) continue;
    const rawVersion = scope.listingVersion ?? scope.version ?? 1;
    const version = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion > 0
      ? rawVersion
      : 1;
    // DACS-1 §6.3.4 reader step 3: future terms cannot authenticate deal history.
    const validity = scope.validity as { notBefore?: unknown; notAfter?: unknown } | undefined;
    const notBefore = typeof validity?.notBefore === "number" ? validity.notBefore : undefined;
    if (notBefore !== undefined && now < notBefore) continue;
    const presentation = listingPresentation(scope);
    // Retain authenticated Listing terms for history after expiry or revocation.
    // Expired terms remain in history, but this reader cannot authenticate their commitment finality (see the evidence graph).
    const expiredAt = typeof validity?.notAfter === "number" && now > validity.notAfter ? validity.notAfter : undefined;
    listingArtifacts.set(`${listingId}\n${version}\n${verified.contentHash}`, { locator: anchor, raw: anchored.data, expiredAt });
    categoriesByListing.set(listingId, presentation.category);
    if (!listingIsCurrentlyEffective(scope, now)) continue;
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
    const knownMarkers = (verifiedRevocations[verified.contentHash] ?? []).slice(0, limit);
    const unavailableMarkers = new Set<string>();
    const readMarkers = new Map<string, Record<string, unknown>>();
    const found = await findValidListingRevocation(
      [
        ...knownMarkers,
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
        const marker = await readRevocationCandidate(locator, unavailableMarkers);
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
    const boundRetained = retained?.sellerPrimaryClaim === revocationSellerClaim(verified) && retained.listingId === listingId &&
      retained.listingVersion === version ? retained : null;
    const revocationBinding = found ?? boundRetained ?? prior?.listings.find((listing) => listing.status === "revoked" &&
      listing.contentHash === verified.contentHash)?.revocation ?? null;
    // Raw chain hints have no withdrawal authority. Only an authenticated source
    // can leave an unresolved hold; a verified marker is retained above (RB-3).
    // SDK readers also take a fresh `active` summary without a binding as
    // established revocation absence, so a marker the node could not serve
    // (including a storage `not found`, which DEMOS-MAPPING §A.2 makes
    // indeterminate) holds the listing when it was verified before, or while
    // the listing owner has an anchored marker that no read has settled, even
    // on a pass that skips it during its retry backoff. Anyone can anchor
    // other candidates, so an outage on those cannot hold it.
    const revocation: RevocationCheck = revocationBinding ? "revoked"
      : hasIncompleteWellKnownWithdrawal(reg.primaryClaim, verified.contentHash) ||
        [...unavailableMarkers].some((ref) => knownMarkers.includes(ref)) ||
        hasPendingOwnerRevocationCandidate(verified.contentHash, anchored.owner ?? null)
        ? "indeterminate" : "absent";
    const signedSeller = scope.seller && typeof scope.seller === "object" && !Array.isArray(scope.seller)
      ? scope.seller as Record<string, unknown> : null;
    if (verified.profile === "dacs-v0.1" && signedSeller?.identity && typeof signedSeller.identity === "object") {
      identityBundle = signedSeller.identity as Record<string, unknown>;
      identityBundles.push(identityBundle);
    }
    // The catalog can publish neither "active" for an indeterminate check (a reader would take it
    // as absent, RB-6) nor "revoked" without a binding (RB-3), so the listing waits for a later pass.
    if (revocation === "indeterminate") continue;
    const summaryClaim = verified.profile === "dacs-v0.1"
      ? verified.listing.seller.identity.presentedBy
      : reg.primaryClaim;
    // Discovery cannot address a seller by a reference above the query bound, and a summary
    // carries it verbatim; the signed Listing stays above as evidence only.
    if (Buffer.byteLength(summaryClaim, "utf8") > MAX_CLAIM_QUERY_BYTES) continue;
    listings.push({
      listingId,
      version,
      contentHash: verified.contentHash,
      anchor: { kind: "storage-program", locator: anchor },
      // §6.3.6 / RB-2: SDK catalog clients derive the logical address from, and
      // match the revocation binding against, the exact `presentedBy` bytes.
      seller: {
        primaryClaim: summaryClaim,
        displayName: reg.displayName,
      },
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
      transactionReadiness: DIRECTORY_TRANSACTION_READINESS,
    });
  }

  // Partial discovery cannot prove crawl removals, but verified owner pointers can prove owner removals.
  if (!reg.discoveryIncomplete || ownerRegistered) {
    pruneRegistrationListingRejections(reg.primaryClaim, rejectedListingAnchors,
      reg.discoveryIncomplete ? ownerSignedAnchors : undefined);
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
      return listingArtifacts.get(`${id}\n${version}\n${hash}`) ?? null;
    };
    const graphFor = (locator: string) => buildCurrentEvidenceGraph(locator, { read: readAnchor, resolveListing });
    const buyerIsCurrent = usesCurrentBundleProfile(buyerInitial);
    const sellerCurrentProbe = buyerIsCurrent || jobBindings.length > 0 || !deal.sellerBundleRef
      ? null
      : await graphFor(deal.sellerBundleRef);
    // Profile selection is based on the signed format discriminator, not on
    // whether verification succeeds. A malformed current bundle must fail in
    // the current verifier instead of being retried by the legacy verifier.
    if (jobBindings.length > 0 || buyerIsCurrent || usesCurrentBundleProfile(sellerCurrentProbe?.bundle ?? null)) {
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
        const signed = new Set(
          (Array.isArray(graph.bundle.signatures) ? graph.bundle.signatures : [])
            .map((signature) => signature && typeof signature === "object" && !Array.isArray(signature)
              ? (signature as Record<string, unknown>).party : undefined)
            .filter((party): party is string => typeof party === "string")
            .map(canonicalDemosAgentClaim)
            .filter((party): party is string => party !== null),
        );
        const required = parties.filter((party) =>
          party.role === "buyer" || party.role === "seller" || party.role === "orchestrator")
          .map((party) => party.primaryClaim)
          .filter((claim): claim is string => typeof claim === "string")
          .map(canonicalDemosAgentClaim)
          .filter((claim): claim is string => claim !== null);
        return {
          value: graph,
          bundleContentHash: graph.bundleContentHash,
          fullSignatureStanding: required.length >= 2 && required.every((claim) => signed.has(claim)),
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
      const { authoritative, buyerOk, sellerOk, refsVerified, sellerOutcome, selectedLocator } =
        reconcileCurrentCopies(resolvedDeal, reg.primaryClaim, buyerGraph, sellerGraph);
      const parties = Array.isArray(authoritative?.bundle.parties) ? authoritative.bundle.parties as Array<Record<string, unknown>> : [];
      const ratings = (authoritative?.ratings ?? []).filter((rating) =>
        rating.jobId === deal.jobId && parties.some((party) =>
          typeof party.primaryClaim === "string" && typeof rating.rater === "string" &&
          canonicalSigningIdentity(party.primaryClaim) === canonicalSigningIdentity(rating.rater)),
      ).map((rating) => ({
        rater: String(rating.rater), target: String(rating.target),
        targetRole: rating.targetRole as "buyer" | "seller", value: Number(rating.value),
        ratedAt: Number(rating.ratedAt),
        contentHash: authoritative!.artifacts.find((artifact) => artifact.raw === rating)?.contentHash ?? "",
      })).filter((rating) => (rating.targetRole === "buyer" || rating.targetRole === "seller") && Number.isFinite(rating.ratedAt));
      const settlementTxIds = (authoritative?.artifacts ?? []).filter((artifact) => artifact.kind === "evidence")
        .flatMap((artifact) => {
          const refs = Array.isArray(artifact.raw.paymentTxRefs) ? artifact.raw.paymentTxRefs : [];
          const phaseIndex = Number(artifact.raw.phaseIndex ?? 0);
          return refs.map((ref) => typeof ref === "string" ? ref : String((ref as Record<string, unknown>)?.txId ?? (ref as Record<string, unknown>)?.id ?? ""))
            .filter(Boolean).map((id) => ({ id, observedAt: Number(artifact.raw.observedAt), phaseIndex }));
        });
      const cancellation = [sellerOk ? sellerGraph?.bundle.cancellation : undefined, buyerOk ? buyerGraph.bundle.cancellation : undefined]
        .find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
      const cancellationNeutral = isNeutralCancellation(
        sellerOutcome, cancellation, authoritative?.listing?.terms, authoritative?.bundle.phaseSummary,
      );
      dealCandidates.push({
        ...resolvedDeal, signatureVerified: Boolean(authoritative?.signaturesVerified), refsVerified,
        rail: agreementRail(authoritative?.agreement) ?? "unknown",
        outcome: String(authoritative?.bundle.outcome ?? "") || undefined, sellerOutcome,
        anchoredByRole: authoritative?.bundle.anchoredByRole as DealRecord["anchoredByRole"],
        bundleContentHash: authoritative?.bundleContentHash,
        reputationEligible: refsVerified,
        cancellationNeutral,
        finalisedAt: typeof authoritative?.bundle.finalisedAt === "number" ? authoritative.bundle.finalisedAt : undefined,
        anchorTimestamp: artifactAnchorTime(selectedLocator),
        agreementPrice: agreementPrice(authoritative?.agreement) ?? undefined,
        ratings, settlementTxIds,
        category: typeof (authoritative?.listing?.offering as Record<string, unknown> | undefined)?.category === "string"
          ? (authoritative!.listing!.offering as Record<string, unknown>).category as string : undefined,
        verifiedAt: now,
      });
      return;
    }
    const verifyCopy = async (ref: string, expectedRole: "buyer" | "seller") => {
      const resolvedArtifacts: ResolvedArtifact[] = [];
      let rawBundle: Record<string, unknown> | null = null;
      const verification = await verifyLegacyBundle(ref, {
        readArtifact: async (r) => {
          const raw = await readAnchor(r);
          if (r === ref) rawBundle = raw;
          if (raw && r !== ref) resolvedArtifacts.push({ kind: "dacs-1-listing", raw, locator: r });
          return raw;
        },
        resolveRef: async (kind, jobId) => {
          const name = kind === "dacs-3-agreement" ? legacySessionAnchorName.agreement(jobId)
            : kind === "dacs-4-evidence" ? legacySessionAnchorName.evidence(jobId)
              : kind === "dacs-2-verifyresult" ? legacySessionAnchorName.vet(jobId) : null;
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
      }).catch((error) => {
        throwIfInfrastructureError(error);
        return null;
      });
      const bundle = verification && isLegacyMvpAttestationBundle(verification.bundle)
        ? verification.bundle
        : undefined;
      const signaturesOk = verification ? hasRequiredBundleSignatures(
        verification,
        rawBundle,
      ) : false;
      const bindingOk = bundleMatchesRegisteredDeal(bundle, deal, reg.primaryClaim);
      const authenticated = Boolean(verification) && legacyCopyCanVerifyRefs(signaturesOk, bindingOk, bundle?.anchoredByRole, expectedRole);
      const refsOk = verification && authenticated ? await refsPassStrictPolicy(verification, resolvedArtifacts) : false;
      return { verification, bundle, signaturesOk, refsOk, rawBundle, resolvedArtifacts,
        carriesVetRecords: authenticated && Boolean(bundle?.vetRecords.length) };
    };

    const buyerCopy = await verifyCopy(deal.buyerBundleRef, "buyer");
    const sellerCopy = deal.sellerBundleRef ? await verifyCopy(deal.sellerBundleRef, "seller") : null;
    const { authoritative, refsVerified: strictRefsVerified, sellerOutcome, reputationEligible } =
      reconcileLegacyCopies(buyerCopy, sellerCopy);
    const bundle = authoritative.bundle;
    const selectedRaw = authoritative.rawBundle as Record<string, unknown> | null;
    const signedBundleScope: Record<string, unknown> | null = selectedRaw ? Object.assign({}, selectedRaw) : null;
    if (signedBundleScope) {
      delete signedBundleScope.signatures;
      delete signedBundleScope.anchoredByRole;
    }
    const cancellation = selectedRaw?.cancellation as { claimedPolicy?: unknown } | undefined;
    const listingTerms = verifiedListingTerms(
      authoritative.verification,
      authoritative.resolvedArtifacts,
      strictRefsVerified,
    );
    const cancellationNeutral = isNeutralCancellation(sellerOutcome, cancellation, listingTerms, bundle?.phaseSummary);
    const selectedLocator = authoritative === sellerCopy ? deal.sellerBundleRef! : deal.buyerBundleRef;
    dealCandidates.push({
      ...deal,
      signatureVerified: authoritative.signaturesOk,
      refsVerified: strictRefsVerified,
      verificationLimitation: !strictRefsVerified && (buyerCopy.carriesVetRecords || sellerCopy?.carriesVetRecords)
        ? "legacy-vet-unsupported" : undefined,
      outcome: bundle?.outcome,
      sellerOutcome,
      anchoredByRole: bundle?.anchoredByRole === "buyer" || bundle?.anchoredByRole === "seller" || bundle?.anchoredByRole === "orchestrator"
        ? bundle.anchoredByRole : undefined,
      // Only a bundle the verifier already hashed is hashed again; a rejected raw bundle gets no hash.
      bundleContentHash: bundle && signedBundleScope ? legacyListingHash(signedBundleScope) : undefined,
      reputationEligible,
      cancellationNeutral,
      finalisedAt: bundle?.finalisedAt,
      anchorTimestamp: artifactAnchorTime(selectedLocator),
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
    reputationHint: (() => {
      const categoryDeals = counted.filter(
        (d) => d.category === l.offering.category || d.category?.startsWith(l.offering.category + "."),
      );
      const categoryCompleted = categoryDeals.filter((d) => d.sellerOutcome === "completed").length;
      const categoryDenominator = categoryDeals.filter((d) => d.sellerOutcome !== "failed-substrate" && !d.cancellationNeutral).length;
      return {
        categoryScope: l.offering.category,
        completionRate: categoryDenominator ? categoryCompleted / categoryDenominator : null,
        averageSellerRating: deriveSellerReputation(categoryDeals, windowStart, windowEnd).averageSellerRating ?? null,
        bundleCount: categoryDeals.length,
        windowStart,
        windowEnd,
        computedAt: now,
      };
    })(),
  }));

  // Owner badge: re-verify the stored signature each pass (freshness is a
  // submission-time replay gate only — the cryptographic binding must hold).
  const identityTiers = await Promise.all(identityBundles.map((bundle) => deriveIdentityTier(bundle, resolveRecipe)));
  const identityTier = identityTiers.includes("institutional") ? "institutional"
    : identityTiers.includes("verified") ? "verified" : "self-declared";

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
