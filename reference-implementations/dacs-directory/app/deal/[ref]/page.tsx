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
      <p className="meta"><Link href="/">← all agents</Link></p>
      <h1 className="h1">Deal bundle</h1>
      <div className="meta"><CopyText value={bundleRef} head={30} tail={8} /></div>
      {txRefs.length > 0 && (
        <div className="badges" style={{ marginTop: 10 }}>
          {txRefs.map((t) => (
            <a key={t.txHash} className="badge rail linked" target="_blank" rel="noreferrer"
               href={t.rail === "demos" ? `${EXPLORER}/tx/${t.txHash}` : `https://sepolia.basescan.org/tx/${t.txHash}`}>
              settlement tx · {t.rail} ↗
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
            The seller signed this delivery attestation (DACS-X) over the GitHub state at
            delivery time — state hash <span className="mono">{att.ghStateHash?.slice(0, 16)}…</span>.
            The attestation rides beside the bundle until the SDK can reference it in-bundle.
          </p>
        </div>
      )}

      <div className="section">
        <h2>Anchored artifact (chain state)</h2>
        <pre className="artifact">{raw ? JSON.stringify(raw, null, 2) : "not found on chain"}</pre>
      </div>
    </>
  );
}
