"use client";
/**
 * Verify any deal — ONE input. The buyer's identity (needed to resolve the
 * bundle's owner-scoped referenced artifacts) is read from the bundle itself,
 * or looked up in the catalog for seller-anchored copies; a manual override
 * only appears if both fail.
 */
import { useState } from "react";
import VerifyDeal from "@/src/components/VerifyDeal";

type Loaded = { ref: string; buyer: string; jobId?: string; outcome?: string };

export default function VerifyPage() {
  const [ref, setRef] = useState("");
  const [manualBuyer, setManualBuyer] = useState("");
  const [needBuyer, setNeedBuyer] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true); setErr(null); setLoaded(null); setNeedBuyer(false);
    try {
      let address = ref.trim();
      // Deal ids are what the ledgers show — resolve them to the bundle.
      if (!address.startsWith("stor-")) {
        const o = await fetch(`/api/dacs/deal-owners?jobId=${encodeURIComponent(address)}`).then((r) => r.json());
        if (o?.buyerBundleRef) address = o.buyerBundleRef;
        else throw new Error("that's not a storage address, and no deal in the catalog has that id");
      }
      const res = await fetch(`/api/dacs/artifact?ref=${encodeURIComponent(address)}`);
      const { value } = (await res.json()) as { value: Record<string, unknown> | null };
      if (!value) throw new Error("nothing anchored at that address");
      const jobId = value["jobId"] as string | undefined;
      const outcome = value["outcome"] as string | undefined;

      // 1. buyer named in the bundle itself?
      const parties = (value["parties"] as Array<{ role?: string; primaryClaim?: string }>) ?? [];
      let buyer = parties.find((p) => p.role === "buyer")?.primaryClaim ?? null;

      // 2. seller-anchored copy → the catalog knows the deal's owners.
      if (!buyer && jobId) {
        const o = await fetch(`/api/dacs/deal-owners?jobId=${encodeURIComponent(jobId)}`).then((r) => r.json());
        buyer = o?.owners?.buyer ?? null;
      }
      // 3. manual override as last resort.
      if (!buyer && manualBuyer.trim()) buyer = manualBuyer.trim();
      if (!buyer) {
        setNeedBuyer(true);
        throw new Error("couldn't determine the buyer for this bundle — paste the buyer's claim below and load again");
      }
      setLoaded({ ref: address, buyer, jobId, outcome });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-hero compact-hero">
        <p className="eyebrow">Independent proof</p>
        <h1>Check a job receipt.</h1>
        <p className="hero-sub">
          Enter the receipt or job ID to confirm who was involved, what happened, and whether
          the record is complete. The check runs here in your browser.
        </p>
      </div>
      <div className="card receipt-form" style={{ maxWidth: 640 }}>
        <label htmlFor="receipt-id">Receipt or job ID</label>
        <input id="receipt-id" className="mono" style={inputStyle} placeholder="For example: live-… or stor-…"
          value={ref} onChange={(e) => setRef(e.target.value)} />
        {needBuyer && (
          <>
          <label htmlFor="buyer-claim">Buyer claim</label>
          <input id="buyer-claim" className="mono" style={inputStyle} placeholder="did:demos:agent:… (optional fallback)"
            value={manualBuyer} onChange={(e) => setManualBuyer(e.target.value)} />
          </>
        )}
        <button className="btn" onClick={load} disabled={busy || !ref.trim()}>
          {busy ? "Checking receipt…" : "Check receipt"}
        </button>
        {err && <p className="note" role="alert" style={{ color: "var(--red-strong)", marginTop: 10 }}>✗ {err}</p>}
      </div>
      {loaded && (
        <div className="section">
          <div className="badges" style={{ marginBottom: 10 }}>
            {loaded.jobId && <span className="badge"><b>job</b><span className="mono">{loaded.jobId}</span></span>}
            {loaded.outcome && <span className={`badge ${loaded.outcome === "completed" ? "ok" : ""}`}>{loaded.outcome}</span>}
            <span className="badge"><b>buyer</b><span className="mono">{loaded.buyer.slice(0, 26)}…</span></span>
          </div>
          <VerifyDeal bundleRef={loaded.ref} buyerOwner={loaded.buyer} />
        </div>
      )}
    </>
  );
}
const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", marginBottom: 8, padding: "8px 10px",
  background: "var(--bg-subtle)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 6, fontSize: 12,
};
