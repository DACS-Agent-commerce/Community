"use client";
/** Searchable, filterable agent directory — the §6.3.6 filters, in the UI. */
import Link from "next/link";
import { useMemo, useState } from "react";
import { activeCatalogSellers } from "@/src/catalog/discovery";
import type { SellerRecord } from "@/src/catalog/types";
import { CciChip } from "./Badge";
import { railLabel, negotiationLabel, IDENTITY_TIERS, tierMeta } from "./labels";

const sellerRails = (s: SellerRecord) => [
  ...new Set(
    s.listings.flatMap(
      (l) => l.offering.rails ?? l.offering.tags.filter((t) => t.startsWith("pay-")),
    ),
  ),
];
const sellerTier = (s: SellerRecord) => s.identityTier ?? (s.cci.length > 0 ? "verified" : "self-declared");
const sellerCategories = (s: SellerRecord) => s.listings.map((l) => l.offering.category);
/** §10.5.4 category prefix matching: scope matches cat or cat starts with scope + "." */
const categoryMatches = (cat: string, scope: string) =>
  cat === scope || cat.startsWith(scope + ".");

export default function DirectoryExplorer({ sellers }: { sellers: SellerRecord[] }) {
  const [q, setQ] = useState("");
  const [rail, setRail] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [goodRecord, setGoodRecord] = useState(false);

  const availableSellers = useMemo(
    () => activeCatalogSellers(sellers),
    [sellers],
  );
  const rails = useMemo(() => [...new Set(availableSellers.flatMap(sellerRails))].sort(), [availableSellers]);
  // Top-level category segments, data-driven (no fixed taxonomy in the spec).
  const categories = useMemo(
    () => [...new Set(availableSellers.flatMap(sellerCategories).map((c) => c.split(".")[0]))].sort(),
    [availableSellers],
  );
  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of availableSellers) counts[sellerTier(s)] = (counts[sellerTier(s)] ?? 0) + 1;
    return counts;
  }, [availableSellers]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return availableSellers.filter((s) => {
      if (rail && !sellerRails(s).includes(rail)) return false;
      if (tier && sellerTier(s) !== tier) return false;
      if (category && !sellerCategories(s).some((c) => categoryMatches(c, category))) return false;
      if (goodRecord && !(s.reputation.completionRate !== null && s.reputation.completionRate >= 0.9)) return false;
      if (!needle) return true;
      const hay = [
        s.displayName, s.primaryClaim,
        ...s.cci.map((b) => `${b.platform}:${b.handle}`),
        ...s.listings.flatMap((l) => [
          l.offering.title,
          l.offering.description ?? "",
          l.offering.category,
          ...l.offering.tags,
          ...(l.offering.rails ?? []),
          ...(l.offering.delivery ?? []),
        ]),
      ].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [availableSellers, q, rail, tier, category, goodRecord]);

  return (
    <>
      <div className="toolbar">
        <input
          className="search"
          placeholder="Search services, agents, identities…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="meta" style={{ marginLeft: "auto" }}>
          {filtered.length} of {availableSellers.length} agent{availableSellers.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="facets">
        <div className="facet-row">
          <span className="facet-label">identity</span>
          {IDENTITY_TIERS.map((t) => {
            const n = tierCounts[t.id] ?? 0;
            return (
              <button key={t.id} title={t.hint} disabled={n === 0}
                className={`badge ${t.chipClass} filter ${tier === t.id ? "active" : ""}`}
                onClick={() => setTier(tier === t.id ? null : t.id)}>
                {t.label} <span className="facet-count">{n}</span>
              </button>
            );
          })}
        </div>
        {categories.length > 0 && (
          <div className="facet-row">
            <span className="facet-label">category</span>
            {categories.map((c) => (
              <button key={c} className={`badge filter ${category === c ? "active" : ""}`}
                title={`Matches listings whose category is "${c}" or starts with "${c}." (§10.5.4 prefix rule)`}
                onClick={() => setCategory(category === c ? null : c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        <div className="facet-row">
          <span className="facet-label">pays in</span>
          {rails.map((r) => (
            <button key={r} className={`badge rail filter ${rail === r ? "active" : ""}`}
              onClick={() => setRail(rail === r ? null : r)} title={r}>
              {railLabel(r)}
            </button>
          ))}
        </div>
        <div className="facet-row">
          <span className="facet-label">track record</span>
          <button className={`badge ${goodRecord ? "ok" : ""} filter ${goodRecord ? "active" : ""}`}
            title="Only agents with ≥90% completion across chain-verified deals (advisory reputationHint, §6.3.6 minCompletionRate — the verify pages are authoritative)"
            onClick={() => setGoodRecord(!goodRecord)}>
            90%+ completion
          </button>
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="card"><h3>No matches</h3><p className="meta">Try a different search, or clear the filters.</p></div>
      )}
      <div className="grid">
        {filtered.map((s) => {
          const lead = s.listings[0];
          const href = `/seller/${encodeURIComponent(s.primaryClaim)}`;
          const web2 = s.cci.filter((b) => b.kind === "web2");
          const t = tierMeta(sellerTier(s));
          const negotiation = [
            ...new Set(s.listings.flatMap((l) => l.offering.negotiation ?? [])),
          ];
          return (
            // A <div>, not a link: the proof chips inside are links themselves
            // and <a> cannot nest. The title carries the navigation.
            <div key={s.primaryClaim} className="card agent-card">
              <h3><Link href={href} className="card-title-link">{lead?.offering.title ?? s.displayName}</Link></h3>
              <div className="byline">
                by <strong>{s.displayName}</strong>
                <span className={`byline-src ${s.ownerRegistered ? "ok" : ""}`}>
                  {s.ownerRegistered
                    ? "owner-registered"
                    : s.discovered
                      ? "found on-chain"
                      : "unverified submission"}
                </span>
              </div>
              {lead?.offering.description && (
                <p className="agent-desc clamp2">{lead.offering.description}</p>
              )}
              <div className="card-meta">
                <span className="meta-label">identity</span>
                <span className="meta-chips">
                  <span className={`badge ${t.chipClass}`} title={t.hint}>{t.label}</span>
                  {web2.map((b) => <CciChip key={b.ref} badge={b} />)}
                </span>

                <span className="meta-label">pays in</span>
                <span className="meta-chips">
                  {sellerRails(s).map((r) => (
                    <span key={r} className="badge rail" title={r}>{railLabel(r)}</span>
                  ))}
                </span>

                <span className="meta-label">negotiation</span>
                <span className="meta-chips">
                  {negotiation.length > 0
                    ? negotiation.map((n) => (
                        <span key={n} className="badge" title={n}>{negotiationLabel(n)}</span>
                      ))
                    : <span className="meta-empty">not stated</span>}
                </span>

                <span className="meta-label">track record</span>
                <span className="meta-chips">
                  <span className={`badge ${s.reputation.completed > 0 ? "ok" : ""}`}>
                    {s.reputation.completed}/{s.reputation.totalAgreements} deals
                    {s.reputation.completionRate !== null && ` · ${Math.round(s.reputation.completionRate * 100)}%`}
                  </span>
                </span>
              </div>
              <Link href={href} className="card-cta">view agent →</Link>
            </div>
          );
        })}
      </div>
    </>
  );
}
