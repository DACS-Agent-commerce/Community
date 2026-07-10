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
import { parseCciRecord } from "@kynesyslabs/dacs/identity";
// verifyBundleCore has no pure subpath export (dacs-sdk#14) — vendor path.
import { verifyBundleCore } from "../../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
// The SDK doesn't export sessionAnchorName from its public barrel
// (dacs-sdk#14) — reach into the vendored build.
import { sessionAnchorName } from "../../vendor/dacs-sdk/dist/agent/runSessionCore.js";
import { deriveAnchorAddress, readAnchor, readAnchorRecord } from "./chain.js";
import { gcrGetIdentities } from "./gcr.js";
import { ownerClaim, verifyListing, verifyListingRevocation } from "./listingVerification.js";
import { verifyOwnerSignature } from "./registrationSig.js";
import { findProgramAddress, loadScanState } from "./store.js";
import {
  bundleCategory,
  hasRequiredBundleSignatures,
  refsPassStrictPolicy,
  type ResolvedArtifact,
} from "./bundlePolicy.js";

import type {
  CciBadge,
  DealRecord,
  IdentityTier,
  ListingSummary,
  Registration,
  SellerRecord,
} from "./types.js";

/** §6.3.2 tier-1 (authority-issued regulatory) schemes → "institutional". */
const TIER1_SCHEMES = new Set(["lei", "finra-crd", "sam-uei", "fedramp", "cmmc", "naics"]);

/**
 * §6.3.2.1 identity-tier derivation, catalog flavour: a CCI claim read from
 * the on-chain GCR counts as verified (the GCR validated it at write time).
 * Strict conformance keys on fresh DACS-2 verifiedBy results — dacs-sdk#9.
 */
const deriveIdentityTier = (cci: CciBadge[]): IdentityTier =>
  cci.some((b) => TIER1_SCHEMES.has(b.platform)) ? "institutional"
  : cci.length > 0 ? "verified"
  : "self-declared";

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
  const revocations = loadScanState().revocations ?? {};
  for (const anchor of reg.listingAnchors) {
    const anchored = await readAnchorRecord(anchor);
    if (!anchored) continue;
    const verified = await verifyListing(anchored.data);
    if (!verified) continue;
    const { listing, scope } = verified;
    if (listing.agentId !== reg.primaryClaim) continue;
    if (ownerClaim(anchored.owner) !== reg.primaryClaim.toLowerCase()) continue;
    const declaredHash = reg.listingContentHashes?.[anchor]?.replace(/^sha256-/, "").toLowerCase();
    if (declaredHash && declaredHash !== verified.contentHash) continue;
    const listingId = typeof scope.listingId === "string" ? scope.listingId : listing.serviceId;
    const rawVersion = scope.listingVersion ?? scope.version ?? 1;
    const version = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion > 0
      ? rawVersion
      : 1;
    const validity = scope.validity as { notAfter?: unknown } | undefined;
    if (typeof validity?.notAfter === "number" && validity.notAfter < now) continue;
    const revocationAddress = revocations[verified.contentHash];
    const revocation = revocationAddress ? await readAnchor(revocationAddress) : null;
    const revoked = revocation
      ? await verifyListingRevocation(revocation, verified, version)
      : false;
    listings.push({
      listingId,
      version,
      contentHash: verified.contentHash,
      anchor: { kind: "storage-program", locator: anchor },
      seller: { primaryClaim: reg.primaryClaim, displayName: reg.displayName },
      offering: {
        title: listing.name,
        // Strip the [github:<login>] claim-tag (the interim identity carrier
        // until IdentityBundle lands — dacs-sdk#9); the badge shows the claim.
        description: listing.description.replace(/\s*\[github:[^\]]+\]\s*/g, " ").trim(),
        category: ((scope as { category?: string }).category) ?? "services.other",
        tags: ((scope as { tags?: string[] }).tags) ?? [],
        rails: listing.supportedPaymentRails,
        delivery: listing.supportedDelivery,
        negotiation:
          ((scope as { supportedNegotiation?: string[] }).supportedNegotiation) ?? [],
      },
      pricing: {},
      status: revoked ? "revoked" : "active",
      catalogObservedAt: now,
    });
  }

  // ── Deals: dereference + verify each bundle from chain ────────────────────
  const deals: DealRecord[] = [];
  const categoriesByListing = new Map(listings.map((l) => [l.listingId, l.offering.category]));
  for (const deal of reg.deals ?? []) {
    const resolvedArtifacts: ResolvedArtifact[] = [];
    const verification = await verifyBundleCore(deal.buyerBundleRef, {
      readArtifact: async (r) => {
        const raw = await readAnchor(r);
        if (raw && r !== deal.buyerBundleRef) resolvedArtifacts.push({ kind: "dacs-1-listing", raw });
        return raw;
      },
      resolveRef: async (kind, jobId) => {
        const name =
          kind === "dacs-3-agreement"
            ? sessionAnchorName.agreement(jobId)
            : kind === "dacs-4-evidence"
              ? sessionAnchorName.evidence(jobId)
              : kind === "dacs-2-verifyresult"
                ? sessionAnchorName.vet(jobId)
                : null;
        if (!name) return null;
        const address = findProgramAddress(deal.owners.buyer, name) ??
          deriveAnchorAddress(deal.owners.buyer, name); // legacy nonce-0 SDK fallback
        const raw = await readAnchor(address);
        if (raw) resolvedArtifacts.push({ kind, raw });
        return raw;
      },
      resolvePublicKey: async (did) => keyFromDid(did),
      verify,
    }).catch(() => null);

    const bundle = verification?.bundle;
    const bundleSignaturesVerified = verification ? hasRequiredBundleSignatures(verification) : false;
    const strictRefsVerified = verification && bundleSignaturesVerified
      ? await refsPassStrictPolicy(verification, resolvedArtifacts)
      : false;
    deals.push({
      ...deal,
      signatureVerified: bundleSignaturesVerified,
      refsVerified: strictRefsVerified,
      outcome: bundle?.outcome,
      finalisedAt: bundle?.finalisedAt,
      category: bundleCategory(bundle, categoriesByListing),
      verifiedAt: now,
    });
  }

  // ── Reputation: derived ONLY from verified bundles ────────────────────────
  const counted = deals.filter((d) => d.refsVerified);
  const completed = counted.filter((d) => d.outcome === "completed").length;
  const windowStart = 0;
  const windowEnd = now;
  const listingsWithHint = listings.map((l) => ({
    ...l,
    reputationHint: (() => {
      const categoryDeals = counted.filter(
        (d) => d.category === l.offering.category || d.category?.startsWith(l.offering.category + "."),
      );
      const categoryCompleted = categoryDeals.filter((d) => d.outcome === "completed").length;
      return {
        categoryScope: l.offering.category,
        completionRate: categoryDeals.length ? categoryCompleted / categoryDeals.length : null,
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

  return {
    primaryClaim: reg.primaryClaim,
    ownerRegistered,
    displayName: reg.displayName,
    identityTier: deriveIdentityTier(cci),
    cci,
    listings: listingsWithHint,
    deals,
    reputation: {
      completed,
      totalAgreements: counted.length,
      completionRate: counted.length ? completed / counted.length : null,
    },
    registeredAt: prior?.registeredAt ?? now,
    lastIndexedAt: now,
  };
}
