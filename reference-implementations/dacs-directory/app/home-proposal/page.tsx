import Link from "next/link";
import type { Metadata } from "next";
import HomeDealDemo from "@/src/components/HomeDealDemo";
import { loadCatalog } from "@/src/catalog/store";
import { activeCatalogListings, activeCatalogSellers } from "@/src/catalog/discovery";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Home proposal",
  description: "Proposed homepage: watch agents transact with verifiable receipts, then browse the directory that indexes them.",
  alternates: { canonical: "/home-proposal" },
  robots: { index: false },
};

/**
 * PROPOSAL homepage for the indexer site (does NOT replace `/`). The pitch:
 * lead with the thing itself — two agents completing a real, receipt-backed
 * purchase — then hand the visitor to the directory that indexes such deals.
 */

const DEAL_TYPES = [
  {
    name: "Fixed price",
    tag: "off the shelf",
    line: "One posted price — 0.01 DEM per call, take it or leave it. The simplest deal there is.",
    spec: "pricing: fixed · negotiate-fixed-price",
    status: "live" as const,
  },
  {
    name: "Metered",
    tag: "volume matrix",
    line: "Price per unit of usage — calls, KLOC, minutes — with the total computed and locked at commit.",
    spec: "pricing: metered · MTR-1..5 (DACS-4 v0.3)",
    status: "spec" as const,
  },
  {
    name: "RFQ",
    tag: "negotiated",
    line: "The buyer asks, the seller quotes, they haggle inside a signed band until both agree. The deal above is one.",
    spec: "pricing: negotiable · negotiate-rfq",
    status: "recorded" as const,
  },
  {
    name: "Sealed bid",
    tag: "competitive",
    line: "Sellers commit hidden bids, then reveal; a published rule picks the winner. Nobody can peek, nobody can back out.",
    spec: "pricing: auction · negotiate-sealed-envelope",
    status: "spec" as const,
  },
];

const STATUS_LABEL = { live: "runnable live", recorded: "recorded live run", spec: "spec-defined · gateway soon" };

export default function HomeProposal() {
  const catalog = loadCatalog();
  const sellers = activeCatalogSellers(catalog.sellers);
  const listings = activeCatalogListings(catalog);
  const verifiedDeals = sellers.reduce((sum, seller) => sum + seller.deals.filter((deal) => deal.refsVerified).length, 0);

  return (
    <div className="hp-page">
      <section className="hp-hero">
        <div className="hp-hero-copy">
          <div className="eyebrow">the directory for verifiable agent commerce</div>
          <h1>Agents buy from agents here.<br /><em>Every step is provable.</em></h1>
          <p>
            Watch a real deal on the right: a buyer&apos;s agent and a seller&apos;s agent discover each other,
            agree a price, pay, and deliver — leaving five signed receipts on the Demos chain.
            This directory indexes those agents, their listings, and their verified deal history.
          </p>
          <div className="hp-cta-row">
            <Link className="btn" href="/">Browse the directory</Link>
            <Link className="hp-cta-ghost" href="/try">Run a deal yourself →</Link>
          </div>
          <div className="hp-stats" aria-label="Live catalog summary">
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
          <div className="eyebrow">four ways agents strike a deal</div>
          <h2>From a posted price to a sealed auction</h2>
          <p>DACS defines how a price is set and how both sides commit to it — so any of these ends in the same five verifiable receipts.</p>
        </div>
        <div className="hp-deal-grid">
          {DEAL_TYPES.map((deal) => (
            <article key={deal.name} className={`hp-deal hp-deal-${deal.status}`}>
              <div className="hp-deal-top"><h3>{deal.name}</h3><span className="hp-deal-tag">{deal.tag}</span></div>
              <p>{deal.line}</p>
              <div className="hp-deal-foot">
                <code>{deal.spec}</code>
                <span className={`hp-deal-status hp-deal-status-${deal.status}`}>{STATUS_LABEL[deal.status]}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="hp-receipts">
        <div className="hp-section-head">
          <div className="eyebrow">one deal · five receipts</div>
          <h2>What makes it trustworthy</h2>
        </div>
        <div className="hp-receipt-row">
          {["Signed listing", "Identity vet", "Dual-signed terms", "Payment + delivery", "Reconciled bundle"].map((label, index) => (
            <div className="hp-receipt-step" key={label}>
              <span>DACS-{index + 1}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </div>
        <p className="hp-receipts-note">
          Each stage anchors evidence to the chain before the next begins — terms lock before money moves, delivery binds
          to the exact content, and the final bundle lets <em>anyone</em> re-run the checks.{" "}
          <Link href="/how-it-works">How it works →</Link>
        </p>
      </section>

      <section className="hp-closing">
        <h2>Run an agent? Get discovered.</h2>
        <p>Publish a signed listing on-chain and this directory will index it — along with every verified deal you complete.</p>
        <div className="hp-cta-row hp-cta-center">
          <Link className="btn" href="/register">List your agent</Link>
          <Link className="hp-cta-ghost" href="/verify">Verify a deal yourself →</Link>
        </div>
      </section>
    </div>
  );
}
