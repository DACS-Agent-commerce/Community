"use client";
/**
 * In-browser deal verification — the directory's thesis feature.
 *
 * The catalog's numbers are §6.3.6 hints. This component repeats strict bundle
 * signer coverage plus referenced-artifact signature/hash checks in-browser.
 * Bytes arrive through /api/dacs/artifact, so this is cryptographic consistency
 * verification rather than an independent chain-inclusion proof. The checks,
 * verdict and labels live in verifyDealModel.ts; this file only renders them.
 */
import { useState } from "react";
// Side-effect: patches the browser Buffer polyfill with base64url support
// (the SDK decodes signature bytes with Buffer.from(x, "base64url")).
import "@/src/shims/buffer";
// The model imports ONLY pure modules: the package barrel re-exports createAgent, whose
// lazy `import("../substrate")` gets statically traced by Next's bundler and
// drags demosdk (node-only) into the client bundle. (SDK finding: a pure
// "./verify" subpath export would fix this properly — see dacs-sdk#14.)
import type { BundleVerification } from "@/vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
import {
  detailRows,
  verdictPresentation,
  verificationErrorMessage,
  verifyDealInBrowser,
  type DealVerdict,
  type RegisteredBundleRefs,
} from "./verifyDealModel";

async function fetchArtifact(params: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`/api/dacs/artifact?${params}`);
  const json = (await res.json()) as { value: Record<string, unknown> | null };
  return json.value ?? null;
}

async function registeredBundleRefs(jobId: string, bundleRef: string): Promise<RegisteredBundleRefs> {
  try {
    const res = await fetch(`/api/dacs/deal-owners?jobId=${encodeURIComponent(jobId)}&bundleRef=${encodeURIComponent(bundleRef)}`);
    if (!res.ok) return null;
    return await res.json() as RegisteredBundleRefs;
  } catch {
    return null;
  }
}

export default function VerifyDeal({
  bundleRef,
  buyerOwner,
  expectedSeller,
}: {
  bundleRef: string;
  buyerOwner: string;
  expectedSeller?: string;
}) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<BundleVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<DealVerdict | null>(null);

  const run = async () => {
    setState("running"); setError(null); setResult(null); setVerdict(null);
    try {
      const outcome = await verifyDealInBrowser({ bundleRef, buyerOwner, expectedSeller }, { fetchArtifact, registeredBundleRefs });
      setResult(outcome.result);
      setVerdict(outcome.verdict);
      setState("done");
    } catch (cause) {
      setError(verificationErrorMessage(cause)); setState("error");
    }
  };

  const shown = result ? verdictPresentation(result, verdict) : null;
  const rows = result ? detailRows(result) : null;
  return (
    <div aria-live="polite">
      <button className="btn" onClick={run} disabled={state === "running"}>
        {state === "running" ? "Verifying in your browser…" : "Verify this deal in your browser"}
      </button>
      {state === "running" && (
        <ul className="progress-list" aria-label="Verification progress">
          <li className="complete"><span aria-hidden>✓</span>Load the anchored bundle</li>
          <li className="current"><span aria-hidden>●</span>Check signatures and referenced hashes</li>
          <li><span aria-hidden>○</span>Produce a plain-language verdict</li>
        </ul>
      )}
      {error && <div className="verification-summary err" role="alert"><h3>Could not verify</h3><p>{error}</p></div>}
      {shown && rows && (
        <>
          <div className={`verification-summary ${shown.tone}`}>
            <h3>{shown.headline}</h3>
            <p>{shown.summary}</p>
            <p className="mono">checked {new Date().toLocaleString()}</p>
          </div>
          <ul className="trust-checks" aria-label="Plain-language verification results">
            {shown.checks.map((check) => (
              <li key={check.label}>
                <span className={check.ok ? "check ok" : "check"}>{check.mark}</span>
                <div><strong>{check.label}</strong><p>{check.detail}</p></div>
              </li>
            ))}
          </ul>
          <details className="technical-disclosure">
            <summary>Technical checks and identifiers</summary>
            <div className="table-scroll" role="region" aria-label="Detailed verification checks" tabIndex={0}>
            <table>
            <thead><tr><th>What we checked</th><th>Result</th></tr></thead>
            <tbody>
              {rows.signatures.map((row) => (
                <tr key={row.key}>
                  <td>
                    {row.title} {row.text}
                    <div className="mono meta" style={{ marginTop: 2 }}>{row.id}</div>
                  </td>
                  <td><span className={`badge ${row.ok ? "ok" : "err"}`}>{row.badge}</span></td>
                </tr>
              ))}
              {rows.refs.map((row) => (
                <tr key={row.key}>
                  <td>
                    <strong>{row.title}</strong>{" "}{row.text}
                    <div className="mono meta" style={{ marginTop: 2 }}>{row.id}</div>
                  </td>
                  <td><span className={`badge ${row.ok ? "ok" : "err"}`}>{row.badge}</span></td>
                </tr>
              ))}
            </tbody>
            </table>
            </div>
          </details>
          <div className="card" style={{ marginTop: 14, background: "var(--bg-tinted)" }}>
            <h3>What this verdict does not prove</h3>
            <p className="note">
            These checks ran <em>in your browser</em>, but the records were fetched through this
            website because the Demos RPC is not browser-accessible. This proves internal
            signature/hash consistency; it does <strong>not</strong> independently prove that the
            server returned the bytes currently stored at the claimed chain addresses.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
