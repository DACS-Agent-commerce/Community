/**
 * GET /api/dacs/wellknown-files?claim=<did>&domain=<your-domain>
 * Generates the §6.3.5 discovery surface for an agent, ready to host:
 *   /.well-known/agent.json            (dacs block, hash-bound index ref)
 *   /.well-known/dacs/listings.json    (per-listing anchors + content hashes)
 * All hashes computed from CHAIN STATE, so the files are correct-by-
 * construction — host them byte-exact, then register the domain here.
 * Answers 503 instead of a partial index when an indexed anchor cannot be read.
 * Each anchor read receives the request signal, so a client disconnect aborts
 * the in-flight read and stops the loop. The whole loop is also capped at
 * WELLKNOWN_INDEX_DEADLINE_MS (30 s); reaching the cap returns 503 with an
 * incomplete-index reason rather than a partial 200. The per-read 15 s
 * timeout in chain.ts is unchanged.
 */
import { NextRequest, NextResponse } from "next/server";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";
import { parseCciRecord } from "@kynesyslabs/dacs/identity";
import { readAnchorResult } from "@/src/catalog/chain";
import { storedListingHash } from "@/src/catalog/listingVerification";
import { gcrGetIdentities } from "@/src/catalog/gcr";
import { discoveryListing } from "@/src/catalog/discovery";
import { loadStoredCatalog } from "@/src/catalog/store";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const claim = q.get("claim")?.trim();
  const domain = (q.get("domain")?.trim() || "YOUR-DOMAIN.example")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const hex = claim?.match(/([0-9a-fA-F]{64})$/)?.[1];
  if (!claim || !hex) return NextResponse.json({ error: "need ?claim=" }, { status: 400 });

  const seller = loadStoredCatalog().sellers.find((s) => s.primaryClaim === claim);
  if (!seller) {
    return NextResponse.json(
      { error: "no indexed listings for that claim — publish/index first" },
      { status: 404 },
    );
  }

  const WELLKNOWN_INDEX_DEADLINE_MS = 30_000;
  const deadline = Date.now() + WELLKNOWN_INDEX_DEADLINE_MS;
  const entries = [];
  // The public catalog intentionally strips held versions. Read stored evidence here,
  // but publish only the existing discovery summaries, never the held records.
  const listings = seller.listings.filter(discoveryListing);
  const visibleAnchors = new Set(listings.map((l) => l.anchor.locator));
  const anchors = [
    ...listings.map((l) => ({ locator: l.anchor.locator, listingId: l.listingId, listing: l })),
    ...[...new Map((seller.heldListingVersions ?? [])
      .filter((held) => !visibleAnchors.has(held.locator))
      .map((held) => [held.locator, held])).values()]
      .map((held) => ({ locator: held.locator, listingId: held.listingId, listing: undefined })),
  ];
  for (const candidate of anchors) {
    if (req.signal.aborted || Date.now() >= deadline) {
      return NextResponse.json(
        { error: "listing index incomplete: the request was aborted or the 30 s total deadline was reached" },
        { status: 503 },
      );
    }
    const read = await readAnchorResult(candidate.locator, req.signal);
    if (req.signal.aborted || Date.now() >= deadline) {
      return NextResponse.json(
        { error: "listing index incomplete: the request was aborted or the 30 s total deadline was reached" },
        { status: 503 },
      );
    }
    // An indexed anchor the node cannot answer for, or reports missing, is indeterminate (RB-6):
    // an index without it would look complete.
    if (read.status === "unavailable" || read.status === "absent") {
      const reason = read.status === "unavailable" ? read.reason : "the node reports no storage program at the anchor";
      return NextResponse.json(
        { error: `listing anchor unavailable for ${candidate.listingId}: the index would be incomplete`, reason },
        { status: 503 },
      );
    }
    // A readable hold can reflect rejected content or declarations, rather than
    // an indeterminate read. It stays unadvertised until the indexer admits it.
    const l = candidate.listing;
    if (!l) continue;
    // Stored programs are mutable; one whose content is not an object has no canonical form either.
    if (read.status === "invalid") continue;
    const raw = read.record.data;
    let listingContentHash: string;
    // Stored programs are mutable; one with no canonical form must not fail the whole index.
    try { listingContentHash = storedListingHash(raw, l.contentHash); } catch { continue; }
    entries.push({
      listingId: l.listingId,
      version: l.version,
      contentHash: listingContentHash,
      anchor: { kind: "storage-program", locator: l.anchor.locator },
      summary: {
        title: l.offering.title,
        category: l.offering.category,
        tags: l.offering.tags,
        ...(l.pricing.priceHint ? { priceHint: l.pricing.priceHint } : {}),
      },
      status: l.status,
      ...(l.revocation ? { revocation: l.revocation } : {}),
    });
  }

  // Check held anchors before calling an all-held seller an empty catalog.
  if (seller.listings.length === 0) {
    return NextResponse.json(
      { error: "no indexed listings for that claim — publish/index first" },
      { status: 404 },
    );
  }

  const listingsJson = JSON.stringify(
    { indexVersion: "1", generatedAt: Date.now(), seller: claim, listings: entries },
    null,
    2,
  );

  let identityClaims: string[] = [claim];
  try {
    const record = parseCciRecord(claim, await gcrGetIdentities(hex));
    identityClaims = [claim, ...record.claims.map((c) => c.ref)];
  } catch {
    /* best effort */
  }

  const agentJson = JSON.stringify(
    {
      name: seller.displayName,
      description: seller.listings[0]?.offering.description ?? "",
      url: `https://${domain}`,
      version: "1.0.0",
      protocolVersion: "0.3.0",
      preferredTransport: "HTTP+JSON",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json"],
      skills: seller.listings.filter((listing) => listing.status === "active").map((listing) => ({
        id: listing.listingId,
        name: listing.offering.title,
        description: listing.offering.description ?? "DACS service",
        tags: listing.offering.tags,
      })),
      dacs: {
        dacsVersion: "1",
        listings: {
          indexUrl: `https://${domain}/.well-known/dacs/listings.json`,
          indexHash: `sha256-${sha256Hex(listingsJson)}`,
        },
        identityClaims,
      },
    },
    null,
    2,
  );

  return NextResponse.json({
    files: {
      "/.well-known/agent.json": agentJson,
      "/.well-known/dacs/listings.json": listingsJson,
    },
    note: "Host both files byte-exact (the indexHash binds listings.json), then register the domain on this page.",
  });
}
