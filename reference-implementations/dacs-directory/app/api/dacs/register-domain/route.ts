/**
 * POST /api/dacs/register-domain — submit a domain publishing a §6.3.5
 * well-known surface. Zero trust in the submission: the crawler verifies the
 * hash-bound index and the indexer verifies every anchor from chain.
 */
import { NextRequest, NextResponse } from "next/server";
import { crawlDomain, normalizeSubmittedDomain } from "@/src/catalog/wellknown";
import { rateLimit, rejectOversizeRequest } from "@/src/catalog/security";
import { loadDomains, saveDomains, withDataLock } from "@/src/catalog/store";

export async function POST(req: NextRequest) {
  const blocked = rateLimit(req, "register-domain", 3, 60 * 60_000) ?? rejectOversizeRequest(req, 4096);
  if (blocked) return blocked;
  const body = (await req.json().catch(() => null)) as { domain?: string } | null;
  const submitted = body?.domain?.trim();
  if (!submitted || submitted.length > 253) {
    return NextResponse.json({ error: "need { domain }" }, { status: 400 });
  }
  let domain: string;
  try {
    domain = normalizeSubmittedDomain(submitted);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid domain" },
      { status: 400 },
    );
  }
  // Probe now so the submitter gets immediate feedback.
  const probe = await crawlDomain(domain);
  if ("error" in probe) {
    return NextResponse.json({ error: `domain not crawlable: ${probe.error}` }, { status: 400 });
  }
  return withDataLock("domains", () => {
    const domains = loadDomains();
    if (!domains.includes(domain) && domains.length >= 50) {
      return NextResponse.json({ error: "domain registry is at capacity" }, { status: 507 });
    }
    saveDomains([...domains, domain]);
    return NextResponse.json({
      ok: true,
      seller: probe.seller,
      listings: probe.listingAnchors.length,
      note: "index hash verified — agent appears after the next index pass",
    });
  });
}
