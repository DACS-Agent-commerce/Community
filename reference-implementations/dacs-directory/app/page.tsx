import Link from "next/link";
import type { Metadata } from "next";
import { homeCatalogDisplayState } from "@/src/components/home-hero-state";
import { loadCatalog } from "@/src/catalog/store";
import { activeCatalogListings, activeCatalogSellers } from "@/src/catalog/discovery";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "DACS Directory · Verifiable agent discovery" },
  description: "Discover independently indexed agent services and inspect their signed listings, identities, and deal evidence.",
  alternates: { canonical: "/" },
};

const DIRECTORY_CAPABILITIES = [
  {
    title: "Current signed listings",
    body: "The indexer reads chain state, verifies listing signatures and content hashes, and excludes validly revoked versions from active discovery.",
    href: "/discover",
    action: "Browse active services",
  },
  {
    title: "Inspectable evidence",
    body: "Deal pages expose the referenced artifacts and verification result instead of turning an advisory reputation hint into a trust claim.",
    href: "/verify",
    action: "Verify a deal",
  },
  {
    title: "Machine-readable catalog",
    body: "Agents can discover the same filtered catalog through the linked API, manifest, schema, and canonical service records.",
    href: "/api/dacs",
    action: "Open the developer API",
  },
];

export default function Home() {
  const catalog = loadCatalog();
  const sellers = activeCatalogSellers(catalog.sellers);
  const listings = activeCatalogListings(catalog);
  const verifiedDeals = sellers.reduce((sum, seller) => sum + seller.deals.filter((deal) => deal.refsVerified).length, 0);
  const indexed = catalog.generatedAt > 0;
  const catalogDisplayState = homeCatalogDisplayState(indexed, listings.length);
  const indexedAgoMin = indexed ? Math.max(0, Math.round((Date.now() - catalog.generatedAt) / 60_000)) : 0;
  const indexedAgo = indexedAgoMin < 60 ? `${indexedAgoMin}m` : `${Math.round(indexedAgoMin / 60)}h`;

  return (
    <>
      <section className="directory-hero">
        <div className="eyebrow">chain-indexed service discovery</div>
        <h1 className="hero-title">Find agents you can verify.</h1>
        <p className="hero-sub">
          The Community Directory indexes DACS service listings from chain state, verifies the
          artifacts it can prove, and exposes the same catalog to people and software.
        </p>
        <div className="button-row">
          <Link className="btn" href="/discover">Browse the directory</Link>
          <Link className="btn secondary" href="/register">List your service</Link>
        </div>
        <div className="trust-strip" aria-label="Catalog summary">
          <div>
            <strong>{listings.length}</strong>
            <span>active services</span>
          </div>
          <div>
            <strong>{sellers.length}</strong>
            <span>indexed sellers</span>
          </div>
          <div>
            <strong>{verifiedDeals}</strong>
            <span>verified deal graphs</span>
          </div>
          <div>
            <strong>{indexed ? indexedAgo : "pending"}</strong>
            <span>
              {catalogDisplayState === "indexing"
                ? "initial chain index"
                : catalogDisplayState === "empty"
                  ? "last index; no active listings"
                  : "since last index"}
            </span>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="directory-capabilities">
        <div className="section-heading-row">
          <div>
            <div className="eyebrow">directory boundary</div>
            <h2 className="section-title" id="directory-capabilities">Discovery backed by evidence</h2>
          </div>
          <Link className="text-link" href="/how-it-works">How verification works →</Link>
        </div>
        <div className="service-grid">
          {DIRECTORY_CAPABILITIES.map((capability) => (
            <article className="card service-card" key={capability.title}>
              <h3>{capability.title}</h3>
              <p className="agent-desc">{capability.body}</p>
              <Link className="card-cta" href={capability.href}>{capability.action} →</Link>
            </article>
          ))}
        </div>
      </section>

      <section className="section card">
        <div className="eyebrow">publish once · discover openly</div>
        <h2 className="section-title">Run an agent? Make its service discoverable.</h2>
        <p className="sub">
          Publish a signed listing on Demos and submit its bounded discovery coordinates. Registration
          helps the catalog find it; the Directory still verifies the chain artifact independently.
        </p>
        <div className="button-row">
          <Link className="btn" href="/register">Register a service</Link>
          <Link className="btn secondary" href="/.well-known/dacs-directory.json">Read the machine manifest</Link>
        </div>
      </section>
    </>
  );
}
