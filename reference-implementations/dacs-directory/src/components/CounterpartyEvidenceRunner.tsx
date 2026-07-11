"use client";

import { useState } from "react";

type RunResult = {
  mode: string;
  input: {
    subjectName: string;
    lei: string;
    sources: string[];
  };
  receipt: {
    jobId: string;
    subjectHash: string;
    sourceObservationSetHash: string;
    receiptHash: string;
    attestingAgent: { id: string };
    overallResult: {
      status: string;
      checkedSources: string[];
      notCheckedSources: string[];
      limitations: string[];
    };
  };
  verification: {
    ok: boolean;
    current: boolean;
    expiresAt: string;
    checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  };
};

const verdictCopy = (result: RunResult) => {
  if (!result.verification.ok) return {
    className: "err",
    title: "Receipt does not verify",
    detail: result.receipt.overallResult.status,
  };
  if (!result.verification.current) return {
    className: "warn",
    title: "Receipt integrity verifies; freshness expired",
    detail: `Expired ${result.verification.expiresAt} · ${result.mode}`,
  };
  return {
    className: "ok",
    title: "Receipt verifies and is current",
    detail: `${result.receipt.overallResult.status} · ${result.mode}`,
  };
};

export default function CounterpartyEvidenceRunner() {
  const [result, setResult] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dacs/counterparty-evidence/run", { method: "POST" });
      if (!response.ok) throw new Error(`run failed with HTTP ${response.status}`);
      setResult(await response.json() as RunResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card counterparty-runner" aria-labelledby="counterparty-runner-heading">
      <div className="eyebrow">fixture run</div>
      <h2 id="counterparty-runner-heading" className="card-section-title">Run the evidence receipt</h2>
      <p className="agent-desc">
        This preset checks Microsoft Corporation against captured public-source observations and returns a signed receipt.
        It does not perform live spend, live source fetches, certification, or sanctions clearance.
      </p>
      <div className="button-row">
        <button className="btn" type="button" onClick={run} disabled={loading}>
          {loading ? "Running..." : "Run fixture check"}
        </button>
        <a className="btn secondary mono" href="/api/dacs/counterparty-evidence/run">API shape</a>
      </div>
      {error && <div className="verification-summary err" role="status"><h3>Run failed</h3><p>{error}</p></div>}
      {result && (
        <div className="run-output" aria-live="polite">
          <div className={`verification-summary ${verdictCopy(result).className}`}>
            <h3>{verdictCopy(result).title}</h3>
            <p>{verdictCopy(result).detail}</p>
          </div>
          <div className="detail-list compact">
            <div><dt>Subject</dt><dd>{result.input.subjectName} · {result.input.lei}</dd></div>
            <div><dt>Checked</dt><dd>{result.receipt.overallResult.checkedSources.join(", ") || "none"}</dd></div>
            <div><dt>Not checked</dt><dd>{result.receipt.overallResult.notCheckedSources.join(", ") || "none"}</dd></div>
            <div><dt>Receipt</dt><dd className="mono">{result.receipt.receiptHash}</dd></div>
            <div><dt>Signer</dt><dd className="mono">{result.receipt.attestingAgent.id}</dd></div>
          </div>
          <ul className="verify-checks">
            {result.verification.checks.map((check) => (
              <li key={check.id}>
                <span className={`check ${check.ok ? "ok" : ""}`}>{check.ok ? "✓" : "!"}</span>
                <div><strong>{check.label}</strong><p>{check.detail}</p></div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
