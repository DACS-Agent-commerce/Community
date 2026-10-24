"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useDemosWallet } from "@/src/components/useDemosWallet";
import {
  clearPendingListingPublication,
  readPendingListingPublication,
  writePendingListingPublication,
  type PendingListingPublication,
} from "@/src/components/listing-publication-recovery";
import { safePublicEndpoint } from "@/src/catalog/publicEndpoint";
import { importLegacySignatureValue } from "@/src/catalog/signatureValue";
import {
  negotiationPhaseForPricing,
  publishableRail,
  PUBLISHABLE_PRICING_KINDS,
  PUBLISHABLE_RAIL_OPTIONS,
  type PublishablePricingKind,
} from "@/src/catalog/listingOptions";

const WALLET_URL = "https://chromewebstore.google.com/detail/demos-wallet/nefongcpmdahjaijjkihgieiamoahcoo";
const DELIVERY_OPTIONS = [
  { id: "deliver-attested-payload", label: "Verified result", hint: "A result such as data, analysis, or code with an authenticity attestation." },
  { id: "deliver-storage-program", label: "On-chain result", hint: "The deliverable is stored on-chain or bound to an external payload by hash." },
  { id: "deliver-entitlement", label: "Access or entitlement", hint: "A time-bound API, subscription, quota, or access grant." },
];
const SCREENS = ["Connect", "Describe", "Review", "Publish"];
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

type Screen = "connect" | "describe" | "review" | "publish" | "done";
type PublishStep = "idle" | "building" | "signing" | "anchoring" | "confirming" | "registering" | "failed" | "complete";

type BuiltListing = {
  listing: Record<string, unknown>;
  message?: string;
  contentHash: string;
  logicalAddress: string;
  programName: string;
  anchorAddress: string;
  exists: boolean;
  tx: Record<string, unknown> | null;
  registration: Record<string, unknown> & {
    ownerSignature?: { message?: string; signedAt?: number };
  };
};

export default function Register() {
  const wallet = useDemosWallet();
  const [screen, setScreen] = useState<Screen>("connect");
  const [publishStep, setPublishStep] = useState<PublishStep>("idle");
  const [failedAt, setFailedAt] = useState<PublishStep | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rails, setRails] = useState<string[]>(["demos-native:DEM"]);
  const [category, setCategory] = useState("services.other");
  const [tags, setTags] = useState("");
  const [delivery, setDelivery] = useState(DELIVERY_OPTIONS[0].id);
  const [pricingKind, setPricingKind] = useState<PublishablePricingKind>("fixed");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("DEM");
  const [unit, setUnit] = useState("per-job");
  const [minTotal, setMinTotal] = useState("");
  const [minPct, setMinPct] = useState("20");
  const [maxPct, setMaxPct] = useState("20");
  const [selectionRule, setSelectionRule] = useState<"lowest-price" | "highest-price" | "first-acceptable">("first-acceptable");
  const [publicEndpoint, setPublicEndpoint] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [profileUrl, setProfileUrl] = useState<string | null>(null);
  const [pendingPublication, setPendingPublication] = useState<PendingListingPublication | null>(null);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const operationInFlight = useRef(false);

  useEffect(() => {
    setPendingPublication(readPendingListingPublication(window.localStorage));
    setRecoveryLoaded(true);
  }, []);

  const claim = wallet.address ? `did:demos:agent:${wallet.address.replace(/^0x/, "").toLowerCase()}` : null;
  const slug = serviceId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const selectedRail = publishableRail(rails[0] ?? "");
  const tagValues = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  const validTags = tagValues.length <= 16 && tagValues.every((tag) => tag.length <= 32);
  const validAmount = CANONICAL_DECIMAL.test(amount.trim()) && Number(amount) > 0;
  const validCurrency = /^[A-Za-z0-9._:-]{1,32}$/.test(currency.trim());
  const validMinimum = !minTotal.trim() || (CANONICAL_DECIMAL.test(minTotal.trim()) && Number(minTotal) > 0);
  const validNegotiation = pricingKind !== "negotiable" || (
    Number.isFinite(Number(minPct)) && Number(minPct) >= 0 && Number(minPct) < 100 &&
    Number.isFinite(Number(maxPct)) && Number(maxPct) >= 0
  );
  const validEndpoint = !publicEndpoint.trim() || Boolean(safePublicEndpoint(publicEndpoint.trim()));
  const validationIssues = [
    !name.trim() ? "service title" : null,
    !description.trim() ? "buyer outcome" : null,
    !slug || slug.length > 64 ? "service ID (maximum 64 characters)" : null,
    !selectedRail || !delivery ? "payment and delivery choices" : null,
    !validAmount ? "canonical positive price, such as 1 or 0.25" : null,
    !validCurrency ? "currency or asset identifier" : null,
    pricingKind === "metered" && (!unit.trim() || unit.trim().length > 64) ? "metered unit" : null,
    pricingKind === "metered" && !validMinimum ? "canonical positive minimum total" : null,
    !validNegotiation ? "valid negotiation percentages" : null,
    !validTags ? "at most 16 tags of 32 characters each" : null,
    !validEndpoint ? "HTTPS agent endpoint without embedded credentials" : null,
  ].filter((issue): issue is string => Boolean(issue));
  const validDescription = validationIssues.length === 0;
  const activeIndex = screen === "connect" ? 0 : screen === "describe" ? 1 : screen === "review" ? 2 : 3;
  const priceTermPreview = { amount, currency, ...(pricingKind !== "metered" && unit ? { unit } : {}) };
  const pricingPreview = pricingKind === "negotiable"
    ? { kind: pricingKind, bandCenter: priceTermPreview, minPct: Number(minPct), maxPct: Number(maxPct) }
    : pricingKind === "auction"
      ? { kind: pricingKind, reservePrice: priceTermPreview, selectionRule }
      : pricingKind === "metered"
        ? {
            kind: pricingKind, unitPrice: { amount, currency }, unit,
            ...(minTotal.trim() ? { minTotal: { amount: minTotal.trim(), currency } } : {}),
          }
        : { kind: pricingKind, price: priceTermPreview };
  const negotiationPhase = negotiationPhaseForPricing(pricingKind);

  const savePending = (pending: PendingListingPublication): boolean => {
    const saved = writePendingListingPublication(window.localStorage, pending);
    if (saved) setPendingPublication(pending);
    return saved;
  };

  const confirmAnchoredListing = async (
    pending: PendingListingPublication,
    onStep?: (step: PublishStep) => void,
  ): Promise<void> => {
    onStep?.("confirming");
    setPublishStep("confirming");
    setStatus("Waiting for the exact signed listing to become readable and independently verifiable…");
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0 && attempt % 4 === 0) {
        setStatus(`The listing is still finalising on-chain. Verification check ${attempt + 1} of 20; no new transaction will be sent.`);
      }
      const response = await fetch("/api/dacs/confirm-listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anchorAddress: pending.anchorAddress,
          programName: pending.programName,
          contentHash: pending.contentHash,
          sellerClaim: pending.claim,
          listingId: pending.listingId,
          listingVersion: pending.listingVersion,
        }),
      });
      const body = await response.json();
      if (response.ok && body.confirmed === true) return;
      if (response.status !== 202) {
        throw new Error(body.error ?? "The anchored listing failed independent verification.");
      }
      if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    throw new Error("The exact listing is not visible yet. No new transaction was sent; use Check chain and resume to follow this same anchor.");
  };

  const registerPendingListing = async (
    pending: PendingListingPublication,
    onStep?: (step: PublishStep) => void,
  ): Promise<void> => {
    const registering = { ...pending, stage: "registering" as const };
    if (!savePending(registering)) {
      throw new Error("This browser cannot preserve the listing recovery record, so directory registration was not attempted.");
    }
    onStep?.("registering");
    setPublishStep("registering");
    setStatus("One final wallet signature connects this verified listing to the directory.");
    const prepared = await fetch("/api/dacs/prepare-registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registering.registration),
    });
    const preparedBody = await prepared.json();
    if (!prepared.ok) throw new Error(preparedBody.error ?? "Could not prepare the directory registration.");
    const registration = preparedBody.registration as Record<string, unknown> & {
      ownerSignature?: { message?: string; signedAt?: number };
    };
    const message = registration.ownerSignature?.message;
    if (!message) throw new Error("The directory returned no registration signing message.");
    const registrationSignature = await wallet.sign(message);
    if (!registrationSignature) throw new Error(wallet.error ?? "The directory registration signature was declined.");
    const signedRegistration = {
      ...registration,
      ownerSignature: {
        ...registration.ownerSignature,
        signature: registrationSignature.replace(/^(0x)+/i, ""),
      },
    };
    const registered = await fetch("/api/dacs/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedRegistration),
    });
    const registeredBody = await registered.json();
    if (!registered.ok) throw new Error(registeredBody.error ?? "Directory registration failed.");

    clearPendingListingPublication(window.localStorage);
    setPendingPublication(null);
    setPublishStep("complete");
    setStatus("Your signed listing is anchored, independently verified, and queued for the next index pass.");
    setProfileUrl(`/seller/${encodeURIComponent(pending.claim)}`);
    setScreen("done");
  };

  const finishPendingPublication = async (
    pending: PendingListingPublication,
    onStep?: (step: PublishStep) => void,
  ): Promise<void> => {
    await confirmAnchoredListing(pending, onStep);
    const confirmed = { ...pending, stage: "registering" as const };
    if (!savePending(confirmed)) {
      throw new Error("The listing verified, but this browser cannot preserve its recovery record; directory registration was not attempted.");
    }
    await registerPendingListing(confirmed, onStep);
  };

  const resumePublication = async () => {
    if (!claim || !pendingPublication || pendingPublication.claim !== claim || operationInFlight.current) return;
    operationInFlight.current = true;
    setScreen("publish");
    setStatus(null); setFailedAt(null);
    let activeStep: PublishStep = "confirming";
    try {
      // Re-verify on every resume even when the prior browser session had
      // already reached registration; persisted client state is only a hint.
      await finishPendingPublication(pendingPublication, (step) => { activeStep = step; });
    } catch (error) {
      setFailedAt(activeStep);
      setPublishStep("failed");
      setStatus((error as Error).message);
    } finally {
      operationInFlight.current = false;
    }
  };

  const publish = async () => {
    if (!claim || !validDescription || pendingPublication || operationInFlight.current) return;
    operationInFlight.current = true;
    setScreen("publish");
    setStatus(null); setFailedAt(null);
    let activeStep: PublishStep = "building";
    try {
      setPublishStep("building");
      const listingInput = {
        claim, serviceId: slug, name: name.trim(), description: description.trim(), rails,
        delivery: [delivery], category: category.trim(), publicEndpoint: publicEndpoint.trim() || undefined,
        tags: tagValues,
        pricing: {
          kind: pricingKind, amount: amount.trim(), currency: currency.trim(), unit: unit.trim() || undefined,
          minTotal: minTotal.trim() || undefined, minPct: Number(minPct), maxPct: Number(maxPct), selectionRule,
        },
      };
      const identityBuild = await fetch("/api/dacs/build-listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(listingInput),
      });
      const identityDraft = await identityBuild.json();
      if (!identityBuild.ok) throw new Error(identityDraft.error);

      activeStep = "signing"; setPublishStep("signing");
      setStatus("First, bind the seller identity to this listing.");
      const identitySignature = await wallet.sign(identityDraft.identityMessage);
      if (!identitySignature) throw new Error(wallet.error ?? "The identity presentation signature was declined.");
      const build = await fetch("/api/dacs/build-listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...listingInput,
          identityPresentedAt: identityDraft.identityPresentedAt,
          identitySignature,
        }),
      });
      const built = await build.json();
      if (!build.ok) throw new Error(built.error);
      const publication = built as BuiltListing;
      const { ownerSignature: _ownerSignature, ...unsignedRegistration } = publication.registration;
      let signedListing = publication.listing;
      let transaction = publication.tx;
      if (!publication.exists) {
        if (!publication.message || !transaction) throw new Error("The listing builder returned an incomplete create transaction.");
        setStatus("Now approve the complete structured listing.");
        const signature = await wallet.sign(publication.message);
        if (!signature) throw new Error(wallet.error ?? "The listing signature was declined.");
        // The wallet returns hex; a ListingSignature value is unpadded Base64URL (CORE SIG-6).
        const value = importLegacySignatureValue(signature.replace(/^0x/i, "").toLowerCase(), "lowercase-hex");
        if (!value) throw new Error("The wallet returned a listing signature that is not a 64-byte Ed25519 signature.");
        signedListing = {
          ...publication.listing,
          signature: { algorithm: "ed25519", signer: claim, value },
        };
        transaction = structuredClone(transaction);
        const content = transaction.content as Record<string, unknown> | undefined;
        const data = content?.data;
        if (!Array.isArray(data) || !data[1] || typeof data[1] !== "object" || Array.isArray(data[1])) {
          throw new Error("The listing builder returned an invalid StorageProgram transaction.");
        }
        (data[1] as Record<string, unknown>).data = signedListing;
      }
      const listingVersion = Number(signedListing.listingVersion);
      if (!Number.isSafeInteger(listingVersion) || listingVersion < 1) {
        throw new Error("The listing builder returned an invalid listing version.");
      }
      let pending: PendingListingPublication = {
        version: 1,
        claim,
        listingId: slug,
        listingVersion,
        anchorAddress: publication.anchorAddress,
        programName: publication.programName,
        contentHash: publication.contentHash,
        signedListing,
        transaction,
        registration: unsignedRegistration,
        stage: publication.exists ? "confirming" : "broadcast-uncertain",
        createdAt: Date.now(),
      };
      if (!savePending(pending)) {
        throw new Error("This browser cannot durably save the listing recovery record, so no on-chain transaction was sent.");
      }

      if (!publication.exists) {
        activeStep = "anchoring"; setPublishStep("anchoring");
        setStatus("Approve the on-chain anchor transaction. Its recovery coordinates are already saved in this browser.");
        const sent = await wallet.send(transaction);
        if (!sent) throw new Error(wallet.error ?? "The anchor transaction was not acknowledged; check this same anchor before trying anything else.");
        pending = { ...pending, stage: "confirming" };
        if (!savePending(pending)) {
          throw new Error("The transaction was sent, but this browser could not update its recovery record. Do not publish again; preserve this page and check the anchor.");
        }
      } else {
        setStatus("Recovered the existing immutable listing version; no new chain transaction will be sent.");
      }

      activeStep = "confirming";
      await finishPendingPublication(pending, (step) => { activeStep = step; });
    } catch (error) {
      setFailedAt(activeStep);
      setPublishStep("failed");
      setStatus((error as Error).message);
    } finally {
      operationInFlight.current = false;
    }
  };

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
  </section>;
}
