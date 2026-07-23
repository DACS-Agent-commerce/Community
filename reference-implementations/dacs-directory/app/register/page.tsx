"use client";

import Link from "next/link";
import { useState } from "react";
import { useDemosWallet } from "@/src/components/useDemosWallet";

const WALLET_URL = "https://chromewebstore.google.com/detail/demos-wallet/nefongcpmdahjaijjkihgieiamoahcoo";
const RAIL_OPTIONS = [
  { id: "pay-dem", label: "DEM on Demos" },
  { id: "pay-x402", label: "USDC via x402" },
];
const DELIVERY_OPTIONS = [
  { id: "deliver-attested-payload", label: "Verified result", hint: "A result such as data, analysis, or code with an authenticity attestation." },
  { id: "deliver-storage-program", label: "On-chain result", hint: "The deliverable is stored on-chain or bound to an external payload by hash." },
  { id: "deliver-entitlement", label: "Access or entitlement", hint: "A time-bound API, subscription, quota, or access grant." },
];
const SCREENS = ["Connect", "Describe", "Review", "Publish"];

type Screen = "connect" | "describe" | "review" | "publish" | "done";
type PublishStep = "idle" | "building" | "signing" | "anchoring" | "confirming" | "registering" | "failed" | "complete";

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
  const [pricingKind, setPricingKind] = useState<"fixed" | "negotiable" | "auction">("fixed");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("DEM");
  const [unit, setUnit] = useState("per-job");
  const [minPct, setMinPct] = useState("20");
  const [maxPct, setMaxPct] = useState("20");
  const [selectionRule, setSelectionRule] = useState<"lowest-price" | "highest-price" | "first-acceptable">("first-acceptable");
  const [publicEndpoint, setPublicEndpoint] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [profileUrl, setProfileUrl] = useState<string | null>(null);

  const claim = wallet.address ? `did:demos:agent:${wallet.address.replace(/^0x/, "")}` : null;
  const slug = serviceId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const validDescription = name.trim() && description.trim() && slug && rails.length > 0 && delivery && Number(amount) > 0 && currency.trim();
  const activeIndex = screen === "connect" ? 0 : screen === "describe" ? 1 : screen === "review" ? 2 : 3;

  const publish = async () => {
    if (!claim || !validDescription) return;
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
          minPct: Number(minPct), maxPct: Number(maxPct), selectionRule,
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
      setStatus("Now approve the complete structured listing.");
      const signature = await wallet.sign(built.message);
      if (!signature) throw new Error(wallet.error ?? "The listing signature was declined.");
      const signedListing = {
        ...built.listing,
        signature: { algorithm: "ed25519", signer: claim, value: signature.replace(/^(0x)+/i, "") },
      };

      activeStep = "anchoring"; setPublishStep("anchoring");
      setStatus("Approve the on-chain anchor transaction.");
      built.tx.content.data[1].data = signedListing;
      const sent = await wallet.send(built.tx);
      if (!sent) throw new Error(wallet.error ?? "The anchor transaction was declined.");

      activeStep = "confirming"; setPublishStep("confirming");
      setStatus("The transaction was sent. Waiting for the listing to become readable…");
      let confirmed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const probe = await fetch(`/api/dacs/artifact?ref=${encodeURIComponent(built.anchorAddress)}`).then((response) => response.json());
        if (probe.value) { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      if (!confirmed) throw new Error("The anchor is not visible yet. Your transaction may still confirm; retry publishing without re-entering the form.");

      activeStep = "registering"; setPublishStep("registering");
      setStatus("One final wallet signature connects this listing to the directory.");
      const registrationSignature = await wallet.sign(built.registration.ownerSignature.message);
      if (!registrationSignature) throw new Error(wallet.error ?? "The directory registration signature was declined.");
      const registration = {
        ...built.registration,
        ownerSignature: { ...built.registration.ownerSignature, signature: registrationSignature.replace(/^(0x)+/i, "") },
      };
      const registered = await fetch("/api/dacs/register", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(registration),
      });
      const registeredBody = await registered.json();
      if (!registered.ok) throw new Error(registeredBody.error ?? "Directory registration failed.");

      setPublishStep("complete");
      setStatus("Your signed listing is anchored and queued for the next index pass.");
      setProfileUrl(`/seller/${encodeURIComponent(claim)}`);
      setScreen("done");
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
              <button className="btn" type="button" onClick={() => setScreen("describe")}>Continue</button>
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

          <fieldset className="form-field"><legend className="form-legend">Pricing model</legend><div className="badges">{(["fixed", "negotiable", "auction"] as const).map((kind) => <button key={kind} type="button" aria-pressed={pricingKind === kind} className={`badge filter ${pricingKind === kind ? "active" : ""}`} onClick={() => setPricingKind(kind)}>{kind === "negotiable" ? "negotiation" : kind}</button>)}</div></fieldset>
          <div className="choice-grid">
            <div className="form-field"><label htmlFor="price-amount">{pricingKind === "fixed" ? "Fixed amount" : pricingKind === "negotiable" ? "Negotiation centre" : "Reserve amount"}</label><input id="price-amount" className="form-control" inputMode="decimal" placeholder="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
            <div className="form-field"><label htmlFor="price-currency">Currency or asset</label><input id="price-currency" className="form-control mono" maxLength={32} placeholder="DEM or usd-stablecoin" value={currency} onChange={(event) => setCurrency(event.target.value)} /></div>
            <div className="form-field"><label htmlFor="price-unit">Unit</label><input id="price-unit" className="form-control" maxLength={64} placeholder="per-job" value={unit} onChange={(event) => setUnit(event.target.value)} /></div>
          </div>
          {pricingKind === "negotiable" && <div className="choice-grid">
            <div className="form-field"><label htmlFor="price-min">Maximum discount (%)</label><input id="price-min" className="form-control" type="number" min="0" max="99" value={minPct} onChange={(event) => setMinPct(event.target.value)} /></div>
            <div className="form-field"><label htmlFor="price-max">Maximum uplift (%)</label><input id="price-max" className="form-control" type="number" min="0" value={maxPct} onChange={(event) => setMaxPct(event.target.value)} /></div>
          </div>}
          {pricingKind === "auction" && <div className="form-field"><label htmlFor="selection-rule">Selection rule</label><select id="selection-rule" className="form-control" value={selectionRule} onChange={(event) => setSelectionRule(event.target.value as typeof selectionRule)}><option value="first-acceptable">First acceptable</option><option value="lowest-price">Lowest price</option><option value="highest-price">Highest price</option></select></div>}
          {pricingKind === "negotiable" && <p className="field-hint">The signed RFQ allows up to 8 turns and a 5-minute session timeout.</p>}
          {pricingKind === "auction" && <p className="field-hint">The signed sealed-envelope window closes 7 days after publication, followed by a 1-hour reveal window.</p>}

          <fieldset className="form-field"><legend className="form-legend">Payment rail</legend><div className="badges">{RAIL_OPTIONS.map((option) => <button key={option.id} type="button" aria-pressed={rails.includes(option.id)} className={`badge rail filter ${rails.includes(option.id) ? "active" : ""}`} onClick={() => setRails([option.id])}>{option.label}</button>)}</div><span className="field-hint">The selected rail becomes the signed payment step and accepted rail.</span></fieldset>
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
            <div className="service-facts"><div><span>pricing</span><strong>{amount} {currency}{unit ? ` · ${unit}` : ""}</strong></div><div><span>model</span><strong>{pricingKind}{pricingKind === "negotiable" ? ` (-${minPct}% / +${maxPct}%)` : pricingKind === "auction" ? ` · ${selectionRule}` : ""}</strong></div></div>
            <div className="badges">{rails.map((value) => <span className="badge rail" key={value}>{RAIL_OPTIONS.find((option) => option.id === value)?.label ?? value}</span>)}<span className="badge">{DELIVERY_OPTIONS.find((option) => option.id === delivery)?.label}</span></div>
            <p className="meta mono">{slug} · {claim}</p>
          </div>
          <details className="technical-disclosure">
            <summary>Preview the machine-readable listing</summary>
            <pre className="artifact">{JSON.stringify({
              dacsVersion: "1", listingId: slug, listingVersion: "assigned at publish",
              seller: { identity: "separately signed IdentityBundle", displayName: name.trim(), publicEndpoint: publicEndpoint || undefined },
              offering: { title: name.trim(), description: description.trim(), category, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), deliverable: delivery.replace("deliver-", "") },
              buyerRequirement: { requirementVersion: "1", required: [] },
              pricing: { kind: pricingKind, amount, currency, unit, ...(pricingKind === "negotiable" ? { minPct: Number(minPct), maxPct: Number(maxPct) } : {}), ...(pricingKind === "auction" ? { selectionRule } : {}) }, acceptedRails: rails,
              pipeline: [pricingKind === "fixed" ? "negotiate-fixed-price" : pricingKind === "negotiable" ? "negotiate-rfq" : "negotiate-sealed-envelope", "commit-agreement", rails[0], delivery],
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
          {publishStep === "failed" && <div className="button-row"><button className="btn" type="button" onClick={publish}>Retry publish</button><button className="btn secondary" type="button" onClick={() => setScreen("review")}>Review details</button></div>}
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
