/** Deal explorer — the anchored bundle, raw, plus in-browser verification. */
import Link from "next/link";
import CopyText from "@/src/components/CopyText";
import VerifyAttestation from "@/src/components/VerifyAttestation";
import VerifyDeal from "@/src/components/VerifyDeal";
import { deriveAnchorAddress, readAnchor } from "@/src/catalog/chain";
import { findProgramAddress } from "@/src/catalog/store";

const EXPLORER = "https://explorer.demos.sh";

/** Pull settlement txRefs out of the bundle's phaseSummary for explorer links. */
function txRefsOf(raw: Record<string, unknown> | null): Array<{ rail: string; txHash: string }> {
  const phases = (raw?.["phaseSummary"] as Array<{ txRefs?: Array<{ rail: string; txHash: string }> }>) ?? [];
  return phases.flatMap((p) => p.txRefs ?? []);
}

export const dynamic = "force-dynamic";

export default async function Deal({
  params,
  searchParams,
}: {
  params: Promise<{ ref: string }>;
  searchParams: Promise<{ buyer?: string; seller?: string }>;
}) {
  const { ref } = await params;
  const { buyer, seller } = await searchParams;
  const bundleRef = decodeURIComponent(ref);

  const raw = await readAnchor(bundleRef);

  // The delivery attestation is a seller-owned sidecar anchor (DACS-X — the
  // bundle can't reference it yet, dacs-sdk#15).
  const jobId = (raw?.["jobId"] as string) ?? "";
  const deliveryName = `dacsx:delivery:${jobId}`;
  const sellerClaim = seller ? decodeURIComponent(seller) : null;
  const attestationAddress = sellerClaim && jobId
    ? findProgramAddress(sellerClaim, deliveryName) ?? deriveAnchorAddress(sellerClaim, deliveryName)
    : null;
  const attestation = attestationAddress ? await readAnchor(attestationAddress) : null;
  const att = attestation as {
    repo?: string; pullNumber?: number; reviewId?: number;
    ghAuthor?: string; deliveredAt?: string; ghStateHash?: string;
  } | null;

  const txRefs = txRefsOf(raw);
  return (
    <>
      <p className="breadcrumb"><Link href="/">← Back to services</Link></p>
      <div className="page-hero compact-hero receipt-hero">
        <p className="eyebrow">Independent proof</p>
        <h1>Job receipt</h1>
        <p className="hero-sub">Check that the provider, payment, and delivered result belong to the same job.</p>
        <details className="technical-details inline-details">
          <summary>Receipt ID</summary>
          <div className="meta"><CopyText value={bundleRef} head={30} tail={8} /></div>
        </details>
      </div>
      {txRefs.length > 0 && (
        <div className="badges" style={{ marginTop: 10 }}>
          {txRefs.map((t) => (
            <a key={t.txHash} className="badge rail linked" target="_blank" rel="noreferrer"
               href={t.rail === "demos" ? `${EXPLORER}/tx/${t.txHash}` : `https://sepolia.basescan.org/tx/${t.txHash}`}>
              View payment · {t.rail} ↗
            </a>
          ))}
        </div>
      )}
      <div className="section">
        <VerifyDeal
          bundleRef={bundleRef}
          buyerOwner={buyer ? decodeURIComponent(buyer) : ""}
          expectedSeller={seller ? decodeURIComponent(seller) : undefined}
        />
      </div>
      {att?.repo && (
        <div className="section card" style={{ background: "var(--bg-tinted)" }}>
          <h3>What was delivered</h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", margin: "6px 0 10px" }}>
            A code review by <span className="mono">@{att.ghAuthor}</span> on{" "}
            <span className="mono">{att.repo}#{att.pullNumber}</span>
            {att.deliveredAt && <> · {new Date(att.deliveredAt).toLocaleString()}</>}
          </p>
          <div className="badges">
            <a className="badge cci linked" target="_blank" rel="noreferrer"
               href={`https://github.com/${att.repo}/pull/${att.pullNumber}#pullrequestreview-${att.reviewId}`}>
              view the review on GitHub ↗
            </a>
            {seller && attestation && (
              <VerifyAttestation attestation={attestation} sellerDid={decodeURIComponent(seller)} />
            )}
          </div>
          <p className="note">
            The provider signed a snapshot of the GitHub review at delivery time.
          </p>
        </div>
      )}

      <details className="technical-details raw-record section">
        <summary>View raw technical record</summary>
        <pre className="artifact">{raw ? JSON.stringify(raw, null, 2) : "Record not found"}</pre>
      </details>
    </>
  );
}
