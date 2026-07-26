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
import { deriveAnchorAddress, readAnchor } from "@/src/catalog/chain";
import { findProgramAddress } from "@/src/catalog/store";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  let ref = q.get("ref");
  const owner = q.get("owner");
  const name = q.get("name");
  if (!ref && owner && name) {
    ref = findProgramAddress(owner, name) ?? deriveAnchorAddress(owner, name);
  }
  if (!ref) return NextResponse.json({ error: "need ?ref= or ?owner=&name=" }, { status: 400 });
  const value = await readAnchor(ref);
  return NextResponse.json({ ref, value });
}
