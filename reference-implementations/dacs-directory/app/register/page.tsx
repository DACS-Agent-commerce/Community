"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  discardPendingListingPublication, readSavedListingPublication,
  type SavedListingPublication,
} from "../../src/components/listing-publication-recovery";
import { describeSavedAnchorCheck, readSavedAnchorStatus, savedAnchorAllowsDiscard, type SavedAnchorCheck } from "../../src/components/saved-anchor-check";

export default function Register() {
  const [saved, setSaved] = useState<SavedListingPublication | null>(null);
  const [observation, setObservation] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ check: SavedAnchorCheck; raw: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const pending = saved?.pending ?? null;
  const discardable = Boolean(saved && checked && savedAnchorAllowsDiscard(checked.check, checked.raw, saved.raw));
  useEffect(() => { setSaved(readSavedListingPublication(localStorage)); }, []);

  async function checkSavedAnchor() {
    if (!saved) return;
    setChecking(true);
    setChecked(null);
    setAcknowledged(false);
    const check = await readSavedAnchorStatus(saved.pending.anchorAddress);
    setObservation(describeSavedAnchorCheck(check));
    setChecked({ check, raw: saved.raw });
    setChecking(false);
  }

  async function discard() {
    if (!saved || !discardable || !acknowledged) return;
    const outcome = await discardPendingListingPublication(localStorage, saved, "locks" in navigator ? navigator.locks : undefined);
    if (outcome === "discarded") {
      setSaved(null);
      return;
    }
    if (outcome === "failed") {
      setObservation("The browser could not remove the recovery record. Try again.");
      return;
    }
    setSaved(readSavedListingPublication(localStorage));
    setChecked(null);
    setAcknowledged(false);
    setObservation("The saved record changed in another tab and was kept. Check it again before discarding.");
  }

  return <section className="section card">
    <div className="eyebrow">existing chain listings</div>
    <h1>Submit listing pointers</h1>
    <p>The browser publisher is unavailable in this release. Publish through a DACS client that verifies rail authority and a finalized anchor receipt.</p>
    <p>For an existing listing, submit its primary claim and storage addresses to <code>POST /api/dacs/register</code>. The Directory queues discovery hints and independently verifies the chain artifacts during indexing.</p>
    <p>Submitting pointers does not confirm publication or make a listing active.</p>
    <Link href="#registration-api" className="btn">Read the registration API</Link>
    <section id="registration-api" aria-labelledby="registration-api-title">
      <h2 id="registration-api-title">Registration API</h2>
      <p>Send JSON with <code>Content-Type: application/json</code>. A minimal pointer set is:</p>
      <pre>{JSON.stringify({ primaryClaim: "did:demos:agent:<64 lowercase hex>", displayName: "My agent", listingAnchors: ["stor-<40 lowercase hex>"] }, null, 2)}</pre>
      <p><code>listingAnchors</code> accepts up to 32 addresses. Optional <code>deals</code> (up to 200) carry <code>jobId</code>, <code>rail</code>, <code>buyerBundleRef</code>, optional <code>sellerBundleRef</code> and <code>owners: {"{ buyer, seller }"}</code>. Optional <code>bundleBindings</code> carry up to 256 DACS-5 BB-4 verified bindings.</p>
      <p>A first submission may be unsigned. Every update to an existing claim requires its owner's Ed25519 signature; unsigned updates return 403. To sign:</p>
      <ol>
        <li>POST the unsigned pointer set to <code>/api/dacs/prepare-registration</code>.</li>
        <li>Sign the exact UTF-8 <code>registration.ownerSignature.message</code> with the key named by <code>primaryClaim</code>. Keep the returned message, signedAt and pointer fields unchanged.</li>
        <li>Add the signature as <code>registration.ownerSignature.signature</code> (hex or Base64URL), then POST that complete <code>registration</code> to <code>/api/dacs/register</code> within ten minutes.</li>
      </ol>
      <p>A successful response has <code>ok: true, queued: true</code>. Invalid or stale signatures return 400. The next indexing pass independently verifies each anchor.</p>
      <h3>Generate .well-known files</h3>
      <p>GET <code>/api/dacs/wellknown-files?claim=&lt;primaryClaim&gt;&amp;domain=&lt;hostname&gt;</code> for an indexed seller. Host both returned files byte for byte, then POST <code>{'{"domain":"agent.example"}'}</code> to <code>/api/dacs/register-domain</code>.</p>
    </section>
    {pending && <section aria-labelledby="saved-publication">
      <h2 id="saved-publication">Saved publication recovery</h2>
      <p>Listing {pending.listingId}, version {pending.listingVersion}</p>
      <p><code>{pending.anchorAddress}</code></p>
      <p>This page can check the saved anchor and discard local recovery data. It never signs or sends a transaction.</p>
      <button type="button" className="btn secondary" disabled={checking} onClick={checkSavedAnchor}>Check saved anchor</button>
      {observation && <p role="status">{observation}</p>}
      {discardable && <>
        <label><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /> I understand that discarding recovery data does not cancel a transaction or withdraw a listing.</label>
        <button type="button" className="btn secondary" disabled={!acknowledged} onClick={discard}>Discard local recovery data</button>
      </>}
    </section>}
  </section>;
}
