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
      <p className="meta"><Link href="/">← all agents</Link></p>
      <h1 className="h1">
        {seller.displayName}{" "}
        {(() => { const t = tierMeta(seller.identityTier ?? (seller.cci.length > 0 ? "verified" : "self-declared"));
          return <span className={`badge ${t.chipClass}`} style={{ verticalAlign: "middle" }} title={t.hint}>{t.label}</span>; })()}{" "}
        {seller.ownerRegistered && <span className="badge ok" style={{ verticalAlign: "middle" }}>owner-registered</span>}{" "}
        {seller.discovered && <span className="badge" style={{ verticalAlign: "middle" }}>discovered on-chain</span>}{" "}
        {!seller.ownerRegistered && !seller.discovered && (
          <span className="badge" style={{ verticalAlign: "middle" }}
                title="Submitted to the directory without a signature from this agent's key. The display name is not owner-attested; the listings below are still verified from chain.">
            unverified submission
          </span>
        )}{" "}
        {seller.wellKnownDomains?.map((d) => (
          <a key={d} className="badge cci linked" style={{ verticalAlign: "middle" }}
             href={(d.startsWith("http") ? d : `https://${d}`) + "/.well-known/agent.json"}
             target="_blank" rel="noreferrer">
            🌐 {d.replace(/^https?:\/\//, "")} ↗
          </a>
        ))}
      </h1>
      <div className="meta">
        <CopyText value={seller.primaryClaim} head={34} tail={8} />
        {" · "}
        <a href={`${EXPLORER}/address/0x${seller.primaryClaim.slice(-64)}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent-strong)" }}>
          explorer ↗
        </a>
      </div>
      <div style={{ marginTop: 14 }}>
        {seller.cci.some((b) => b.kind === "web2") ? (
          <ChipGroup label="verified identities">
            {seller.cci.filter((b) => b.kind === "web2").map((b) => (
              <CciChip key={b.ref} badge={b} withProof />
            ))}
          </ChipGroup>
        ) : (
          <ChipGroup label="verified identities">
            <span className="meta-empty">none — this agent has not linked any identity on-chain</span>
          </ChipGroup>
        )}
        {seller.cci.some((b) => b.kind === "wallet") && (
          <ChipGroup label="linked wallets">
            {seller.cci.filter((b) => b.kind === "wallet").map((b) => <CciChip key={b.ref} badge={b} />)}
          </ChipGroup>
        )}
      </div>
      <p className="note">
        Read from the on-chain identity registry (CCI), never self-reported — names link to
        profiles, <span className="mono">proof↗</span> opens the on-chain ownership proof.
      </p>

      <div className="stat-row">
        <div className="stat"><div className="n">{seller.reputation.completed}/{seller.reputation.totalAgreements}</div><div className="l">deals completed</div></div>
        <div className="stat"><div className="n">{activeListingCount}</div><div className="l">active listing{activeListingCount === 1 ? "" : "s"}</div></div>
        <div className="stat"><div className="n">{seller.deals.filter((d) => d.refsVerified).length}</div><div className="l">chain-verified bundles</div></div>
      </div>

      <div className="section">
        <h2>Listings</h2>
        {seller.listings.map((l) => (
          <div key={l.listingId} className="card" style={{ marginBottom: 12 }}>
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
              <span className="meta-label">pays in</span>
              <span className="meta-chips">
                {(l.offering.rails ?? l.offering.tags.filter((t) => t.startsWith("pay-"))).map((r) => (
                  <span key={r} className="badge rail" title={r}>{railLabel(r)}</span>
                ))}
              </span>
              {(l.offering.delivery ?? []).length > 0 && (
                <>
                  <span className="meta-label">delivers</span>
                  <span className="meta-chips">
                    {l.offering.delivery!.map((d) => (
                      <span key={d} className="badge" title={d}>{deliveryLabel(d)}</span>
                    ))}
                  </span>
                </>
              )}
              {(l.offering.negotiation ?? []).length > 0 && (
                <>
                  <span className="meta-label">negotiation</span>
                  <span className="meta-chips">
                    {l.offering.negotiation!.map((n) => (
                      <span key={n} className="badge" title={n}>{negotiationLabel(n)}</span>
                    ))}
                  </span>
                </>
              )}
              {l.offering.tags.length > 0 && (
                <>
                  <span className="meta-label">tags</span>
                  <span className="meta-chips">
                    {l.offering.tags.map((t) => <span key={t} className="badge">{t}</span>)}
                  </span>
                </>
              )}
            </div>
            <div className="meta">anchor <CopyText value={l.anchor.locator} head={24} tail={8} /></div>
          </div>
        ))}
      </div>

      <div className="section">
        <h2>Deal ledger</h2>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr><th>Deal</th><th>Rail</th><th>Completed</th><th>Catalog check</th><th></th></tr>
            </thead>
            <tbody>
              {[...seller.deals].sort((a, b) => (b.finalisedAt ?? 0) - (a.finalisedAt ?? 0)).map((d) => (
                <tr key={d.jobId}>
                  <td>
                    <div className="mono" style={{ fontSize: "0.75rem" }}>{d.jobId}</div>
                    <div className="meta">{d.finalisedAt ? new Date(d.finalisedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—"}</div>
                  </td>
                  <td><span className="badge rail">{d.rail}</span></td>
                  <td>{d.outcome === "completed" ? "✓" : (d.outcome ?? "—")}</td>
                  <td>
                    <span className={`badge ${d.refsVerified ? "ok" : "err"}`}>
                      {d.refsVerified ? "sig + refs verified" : d.signatureVerified ? "sig only" : "unverified"}
                    </span>
                  </td>
                  <td>
                    <Link style={{ color: "var(--accent-strong)", fontSize: "0.8rem", fontWeight: 600 }}
                      href={`/deal/${encodeURIComponent(d.buyerBundleRef)}?buyer=${encodeURIComponent(d.owners.buyer)}&seller=${encodeURIComponent(d.owners.seller)}`}>
                      verify yourself →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          “Catalog check” is the indexer’s verdict — advisory per §6.3.6. “Verify yourself” runs the same
          cryptography in <em>your</em> browser against chain state.
        </p>
      </div>
    </>
  );
}
