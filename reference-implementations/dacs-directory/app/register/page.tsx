"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  clearPendingListingPublication, readPendingListingPublication,
  type PendingListingPublication,
} from "../../src/components/listing-publication-recovery";

export default function Register() {
  const [pending, setPending] = useState<PendingListingPublication | null>(null);
  const [observation, setObservation] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setPending(readPendingListingPublication(localStorage)); }, []);

  async function checkSavedAnchor() {
    if (!pending) return;
    setChecking(true);
    setChecked(false);
    try {
      const response = await fetch(`/api/dacs/artifact?ref=${encodeURIComponent(pending.anchorAddress)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("The saved anchor could not be checked. Try again before discarding recovery data.");
      const body = await response.json() as { value?: unknown };
      setObservation(body.value
        ? "The node reports data at the saved anchor. This read does not verify its signatures or finality. Discarding this local record will not withdraw it."
        : "The node reports no readable data at the saved anchor. The earlier send may still have succeeded or may become visible later.");
      setChecked(true);
    } catch (error) {
      setObservation(error instanceof Error ? error.message : "The saved anchor could not be checked.");
    } finally { setChecking(false); }
  }

  function discard() {
    if (!checked || !acknowledged) return;
    clearPendingListingPublication(localStorage);
    if (readPendingListingPublication(localStorage)) {
      setObservation("The browser could not remove the recovery record. Try again.");
      return;
    }
    setPending(null);
  }

  return <section className="section card">
    <div className="eyebrow">existing chain listings</div>
    <h1>Submit listing pointers</h1>
    <p>The browser publisher is unavailable in this release. Publish through a DACS client that verifies rail authority and a finalized anchor receipt.</p>
    <p>For an existing listing, submit its primary claim and storage addresses to <code>POST /api/dacs/register</code>. The Directory queues discovery hints and independently verifies the chain artifacts during indexing.</p>
    <p>Submitting pointers does not confirm publication or make a listing active.</p>
    <Link href="/api/dacs" className="btn">Read the registration API</Link>
    {pending && <section aria-labelledby="saved-publication">
      <h2 id="saved-publication">Saved publication recovery</h2>
      <p>Listing {pending.listingId}, version {pending.listingVersion}</p>
      <p><code>{pending.anchorAddress}</code></p>
      <p>This page can check the saved anchor and discard local recovery data. It never signs or sends a transaction.</p>
      <button type="button" className="btn secondary" disabled={checking} onClick={checkSavedAnchor}>Check saved anchor</button>
      {observation && <p role="status">{observation}</p>}
      {checked && <>
        <label><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /> I understand that discarding recovery data does not cancel a transaction or withdraw a listing.</label>
        <button type="button" className="btn secondary" disabled={!acknowledged} onClick={discard}>Discard local recovery data</button>
      </>}
    </section>}
  </section>;
}
