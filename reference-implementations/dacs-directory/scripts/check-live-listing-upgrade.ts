/**
 * Read-only deployment acceptance for replacing the three malformed live x402
 * Listings. This never writes, reindexes, purchases, or invokes an agent.
 *
 * Required:
 *   NEXT_PUBLIC_DIRECTORY_URL=https://...
 *   DACS_LISTING_UPGRADE_REPLACEMENTS='[{"sourceListingId":"...","replacementListingId":"...","replacementLocator":"stor-...","replacementVersion":1,"supportedPayloadMethods":["self-signed"]}, ...]'
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import invalidLiveListings from "../test/fixtures/live-invalid-verification-methods.json";
import { validateListingArtifact } from "../src/sdkListingValidation.js";
import { verifyListingResult } from "../src/catalog/listingVerification.js";
import { listingUpgradeReaderDeps, listingUpgradeRefusal } from "../src/catalog/listingUpgradeAcceptance.js";

import { parseListingUpgradeManifest } from "../src/catalog/listingUpgradeManifest.js";

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

export async function checkListingUpgrades(write = (message: string) => { process.stdout.write(message); }) {
  const directory = httpsOrigin("NEXT_PUBLIC_DIRECTORY_URL");
  const manifest = parseListingUpgradeManifest(JSON.parse(process.env.DACS_LISTING_UPGRADE_REPLACEMENTS ?? "null"));

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
      item.code === "VERIFICATION_METHOD_INVALID" && item.locator === old.locator)) {
      throw new Error(`${old.listingId} is missing its expected public rejection diagnostic`);
    }

    const replacement = manifest.find((candidate) => candidate.sourceListingId === old.listingId)!;
    const replacementRaw = await anchor(replacement.replacementLocator);
    const authenticated = await verifyListingResult(replacementRaw);
    if (!authenticated.ok || authenticated.value.profile !== "dacs-v0.1") {
      throw new Error(`${replacement.replacementListingId}@${replacement.replacementVersion} failed catalog authentication`);
    }
    const listing = authenticated.value.listing;
    const oldSeller = (raw.seller as Record<string, unknown> | undefined)?.identity as Record<string, unknown> | undefined;
    if (
      listing.listingId !== replacement.replacementListingId ||
      listing.listingVersion !== replacement.replacementVersion ||
      listing.seller.identity.presentedBy !== oldSeller?.presentedBy
    ) {
      throw new Error(`${replacement.replacementListingId} replacement tuple does not match its manifest and prior seller`);
    }

    const catalog = await json(`${directory}/api/dacs/listings?primaryClaim=${encodeURIComponent(authenticated.value.sellerClaim)}&limit=100`);
    const summaries = Array.isArray(catalog.listings) ? catalog.listings : [];
    const summary = summaries.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      candidate.listingId === replacement.replacementListingId && candidate.version === replacement.replacementVersion) as Record<string, unknown> | undefined;
    if (
      !summary ||
      (summary.anchor as Record<string, unknown> | undefined)?.locator !== replacement.replacementLocator ||
      summary.contentHash !== authenticated.value.contentHash ||
      (summary.transactionReadiness as Record<string, unknown> | undefined)?.disposition !== "unassessed"
    ) throw new Error(`${replacement.replacementListingId} replacement is not exposed by the reindexed catalog`);

    const validation = await validateListingArtifact(replacementRaw, listingUpgradeReaderDeps({
      catalog: { status: summary.status, catalogObservedAt: summary.catalogObservedAt, revocation: summary.revocation },
      readMarker: async (marker) => anchor(marker.locator),
      supportedPayloadMethods: replacement.supportedPayloadMethods,
      signer: authenticated.value.signer,
    }));
    const refusal = listingUpgradeRefusal(validation);
    if (refusal && !(validation.disposition === "indeterminate" && validation.reason === "pa1-definition-unverifiable")) {
      throw new Error(`${replacement.replacementListingId} ${refusal}`);
    }
    if (refusal) write(`reader remains unassessed: ${refusal}\n`);

    write(`ok ${old.listingId}@${old.listingVersion} rejected -> ${replacement.replacementListingId}@${replacement.replacementVersion} authenticated and discoverable\n`);
  }
  write("ok every replacement is catalogued; buyer readiness is reported separately\n");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) checkListingUpgrades().catch((error) => {
  process.stderr.write(`[listing upgrade acceptance] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
