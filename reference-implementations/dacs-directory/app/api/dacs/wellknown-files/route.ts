/**
 * GET /api/dacs/wellknown-files?claim=<did>&domain=<your-domain>&a2aEndpoint=<https-url>&a2aTransport=<JSONRPC|GRPC|HTTP+JSON>
 * Generates the §6.3.5 discovery surface for an agent, ready to host:
 *   /.well-known/agent.json            (A2A v0.3.0 agent card + dacs block, hash-bound index ref)
 *   /.well-known/agent-card.json       (the identical card at the A2A v0.3.0 well-known path)
 *   /.well-known/dacs/listings.json    (per-listing anchors + content hashes)
 * §6.3.5 extends an A2A agent card, so the publisher's A2A service endpoint and transport are
 * required; they are the publisher's declaration and are not probed. Index entries carry the
 * catalog's verified content hashes. Each active offer's anchor is re-read and must still hold
 * that exact verified listing: an offer whose anchor is gone or changed is omitted and reported,
 * and a failed read refuses the export, so a partial index is never offered for signing.
 * Withdrawn versions are retained whatever their anchors read now (RB-3). Host the files
 * byte-exact with the publisher signature, then submit the domain to POST /api/dacs/register-domain.
 */
import { NextRequest, NextResponse } from "next/server";
import { sha256Hex } from "../../../../src/catalog/canonical.js";
import { parseCciRecord } from "@kynesyslabs/dacs/identity";
import { A2A_PROTOCOL_VERSION, a2aService } from "@/src/catalog/a2a";
import { readAnchorResult } from "@/src/catalog/chain";
import { gcrGetIdentities } from "@/src/catalog/gcr";
import { activeOffer } from "@/src/catalog/discovery";
import { verifyListing } from "@/src/catalog/listingVerification";
import { loadCatalog } from "@/src/catalog/store";
import type { ListingSummary } from "@/src/catalog/types";
import { MAX_INDEX_LISTINGS, normalizeSubmittedDomain, wellKnownWithdrawalMessage } from "@/src/catalog/wellknown";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const claim = q.get("claim")?.trim();
  const hex = claim?.match(/([0-9a-fA-F]{64})$/)?.[1];
  if (!claim || !hex) return NextResponse.json({ error: "need ?claim=" }, { status: 400 });
  // Validated exactly as POST /api/dacs/register-domain will validate it.
  const submitted = q.get("domain")?.trim();
  if (!submitted || submitted.length > 253) return NextResponse.json({ error: "need ?domain= (the HTTPS hostname that will host these files)" }, { status: 400 });
  let origin: string;
  try {
    origin = normalizeSubmittedDomain(submitted);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid domain" }, { status: 400 });
  }
  const service = a2aService(q.get("a2aEndpoint"), q.get("a2aTransport"));
  if (!service) {
    return NextResponse.json({ error: "provide your A2A service's HTTPS a2aEndpoint and its a2aTransport (JSONRPC, GRPC or HTTP+JSON)" }, { status: 400 });
  }

  const seller = loadCatalog().sellers.find((s) => s.primaryClaim === claim);
  if (!seller || seller.listings.length === 0) {
    return NextResponse.json(
      { error: "no indexed listings for that claim — publish/index first" },
      { status: 404 },
    );
  }

  // RB-3: a withdrawn version is retained whatever its anchor reads now. A withdrawal cached
  // before bindings were recorded has none; it stays `revoked`, which readers treat as indeterminate (RB-5).
  const published = seller.listings.filter((l) => l.status === "revoked" || activeOffer(l));
  if (published.length > MAX_INDEX_LISTINGS) {
    return NextResponse.json({ error: `a well-known index holds at most ${MAX_INDEX_LISTINGS} listings` }, { status: 422 });
  }
  const entries = [];
  const offers: ListingSummary[] = [];
  const omitted: Array<{ listingId: string; reason: "absent" | "invalid" | "changed" }> = [];
  for (const l of published) {
    if (l.status !== "revoked") {
      const read = await readAnchorResult(l.anchor.locator);
      if (read.status === "unavailable") {
        return NextResponse.json(
          { error: `the node read for listing ${l.listingId} failed; retry later. A signed index without this offer would withhold it.` },
          { status: 503 },
        );
      }
      const verified = read.status === "present" ? await verifyListing(read.record.data).catch(() => null) : null;
      if (verified?.contentHash !== l.contentHash) {
        omitted.push({ listingId: l.listingId, reason: read.status === "present" ? "changed" : read.status });
        continue;
      }
      offers.push(l);
    }
    entries.push({
      listingId: l.listingId,
      version: l.version,
      contentHash: l.contentHash,
      anchor: { kind: "storage-program", locator: l.anchor.locator },
      summary: {
        title: l.offering.title,
        category: l.offering.category,
        tags: l.offering.tags,
        ...(l.pricing.priceHint ? { priceHint: l.pricing.priceHint } : {}),
      },
      status: l.status,
      ...(l.status === "revoked" && l.revocation ? { revocation: l.revocation } : {}),
    });
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
      description: offers[0]?.offering.description ?? "",
      url: service.url,
      version: "1.0.0",
      protocolVersion: A2A_PROTOCOL_VERSION,
      preferredTransport: service.transport,
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json"],
      skills: offers.map((listing) => ({
        id: listing.listingId,
        name: listing.offering.title,
        description: listing.offering.description ?? "DACS service",
        tags: listing.offering.tags,
      })),
      dacs: {
        dacsVersion: "1",
        listings: {
          indexUrl: `${origin}/.well-known/dacs/listings.json`,
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
      "/.well-known/agent-card.json": agentJson,
      "/.well-known/dacs/listings.json": listingsJson,
    },
    omitted,
    withdrawalSigning: {
      algorithm: "ed25519", signer: claim,
      message: wellKnownWithdrawalMessage(origin, sha256Hex(listingsJson)),
      signatureField: "dacs.listings.publisherSignature",
      encoding: "base64url",
    },
    note: "Host these files byte-exact with the publisher signature (the indexHash binds listings.json), then submit the domain to POST /api/dacs/register-domain.",
  });
}
