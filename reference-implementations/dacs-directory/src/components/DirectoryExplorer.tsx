"use client";
/** Searchable, filterable agent directory — the §6.3.6 filters, in the UI. */
import Link from "next/link";
import { useMemo, useState } from "react";
import { activeCatalogSellers } from "@/src/catalog/discovery";
import type { ListingSummary, SellerRecord } from "@/src/catalog/types";
import { deliveryLabel, railLabel, negotiationLabel, IDENTITY_TIERS, tierMeta } from "./labels";

const listingRails = (listing: ListingSummary) =>
  listing.offering.rails ?? listing.offering.tags.filter((tag) => tag.startsWith("pay-"));
const sellerTier = (s: SellerRecord) => s.identityTier ?? "self-declared";
/** §10.5.4 category prefix matching: scope matches cat or cat starts with scope + "." */
const categoryMatches = (cat: string, scope: string) =>
  cat === scope || cat.startsWith(scope + ".");

const cleanDescription = (value: string) =>
  value.replace(/\s*\[[a-z0-9_-]+:[^\]]+\]\s*$/i, "").trim();

export default function DirectoryExplorer({ sellers }: { sellers: SellerRecord[] }) {
  const [q, setQ] = useState("");
  const [rail, setRail] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [goodRecord, setGoodRecord] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const availableSellers = useMemo(
    () => activeCatalogSellers(sellers),
    [sellers],
  );
  const availableListings = useMemo(
    () => availableSellers.flatMap((seller) =>
      seller.listings.map((listing) => ({ seller, listing })),
    ),
    [availableSellers],
  );
  const rails = useMemo(
    () => [...new Set(availableListings.flatMap(({ listing }) => listingRails(listing)))].sort(),
    [availableListings],
  );
  const categories = useMemo(
    () => [...new Set(availableListings.map(({ listing }) => listing.offering.category))].sort(),
    [availableListings],
  );
  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const { seller } of availableListings) {
      counts[sellerTier(seller)] = (counts[sellerTier(seller)] ?? 0) + 1;
    }
    return counts;
  }, [availableListings]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return availableListings.filter(({ seller, listing }) => {
      if (rail && !listingRails(listing).includes(rail)) return false;
      if (tier && sellerTier(seller) !== tier) return false;
      if (category && !categoryMatches(listing.offering.category, category)) return false;
      if (goodRecord && !(seller.reputation.completionRate !== null && seller.reputation.completionRate >= 0.9)) return false;
      if (!needle) return true;
      const hay = [
        seller.displayName, seller.primaryClaim,
        ...seller.cci.map((b) => `${b.platform}:${b.handle}`),
        listing.offering.title,
        listing.offering.description ?? "",
        listing.offering.category,
        ...listing.offering.tags,
        ...(listing.offering.rails ?? []),
        ...(listing.offering.delivery ?? []),
      ].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [availableListings, q, rail, tier, category, goodRecord]);

  const activeFilters = [rail, tier, category, goodRecord ? "record" : null].filter(Boolean).length;
  const clearFilters = () => {
    setRail(null);
    setTier(null);
    setCategory(null);
    setGoodRecord(false);
    setQ("");
  };
  const humanCategory = (value: string) => {
    const last = value.split(".").at(-1) ?? value;
    return last.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  };
  const serviceGlyph = (value?: string) => {
    const category = value?.toLowerCase() ?? "";
    if (category.includes("research") || category.includes("search")) return "⌕";
    if (category.includes("code") || category.includes("develop")) return "</>";
    if (category.includes("design") || category.includes("creative")) return "◇";
    if (category.includes("data") || category.includes("analysis")) return "⌁";
    if (category.includes("write") || category.includes("content")) return "✎";
    return "✦";
  };

  return (
    <>
      <div className="explorer-controls">
        <label className="search-wrap">
          <span className="sr-only">Search services</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="m21 21-4.3-4.3m2.3-5.2a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          <input
            className="search"
            placeholder="Try “code review” or “research”…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <button className={`filter-toggle ${showFilters ? "open" : ""}`} onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters} aria-controls="directory-filters">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M4 7h16M7 12h10m-7 5h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          Filters
          {activeFilters > 0 && <span>{activeFilters}</span>}
        </button>
        <span className="result-count">
          {filtered.length} service{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      <div id="directory-filters" className={`facets ${showFilters ? "visible" : ""}`}>
        <div className="filter-panel-head">
          <strong>Refine your search</strong>
          {activeFilters > 0 && <button onClick={clearFilters}>Clear all</button>}
        </div>
        <div className="facet-row">
          <span className="facet-label">Trust level</span>
          {IDENTITY_TIERS.map((t) => {
            const n = tierCounts[t.id] ?? 0;
            return (
              <button key={t.id} title={t.hint} disabled={n === 0}
                aria-pressed={tier === t.id}
                className={`badge ${t.chipClass} filter ${tier === t.id ? "active" : ""}`}
                onClick={() => setTier(tier === t.id ? null : t.id)}>
                {t.label} <span className="facet-count">{n}</span>
              </button>
            );
          })}
        </div>
        {categories.length > 0 && (
          <div className="facet-row">
            <span className="facet-label">Service type</span>
            {categories.map((c) => (
              <button key={c} className={`badge filter ${category === c ? "active" : ""}`}
                aria-pressed={category === c}
                title={`Show ${humanCategory(c)} services`}
                onClick={() => setCategory(category === c ? null : c)}>
                {humanCategory(c)}
              </button>
            ))}
          </div>
        )}
        <div className="facet-row">
          <span className="facet-label">Payment</span>
          {rails.map((r) => (
            <button key={r} className={`badge rail filter ${rail === r ? "active" : ""}`}
              aria-pressed={rail === r}
              onClick={() => setRail(rail === r ? null : r)} title={r}>
              {railLabel(r)}
            </button>
          ))}
        </div>
        <div className="facet-row">
          <span className="facet-label">Experience</span>
          <button className={`badge ${goodRecord ? "ok" : ""} filter ${goodRecord ? "active" : ""}`}
            aria-pressed={goodRecord}
            title="Only show providers who completed at least 90% of recorded jobs"
            onClick={() => setGoodRecord(!goodRecord)}>
            Proven track record
          </button>
        </div>
      </div>

      {availableListings.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">✦</div>
          <p className="eyebrow">The directory is growing</p>
          <h3>New services are on the way.</h3>
          <p>There aren&apos;t any live listings in this catalog yet. If you run an agent, you can be one of the first providers here.</p>
          <div className="empty-actions">
            <Link href="/register" className="btn">List a service</Link>
            <Link href="/how-it-works" className="btn secondary">See how trust works</Link>
          </div>
        </div>
      )}
      {availableSellers.length > 0 && filtered.length === 0 && (
        <div className="empty-state compact">
          <div className="empty-icon" aria-hidden="true">⌕</div>
          <h3>No services match that search.</h3>
          <p>Try a broader phrase or remove a filter.</p>
          <button className="btn secondary" onClick={clearFilters}>Clear search and filters</button>
        </div>
      )}
      <div className="grid">
        {filtered.map(({ seller, listing }) => {
          const href = `/seller/${encodeURIComponent(seller.primaryClaim)}/${encodeURIComponent(listing.listingId)}`;
          const t = tierMeta(sellerTier(seller));
          const negotiation = listing.offering.negotiation ?? [];
          const price = listing.pricing.priceHint
            ? `${listing.pricing.priceHint}${listing.pricing.currency ? ` ${listing.pricing.currency}` : ""}`
            : null;
          const pricingCopy = price
            ? `From ${price}`
            : negotiation.some((mode) => mode.includes("fixed-price"))
              ? "Agree price upfront"
              : "Request a quote";
          const delivery = listing.offering.delivery?.[0];
          return (
            <article key={`${seller.primaryClaim}:${listing.listingId}:${listing.version}`} className="card agent-card listing-market-card">
              <div className="service-card-top">
                <span className="listing-category">{humanCategory(listing.offering.category)}</span>
                <span className="availability"><i /> Available</span>
              </div>
              <div className="service-title-row">
                <span className="service-icon" aria-hidden="true">{serviceGlyph(listing.offering.category)}</span>
                <h3><Link href={href} className="card-title-link">{listing.offering.title}</Link></h3>
              </div>
              {listing.offering.description && (
                <p className="agent-desc clamp2">{cleanDescription(listing.offering.description)}</p>
              )}
              <div className="listing-price-row">
                <div><span>Commercial terms</span><strong>{pricingCopy}</strong></div>
                <span className="pricing-mode">
                  {negotiation[0] ? negotiationLabel(negotiation[0]) : "Terms on request"}
                </span>
              </div>
              <div className="listing-facts">
                <div><span>You receive</span><strong>{delivery ? deliveryLabel(delivery) : "Defined with provider"}</strong></div>
                <div><span>Settle with</span><strong>{listingRails(listing).map(railLabel).join(" or ") || "Agreed rail"}</strong></div>
              </div>
              <div className="listing-provider">
                <span className="provider-avatar" aria-hidden="true">{seller.displayName.slice(0, 1).toUpperCase()}</span>
                <div><span>Offered by</span><strong>{seller.displayName}</strong></div>
                <span className={`badge ${t.chipClass}`} title={t.hint}>{t.label}</span>
              </div>
              <div className="listing-card-actions">
                <span className="provider-record">
                  {seller.reputation.totalAgreements === 0
                    ? "New provider"
                    : `${seller.reputation.completed}/${seller.reputation.totalAgreements} completed`}
                </span>
                <Link href={href} className="card-cta">Explore service <span aria-hidden="true">→</span></Link>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
