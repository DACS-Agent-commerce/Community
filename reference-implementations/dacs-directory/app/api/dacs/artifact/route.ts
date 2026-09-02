/**
 * GET /api/dacs/artifact?ref=<address>        — read a raw anchored artifact
 * GET /api/dacs/artifact?owner=<claim>&name=… — read via owner-scoped derivation
 *
 * TRUST MODEL: this proxy fetches bytes because browsers cannot reach the node
 * cross-origin. Browser cryptography validates internal signatures and hashes,
 * but without a chain inclusion proof the proxy/RPC remains trusted for the
 * claim that those exact bytes occupy the requested native address.
 */
import { NextRequest, NextResponse } from "next/server";
import { deriveAnchorAddress, readAnchorRecord } from "@/src/catalog/chain";
import { canonicalProgramOwner, findProgramAddress } from "@/src/catalog/store";
import { rateLimit } from "@/src/catalog/security";

export async function GET(req: NextRequest) {
  const blocked = rateLimit(req, "artifact", 120, 60_000);
  if (blocked) return blocked;
  const q = req.nextUrl.searchParams;
  let ref = q.get("ref");
  const owner = q.get("owner");
  const name = q.get("name");
  if (!ref && owner && name) {
    ref = findProgramAddress(owner, name) ?? deriveAnchorAddress(owner, name);
  }
  if (!ref) return NextResponse.json({ error: "need ?ref= or ?owner=&name=" }, { status: 400 });
  const record = await readAnchorRecord(ref);
  if (record && owner && canonicalProgramOwner(record.owner ?? "") !== canonicalProgramOwner(owner)) {
    return NextResponse.json({ error: "artifact owner does not match the requested party", ref, value: null }, { status: 409 });
  }
  return NextResponse.json({ ref, value: record?.data ?? null });
}
