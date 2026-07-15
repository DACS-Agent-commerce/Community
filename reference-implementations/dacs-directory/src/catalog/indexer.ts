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
// Pure vendored subpaths only; no substrate client dependency.
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { parseCciRecord } from "@kynesyslabs/dacs/identity";
// verifyBundleCore has no pure subpath export (dacs-sdk#14) — vendor path.
import { verifyBundleCore } from "../../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
// The SDK doesn't export sessionAnchorName from its public barrel
// (dacs-sdk#14) — reach into the vendored build.
import { sessionAnchorName } from "../../vendor/dacs-sdk/dist/agent/runSessionCore.js";
import { deriveAnchorAddress, readAnchor, readAnchorRecord } from "./chain.js";
import { gcrGetIdentities } from "./gcr.js";
import { hasValidListingRevocation, ownerClaim, verifyListing } from "./listingVerification.js";
import { listingPresentation } from "./listingMetadata.js";
import { verifyOwnerSignature } from "./registrationSig.js";
import { artifactAnchorTime, findProgramAddress, loadScanState } from "./store.js";
import { deriveSellerReputation, flipOutcome, isNeutralCancellation } from "./reputation.js";
import { agreementPrice, buildCurrentEvidenceGraph, type EvidenceGraph } from "./evidenceGraph.js";
import { currentBundleCopiesDiverge, reconcileCurrentCopies } from "./currentReconciliation.js";
import { safePublicEndpoint } from "./publicEndpoint.js";
import { deriveIdentityTier, type ResolveRecipe } from "./identityVerification.js";
import {
  bundleMatchesRegisteredDeal,
  bundleCategory,
  dedupeVerifiedDeals,
  hasRequiredBundleSignatures,
  refsPassStrictPolicy,
  type ResolvedArtifact,
} from "./bundlePolicy.js";

import type {
  CciBadge,
  DealRecord,
  ListingSummary,
  Registration,
  SellerRecord,
} from "./types.js";

const keyFromDid = (did: string): Uint8Array | null => {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
};
const verify = (b: Uint8Array, s: Uint8Array, p: Uint8Array): boolean =>
  ed25519Verify(b, s, publicKeyFromRaw(p));

/** Resolve the raw GCR identity payload for a bare-hex Demos address. */
export type ResolveIdentities = (addressHex: string) => Promise<unknown>;

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
): Promise<SellerRecord> {
  const now = Date.now();

  // ── CCI badges: from the on-chain GCR, never from the payload ────────────
  const hex = reg.primaryClaim.match(/([0-9a-fA-F]{64})$/)?.[1] ?? reg.primaryClaim;
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
  let identityBundle: Record<string, unknown> | undefined;
  const identityBundles: Record<string, unknown>[] = [];
  const revocations = loadScanState().revocations ?? {};
  for (const anchor of reg.listingAnchors) {
    const anchored = await readAnchorRecord(anchor);
    if (!anchored) continue;
    const verified = await verifyListing(anchored.data);
    if (!verified) continue;
    const { scope } = verified;
    if (verified.sellerClaim.toLowerCase() !== reg.primaryClaim.toLowerCase()) continue;
    if (ownerClaim(anchored.owner) !== reg.primaryClaim.toLowerCase()) continue;
    const declaredHash = reg.listingContentHashes?.[anchor]?.replace(/^sha256-/, "").toLowerCase();
    if (declaredHash && declaredHash !== verified.contentHash) continue;
    const listingId = typeof scope.listingId === "string" ? scope.listingId
      : typeof scope.serviceId === "string" ? scope.serviceId : "";
    if (!listingId) continue;
    const rawVersion = scope.listingVersion ?? scope.version ?? 1;
    const version = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion > 0
      ? rawVersion
      : 1;
    const validity = scope.validity as { notAfter?: unknown } | undefined;
    if (typeof validity?.notAfter === "number" && validity.notAfter < now) continue;
    const storedCandidates = revocations[verified.contentHash];
    const revocationAddresses = Array.isArray(storedCandidates)
      ? storedCandidates
      : storedCandidates ? [storedCandidates] : [];
    const revoked = await hasValidListingRevocation(
      revocationAddresses,
      verified,
      version,
      readAnchor,
    );
    const presentation = listingPresentation(scope);
    const signedSeller = scope.seller && typeof scope.seller === "object" && !Array.isArray(scope.seller)
      ? scope.seller as Record<string, unknown> : null;
    if (verified.profile === "dacs-v0.1" && signedSeller?.identity && typeof signedSeller.identity === "object") {
      identityBundle = signedSeller.identity as Record<string, unknown>;
      identityBundles.push(identityBundle);
    }
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
      status: revoked ? "revoked" : "active",
      catalogObservedAt: now,
    });
    listingArtifacts.set(`${listingId}\n${version}\n${verified.contentHash}`, { locator: anchor, raw: anchored.data });
  }

  // ── Deals: dereference + verify each bundle from chain ────────────────────
  const dealCandidates: DealRecord[] = [];
  const categoriesByListing = new Map(listings.map((l) => [l.listingId, l.offering.category]));
  const listingsById = new Map(listings.map((l) => [l.listingId, l]));
  for (const deal of reg.deals ?? []) {
    const buyerInitial = await readAnchor(deal.buyerBundleRef);
    const resolveListing = async (ref: Record<string, unknown>) => {
      const id = String(ref.listingId ?? "");
      const version = Number(ref.version ?? ref.listingVersion ?? 0);
      const hash = String(ref.contentHash ?? "").replace(/^sha256:/, "").toLowerCase();
      return listingArtifacts.get(`${id}\n${version}\n${hash}`) ?? null;
    };
    const graphFor = (locator: string) => buildCurrentEvidenceGraph(locator, { read: readAnchor, resolveListing });
    const sellerCurrentProbe = buyerInitial?.bundleVersion === "1" || !deal.sellerBundleRef
      ? null
      : await graphFor(deal.sellerBundleRef);
    // Profile selection is based on the signed format discriminator, not on
    // whether verification succeeds. A malformed current bundle must fail in
    // the current verifier instead of being retried by the legacy verifier.
    if (buyerInitial?.bundleVersion === "1" || sellerCurrentProbe?.bundle.bundleVersion === "1") {
      const buyerGraph = await graphFor(deal.buyerBundleRef);
      const sellerGraph = sellerCurrentProbe ?? (deal.sellerBundleRef ? await graphFor(deal.sellerBundleRef) : null);
      const { authoritative, buyerOk, sellerOk, refsVerified, sellerOutcome, selectedLocator } =
        reconcileCurrentCopies(deal, reg.primaryClaim, buyerGraph, sellerGraph);
      const parties = Array.isArray(authoritative?.bundle.parties) ? authoritative.bundle.parties as Array<Record<string, unknown>> : [];
      const ratings = (authoritative?.ratings ?? []).filter((rating) =>
        rating.jobId === deal.jobId && parties.some((party) => party.primaryClaim === rating.rater),
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
        ...deal, signatureVerified: Boolean(authoritative?.signaturesVerified), refsVerified,
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
      continue;
    }
    const verifyCopy = async (ref: string, expectedRole: "buyer" | "seller") => {
      const resolvedArtifacts: ResolvedArtifact[] = [];
      let rawBundle: Record<string, unknown> | null = null;
      const verification = await verifyBundleCore(ref, {
        readArtifact: async (r) => {
          const raw = await readAnchor(r);
          if (r === ref) rawBundle = raw;
          if (raw && r !== ref) resolvedArtifacts.push({ kind: "dacs-1-listing", raw });
          return raw;
        },
        resolveRef: async (kind, jobId) => {
          const name = kind === "dacs-3-agreement" ? sessionAnchorName.agreement(jobId)
            : kind === "dacs-4-evidence" ? sessionAnchorName.evidence(jobId)
              : kind === "dacs-2-verifyresult" ? sessionAnchorName.vet(jobId) : null;
          if (!name) return null;
          const address = findProgramAddress(deal.owners.buyer, name) ?? deriveAnchorAddress(deal.owners.buyer, name);
          const raw = await readAnchor(address);
          if (raw) resolvedArtifacts.push({ kind, raw });
          return raw;
        },
        resolvePublicKey: async (did) => keyFromDid(did),
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
      return { verification, bundle, signaturesOk, refsOk, rawBundle };
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
    const strictRefsVerified = authoritative.refsOk && !divergent;
    const selectedRaw = authoritative.rawBundle as Record<string, unknown> | null;
    const signedBundleScope: Record<string, unknown> | null = selectedRaw ? Object.assign({}, selectedRaw) : null;
    if (signedBundleScope) {
      delete signedBundleScope.signatures;
      delete signedBundleScope.anchoredByRole;
    }
    const sellerOutcome = authoritative === sellerCopy ? bundle?.outcome : flipOutcome(bundle?.outcome);
    const currentOutcomes = new Set(["completed", "failed-perm", "failed-counterparty", "failed-substrate", "aborted-by-self", "aborted-by-other"]);
    const cancellation = selectedRaw?.cancellation as { claimedPolicy?: unknown } | undefined;
    const listingTerms = bundle ? listingsById.get(String(bundle.listingRef.listingId))?.terms : undefined;
    const cancellationNeutral = isNeutralCancellation(sellerOutcome, cancellation, listingTerms, bundle?.phaseSummary);
    const selectedLocator = authoritative === sellerCopy ? deal.sellerBundleRef! : deal.buyerBundleRef;
    dealCandidates.push({
      ...deal,
      signatureVerified: authoritative.signaturesOk,
      refsVerified: strictRefsVerified,
      outcome: bundle?.outcome,
      sellerOutcome,
      anchoredByRole: bundle?.anchoredByRole === "buyer" || bundle?.anchoredByRole === "seller" || bundle?.anchoredByRole === "orchestrator"
        ? bundle.anchoredByRole : undefined,
      bundleContentHash: signedBundleScope ? contentHash(signedBundleScope) : undefined,
      reputationEligible: strictRefsVerified && currentOutcomes.has(sellerOutcome ?? ""),
      cancellationNeutral,
      finalisedAt: bundle?.finalisedAt,
      anchorTimestamp: artifactAnchorTime(selectedLocator),
      category: bundleCategory(bundle, categoriesByListing),
      verifiedAt: now,
    });
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
  const ownerRegistered = reg.ownerSignature
    ? await verifyOwnerSignature(reg, { ignoreFreshness: true }).catch(() => false)
    : false;
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
