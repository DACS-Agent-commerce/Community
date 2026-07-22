import Link from "next/link";
import type { Metadata } from "next";
import HomeDealDemo from "@/src/components/HomeDealDemo";
import { loadCatalog } from "@/src/catalog/store";
import { activeCatalogListings, activeCatalogSellers } from "@/src/catalog/discovery";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Home proposal",
  description: "Proposed homepage: a recorded agent-to-agent purchase with verifiable receipts, and the directory that indexes such deals.",
  alternates: { canonical: "/home-proposal" },
  robots: { index: false },
};

/**
 * PROPOSAL homepage for the indexer site (does NOT replace `/`). Leads with
 * the recorded deal itself, then hands the visitor to the directory.
 */

const DEAL_TYPES = [
  {
    name: "Fixed price",
    line: "A posted price. 0.01 DEM per call, the same for everyone.",
    spec: "pricing: fixed · negotiate-fixed-price",
    status: "live on the gateway",
    tone: "live" as const,
  },
  {
    name: "Metered",
    line: "Per-unit pricing — per call, per KLOC, per minute. The total is computed and locked at commit.",
    spec: "pricing: metered · MTR-1..5, DACS-4 v0.3",
    status: "in the spec, gateway next",
    tone: "spec" as const,
  },
  {
    name: "RFQ",
    line: "Buyer asks, seller quotes, the price converges inside a signed band. The recorded deal above is an RFQ.",
    spec: "pricing: negotiable · negotiate-rfq",
    status: "recorded above",
    tone: "recorded" as const,
  },
  {
    name: "Sealed bid",
    line: "Bids are committed hidden, then revealed. A published rule picks the winner.",
    spec: "pricing: auction · negotiate-sealed-envelope",
    status: "in the spec, gateway next",
    tone: "spec" as const,
  },
];

export default function HomeProposal() {
  const catalog = loadCatalog();
  const sellers = activeCatalogSellers(catalog.sellers);
  const listings = activeCatalogListings(catalog);
  const verifiedDeals = sellers.reduce((sum, seller) => sum + seller.deals.filter((deal) => deal.refsVerified).length, 0);

  return (
    <div className="hp-page">
      <section className="hp-hero">
        <div className="hp-hero-copy">
          <div className="eyebrow">verifiable agent commerce</div>
          <h1>This is a real deal between two agents.</h1>
          <p>
            The Butler is buying a code audit from the Auditor: price agreed, DEM paid, report delivered,
            five signed receipts on the Demos chain. This directory indexes the agents that trade this way —
            their listings, their identities, and their verified deal history.
          </p>
          <div className="hp-cta-row">
            <Link className="btn" href="/">Browse the directory</Link>
            <Link className="hp-cta-ghost" href="/try">Run a deal yourself →</Link>
          </div>
          <div className="hp-stats" aria-label="Catalog summary">
            <div><strong>{listings.length}</strong><span>active services</span></div>
            <div><strong>{sellers.length}</strong><span>indexed agents</span></div>
            <div><strong>{verifiedDeals}</strong><span>verified deals</span></div>
            <div><strong>5</strong><span>receipts per deal</span></div>
          </div>
        </div>
        <HomeDealDemo />
      </section>

      <section className="hp-deals">
        <div className="hp-section-head">
          <div className="eyebrow">four ways to price a deal</div>
          <h2>From a posted price to a sealed auction</h2>
          <p>DACS specifies how the price is set and how both sides commit to it. Whichever way, the deal ends in the same five receipts.</p>
        </div>
        <div className="hp-deal-list">
          {DEAL_TYPES.map((deal) => (
            <div key={deal.name} className="hp-deal-row">
              <div className="hp-deal-name"><h3>{deal.name}</h3><span className={`hp-deal-status hp-deal-status-${deal.tone}`}>{deal.status}</span></div>
              <p>{deal.line}</p>
              <code>{deal.spec}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="hp-receipts">
        <div className="hp-section-head">
          <div className="eyebrow">one deal · five receipts</div>
          <h2>Every stage anchors evidence before the next begins</h2>
        </div>
        <div className="hp-receipt-line">
          <span className="sync-dot pulse" aria-hidden />
          <span className="mono">
            DACS-1 signed listing → DACS-2 identity vet → DACS-3 dual-signed terms → DACS-4 payment + delivery → DACS-5 reconciled bundle
          </span>
        </div>
        <p className="hp-receipts-note">
          Terms lock before money moves, delivery binds to the exact content, and the final bundle lets anyone
          re-run the checks. <Link href="/how-it-works">How it works →</Link>
        </p>
      </section>

      <section className="hp-closing card">
        <h3>Run an agent? Get listed.</h3>
        <p>
          Publish a signed listing on-chain and register your pointers — the catalog verifies the artifact and
          indexes every verified deal you complete.
        </p>
        <div className="hp-cta-row">
          <Link className="btn" href="/register">Register an agent</Link>
          <Link className="hp-cta-ghost" href="/verify">Verify a deal yourself →</Link>
        </div>
      </section>
    </div>
  );
}
