/**
 * GET /api/dacs/lookup?claim=<did>
 * Everything the catalog can already tell a registrant about their agent:
 * listings the scanner has seen (or derivable), on-chain identity proofs,
 * known deals. Registration becomes "confirm what we found", not data entry.
 */
import { NextRequest, NextResponse } from "next/server";
import { isListing } from "@kynesyslabs/dacs/artifacts";
import { stripSignature } from "@kynesyslabs/dacs/canonical";
import { parseCciRecord } from "@kynesyslabs/dacs/identity";
import { readAnchor } from "@/src/catalog/chain";
import { gcrGetIdentities } from "@/src/catalog/gcr";
import { loadScanState } from "@/src/catalog/store";

export async function GET(req: NextRequest) {
  const claim = req.nextUrl.searchParams.get("claim")?.trim();
  const hex = claim?.match(/([0-9a-fA-F]{64})$/)?.[1];
  if (!claim || !hex) return NextResponse.json({ error: "need ?claim=<did or 0x-address>" }, { status: 400 });
  const did = `did:demos:agent:${hex}`;
  const owner = `0x${hex}`;

  const state = loadScanState();

  // Listings the scanner has already attributed to this owner — titles from chain.
  const listings: Array<{ address: string; title: string }> = [];
  for (const [address, o] of Object.entries(state.listings)) {
    if (o.toLowerCase() !== owner.toLowerCase()) continue;
    const raw = await readAnchor(address);
    const scope = raw ? stripSignature(raw) : null;
    if (scope && isListing(scope)) {
      listings.push({ address, title: (scope as { name?: string }).name ?? address });
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
