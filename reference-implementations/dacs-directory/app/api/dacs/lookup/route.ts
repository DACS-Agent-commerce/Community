/**
 * GET /api/dacs/lookup?claim=<did>
 * Everything the catalog can already tell a registrant about their agent:
 * listings the scanner has seen (or derivable), on-chain identity proofs,
 * known deals. Registration becomes "confirm what we found", not data entry.
 */
import { NextRequest, NextResponse } from "next/server";
import { parseCciRecord } from "@kynesyslabs/dacs/identity";
import { readAnchorRecord } from "@/src/catalog/chain";
import { gcrGetIdentities } from "@/src/catalog/gcr";
import { listingTitle, ownerClaim, verifyStoredListing } from "@/src/catalog/listingVerification";
import { loadScanState } from "@/src/catalog/store";

export async function GET(req: NextRequest) {
  const claim = req.nextUrl.searchParams.get("claim")?.trim();
  const hex = claim?.match(/([0-9a-fA-F]{64})$/)?.[1];
  if (!claim || !hex) return NextResponse.json({ error: "need ?claim=<did or 0x-address>" }, { status: 400 });
  const did = `did:demos:agent:${hex.toLowerCase()}`;
  const owner = `0x${hex}`;

  const state = loadScanState();

  // Listings the scanner has already attributed to this owner — titles from chain.
  const listings: Array<{ address: string; title: string }> = [];
  for (const [address, o] of Object.entries(state.listings)) {
    if (o.toLowerCase() !== owner.toLowerCase()) continue;
    const anchored = await readAnchorRecord(address);
    const verified = anchored ? await verifyStoredListing(anchored.data, address) : null;
    // The scanned pointer is a hint: the anchor's owner and the Listing's own seller must both be this claim.
    if (verified && verified.sellerClaim === did && ownerClaim(anchored?.owner) === did) {
      listings.push({ address, title: listingTitle(verified) });
    }
  }

  const dealCount = Object.values(state.deals).filter(
    (d) => d.owners.seller === did,
  ).length;

  // Live CCI proofs (best effort).
  let proofs: Array<{ platform: string; handle: string }> = [];
  try {
    const record = parseCciRecord(did, await gcrGetIdentities(hex));
    proofs = record.web2.map((c) => ({ platform: c.platform, handle: c.handle }));
  } catch { /* identity service hiccup — registration still works */ }

  return NextResponse.json({ did, listings, dealCount, proofs });
}
