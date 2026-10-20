/**
 * POST /api/dacs/index-now { claim } — index one registration immediately
 * (fresh publishes shouldn't wait for the next timer pass). Full chain
 * verification, same as the batch path, with the same DACS_AUTHORITY_VERIFIER:
 * one that cannot load is 503, and a catalog whose identity tiers were derived
 * with another verifier is 409 until a full reindex. Nothing is saved then.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthorityVerifierUnavailable,
  immediateTierVerifierMismatch,
  loadAuthorityVerifier,
  type AuthorityVerifierConfig,
} from "@/src/catalog/authorityVerifierConfig";
import { indexRegistration } from "@/src/catalog/indexer";
import { requireAdmin } from "@/src/catalog/security";
import { loadCatalog, loadRegistrations, saveCatalog, withDataLock } from "@/src/catalog/store";

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { claim?: string } | null;
  const claim = body?.claim?.trim();
  if (!claim) return NextResponse.json({ error: "need { claim }" }, { status: 400 });
  const reg = loadRegistrations().find((r) => r.primaryClaim === claim);
  if (!reg) return NextResponse.json({ error: "no registration for that claim" }, { status: 404 });
  let authority: AuthorityVerifierConfig;
  try {
    authority = await loadAuthorityVerifier();
  } catch (error) {
    if (!(error instanceof AuthorityVerifierUnavailable)) throw error;
    return NextResponse.json({ error: error.message }, { status: 503 });
  }

  return withDataLock("reindex", async () => {
    const catalog = loadCatalog();
    const mismatch = immediateTierVerifierMismatch(catalog, authority);
    if (mismatch) return NextResponse.json({ error: mismatch }, { status: 409 });
    const prior = catalog.sellers.find((s) => s.primaryClaim === claim);
    const record = await indexRegistration(reg, prior, undefined, undefined, undefined, undefined, authority.verify);
    const i = catalog.sellers.findIndex((s) => s.primaryClaim === claim);
    if (i >= 0) catalog.sellers[i] = record;
    else catalog.sellers.push(record);
    catalog.generatedAt = Date.now();
    saveCatalog(catalog);
    return NextResponse.json({
      ok: true,
      listings: record.listings.length,
      verifiedDeals: record.deals.filter((d) => d.refsVerified).length,
    });
  });
}
