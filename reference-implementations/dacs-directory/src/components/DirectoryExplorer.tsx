"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { activeCatalogSellers } from "@/src/catalog/discovery";
import type { ListingSummary, SellerRecord } from "@/src/catalog/types";
import { deliveryLabel, IDENTITY_TIERS, railLabel, tierMeta } from "./labels";

const sellerTier = (seller: SellerRecord) =>
  seller.identityTier ?? (seller.cci.length > 0 ? "verified" : "self-declared");

const categoryMatches = (category: string, scope: string) =>
  category === scope || category.startsWith(`${scope}.`);

type Service = { listing: ListingSummary; seller: SellerRecord };

export default function DirectoryExplorer({ sellers, indexed }: { sellers: SellerRecord[]; indexed: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const rail = params.get("rail");
  const tier = params.get("identityTier");
  const category = params.get("category");
  const goodRecord = params.get("trackRecord") === "90";

  const availableSellers = useMemo(() => activeCatalogSellers(sellers), [sellers]);
  const services = useMemo<Service[]>(
    () => availableSellers.flatMap((seller) => seller.listings
      .filter((listing) => listing.status === "active")
      .map((listing) => ({ listing, seller }))),
    [availableSellers],
  );
  const rails = useMemo(
    () => [...new Set(services.flatMap(({ listing }) => listing.offering.rails ?? []))].sort(),
    [services],
  );
  const categories = useMemo(
    () => [...new Set(services.map(({ listing }) => listing.offering.category.split(".")[0]))].sort(),
    [services],
  );
  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const { seller } of services) counts[sellerTier(seller)] = (counts[sellerTier(seller)] ?? 0) + 1;
    return counts;
  }, [services]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return services.filter(({ listing, seller }) => {
      if (rail && !(listing.offering.rails ?? []).includes(rail)) return false;
      if (tier && sellerTier(seller) !== tier) return false;
      if (category && !categoryMatches(listing.offering.category, category)) return false;
      if (goodRecord && !(seller.reputation.completionRate !== null && seller.reputation.completionRate >= 0.9)) return false;
      if (!needle) return true;
      return [
        listing.offering.title,
        listing.offering.description ?? "",
        listing.offering.category,
        ...listing.offering.tags,
        ...(listing.offering.rails ?? []),
        ...(listing.offering.delivery ?? []),
        seller.displayName,
        ...seller.cci.map((claim) => `${claim.platform} ${claim.handle}`),
      ].join(" ").toLowerCase().includes(needle);
    });
  }, [services, q, rail, tier, category, goodRecord]);

  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  const clear = () => router.replace(pathname, { scroll: false });
  const hasFilters = Boolean(q || rail || tier || category || goodRecord);

  return (
    <section aria-labelledby="services-heading">
      <div className="section-heading-row">
        <div>
          <div className="eyebrow">discover</div>
          <h2 id="services-heading" className="section-title">Services ready to explore</h2>
        </div>
        <Link className="text-link" href="/how-it-works">How trust works <span aria-hidden>→</span></Link>
      </div>

      <div className="discovery-panel">
        <label htmlFor="directory-search" className="sr-only">Search agent services</label>
        <div className="search-wrap">
          <span aria-hidden className="search-icon">⌕</span>
          <input
            id="directory-search"
            className="search"
            placeholder="Try “review my pull request” or “pay with USDC”"
            value={q}
            onChange={(event) => setParam("q", event.target.value || null)}
          />
        </div>
        <div className="result-row">
          <span className="meta" aria-live="polite">
            {filtered.length} service{filtered.length === 1 ? "" : "s"}
          </span>
          {hasFilters && <button className="clear-button" type="button" onClick={clear}>Clear all filters</button>}
        </div>

        <div className="facets" aria-label="Filter services">
          <div className="facet-row">
            <span className="facet-label">identity</span>
            {IDENTITY_TIERS.map((option) => {
              const count = tierCounts[option.id] ?? 0;
              const selected = tier === option.id;
              return (
                <button key={option.id} type="button" title={option.hint} disabled={count === 0}
                  aria-pressed={selected}
                  className={`badge ${option.chipClass} filter ${selected ? "active" : ""}`}
                  onClick={() => setParam("identityTier", selected ? null : option.id)}>
                  {option.label} <span className="facet-count">{count}</span>
                </button>
              );
            })}
          </div>
          {categories.length > 0 && (
            <div className="facet-row">
              <span className="facet-label">category</span>
              {categories.map((option) => (
                <button key={option} type="button" aria-pressed={category === option}
                  className={`badge filter ${category === option ? "active" : ""}`}
                  onClick={() => setParam("category", category === option ? null : option)}>
                  {option}
                </button>
              ))}
            </div>
          )}
          {rails.length > 0 && (
            <div className="facet-row">
              <span className="facet-label">payment</span>
              {rails.map((option) => (
                <button key={option} type="button" aria-pressed={rail === option}
                  className={`badge rail filter ${rail === option ? "active" : ""}`}
                  onClick={() => setParam("rail", rail === option ? null : option)} title={option}>
                  {railLabel(option)}
                </button>
              ))}
            </div>
          )}
          <div className="facet-row">
            <span className="facet-label">record</span>
            <button type="button" aria-pressed={goodRecord}
              className={`badge filter ${goodRecord ? "ok active" : ""}`}
              onClick={() => setParam("trackRecord", goodRecord ? null : "90")}>
              90%+ completion
            </button>
          </div>
        </div>
      </div>

      {!indexed && services.length === 0 && (
        <div className="empty-state" role="status">
          <span className="empty-icon" aria-hidden>◎</span>
          <h3>The catalog has not been indexed yet</h3>
          <p>Once the first chain scan completes, verified services will appear here automatically.</p>
          <div className="button-row">
            <Link href="/how-it-works" className="btn secondary">See how discovery works</Link>
            <Link href="/register" className="btn">List your service</Link>
          </div>
        </div>
      )}
      {indexed && services.length === 0 && (
        <div className="empty-state" role="status">
          <h3>No active services yet</h3>
          <p>Agents appear through chain discovery or an owner-signed listing.</p>
          <Link href="/register" className="btn">List the first service</Link>
        </div>
      )}
      {services.length > 0 && filtered.length === 0 && (
        <div className="empty-state" role="status">
          <h3>No services match those filters</h3>
          <p>Broaden the search or clear the active filters.</p>
          <button className="btn secondary" type="button" onClick={clear}>Clear all filters</button>
        </div>
      )}

      <div className="service-grid">
        {filtered.map(({ listing, seller }) => {
          const trust = tierMeta(sellerTier(seller));
          const href = `/service/${encodeURIComponent(seller.primaryClaim)}/${encodeURIComponent(listing.listingId)}/${listing.version}`;
          const jsonHref = `/api/dacs/listings/${encodeURIComponent(listing.listingId)}/${listing.version}?seller=${encodeURIComponent(seller.primaryClaim)}`;
          return (
            <article key={`${seller.primaryClaim}/${listing.listingId}/${listing.version}`} className="card service-card">
              <div className="service-card-topline">
                <span className="eyebrow">{listing.offering.category.replaceAll(".", " / ")}</span>
                <span className="badge ok">listing verified</span>
              </div>
              <h3><Link href={href} className="card-title-link">{listing.offering.title}</Link></h3>
              <p className="byline">by <Link href={`/seller/${encodeURIComponent(seller.primaryClaim)}`}><strong>{seller.displayName}</strong></Link></p>
              <p className="agent-desc clamp2">{listing.offering.description || "No description supplied."}</p>
              <div className="service-facts">
                <div><span>price</span><strong>{listing.pricing.priceHint ?? "Ask agent"}{listing.pricing.currency ? ` ${listing.pricing.currency}` : ""}</strong></div>
                <div><span>delivery</span><strong>{listing.offering.delivery?.[0] ? deliveryLabel(listing.offering.delivery[0]) : "Not stated"}</strong></div>
              </div>
              <div className="card-meta">
                <span className="meta-label">identity</span>
                <span className="meta-chips"><span className={`badge ${trust.chipClass}`}>{trust.label}</span></span>
                <span className="meta-label">payment</span>
                <span className="meta-chips">
                  {(listing.offering.rails ?? []).map((value) => <span key={value} className="badge rail">{railLabel(value)}</span>)}
                  {(listing.offering.rails ?? []).length === 0 && <span className="meta-empty">not stated</span>}
                </span>
                <span className="meta-label">record</span>
                <span className="meta-chips"><span className={seller.reputation.completed ? "badge ok" : "badge"}>
                  {seller.reputation.completed}/{seller.reputation.totalAgreements} verified deals
                </span></span>
              </div>
              <div className="service-actions">
                <Link href={href} className="btn">Explore service</Link>
                <Link href={jsonHref} className="btn secondary mono" aria-label={`Open JSON contract for ${listing.offering.title}`}>JSON</Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
