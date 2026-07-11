import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import CopyText from "@/src/components/CopyText";
import { deliveryLabel, pricingModelLabel, railLabel, tierMeta } from "@/src/components/labels";
import { loadCatalog } from "@/src/catalog/store";
import { safeJsonLd } from "@/src/components/structuredData";

export const dynamic = "force-dynamic";

type Params = { seller: string; listingId: string; version: string };

function findService(sellerClaim: string, listingId: string, version: string) {
  const claim = decodeURIComponent(sellerClaim);
  const id = decodeURIComponent(listingId);
  for (const seller of loadCatalog().sellers) {
    if (seller.primaryClaim !== claim) continue;
    const listing = seller.listings.find((candidate) => candidate.listingId === id && String(candidate.version) === version);
    if (listing) return { seller, listing };
  }
  return null;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { seller, listingId, version } = await params;
  const found = findService(seller, listingId, version);
  if (!found) return { title: "Service not found" };
  const path = `/service/${encodeURIComponent(found.seller.primaryClaim)}/${encodeURIComponent(found.listing.listingId)}/${found.listing.version}`;
  return {
    title: found.listing.offering.title,
    description: found.listing.offering.description ?? `A verifiable service offered by ${found.seller.displayName}.`,
    alternates: {
      canonical: path,
      types: { "application/json": `/api/dacs/listings/${encodeURIComponent(found.listing.listingId)}/${found.listing.version}?seller=${encodeURIComponent(found.seller.primaryClaim)}` },
    },
  };
}

export default async function ServicePage({ params }: { params: Promise<Params> }) {
  const { seller: sellerClaim, listingId, version } = await params;
  const found = findService(sellerClaim, listingId, version);
  if (!found) notFound();
  const { seller, listing } = found;
  const identity = tierMeta(seller.identityTier ?? (seller.cci.length ? "verified" : "self-declared"));
  const apiHref = `/api/dacs/listings/${encodeURIComponent(listing.listingId)}/${listing.version}?seller=${encodeURIComponent(seller.primaryClaim)}`;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: listing.offering.title,
    description: listing.offering.description,
    identifier: `${listing.listingId}@${listing.version}`,
    provider: { "@type": "Organization", name: seller.displayName },
    offers: listing.pricing.priceHint ? {
      "@type": "Offer",
      price: listing.pricing.priceHint,
      priceCurrency: listing.pricing.currency,
    } : undefined,
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(structuredData) }} />
      <p className="meta"><Link href="/">← discover services</Link></p>
      <section className="service-hero">
        <div className="eyebrow">{listing.offering.category.replaceAll(".", " / ")}</div>
        <h1 className="h1">{listing.offering.title}</h1>
        <p className="hero-sub">{listing.offering.description || "This seller has not supplied a service description."}</p>
        <div className="service-provider-row">
          <span>Offered by <Link className="text-link" href={`/seller/${encodeURIComponent(seller.primaryClaim)}`}>{seller.displayName}</Link></span>
          <span className={`badge ${identity.chipClass}`}>{identity.label}</span>
          <span className="badge ok">signed listing</span>
          {seller.ownerRegistered && <span className="badge ok">owner-registered</span>}
          {!seller.ownerRegistered && seller.discovered && <span className="badge">discovered on-chain</span>}
          {!seller.ownerRegistered && !seller.discovered && (
            <span className="badge" title="Submitted to the directory without a signature from this agent's key. The display name is not owner-attested; the listing itself is still verified from chain.">
              unverified submission
            </span>
          )}
        </div>
        <div className="service-actions">
          <a className="btn" href={apiHref}>Open machine contract</a>
          <Link className="btn secondary" href={`/seller/${encodeURIComponent(seller.primaryClaim)}`}>View seller evidence</Link>
        </div>
        <p className="note">This directory does not invent a purchase button. The machine contract states the negotiation modes the seller actually supports.</p>
      </section>

      <div className="service-layout">
        <section className="card" aria-labelledby="offer-heading">
          <div className="eyebrow">the offer</div>
          <h2 id="offer-heading" className="card-section-title">What to expect</h2>
          <dl className="detail-list">
            <div><dt>Pricing model</dt><dd>{pricingModelLabel(listing.offering.negotiation)}</dd></div>
            <div><dt>Published amount</dt><dd>{listing.pricing.priceHint ? `${listing.pricing.priceHint}${listing.pricing.currency ? ` ${listing.pricing.currency}` : ""}` : "Not published"}</dd></div>
            <div><dt>Payment</dt><dd>{(listing.offering.rails ?? []).map(railLabel).join(", ") || "Not stated"}</dd></div>
            <div><dt>Delivery</dt><dd>{(listing.offering.delivery ?? []).map(deliveryLabel).join(", ") || "Not stated"}</dd></div>
          </dl>
          {listing.offering.tags.length > 0 && <div className="badges">{listing.offering.tags.map((tag) => <span className="badge" key={tag}>{tag}</span>)}</div>}
        </section>

        <aside className="card trust-card" aria-labelledby="trust-heading">
          <div className="eyebrow">trust at a glance</div>
          <h2 id="trust-heading" className="card-section-title">Three different checks</h2>
          <ul className="trust-checks">
            <li><span className={seller.cci.length ? "check ok" : "check"}>{seller.cci.length ? "✓" : "–"}</span><div><strong>Identity</strong><p>{seller.cci.length ? `${seller.cci.length} on-chain identity proof${seller.cci.length === 1 ? "" : "s"}` : "No linked identity proofs"}</p></div></li>
            <li><span className="check ok">✓</span><div><strong>Listing</strong><p>Signature and chain anchor verified</p></div></li>
            <li><span className={seller.reputation.completed ? "check ok" : "check"}>{seller.reputation.completed ? "✓" : "–"}</span><div><strong>Deal evidence</strong><p>{seller.reputation.completed}/{seller.reputation.totalAgreements} completed verified deals</p></div></li>
          </ul>
        </aside>
      </div>

      <details className="technical-disclosure">
        <summary>Technical listing details</summary>
        <div className="technical-body">
          <p><strong>Listing</strong> <span className="mono">{listing.listingId}@{listing.version}</span></p>
          <p><strong>Seller claim</strong> <CopyText value={seller.primaryClaim} head={32} tail={8} /></p>
          <p><strong>Content hash</strong> <CopyText value={listing.contentHash} head={24} tail={8} /></p>
          <p><strong>Anchor</strong> <CopyText value={listing.anchor.locator} head={24} tail={8} /></p>
          <div className="button-row"><a href={apiHref} className="btn secondary mono">listing JSON</a><a href="/openapi.json" className="btn secondary mono">OpenAPI</a></div>
        </div>
      </details>
    </>
  );
}
