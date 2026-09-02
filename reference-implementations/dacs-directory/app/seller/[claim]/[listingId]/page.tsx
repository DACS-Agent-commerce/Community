import Link from "next/link";
import { notFound } from "next/navigation";
import CopyText from "@/src/components/CopyText";
import { CciChip } from "@/src/components/Badge";
import { deliveryLabel, negotiationLabel, railLabel, tierMeta } from "@/src/components/labels";
import { loadCatalog } from "@/src/catalog/store";

export const dynamic = "force-dynamic";

const humanCategory = (value: string) => {
  const last = value.split(".").at(-1) ?? value;
  return last.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const cleanDescription = (value: string) =>
  value.replace(/\s*\[[a-z0-9_-]+:[^\]]+\]\s*$/i, "").trim();

export default async function ServiceDetail({
  params,
}: {
  params: Promise<{ claim: string; listingId: string }>;
}) {
  const { claim, listingId } = await params;
  const seller = loadCatalog().sellers.find(
    (candidate) => candidate.primaryClaim === decodeURIComponent(claim),
  );
  const listing = seller?.listings.find(
    (candidate) => candidate.listingId === decodeURIComponent(listingId) && candidate.status === "active",
  );
  if (!seller || !listing) notFound();

  const rails = listing.offering.rails ?? listing.offering.tags.filter((tag) => tag.startsWith("pay-"));
  const delivery = listing.offering.delivery ?? [];
  const negotiation = listing.offering.negotiation ?? [];
  const tier = tierMeta(seller.identityTier ?? "self-declared");
  const verifiedDeals = seller.deals.filter((deal) => deal.refsVerified && (!deal.category || deal.category === listing.offering.category));
  const price = listing.pricing.priceHint
    ? `${listing.pricing.priceHint}${listing.pricing.currency ? ` ${listing.pricing.currency}` : ""}`
    : null;
  const priceCopy = price
    ? `From ${price}`
    : negotiation.some((mode) => mode.includes("fixed-price"))
      ? "Agree price upfront"
      : "Quoted for the job";

  return (
    <>
      <p className="breadcrumb"><Link href="/#services">← Back to the market</Link></p>

      <section className="service-detail-hero">
        <div className="service-detail-copy">
          <div className="service-detail-kicker">
            <span>{humanCategory(listing.offering.category)}</span>
            <span className="availability"><i /> Available</span>
          </div>
          <h1>{listing.offering.title}</h1>
          {listing.offering.description && (
            <p className="service-detail-description">{cleanDescription(listing.offering.description)}</p>
          )}
          <Link className="service-provider-link" href={`/seller/${encodeURIComponent(seller.primaryClaim)}`}>
            <span className="provider-avatar" aria-hidden="true">{seller.displayName.slice(0, 1).toUpperCase()}</span>
            <span><small>Offered by</small><strong>{seller.displayName}</strong></span>
            <span className={`badge ${tier.chipClass}`} title={tier.hint}>{tier.label}</span>
            <span aria-hidden="true">→</span>
          </Link>
        </div>

        <aside className="service-action-panel" aria-label="Service terms">
          <span className="mini-label">Commercial terms</span>
          <strong className="service-price">{priceCopy}</strong>
          <span className="service-price-note">
            {negotiation[0] ? negotiationLabel(negotiation[0]) : "Terms confirmed before work begins"}
          </span>
          <div className="service-action-facts">
            <div>
              <span>You receive</span>
              <strong>{delivery[0] ? deliveryLabel(delivery[0]) : "A deliverable agreed with the provider"}</strong>
            </div>
            <div>
              <span>Settlement</span>
              <strong>{rails.map(railLabel).join(" or ") || "Compatible rail agreed together"}</strong>
            </div>
          </div>
          <button className="btn service-primary-action" type="button" disabled>Request an offer</button>
          <p className="action-note">Buyer requests and negotiation are the next workflow being connected.</p>
        </aside>
      </section>

      <section className="service-confidence-strip" aria-label="Provider confidence">
        <div><span>Provider record</span><strong>{seller.reputation.totalAgreements === 0 ? "New provider" : `${seller.reputation.completed}/${seller.reputation.totalAgreements} completed`}</strong></div>
        <div><span>Verified outcomes</span><strong>{verifiedDeals.length}</strong></div>
        <div><span>Payment options</span><strong>{rails.length}</strong></div>
        <div><span>Directory status</span><strong>{seller.ownerRegistered ? "Provider confirmed" : "Service record checked"}</strong></div>
      </section>

      <div className="service-detail-grid">
        <section className="section service-terms-section">
          <div className="section-title"><p className="eyebrow">What you are buying</p><h2>Service terms</h2></div>
          <div className="card service-terms-card">
            <div>
              <span>Deliverable</span>
              <strong>{delivery.length > 0 ? delivery.map(deliveryLabel).join(", ") : "Defined with the provider"}</strong>
            </div>
            <div>
              <span>Pricing</span>
              <strong>{priceCopy}</strong>
            </div>
            <div>
              <span>How terms are agreed</span>
              <strong>{negotiation.length > 0 ? negotiation.map(negotiationLabel).join(", ") : "Direct agreement"}</strong>
            </div>
            <div>
              <span>Ways to pay</span>
              <span className="meta-chips">{rails.map((rail) => <span key={rail} className="badge rail">{railLabel(rail)}</span>)}</span>
            </div>
          </div>
        </section>

        <section className="section service-provider-section">
          <div className="section-title"><p className="eyebrow">Who provides it</p><h2>Provider confidence</h2></div>
          <div className="card provider-confidence-card">
            <div className="provider-confidence-title">
              <span className="provider-avatar large" aria-hidden="true">{seller.displayName.slice(0, 1).toUpperCase()}</span>
              <div><strong>{seller.displayName}</strong><span className={`badge ${tier.chipClass}`} title={tier.hint}>{tier.label}</span></div>
            </div>
            {seller.cci.some((badge) => badge.kind === "web2") ? (
              <div className="provider-links">
                <span>Linked accounts</span>
                <div>{seller.cci.filter((badge) => badge.kind === "web2").slice(0, 3).map((badge) => <CciChip key={badge.ref} badge={badge} />)}</div>
              </div>
            ) : <p className="provider-note">No linked public accounts yet.</p>}
            <Link className="text-link" href={`/seller/${encodeURIComponent(seller.primaryClaim)}`}>View full provider profile <span aria-hidden="true">→</span></Link>
          </div>
        </section>
      </div>

      <section className="section">
        <div className="section-title"><p className="eyebrow">Evidence that travels</p><h2>Verified outcomes</h2></div>
        {verifiedDeals.length === 0 ? (
          <div className="card outcome-empty">
            <span aria-hidden="true">◇</span>
            <div><strong>No verified outcomes for this service yet.</strong><p>This provider is new. Completed work will appear here once its receipt can be independently checked.</p></div>
          </div>
        ) : (
          <div className="verified-outcome-list">
            {verifiedDeals.map((deal) => (
              <Link key={deal.jobId} className="card verified-outcome" href={`/deal/${encodeURIComponent(deal.buyerBundleRef)}?buyer=${encodeURIComponent(deal.owners.buyer)}&seller=${encodeURIComponent(deal.owners.seller)}`}>
                <span>✓ Verified outcome</span><strong>{deal.jobId}</strong><span>{railLabel(deal.rail)} · Check receipt →</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <details className="technical-details service-technical">
        <summary>View technical listing record</summary>
        <div className="meta">Listing {listing.listingId} · Version {listing.version}</div>
        <div className="meta">Record <CopyText value={listing.anchor.locator} head={24} tail={8} /></div>
      </details>
    </>
  );
}
