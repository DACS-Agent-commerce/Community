"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useDemosWallet } from "@/src/components/useDemosWallet";
import {
  clearPendingListingPublication,
  readPendingListingPublication,
  writePendingListingPublication,
  type PendingListingPublication,
} from "@/src/components/listing-publication-recovery";
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
  const [rails, setRails] = useState<string[]>(["pay-dem"]);
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

  useEffect(() => { setPendingPublication(readPendingListingPublication(window.localStorage)); }, []);

  const claim = wallet.address ? `did:demos:agent:${wallet.address.replace(/^0x/, "").toLowerCase()}` : null;
  const slug = serviceId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const selectedRail = publishableRail(rails[0] ?? "");
  const validDescription = name.trim() && description.trim() && slug && selectedRail && delivery &&
    Number(amount) > 0 && currency.trim() &&
    (pricingKind !== "metered" || (unit.trim() && (!minTotal.trim() || Number(minTotal) > 0)));
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

  const confirmAnchoredListing = async (pending: PendingListingPublication): Promise<void> => {
    setPublishStep("confirming");
    setStatus("Waiting for the exact signed listing to become readable and independently verifiable…");
    for (let attempt = 0; attempt < 20; attempt++) {
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

  const registerPendingListing = async (pending: PendingListingPublication): Promise<void> => {
    const registering = { ...pending, stage: "registering" as const };
    if (!savePending(registering)) {
      throw new Error("This browser cannot preserve the listing recovery record, so directory registration was not attempted.");
    }
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

  const finishPendingPublication = async (pending: PendingListingPublication): Promise<void> => {
    await confirmAnchoredListing(pending);
    const confirmed = { ...pending, stage: "registering" as const };
    if (!savePending(confirmed)) {
      throw new Error("The listing verified, but this browser cannot preserve its recovery record; directory registration was not attempted.");
    }
    await registerPendingListing(confirmed);
  };

  const resumePublication = async () => {
    if (!claim || !pendingPublication || pendingPublication.claim !== claim) return;
    setScreen("publish");
    setStatus(null); setFailedAt(null);
    const activeStep: PublishStep = "confirming";
    try {
      // Re-verify on every resume even when the prior browser session had
      // already reached registration; persisted client state is only a hint.
      await finishPendingPublication(pendingPublication);
    } catch (error) {
      setFailedAt(activeStep);
      setPublishStep("failed");
      setStatus((error as Error).message);
    }
  };

  const publish = async () => {
    if (!claim || !validDescription || pendingPublication) return;
    setScreen("publish");
    setStatus(null); setFailedAt(null);
    let activeStep: PublishStep = "building";
    try {
      setPublishStep("building");
      const listingInput = {
        claim, serviceId: slug, name: name.trim(), description: description.trim(), rails,
        delivery: [delivery], category: category.trim(), publicEndpoint: publicEndpoint.trim() || undefined,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
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
        signedListing = {
          ...publication.listing,
          signature: { algorithm: "ed25519", signer: claim, value: signature.replace(/^(0x)+/i, "") },
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
      await finishPendingPublication(pending);
    } catch (error) {
      setFailedAt(activeStep);
      setPublishStep("failed");
      setStatus((error as Error).message);
    }
  };

  return (
    <div className="form-shell">
      <div className="eyebrow">seller journey</div>
      <h1 className="h1">List a verifiable service</h1>
      <p className="sub">Describe the outcome in plain language, preview exactly what buyers and agents will see, then sign and anchor it with your Demos wallet.</p>

      <ol className="form-stepper" aria-label="Listing progress">
        {SCREENS.map((label, index) => <li key={label} className={index < activeIndex ? "done" : index === activeIndex ? "active" : ""} aria-current={index === activeIndex ? "step" : undefined}>{index + 1}. {label}</li>)}
      </ol>

      {screen === "connect" && (
        <section className="card" aria-labelledby="connect-heading">
          <div className="eyebrow">step 1</div>
          <h2 id="connect-heading" className="card-section-title">Connect the agent&apos;s wallet</h2>
          <p className="agent-desc">The wallet proves ownership of the listing and anchors it on-chain. The directory never receives your private key.</p>
          {wallet.address ? (
            <>
              <div className="badges"><span className="badge ok">connected</span><span className="badge mono">{wallet.address.slice(0, 22)}…</span></div>
              {pendingPublication?.claim === claim ? (
                <div className="recovery-box">
                  <p className="note">A listing publication from this browser is still unresolved. Resume its exact saved anchor; starting another transaction could create a duplicate version.</p>
                  <button className="btn" type="button" onClick={resumePublication}>Check chain and resume</button>
                </div>
              ) : pendingPublication ? (
                <p className="verdict err" role="alert">This browser has an unresolved listing for a different Demos wallet. Reconnect that wallet to recover it before publishing another listing.</p>
              ) : (
                <button className="btn" type="button" onClick={() => setScreen("describe")}>Continue</button>
              )}
            </>
          ) : wallet.available ? (
            <button className="btn" type="button" onClick={wallet.connect} disabled={wallet.connecting}>{wallet.connecting ? "Connecting…" : "Connect Demos wallet"}</button>
          ) : wallet.detecting ? (
            <p className="meta" role="status">Looking for the wallet extension…</p>
          ) : (
            <div className="button-row"><a className="btn" href={WALLET_URL} target="_blank" rel="noreferrer">Install Demos wallet <span aria-hidden>↗</span></a><Link className="btn secondary" href="/how-it-works">Why a wallet?</Link></div>
          )}
          {wallet.error && <p className="verdict err" role="alert">{wallet.error}</p>}
        </section>
      )}

      {screen === "describe" && (
        <section className="card" aria-labelledby="describe-heading">
          <div className="eyebrow">step 2</div>
          <h2 id="describe-heading" className="card-section-title">Describe the buyer&apos;s outcome</h2>
          <div className="form-field"><label htmlFor="listing-title">Service title</label><input id="listing-title" className="form-control" maxLength={200} placeholder="LLM code review for GitHub pull requests" value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="listing-description">What the buyer receives</label><textarea id="listing-description" className="form-control" maxLength={2000} aria-describedby="description-hint" placeholder="A review posted on your pull request within minutes. Include the price or explain how the agent quotes." value={description} onChange={(event) => setDescription(event.target.value)} /><span id="description-hint" className="field-hint">{description.length}/2000 characters · include price, expected input, output, and timing.</span></div>
          <div className="form-field"><label htmlFor="service-id">Service ID</label><input id="service-id" className="form-control mono" aria-describedby="service-id-hint" placeholder="pr-review" value={serviceId} onChange={(event) => setServiceId(event.target.value)} /><span id="service-id-hint" className="field-hint">Stable machine identifier. It will be saved as <span className="mono">{slug || "your-service-id"}</span>.</span></div>
          <div className="form-field"><label htmlFor="category">Category</label><select id="category" className="form-control" value={category} onChange={(event) => setCategory(event.target.value)}><option value="services.code-review">Code review</option><option value="services.inference">AI inference</option><option value="services.research">Research</option><option value="data.finance">Financial data</option><option value="data.sports">Sports data</option><option value="services.other">Other service</option></select></div>
          <div className="form-field"><label htmlFor="tags">Search tags</label><input id="tags" className="form-control" aria-describedby="tags-hint" placeholder="github, code-review, llm" value={tags} onChange={(event) => setTags(event.target.value)} /><span id="tags-hint" className="field-hint">Optional, comma separated, maximum 16; each tag can be 32 characters.</span></div>
          <div className="form-field"><label htmlFor="public-endpoint">Agent endpoint</label><input id="public-endpoint" className="form-control mono" type="url" placeholder="https://agent.example.com/a2a" value={publicEndpoint} onChange={(event) => setPublicEndpoint(event.target.value)} /><span className="field-hint">Optional HTTPS endpoint buyers and agents can use to begin negotiation.</span></div>

          <fieldset className="form-field"><legend className="form-legend">Pricing model</legend><div className="badges">{PUBLISHABLE_PRICING_KINDS.map((kind) => <button key={kind} type="button" aria-pressed={pricingKind === kind} className={`badge filter ${pricingKind === kind ? "active" : ""}`} onClick={() => setPricingKind(kind)}>{kind === "negotiable" ? "negotiation" : kind}</button>)}</div></fieldset>
          <div className="choice-grid">
            <div className="form-field"><label htmlFor="price-amount">{pricingKind === "fixed" ? "Fixed amount" : pricingKind === "negotiable" ? "Negotiation centre" : pricingKind === "auction" ? "Reserve amount" : "Price per unit"}</label><input id="price-amount" className="form-control" inputMode="decimal" placeholder="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
            <div className="form-field"><label htmlFor="price-currency">Currency or asset</label><input id="price-currency" className="form-control mono" maxLength={32} placeholder="DEM or usd-stablecoin" value={currency} onChange={(event) => setCurrency(event.target.value)} /></div>
            <div className="form-field"><label htmlFor="price-unit">{pricingKind === "metered" ? "Metered unit" : "Unit"}</label><input id="price-unit" className="form-control" maxLength={64} placeholder={pricingKind === "metered" ? "API call" : "per-job"} value={unit} onChange={(event) => setUnit(event.target.value)} /></div>
          </div>
          {pricingKind === "metered" && <div className="form-field"><label htmlFor="price-minimum">Minimum total</label><input id="price-minimum" className="form-control" inputMode="decimal" placeholder="Optional" value={minTotal} onChange={(event) => setMinTotal(event.target.value)} /><span className="field-hint">Optional floor in {currency || "the selected currency"}. The agreement total is the greater of this floor or unit price × whole-unit quantity.</span></div>}
          {pricingKind === "negotiable" && <div className="choice-grid">
            <div className="form-field"><label htmlFor="price-min">Maximum discount (%)</label><input id="price-min" className="form-control" type="number" min="0" max="99" value={minPct} onChange={(event) => setMinPct(event.target.value)} /></div>
            <div className="form-field"><label htmlFor="price-max">Maximum uplift (%)</label><input id="price-max" className="form-control" type="number" min="0" value={maxPct} onChange={(event) => setMaxPct(event.target.value)} /></div>
          </div>}
          {pricingKind === "auction" && <div className="form-field"><label htmlFor="selection-rule">Selection rule</label><select id="selection-rule" className="form-control" value={selectionRule} onChange={(event) => setSelectionRule(event.target.value as typeof selectionRule)}><option value="first-acceptable">First acceptable</option><option value="lowest-price">Lowest price</option><option value="highest-price">Highest price</option></select></div>}
          {pricingKind === "negotiable" && <p className="field-hint">The signed RFQ allows up to 8 turns and a 5-minute session timeout.</p>}
          {pricingKind === "auction" && <p className="field-hint">The signed sealed-envelope window closes 7 days after publication, followed by a 1-hour reveal window.</p>}
          {pricingKind === "metered" && <p className="field-hint">Metered listings use deterministic fixed-price acceptance; buyer and seller co-sign the whole-unit quantity and computed total at agreement commit.</p>}

          <fieldset className="form-field"><legend className="form-legend">Payment rail</legend><div className="badges">{PUBLISHABLE_RAIL_OPTIONS.map((option) => <button key={option.railId} type="button" aria-pressed={rails.includes(option.railId)} className={`badge rail filter ${rails.includes(option.railId) ? "active" : ""}`} onClick={() => setRails([option.railId])}>{option.label}</button>)}</div><span className="field-hint">{selectedRail?.availability === "operator_gated" ? "AP2 is operator-gated in v0.1 and requires Stripe provider onboarding; the listing records that rail without claiming it is publicly live." : "The selected rail becomes the signed payment step and accepted rail."}</span></fieldset>
          <fieldset className="form-field"><legend className="form-legend">Delivery type</legend><div className="choice-grid">{DELIVERY_OPTIONS.map((option) => <label key={option.id} className="choice-card"><input type="radio" name="delivery" value={option.id} checked={delivery === option.id} onChange={() => setDelivery(option.id)} /><span><strong>{option.label}</strong><span className="field-hint" style={{ display: "block" }}>{option.hint}</span></span></label>)}</div></fieldset>

          <div className="button-row"><button className="btn secondary" type="button" onClick={() => setScreen("connect")}>Back</button><button className="btn" type="button" disabled={!validDescription} onClick={() => setScreen("review")}>Review listing</button></div>
        </section>
      )}

      {screen === "review" && (
        <section className="card" aria-labelledby="review-heading">
          <div className="eyebrow">step 3</div>
          <h2 id="review-heading" className="card-section-title">Review before signing</h2>
          <p className="agent-desc">This is the service card buyers will discover. The technical identifiers below become part of the signed artifact.</p>
          <div className="card service-card" style={{ background: "var(--bg-subtle)" }}>
            <div className="service-card-topline"><span className="eyebrow">{category.replaceAll(".", " / ")}</span><span className="badge ok">will be signed</span></div>
            <h3>{name}</h3><p className="agent-desc">{description}</p>
            <div className="service-facts"><div><span>pricing</span><strong>{amount} {currency}{unit ? pricingKind === "metered" ? ` per ${unit}` : ` · ${unit}` : ""}{pricingKind === "metered" && minTotal ? ` · ${minTotal} minimum` : ""}</strong></div><div><span>model</span><strong>{pricingKind}{pricingKind === "negotiable" ? ` (-${minPct}% / +${maxPct}%)` : pricingKind === "auction" ? ` · ${selectionRule}` : ""}</strong></div></div>
            <div className="badges">{rails.map((value) => <span className="badge rail" key={value}>{PUBLISHABLE_RAIL_OPTIONS.find((option) => option.railId === value)?.label ?? value}</span>)}<span className="badge">{DELIVERY_OPTIONS.find((option) => option.id === delivery)?.label}</span></div>
            <p className="meta mono">{slug} · {claim}</p>
          </div>
          <details className="technical-disclosure">
            <summary>Preview the machine-readable listing</summary>
            <pre className="artifact">{JSON.stringify({
              dacsVersion: "1", listingId: slug, listingVersion: "assigned at publish",
              seller: { identity: "separately signed IdentityBundle", displayName: name.trim(), publicEndpoint: publicEndpoint || undefined },
              offering: { title: name.trim(), description: description.trim(), category, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), deliverable: delivery.replace("deliver-", "") },
              buyerRequirement: { requirementVersion: "1", required: [] },
              pricing: pricingPreview, acceptedRails: selectedRail ? [{ railId: selectedRail.railId }] : [],
              pipeline: selectedRail ? [
                { kind: negotiationPhase },
                { kind: "commit-agreement" },
                { kind: selectedRail.phaseKind, parameters: { rail: selectedRail.railId } },
                { kind: delivery },
              ] : [],
            }, null, 2)}</pre>
          </details>
          <div className="button-row"><button className="btn secondary" type="button" onClick={() => setScreen("describe")}>Edit details</button><button className="btn" type="button" onClick={publish}>Sign and publish</button></div>
        </section>
      )}

      {(screen === "publish" || screen === "done") && (
        <section className="card" aria-labelledby="publish-heading">
          <div className="eyebrow">step 4</div>
          <h2 id="publish-heading" className="card-section-title">Publish on-chain</h2>
          <ul className="progress-list" aria-live="polite">
            <Progress label="Build the current DACS listing" state={progressState(publishStep, "building", failedAt)} />
            <Progress label="Sign identity and listing" state={progressState(publishStep, "signing", failedAt)} />
            <Progress label="Anchor it on-chain" state={progressState(publishStep, "anchoring", failedAt)} />
            <Progress label="Confirm chain visibility" state={progressState(publishStep, "confirming", failedAt)} />
            <Progress label="Register the catalog pointer" state={progressState(publishStep, "registering", failedAt)} />
          </ul>
          {status && <p className={publishStep === "failed" ? "verdict err" : publishStep === "complete" ? "verdict ok" : "note"} role={publishStep === "failed" ? "alert" : "status"}>{status}</p>}
          {publishStep === "failed" && pendingPublication ? (
            <div className="button-row"><button className="btn" type="button" onClick={resumePublication}>{pendingPublication.stage === "registering" ? "Retry directory registration" : "Check chain and resume"}</button></div>
          ) : publishStep === "failed" ? (
            <div className="button-row"><button className="btn" type="button" onClick={publish}>Retry publish</button><button className="btn secondary" type="button" onClick={() => setScreen("review")}>Review details</button></div>
          ) : null}
          {screen === "done" && profileUrl && <div className="button-row"><Link className="btn" href={profileUrl}>View seller profile</Link><Link className="btn secondary" href="/discover">Browse directory</Link></div>}
        </section>
      )}

      {screen === "done" && <WellKnownFiles claim={claim} />}
    </div>
  );
}

type ProgressState = "waiting" | "current" | "complete" | "failed";

function progressState(current: PublishStep, target: PublishStep, failedAt: PublishStep | null): ProgressState {
  const order: PublishStep[] = ["idle", "building", "signing", "anchoring", "confirming", "registering", "complete"];
  if (current === "failed" && failedAt) {
    const failedIndex = order.indexOf(failedAt);
    const targetIndex = order.indexOf(target);
    return targetIndex < failedIndex ? "complete" : targetIndex === failedIndex ? "failed" : "waiting";
  }
  const currentIndex = order.indexOf(current);
  const targetIndex = order.indexOf(target);
  return currentIndex > targetIndex ? "complete" : currentIndex === targetIndex ? "current" : "waiting";
}

function Progress({ label, state }: { label: string; state: ProgressState }) {
  return <li className={state}><span aria-hidden>{state === "complete" ? "✓" : state === "current" ? "●" : state === "failed" ? "✗" : "○"}</span>{label}</li>;
}

function WellKnownFiles({ claim }: { claim: string | null }) {
  const [domain, setDomain] = useState("");
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    if (!claim) return;
    setBusy(true); setError(null); setFiles(null);
    const response = await fetch(`/api/dacs/wellknown-files?claim=${encodeURIComponent(claim)}&domain=${encodeURIComponent(domain.trim())}`);
    const body = await response.json();
    if (!response.ok) setError(body.error); else setFiles(body.files);
    setBusy(false);
  };
  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="domain-heading">
      <div className="eyebrow">optional</div><h2 id="domain-heading" className="card-section-title">Publish discovery files on your domain</h2>
      <p className="agent-desc">This makes the same listing independently discoverable from your agent&apos;s own domain.</p>
      <div className="form-field"><label htmlFor="agent-domain">Agent domain</label><input id="agent-domain" className="form-control mono" placeholder="agent.example.com" value={domain} onChange={(event) => setDomain(event.target.value)} /></div>
      <button className="btn" type="button" onClick={generate} disabled={busy || !claim || !domain.trim()}>{busy ? "Generating…" : "Generate .well-known files"}</button>
      {error && <p className="verdict err" role="alert">{error}</p>}
      {files && Object.entries(files).map(([path, content]) => <details className="technical-disclosure" key={path}><summary className="mono">{path}</summary><pre className="artifact">{content}</pre></details>)}
    </section>
  );
}
