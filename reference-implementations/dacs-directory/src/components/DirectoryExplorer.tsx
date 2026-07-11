"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { activeCatalogSellers } from "@/src/catalog/discovery";
import type { ListingSummary, SellerRecord } from "@/src/catalog/types";
import { deliveryLabel, IDENTITY_TIERS, pricingModelLabel, railLabel, tierMeta } from "./labels";

const sellerTier = (_seller: SellerRecord) => "self-declared";

// Provenance of the display name: owner-signed, chain-discovered, or an
// unsigned third-party submission (whose chosen name is not owner-attested).
const provenance = (seller: SellerRecord) =>
  seller.ownerRegistered ? "owner-registered" : seller.discovered ? "found on-chain" : "unverified submission";

const categoryMatches = (category: string, scope: string) =>
  category === scope || category.startsWith(`${scope}.`);

type Service = { listing: ListingSummary; seller: SellerRecord };

export default function DirectoryExplorer({ sellers, indexed }: { sellers: SellerRecord[]; indexed: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const paramsString = params.toString();
  const queryParam = params.get("q") ?? "";
  const [q, setQ] = useState(queryParam);
  const ownNavigation = useRef(false);
  const rail = params.get("rail");
  const tier = params.get("identityTier");
  const category = params.get("category");
  const goodRecord = params.get("trackRecord") === "90";

  useEffect(() => {
    if (ownNavigation.current) ownNavigation.current = false;
    else setQ(queryParam);
  }, [queryParam]);

  useEffect(() => {
    if (q === queryParam) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(paramsString);
      if (q.trim()) next.set("q", q);
      else next.delete("q");
      const query = next.toString();
      ownNavigation.current = true;
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [paramsString, pathname, q, queryParam, router]);

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
    () => [...new Set(services.map(({ listing }) => listing.offering.category))].sort(),
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
        ...(listing.offering.negotiation ?? []),
        listing.pricing.kind ?? "",
        seller.displayName,
        ...seller.cci.map((claim) => `${claim.platform} ${claim.handle}`),
      ].join(" ").toLowerCase().replaceAll("-", " ").includes(needle.replaceAll("-", " "));
    });
  }, [services, q, rail, tier, category, goodRecord]);

  const setParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  const clear = () => {
    setQ("");
    router.replace(pathname, { scroll: false });
  };
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
            onChange={(event) => setQ(event.target.value)}
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
              if (count === 0) return null;
              return (
                <button key={option.id} type="button" title={option.hint} aria-label={`${option.label}: ${option.hint}`}
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
                  {option.replaceAll(".", " / ")}
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
          {services.some(({ seller }) => seller.reputation.totalAgreements > 0) ? <div className="facet-row">
            <span className="facet-label">record</span>
            <button type="button" aria-pressed={goodRecord}
              className={`badge filter ${goodRecord ? "ok active" : ""}`}
              onClick={() => setParam("trackRecord", goodRecord ? null : "90")}>
              90%+ completion
            </button>
          </div> : <div className="facet-row"><span className="facet-label">record</span><span className="badge">No current two-sided deal evidence yet</span></div>}
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
                <span className={`badge ${listing.artifactProfile === "dacs-v0.1" ? "ok" : ""}`}>
                  {listing.artifactProfile === "dacs-v0.1" ? "current DACS listing" : "legacy SDK listing"}
                </span>
              </div>
              <h3><Link href={href} className="card-title-link">{listing.offering.title}</Link></h3>
              <p className="byline">
                by <Link href={`/seller/${encodeURIComponent(seller.primaryClaim)}`}><strong>{seller.displayName}</strong></Link>
                <span className={`byline-src ${seller.ownerRegistered ? "ok" : ""}`}>{provenance(seller)}</span>
              </p>
              <p className="agent-desc clamp2">{listing.offering.description || "No description supplied."}</p>
              <div className="service-facts">
                <div><span>pricing</span><strong>{listing.pricing.priceHint ? `${listing.pricing.priceHint}${listing.pricing.currency ? ` ${listing.pricing.currency}` : ""}` : pricingModelLabel(listing.offering.negotiation)}</strong></div>
                <div><span>delivery</span><strong>{listing.offering.delivery?.[0] ? deliveryLabel(listing.offering.delivery[0]) : "Not stated"}</strong></div>
              </div>
              <div className="card-meta">
                <span className="meta-label">identity</span>
                <span className="meta-chips"><span className={`badge ${trust.chipClass}`}>{trust.label}</span>{seller.cci.length > 0 && <span className="badge cci">{seller.cci.length} identity link{seller.cci.length === 1 ? "" : "s"}</span>}</span>
                <span className="meta-label">payment</span>
                <span className="meta-chips">
                  {(listing.offering.rails ?? []).map((value) => <span key={value} className="badge rail">{railLabel(value)}</span>)}
                  {(listing.offering.rails ?? []).length === 0 && <span className="meta-empty">not stated</span>}
                </span>
                <span className="meta-label">record</span>
                <span className="meta-chips"><span className={seller.reputation.completed ? "badge ok" : "badge"}>
                  {seller.reputation.completed}/{seller.reputation.totalAgreements} strict bundles
                </span></span>
              </div>
              <div className="service-actions">
                <Link href={href} className="btn">Explore service</Link>
                <Link href={jsonHref} className="btn secondary mono" aria-label={`Open signed listing artifact for ${listing.offering.title}`}>JSON</Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
