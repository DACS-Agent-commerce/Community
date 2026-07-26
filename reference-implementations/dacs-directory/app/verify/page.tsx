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
      <div className="eyebrow">independent check</div>
      <h1 className="h1">Verify any deal</h1>
      <p className="sub">
        Paste a deal id (from any agent&apos;s ledger) or an AttestationBundle storage
        address. Verification runs in your browser; a full verified verdict also requires
        the directory&apos;s registered address-to-role binding. Unregistered bundles can be
        inspected, but cannot receive a strict pass because anchoredByRole is intentionally unsigned.
      </p>
      <div className="card" style={{ maxWidth: 680 }}>
        <div className="form-field">
          <label htmlFor="deal-reference">Deal ID or bundle address</label>
          <input id="deal-reference" className="form-control mono" placeholder="live-… or stor-…"
            value={ref} onChange={(e) => setRef(e.target.value)} />
          <span className="field-hint">Use the deal ID shown in a seller ledger or the bundle&apos;s storage address.</span>
        </div>
        {needBuyer && (
          <div className="form-field">
            <label htmlFor="buyer-claim">Buyer claim</label>
            <input id="buyer-claim" className="form-control mono" placeholder="did:demos:agent:…"
              value={manualBuyer} onChange={(e) => setManualBuyer(e.target.value)} />
            <span className="field-hint">Only needed when the buyer cannot be derived from the bundle or catalog.</span>
          </div>
        )}
        <button className="btn" style={{ marginTop: 14 }} onClick={load} disabled={busy || !ref.trim()}>
          {busy ? "Loading from chain…" : "Load deal"}
        </button>
        {err && <div className="verification-summary err" role="alert"><h3>Could not load this deal</h3><p>{err}</p></div>}
      </div>
      {loaded && (
        <div className="section">
          <div className="badges" style={{ marginBottom: 10 }}>
            {loaded.jobId && <span className="badge"><b>deal</b><span className="mono">{loaded.jobId}</span></span>}
            {loaded.outcome && <span className={`badge ${loaded.outcome === "completed" ? "ok" : ""}`}>{loaded.outcome}</span>}
            <span className="badge"><b>buyer</b><span className="mono">{loaded.buyer.slice(0, 26)}…</span></span>
          </div>
          <VerifyDeal bundleRef={loaded.ref} buyerOwner={loaded.buyer} />
        </div>
      )}
    </>
  );
}
