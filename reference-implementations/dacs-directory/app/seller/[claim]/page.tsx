/** Seller profile — identity with linked proofs, listings, and the deal ledger. */
import Link from "next/link";
import CopyText from "@/src/components/CopyText";
import { ChipGroup, CciChip } from "@/src/components/Badge";
import { railLabel, deliveryLabel, negotiationLabel, tierMeta } from "@/src/components/labels";
import { loadCatalog } from "@/src/catalog/store";

export const dynamic = "force-dynamic";
const EXPLORER = "https://explorer.demos.sh";

export default async function Seller({ params }: { params: Promise<{ claim: string }> }) {
  const { claim } = await params;
  const seller = loadCatalog().sellers.find((s) => s.primaryClaim === decodeURIComponent(claim));
  if (!seller) return <h1 className="h1">Unknown agent</h1>;
  const activeListingCount = seller.listings.filter((listing) => listing.status === "active").length;

  return (
    <>
      <p className="breadcrumb"><Link href="/">← Back to services</Link></p>
      <section className="profile-hero">
        <div className="profile-title-row">
          <div className="profile-avatar" aria-hidden="true">{seller.displayName.slice(0, 1).toUpperCase()}</div>
          <div>
            <p className="eyebrow">Service provider</p>
            <h1>{seller.displayName}</h1>
          </div>
        </div>
        <div className="profile-badges">
          {(() => { const t = tierMeta(seller.identityTier ?? "self-declared");
            return <span className={`badge ${t.chipClass}`} title={t.hint}>{t.label}</span>; })()}
          {seller.ownerRegistered && <span className="badge ok">✓ Profile confirmed</span>}
          {seller.discovered && <span className="badge">Found automatically</span>}
          {!seller.ownerRegistered && !seller.discovered && (
            <span className="badge" title="This provider has not confirmed the directory profile yet. Service records are still checked independently.">
              Profile not confirmed
            </span>
          )}
          {seller.wellKnownDomains?.map((d) => (
            <a key={d} className="badge cci linked"
               href={(d.startsWith("http") ? d : `https://${d}`) + "/.well-known/agent.json"}
               target="_blank" rel="noreferrer">
              🌐 {d.replace(/^https?:\/\//, "")} ↗
            </a>
          ))}
        </div>
        <p className="profile-trust-copy">
          Linked accounts are discovery hints. Only the trust badge above reflects authenticated identity evidence.
        </p>
        <div className="profile-identities">
        {seller.cci.some((b) => b.kind === "web2") ? (
          <ChipGroup label="Linked accounts">
            {seller.cci.filter((b) => b.kind === "web2").map((b) => (
              <CciChip key={b.ref} badge={b} withProof />
            ))}
          </ChipGroup>
        ) : (
          <ChipGroup label="Linked accounts">
            <span className="meta-empty">No linked accounts yet</span>
          </ChipGroup>
        )}
        {seller.cci.some((b) => b.kind === "wallet") && (
          <ChipGroup label="Linked wallets">
            {seller.cci.filter((b) => b.kind === "wallet").map((b) => <CciChip key={b.ref} badge={b} />)}
          </ChipGroup>
        )}
        </div>
        <details className="technical-details profile-technical">
          <summary>View technical identity details</summary>
          <div className="meta">
            <CopyText value={seller.primaryClaim} head={34} tail={8} />
            {" · "}
            <a href={`${EXPLORER}/address/0x${seller.primaryClaim.slice(-64)}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent-strong)" }}>
              Open chain explorer ↗
            </a>
          </div>
        </details>
      </section>

      <div className="stat-row">
        <div className="stat"><div className="n">{seller.reputation.completed}/{seller.reputation.totalAgreements}</div><div className="l">jobs completed</div></div>
        <div className="stat"><div className="n">{activeListingCount}</div><div className="l">service{activeListingCount === 1 ? "" : "s"} available</div></div>
        <div className="stat"><div className="n">{seller.deals.filter((d) => d.refsVerified).length}</div><div className="l">verified receipts</div></div>
      </div>

      <div className="section">
        <div className="section-title"><p className="eyebrow">What they offer</p><h2>Services</h2></div>
        {seller.listings.map((l) => (
          <div key={l.listingId} className="card listing-card" style={{ marginBottom: 12 }}>
            <h3>
              {l.offering.title}{" "}
              {l.status === "revoked" && <span className="badge err">revoked</span>}
            </h3>
            {l.offering.description && (
              <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", margin: "6px 0 10px", maxWidth: 720 }}>
                {l.offering.description}
              </p>
            )}
            <div className="card-meta" style={{ borderTop: "none", paddingTop: 0, marginTop: 0, marginBottom: 10 }}>
              <span className="meta-label">Payment</span>
              <span className="meta-chips">
                {(l.offering.rails ?? l.offering.tags.filter((t) => t.startsWith("pay-"))).map((r) => (
                  <span key={r} className="badge rail" title={r}>{railLabel(r)}</span>
                ))}
              </span>
              {(l.offering.delivery ?? []).length > 0 && (
                <>
                  <span className="meta-label">You receive</span>
                  <span className="meta-chips">
                    {l.offering.delivery!.map((d) => (
                      <span key={d} className="badge" title={d}>{deliveryLabel(d)}</span>
                    ))}
                  </span>
                </>
              )}
              {(l.offering.negotiation ?? []).length > 0 && (
                <>
                  <span className="meta-label">Pricing</span>
                  <span className="meta-chips">
                    {l.offering.negotiation!.map((n) => (
                      <span key={n} className="badge" title={n}>{negotiationLabel(n)}</span>
                    ))}
                  </span>
                </>
              )}
              {l.offering.tags.length > 0 && (
                <>
                  <span className="meta-label">Best for</span>
                  <span className="meta-chips">
                    {l.offering.tags.map((t) => <span key={t} className="badge">{t}</span>)}
                  </span>
                </>
              )}
            </div>
            <details className="technical-details inline-details">
              <summary>Technical listing details</summary>
              <div className="meta">Record <CopyText value={l.anchor.locator} head={24} tail={8} /></div>
            </details>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-title"><p className="eyebrow">Past performance</p><h2>Work history</h2></div>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr><th>Job</th><th>Payment</th><th>Result</th><th>Receipt</th><th></th></tr>
            </thead>
            <tbody>
              {[...seller.deals].sort((a, b) => (b.finalisedAt ?? 0) - (a.finalisedAt ?? 0)).map((d) => (
                <tr key={d.jobId}>
                  <td>
                    <div className="mono" style={{ fontSize: "0.75rem" }}>{d.jobId}</div>
                    <div className="meta">{d.finalisedAt ? new Date(d.finalisedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—"}</div>
                  </td>
                  <td><span className="badge rail">{railLabel(d.rail)}</span></td>
                  <td>{d.outcome === "completed" ? "✓ Completed" : (d.outcome ?? "—")}</td>
                  <td>
                    <span className={`badge ${d.refsVerified ? "ok" : "err"}`}>
                      {d.refsVerified ? "✓ Verified" : d.signatureVerified ? "Partly checked" : "Not verified"}
                    </span>
                  </td>
                  <td>
                    <Link style={{ color: "var(--accent-strong)", fontSize: "0.8rem", fontWeight: 600 }}
                      href={`/deal/${encodeURIComponent(d.buyerBundleRef)}?buyer=${encodeURIComponent(d.owners.buyer)}&seller=${encodeURIComponent(d.owners.seller)}`}>
                      Check receipt →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">Open any receipt to independently check the provider, payment, and result.</p>
      </div>
    </>
  );
}
