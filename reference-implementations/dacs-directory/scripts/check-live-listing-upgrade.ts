/**
 * Read-only deployment acceptance for replacing the three malformed live x402
 * Listings. This never writes, reindexes, purchases, or invokes an agent.
 *
 * Required:
 *   NEXT_PUBLIC_DIRECTORY_URL=https://...
 *   NEXT_PUBLIC_BUTLER_ORIGIN=https://...
 *   DACS_LISTING_UPGRADE_REPLACEMENTS='[{"listingId":"...","replacementLocator":"stor-...","replacementVersion":4,"gatewayProfileId":"...","supportedPayloadMethods":["self-signed"]}, ...]'
 */
import invalidLiveListings from "../test/fixtures/live-invalid-verification-methods.json";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { validateListingArtifact } from "../src/sdkListingValidation.js";
import { verifyListingResult } from "../src/catalog/listingVerification.js";
import { PUBLISHER_IN_CODE_RAIL_DEFINITIONS } from "../src/catalog/listingOptions.js";

type Replacement = {
  listingId: string;
  replacementLocator: string;
  replacementVersion: number;
  gatewayProfileId: string;
  supportedPayloadMethods: string[];
};

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");

function httpsOrigin(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is required`);
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  return url.origin;
}

function replacements(): Replacement[] {
  const raw = process.env.DACS_LISTING_UPGRADE_REPLACEMENTS;
  if (!raw) throw new Error("DACS_LISTING_UPGRADE_REPLACEMENTS is required");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== invalidLiveListings.length) {
    throw new Error(`replacement manifest must contain exactly ${invalidLiveListings.length} entries`);
  }
  for (const item of parsed) {
    if (
      !item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.listingId !== "string" ||
      typeof item.replacementLocator !== "string" || !/^stor-[0-9a-f]{40}$/.test(item.replacementLocator) ||
      !Number.isSafeInteger(item.replacementVersion) || Number(item.replacementVersion) < 1 ||
      typeof item.gatewayProfileId !== "string" || !item.gatewayProfileId ||
      !Array.isArray(item.supportedPayloadMethods) || !item.supportedPayloadMethods.every((kind: unknown) => typeof kind === "string")
    ) throw new Error("replacement manifest contains an invalid entry");
  }
  const typed = parsed as Replacement[];
  for (const old of invalidLiveListings) {
    const replacement = typed.find((candidate) => candidate.listingId === old.listingId);
    if (!replacement) {
      throw new Error(`replacement manifest is missing ${old.listingId}`);
    }
    if (replacement.replacementVersion <= old.listingVersion) {
      throw new Error(`${old.listingId} replacement version must be newer than v${old.listingVersion}`);
    }
  }
  return typed;
}

async function json(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.json() as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${url} returned a non-object`);
  return body as Record<string, unknown>;
}

async function anchor(locator: string): Promise<Record<string, unknown>> {
  const body = await json(`${RPC}/storage-program/${locator}`);
  if (body.success !== true || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    throw new Error(`${locator} is not a public Listing anchor`);
  }
  return body.data as Record<string, unknown>;
}

const same = (left: unknown, right: unknown): boolean => {
  try { return canonicalize(left) === canonicalize(right); } catch { return false; }
};

async function main() {
  const directory = httpsOrigin("NEXT_PUBLIC_DIRECTORY_URL");
  const gateway = httpsOrigin("NEXT_PUBLIC_BUTLER_ORIGIN");
  const manifest = replacements();
  const gatewayCatalog = await json(`${gateway}/demo/butler/agents`);
  const gatewayProfiles = Array.isArray(gatewayCatalog.procurementProfiles)
    ? gatewayCatalog.procurementProfiles
    : [];

  for (const old of invalidLiveListings) {
    const raw = await anchor(old.locator);
    const result = await verifyListingResult(raw);
    if (result.ok || result.code !== "VERIFICATION_METHOD_INVALID") {
      throw new Error(`${old.listingId}@${old.listingVersion} did not fail as VERIFICATION_METHOD_INVALID`);
    }
    const diagnostics = await json(`${directory}/api/dacs/status?locator=${encodeURIComponent(old.locator)}&deadLetterLimit=10`);
    const indexer = diagnostics.indexer as Record<string, unknown> | undefined;
    const listingDiagnostics = indexer?.listingRejectionDiagnostics as Record<string, unknown> | undefined;
    const items = Array.isArray(listingDiagnostics?.items) ? listingDiagnostics.items : [];
    if (!items.some((item) => item && typeof item === "object" && !Array.isArray(item) &&
      item.code === "VERIFICATION_METHOD_INVALID" && item.listingId === old.listingId && item.listingVersion === old.listingVersion)) {
      throw new Error(`${old.listingId} is missing its expected public rejection diagnostic`);
    }

    const replacement = manifest.find((candidate) => candidate.listingId === old.listingId)!;
    const replacementRaw = await anchor(replacement.replacementLocator);
    const authenticated = await verifyListingResult(replacementRaw);
    if (!authenticated.ok || authenticated.value.profile !== "dacs-v0.1") {
      throw new Error(`${replacement.listingId}@${replacement.replacementVersion} failed catalog authentication`);
    }
    const listing = authenticated.value.listing;
    const oldSeller = (raw.seller as Record<string, unknown> | undefined)?.identity as Record<string, unknown> | undefined;
    if (
      listing.listingId !== replacement.listingId ||
      listing.listingVersion !== replacement.replacementVersion ||
      listing.seller.identity.presentedBy !== oldSeller?.presentedBy
    ) {
      throw new Error(`${replacement.listingId} replacement tuple does not match its manifest and prior seller`);
    }

    const catalog = await json(`${directory}/api/dacs/listings?primaryClaim=${encodeURIComponent(authenticated.value.sellerClaim)}&limit=100`);
    const summaries = Array.isArray(catalog.listings) ? catalog.listings : [];
    const summary = summaries.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      candidate.listingId === replacement.listingId && candidate.version === replacement.replacementVersion) as Record<string, unknown> | undefined;
    if (
      !summary ||
      (summary.anchor as Record<string, unknown> | undefined)?.locator !== replacement.replacementLocator ||
      summary.contentHash !== authenticated.value.contentHash ||
      (summary.transactionReadiness as Record<string, unknown> | undefined)?.disposition !== "unassessed"
    ) throw new Error(`${replacement.listingId} replacement is not exposed by the reindexed catalog`);

    const validation = await validateListingArtifact(replacementRaw, {
      nowMs: () => Date.now(),
      verifyListingSignature: ({ signature }) =>
        same(signature, listing.signature),
      revocation: {
        surfaces: [{
          kind: "catalog",
          status: "active",
          catalogObservedAt: Number(summary.catalogObservedAt),
        }],
        readMarker: async (marker) => anchor(marker.locator),
        verifyMarkerSignature: () => false,
      },
      verifyIdentityPresentation: ({ bundle }) =>
        same(bundle, listing.seller.identity),
      loadRailResolution: () => ({
        trustPhase: "PA-1",
        trustPolicyAcceptsPA1: true,
        registry: { state: "not-used", entries: [], definitions: [] },
        inCodeDefinitions: PUBLISHER_IN_CODE_RAIL_DEFINITIONS,
      }),
      resolvePayloadVerificationCapability: ({ verificationMethod }) =>
        replacement.supportedPayloadMethods.includes(verificationMethod.kind)
          ? { disposition: "supported", reason: "deployment acceptance verifier is configured for this method" }
          : { disposition: "unsupported", reason: "method is not configured in this independent verifier" },
      verifySellerControl: ({ bundle, signer }) =>
        signer === bundle.presentedBy && signer === authenticated.value.signer,
    });
    if (validation.disposition !== "verified") {
      throw new Error(`${replacement.listingId} complete SDK reader returned ${validation.disposition} (${validation.reason})`);
    }

    const gatewayProfile = gatewayProfiles.find((profile) => profile && typeof profile === "object" && !Array.isArray(profile) &&
      profile.id === replacement.gatewayProfileId) as Record<string, unknown> | undefined;
    if (!gatewayProfile || gatewayProfile.executable !== true) {
      throw new Error(`${replacement.listingId} gateway profile ${replacement.gatewayProfileId} is not executable`);
    }
    process.stdout.write(`ok ${old.listingId}@${old.listingVersion} rejected -> v${replacement.replacementVersion} SDK-verified and discoverable\n`);
  }

  const tryPage = await fetch(`${directory}/try`, { signal: AbortSignal.timeout(15_000) });
  if (!tryPage.ok) throw new Error(`/try returned HTTP ${tryPage.status}`);
  process.stdout.write("ok /try resolves and every replacement maps to an executable gateway profile\n");
}

main().catch((error) => {
  process.stderr.write(`[listing upgrade acceptance] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
