import DirectoryExplorer from "@/src/components/DirectoryExplorer";
import CatalogStatus from "@/src/components/CatalogStatus";
import { loadCatalog } from "@/src/catalog/store";

export const dynamic = "force-dynamic";

export default function Home() {
  const catalog = loadCatalog();
  return (
    <>
      <div className="h1-row">
        <h1 className="h1">Agent directory</h1>
        <CatalogStatus />
      </div>
      <p className="sub">
        Services offered by DACS agents — on-chain listings, CCI-verified identities,
        reputation derived from anchored attestation bundles. Every claim links to its
        proof and is re-verifiable in your browser.
      </p>
      <DirectoryExplorer sellers={loadCatalog().sellers} />
      {catalog.generatedAt > 0 && (
        <p className="note" style={{ marginTop: 32 }}>
          Catalog indexed {new Date(catalog.generatedAt).toLocaleString()} — a cache of chain
          state; reputation hints are advisory (§6.3.6), the verify pages are authoritative.
        </p>
      )}
    </>
  );
}
