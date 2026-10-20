"use client";
import React, { useState } from "react";
import { A2A_TRANSPORTS, type A2aTransport } from "@/src/catalog/a2a";
import { applyPublisherSignature, WithdrawalSigningInstructions, type WithdrawalSigning } from "@/src/components/withdrawal-signing";

export interface WellKnownRequest { claim: string; domain: string; a2aEndpoint: string; a2aTransport: string }
export interface OmittedOffer { listingId: string; reason: "absent" | "invalid" | "changed" }
export interface WellKnownExport { files: Record<string, string>; signing: WithdrawalSigning; omitted: OmittedOffer[] }

const OMITTED_REASON: Record<OmittedOffer["reason"], string> = {
  absent: "its anchor is no longer on chain",
  invalid: "its anchor no longer holds a listing",
  changed: "its anchor no longer holds the indexed listing version",
};

export const wellKnownFilesPath = (request: WellKnownRequest): string => `/api/dacs/wellknown-files?${new URLSearchParams({
  claim: request.claim, domain: request.domain.trim(), a2aEndpoint: request.a2aEndpoint.trim(), a2aTransport: request.a2aTransport,
})}`;

/** Never throws: a failed request, an error status or a body that is not the export becomes an error to display. */
export async function requestWellKnownFiles(request: WellKnownRequest, fetchImpl: typeof fetch = fetch): Promise<WellKnownExport | { error: string }> {
  let response: Response;
  try {
    response = await fetchImpl(wellKnownFilesPath(request));
  } catch {
    return { error: "The directory could not be reached. Check your connection and try again." };
  }
  const body = await response.json().catch(() => null) as { error?: unknown; files?: Record<string, string>; withdrawalSigning?: WithdrawalSigning; omitted?: OmittedOffer[] } | null;
  if (!response.ok || !body?.files || !body.withdrawalSigning || !Array.isArray(body.omitted)) {
    return { error: typeof body?.error === "string" ? body.error : `The directory could not generate the files (HTTP ${response.status}).` };
  }
  return { files: body.files, signing: body.withdrawalSigning, omitted: body.omitted };
}

/** Offers left out of the index, and what hosting it signed does to an offer an earlier signed index listed. */
export function OmittedOffers({ omitted }: { omitted: OmittedOffer[] }) {
  if (omitted.length === 0) return null;
  return <div className="verdict err" role="alert">
    <p>Not in this index:</p>
    <ul>{omitted.map((offer) => <li key={offer.listingId}><span className="mono">{offer.listingId}</span>: {OMITTED_REASON[offer.reason] ?? offer.reason}</li>)}</ul>
    <p>Once this index is signed, hosted and crawled, the directory withholds any of these offers that an earlier signed index from this domain listed, until a later signed index lists it again. For a changed anchor, wait for the next index pass and generate again.</p>
  </div>;
}

export function WellKnownFiles({ claim, sign }: { claim: string | null; sign?: (message: string) => Promise<string | null> }) {
  const [domain, setDomain] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [transport, setTransport] = useState<A2aTransport>("JSONRPC");
  const [generated, setGenerated] = useState<WellKnownExport | null>(null);
  const [signed, setSigned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"generating" | "signing" | null>(null);
  const generate = async () => {
    if (!claim) return;
    setBusy("generating"); setError(null); setGenerated(null); setSigned(false);
    try {
      const result = await requestWellKnownFiles({ claim, domain, a2aEndpoint: endpoint, a2aTransport: transport });
      if ("error" in result) setError(result.error); else setGenerated(result);
    } finally {
      setBusy(null);
    }
  };
  const signWithWallet = async () => {
    if (!generated || !sign) return;
    setBusy("signing"); setError(null);
    try {
      const signature = await sign(generated.signing.message);
      if (!signature) throw new Error("The wallet did not sign the index.");
      setGenerated({ ...generated, files: await applyPublisherSignature(generated.files, generated.signing, signature) });
      setSigned(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The wallet signature failed.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="domain-heading">
      <div className="eyebrow">optional</div><h2 id="domain-heading" className="card-section-title">Publish discovery files on your domain</h2>
      <p className="agent-desc">This makes the same listing independently discoverable from your agent&apos;s own domain. The discovery files extend your agent&apos;s A2A agent card, so they need your A2A service endpoint. Without an A2A service, buyers find this listing through this directory.</p>
      <div className="form-field"><label htmlFor="agent-domain">Agent domain</label><input id="agent-domain" className="form-control mono" placeholder="agent.example.com" value={domain} onChange={(event) => setDomain(event.target.value)} /></div>
      <div className="form-field"><label htmlFor="a2a-endpoint">A2A service endpoint</label><input id="a2a-endpoint" className="form-control mono" type="url" placeholder="https://agent.example.com/a2a" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /><span className="field-hint">The HTTPS URL where your agent already serves A2A over the transport below. The directory does not probe it.</span></div>
      <div className="form-field"><label htmlFor="a2a-transport">A2A transport</label><select id="a2a-transport" className="form-control" value={transport} onChange={(event) => setTransport(event.target.value as A2aTransport)}>{A2A_TRANSPORTS.map((option) => <option key={option} value={option}>{option}</option>)}</select></div>
      <button className="btn" type="button" onClick={generate} disabled={busy !== null || !claim || !domain.trim() || !endpoint.trim()}>{busy === "generating" ? "Generating…" : "Generate .well-known files"}</button>
      {error && <p className="verdict err" role="alert">{error}</p>}
      {generated && <OmittedOffers omitted={generated.omitted} />}
      {generated && <WithdrawalSigningInstructions signing={generated.signing} />}
      {generated && sign && <div className="button-row"><button className="btn" type="button" onClick={signWithWallet} disabled={busy !== null || signed}>{signed ? "Signed" : busy === "signing" ? "Waiting for the wallet…" : "Sign with Demos wallet"}</button></div>}
      {signed && <p className="verdict ok" role="status">The signature is in agent.json and agent-card.json. Host all three files byte-exact.</p>}
      {generated && Object.entries(generated.files).map(([path, content]) => <details className="technical-disclosure" key={path}><summary className="mono">{path}</summary><pre className="artifact">{content}</pre></details>)}
    </section>
  );
}
