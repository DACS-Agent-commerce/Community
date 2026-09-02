/** Turn one submitted or passively discovered seller into SDK-validated projections. */
import {
  bundleConsistency,
  type BundleCopies,
} from "../../vendor/dacs-sdk/dist/agent/bundleConsistency.js";
import { verifyBundleCopy } from "../../vendor/dacs-sdk/dist/agent/bundleCopyValidity.js";
import { deriveReputation } from "../../vendor/dacs-sdk/dist/agent/reputationDerivation.js";
import { verifyBundleCore } from "../../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
import { deriveIdentityTier } from "../../vendor/dacs-sdk/dist/identity/tier.js";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  isAnyAttestationBundle,
  type AnyAttestationBundle,
  type IdentityBundle,
  type Listing,
  type RevocationBinding,
} from "@kynesyslabs/dacs/artifacts";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import { readAnchor, readAnchorRecord } from "./chain.js";
import { gcrGetIdentities } from "./gcr.js";
import { listingPresentation } from "./listingMetadata.js";
import {
  hasValidListingRevocation,
  ownerClaim,
  publicKeyForClaim,
  verifyListing,
} from "./listingVerification.js";
import { verifyOwnerSignature } from "./registrationSig.js";
import { loadScanState } from "./store.js";
import type {
  CciBadge,
  DealRecord,
  ListingSummary,
  RawAnchorObservation,
  Registration,
  SellerRecord,
} from "./types.js";

const verify = (bytes: Uint8Array, signature: Uint8Array, key: Uint8Array): boolean =>
  ed25519Verify(bytes, signature, publicKeyFromRaw(key));

export type ResolveIdentities = (addressHex: string) => Promise<unknown>;

const anchorData = (anchor: RawAnchorObservation | undefined): Record<string, unknown> | null =>
  anchor?.readStatus === "read" && anchor.data ? anchor.data : null;

function resolveAnchor(
  ref: string,
  anchors: RawAnchorObservation[],
): RawAnchorObservation | undefined {
  if (/^stor-[0-9a-f]{40}$/.test(ref)) return anchors.find((anchor) => anchor.nativeAddress === ref);
  return anchors.find((anchor) => anchor.logicalAddress === ref);
}

function currentPricing(listing: Listing): ListingSummary["pricing"] {
  switch (listing.pricing.kind) {
    case "fixed":
      return { priceHint: listing.pricing.price.amount, currency: listing.pricing.price.currency };
    case "negotiable":
      return {
        priceHint: listing.pricing.bandCenter.amount,
        currency: listing.pricing.bandCenter.currency,
      };
    case "auction":
      return listing.pricing.reservePrice
        ? {
            priceHint: listing.pricing.reservePrice.amount,
            currency: listing.pricing.reservePrice.currency,
          }
        : {};
    case "metered":
      return {
        priceHint: listing.pricing.unitPrice.amount,
        currency: listing.pricing.unitPrice.currency,
      };
  }
}

function revocationBindings(
  listing: Listing,
  listingHash: string,
  anchors: RawAnchorObservation[],
): RevocationBinding[] {
  return anchors.flatMap((anchor) => {
    if (
      anchor.kind !== "listing-revocation" ||
      anchor.readStatus !== "read" ||
      !anchor.data ||
      !anchor.contentHash ||
      anchor.data.listingId !== listing.listingId ||
      anchor.data.listingVersion !== listing.listingVersion ||
      anchor.data.listingContentHash !== listingHash
    ) return [];
    return [{
      sellerPrimaryClaim: listing.seller.identity.presentedBy,
      listingId: listing.listingId,
      listingVersion: listing.listingVersion,
      listingContentHash: listingHash,
      logicalAddress: anchor.logicalAddress,
      markerAnchor: { kind: "storage-program", locator: anchor.nativeAddress },
      markerContentHash: anchor.contentHash,
    }];
  });
}

function summaryForCurrent(
  listing: Listing,
  hash: string,
  anchor: string,
  now: number,
  revocation?: RevocationBinding,
): ListingSummary {
  const phaseKinds = listing.pipeline.map((phase) => phase.kind);
  return {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: hash,
    anchor: { kind: "storage-program", locator: anchor },
    seller: {
      primaryClaim: listing.seller.identity.presentedBy,
      displayName: listing.seller.displayName,
    },
    offering: {
      title: listing.offering.title,
      description: listing.offering.description,
      category: listing.offering.category,
      tags: listing.offering.tags,
      rails: (listing.acceptedRails ?? []).map((rail) => rail.railId),
      delivery: phaseKinds.filter((kind) => kind.startsWith("deliver-")),
      negotiation: phaseKinds.filter((kind) => kind.startsWith("negotiate-")),
    },
    pricing: currentPricing(listing),
    status: revocation ? "revoked" : "active",
    ...(revocation ? { revocation } : {}),
    catalogObservedAt: now,
    validationProfile: "current",
  };
}

function categoryForBundle(
  bundle: AnyAttestationBundle,
  listings: ListingSummary[],
): string | undefined {
  return listings.find((listing) =>
    listing.listingId === bundle.listingRef.listingId &&
    listing.version === bundle.listingRef.version &&
    listing.contentHash === bundle.listingRef.contentHash)?.offering.category;
}

function cciBadgesFromRawGcr(resolved: unknown, claim: string): CciBadge[] {
  // Raw GCR claims are display-only until authenticated GCR provenance (#242)
  // lands. They never elevate identityTier.
  try {
    const response = (resolved as { response?: { web2?: Record<string, Array<{ username?: string; proof?: string }>> } })
      ?.response;
    const badges: CciBadge[] = [];
    for (const [platform, entries] of Object.entries(response?.web2 ?? {})) {
      for (const entry of entries ?? []) {
        if (typeof entry?.username !== "string") continue;
        badges.push({
          kind: "web2",
          platform,
          handle: entry.username,
          ref: `cci-web2:${platform}:${entry.username}`,
          ...(typeof entry.proof === "string" ? { proofUrl: entry.proof } : {}),
          ...(platform === "github" ? { linkUrl: `https://github.com/${entry.username}` } : {}),
        });
      }
    }
    return badges;
  } catch {
    void claim;
    return [];
  }
}

/**
 * Index one seller. Current artifacts use SDK validators; legacy artifacts are
 * retained behind an explicit compatibility label and cannot elevate identity.
 */
export async function indexRegistration(
  reg: Registration,
  prior?: SellerRecord,
  resolveIdentities: ResolveIdentities = gcrGetIdentities,
): Promise<SellerRecord> {
  const now = Date.now();
  const state = loadScanState();
  const anchors = Object.values(state.anchors ?? {});

  let cci: CciBadge[] = prior?.cci ?? [];
  try {
    const parsed = parseCanonicalClaimReference(reg.primaryClaim);
    const address = parsed?.identity.scheme === "did"
      ? /^demos:agent:([0-9a-f]{64})$/.exec(parsed.identity.identifier)?.[1]
      : undefined;
    if (address) cci = cciBadgesFromRawGcr(await resolveIdentities(address), reg.primaryClaim);
  } catch {
    // Preserve the prior display-only observation on a transient read failure.
  }

  const listings: ListingSummary[] = [];
  const identityBundles: IdentityBundle[] = [];
  for (const anchorRef of reg.listingAnchors) {
    const anchored = await readAnchorRecord(anchorRef);
    if (!anchored) continue;
    let authenticated = await verifyListing(anchored.data, { nowMs: now });
    if (!authenticated) continue;

    if (authenticated.profile === "current") {
      const bindings = revocationBindings(
        authenticated.listing,
        authenticated.contentHash,
        anchors,
      );
      if (bindings.length > 0) {
        authenticated = await verifyListing(anchored.data, {
          nowMs: now,
          revocations: bindings,
          readMarker: async (markerAnchor) => readAnchor(markerAnchor.locator),
        }) ?? authenticated;
      }
      if (authenticated.profile !== "current") continue;
      const sellerClaim = authenticated.listing.seller.identity.presentedBy;
      if (!sameCanonicalClaimIdentity(sellerClaim, reg.primaryClaim)) continue;
      if (!sameCanonicalClaimIdentity(ownerClaim(anchored.owner), sellerClaim)) continue;
      const declared = reg.listingContentHashes?.[anchorRef]?.replace(/^sha256-/, "").toLowerCase();
      if (declared && declared !== authenticated.contentHash) continue;
      identityBundles.push(authenticated.listing.seller.identity);
      listings.push(summaryForCurrent(
        authenticated.listing,
        authenticated.contentHash,
        anchorRef,
        now,
        authenticated.revocation,
      ));
      continue;
    }

    const listing = authenticated.listing;
    if (!sameCanonicalClaimIdentity(listing.agentId, reg.primaryClaim)) continue;
    if (!sameCanonicalClaimIdentity(ownerClaim(anchored.owner), reg.primaryClaim)) continue;
    const declared = reg.listingContentHashes?.[anchorRef]?.replace(/^sha256-/, "").toLowerCase();
    if (declared && declared !== authenticated.contentHash) continue;
    const version = listing.listingVersion ?? 1;
    const candidates = state.revocations?.[authenticated.contentHash];
    const revoked = await hasValidListingRevocation(
      Array.isArray(candidates) ? candidates : candidates ? [candidates] : [],
      authenticated,
      version,
      readAnchor,
    );
    const presentation = listingPresentation(authenticated.scope);
    listings.push({
      listingId: listing.serviceId,
      version,
      contentHash: authenticated.contentHash,
      anchor: { kind: "storage-program", locator: anchorRef },
      seller: { primaryClaim: reg.primaryClaim, displayName: reg.displayName },
      offering: {
        title: presentation.title,
        description: presentation.description,
        category: presentation.category,
        tags: presentation.tags,
        rails: presentation.rails,
        delivery: presentation.delivery,
        negotiation: presentation.negotiation,
      },
      pricing: {},
      status: revoked ? "revoked" : "active",
      catalogObservedAt: now,
      validationProfile: "legacy-mvp",
    });
  }

  const dealCandidates: DealRecord[] = [];
  const reputationBundles: AnyAttestationBundle[] = [];
  for (const deal of reg.deals ?? []) {
    const buyerRaw = await readAnchor(deal.buyerBundleRef);
    const sellerRaw = deal.sellerBundleRef ? await readAnchor(deal.sellerBundleRef) : null;
    const copies: BundleCopies = {
      buyer: buyerRaw ? { disposition: "present", bundle: buyerRaw } : { disposition: "absent" },
      seller: sellerRaw ? { disposition: "present", bundle: sellerRaw } : { disposition: "absent" },
    };
    const validity = new Map<"buyer" | "seller", boolean>();
    const validateCopy = async (bundle: Record<string, unknown>, role: "buyer" | "seller") => {
      const result = await verifyBundleCopy(bundle, role, {
        resolvePublicKey: async (claim) => publicKeyForClaim(claim),
        verify,
      });
      validity.set(role, result.valid);
      return result.valid;
    };
    const consistency = await bundleConsistency(copies, { isValid: validateCopy }).catch(() => "indeterminate" as const);
    const verification = buyerRaw
      ? await verifyBundleCore(deal.buyerBundleRef, {
          readArtifact: readAnchor,
          resolveAttestationRef: async (ref) => {
            const observation = resolveAnchor(ref.anchor.locator, anchors);
            return anchorData(observation) ?? readAnchor(ref.anchor.locator);
          },
          resolveListingRef: async (pin) => {
            const observation = anchors.find((anchor) =>
              anchor.kind === "listing" &&
              anchor.data?.listingId === pin.listingId &&
              anchor.data?.listingVersion === pin.version &&
              anchor.contentHash === pin.contentHash);
            return anchorData(observation);
          },
          resolvePublicKey: async (claim) => publicKeyForClaim(claim),
          verify,
        }).catch(() => null)
      : null;
    const bundle = buyerRaw && isAnyAttestationBundle(buyerRaw) ? buyerRaw : undefined;
    const partyMatches = !!bundle &&
      bundle.jobId === deal.jobId &&
      bundle.parties.some((party) => party.role === "buyer" && sameCanonicalClaimIdentity(party.primaryClaim, deal.owners.buyer)) &&
      bundle.parties.some((party) => party.role === "seller" && sameCanonicalClaimIdentity(party.primaryClaim, deal.owners.seller)) &&
      bundle.parties.some((party) => party.role === "seller" && sameCanonicalClaimIdentity(party.primaryClaim, reg.primaryClaim));
    const signatureVerified = validity.get("buyer") === true &&
      (sellerRaw ? validity.get("seller") === true : consistency === "oneSided");
    const refsVerified = !!verification?.ok && partyMatches &&
      consistency !== "divergent" && consistency !== "indeterminate";
    dealCandidates.push({
      ...deal,
      signatureVerified,
      refsVerified,
      outcome: bundle?.outcome,
      finalisedAt: bundle?.finalisedAt,
      category: bundle ? categoryForBundle(bundle, listings) : undefined,
      consistency,
      verifiedAt: now,
    });
    if (refsVerified && bundle) {
      reputationBundles.push(bundle);
      if (sellerRaw && isAnyAttestationBundle(sellerRaw)) reputationBundles.push(sellerRaw);
    }
  }

  const seenJobs = new Set<string>();
  const deals = dealCandidates.filter((deal) => {
    if (!deal.refsVerified) return true;
    if (seenJobs.has(deal.jobId)) return false;
    seenJobs.add(deal.jobId);
    return true;
  });
  const reputation = deriveReputation(
    reg.primaryClaim,
    reputationBundles,
    { windowStart: 0, windowEnd: now, computedAt: now },
    {
      trustBundles: true,
      copyAbsence: () => "absent",
    },
  );
  const listingsWithHint = listings.map((listing) => {
    const scopedBundles = reputationBundles.filter((bundle) =>
      categoryForBundle(bundle, listings) === listing.offering.category);
    const scoped = deriveReputation(
      reg.primaryClaim,
      scopedBundles,
      { windowStart: 0, windowEnd: now, computedAt: now },
      { trustBundles: true, copyAbsence: () => "absent" },
    );
    return {
      ...listing,
      reputationHint: {
        categoryScope: listing.offering.category,
        completionRate: scoped.metrics.completionRate,
        averageSellerRating: scoped.metrics.averageSellerRating,
        bundleCount: scoped.bundleCount,
        windowStart: scoped.windowStart,
        windowEnd: scoped.windowEnd,
        computedAt: scoped.computedAt,
      },
    };
  });

  const ownerRegistered = reg.ownerSignature
    ? await verifyOwnerSignature(reg, { ignoreFreshness: true }).catch(() => false)
    : false;
  const identityTier = identityBundles.length > 0
    ? identityBundles.reduce<"institutional" | "verified" | "self-declared">((tier, bundle) => {
        // Fail closed until VerifyResult provenance/freshness is independently authenticated.
        const derived = deriveIdentityTier(bundle, () => false);
        return tier === "institutional" || derived === "institutional"
          ? "institutional"
          : tier === "verified" || derived === "verified"
            ? "verified"
            : "self-declared";
      }, "self-declared")
    : "self-declared";

  return {
    primaryClaim: reg.primaryClaim,
    ownerRegistered,
    displayName: listingsWithHint[0]?.seller.displayName ?? reg.displayName,
    identityTier,
    cci,
    listings: listingsWithHint,
    deals,
    reputation: {
      // Count verified agreements, not bundle copies. A one-sided publication
      // is still one agreement and must never produce a fractional count.
      completed: deals.filter(
        (deal) => deal.refsVerified && deal.outcome === "completed",
      ).length,
      totalAgreements: reputation.bundleCount,
      completionRate: reputation.metrics.completionRate,
    },
    registeredAt: prior?.registeredAt ?? now,
    lastIndexedAt: now,
  };
}
