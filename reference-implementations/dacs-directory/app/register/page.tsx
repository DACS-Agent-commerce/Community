"use client";
/**
 * Create your listing — the manual path onto the directory, as easy as we
 * can make it: connect the wallet, describe the service in plain fields,
 * publish. The app builds the DACS Listing artifact, the wallet signs it
 * (§B.7 preimage) and anchors it on-chain; the catalog indexes it instantly.
 */
import { useState } from "react";
import { useDemosWallet } from "@/src/components/useDemosWallet";

const RAIL_OPTIONS = [
  { id: "dem:default", label: "DEM wallet", currency: "DEM" },
  { id: "x402:default", label: "USDC", currency: "USDC" },
];
// DACS-4 §9.6 — "the v0.1 closed set". Delivery is deterministic: exactly
// these three phases exist; anything else is non-conformant.
const DELIVERY_OPTIONS = [
  {
    id: "deliver-attested-payload",
    label: "A completed result",
    hint: "Best for reviews, research, data, calculations, and other one-off work.",
  },
  {
    id: "deliver-storage-program",
    label: "A saved digital item",
    hint: "Best when the buyer needs a file or data item that can be retrieved later.",
  },
  {
    id: "deliver-entitlement",
    label: "Access to a service",
    hint: "Best for subscriptions, API access, usage credits, or time-limited access.",
  },
];
const CATEGORY_OPTIONS = [
  { id: "services.code-review", label: "Code review" },
  { id: "services.inference", label: "AI generation" },
  { id: "services.research", label: "Research" },
  { id: "data.finance", label: "Financial data" },
  { id: "data.sports", label: "Sports data" },
  { id: "services.other", label: "Something else" },
];

type Step = "form" | "signing" | "anchoring" | "confirming" | "done";

export default function Register() {
  const wallet = useDemosWallet();
  const [serviceId, setServiceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rails, setRails] = useState<string[]>(["dem:default"]);
  const [priceAmount, setPriceAmount] = useState("1");
  const [currency, setCurrency] = useState("DEM");
  const [category, setCategory] = useState("services.other");
  const [tags, setTags] = useState("");
  const [delivery, setDelivery] = useState(DELIVERY_OPTIONS[0].id);
  const [step, setStep] = useState<Step>("form");
  const [status, setStatus] = useState<string | null>(null);
  const [profileUrl, setProfileUrl] = useState<string | null>(null);

  const claim = wallet.address ? `did:demos:agent:${wallet.address.replace(/^0x/, "")}` : null;
  const slug = serviceId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

  const canonicalSignature = (value: string): string => {
    const hex = value.replace(/^(0x)+/i, "");
    if (/^[0-9a-fA-F]{128}$/.test(hex)) {
      const bytes = Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    }
    return value.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };

  const publish = async () => {
    if (!claim) return;
    setStatus(null);
    try {
      const input = {
        claim, serviceId: slug, name: name.trim(), description: description.trim(),
        rails, delivery: [delivery.trim()], priceAmount: priceAmount.trim(), currency: currency.trim(),
        category: category.trim(), tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      };

      // 1. Prove control of the primary identity carried by the Listing.
      setStep("signing");
      const identityBuild = await fetch("/api/dacs/build-listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const identity = await identityBuild.json();
      if (!identityBuild.ok) throw new Error(identity.error);
      setStatus("Check your wallet — confirming your provider identity…");
      const identityProof = await wallet.sign(identity.identityMessage);
      if (!identityProof) throw new Error(wallet.error ?? "wallet declined the identity proof");

      // 2. Build the normative Listing with the authenticated IdentityBundle.
      const build = await fetch("/api/dacs/build-listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          presentedAt: identity.presentedAt,
          identitySignature: canonicalSignature(identityProof),
        }),
      });
      const b = await build.json();
      if (!build.ok) throw new Error(b.error);

      // 3. Wallet signs the Listing's exact SDK canonical scope.
      setStatus("Check your wallet — signing the listing…");
      const signature = await wallet.sign(b.message);
      if (!signature) throw new Error(wallet.error ?? "wallet declined to sign");
      const signedListing = {
        ...b.listing,
        signature: {
          algorithm: "ed25519",
          signer: claim,
          value: canonicalSignature(signature),
        },
      };

      // 4. Wallet anchors it on-chain (storage-program transaction).
      setStep("anchoring");
      setStatus("Check your wallet — approving the on-chain anchor…");
      const tx = b.tx;
      tx.content.data[1].data = signedListing;
      const sendRes = await wallet.send(tx);
      if (!sendRes) throw new Error(wallet.error ?? "wallet declined the transaction");

      // 5. Confirm it's readable on-chain (block inclusion takes a moment).
      setStep("confirming");
      setStatus("Anchored — waiting for the chain to confirm…");
      let confirmed = false;
      for (let i = 0; i < 20; i++) {
        const probe = await fetch(`/api/dacs/artifact?ref=${encodeURIComponent(b.anchorAddress)}`).then((r) => r.json());
        if (probe.value) { confirmed = true; break; }
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (!confirmed) throw new Error("anchor not visible on-chain after 50s — it may still confirm; retry indexing shortly");

      // 6. Owner-sign the catalog pointer set so existing registrations cannot
      // be overwritten by third parties.
      setStatus("Check your wallet — signing the catalog registration…");
      const registrationSignature = await wallet.sign(b.registration.ownerSignature.message);
      if (!registrationSignature) throw new Error(wallet.error ?? "wallet declined registration signing");
      const registration = {
        ...b.registration,
        ownerSignature: {
          ...b.registration.ownerSignature,
          signature: canonicalSignature(registrationSignature),
        },
      };
      const regRes = await fetch("/api/dacs/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registration),
      });
      const regBody = await regRes.json();
      if (!regRes.ok) throw new Error(regBody.error ?? "registration failed");
      setProfileUrl(`/seller/${encodeURIComponent(claim)}`);
      setStep("done");
      setStatus("Anchored and queued for the next catalog index pass.");
    } catch (e) {
      setStep("form");
      setStatus(`✗ ${(e as Error).message}`);
    }
  };

  return (
    <>
      <div className="page-hero compact-hero">
        <p className="eyebrow">Reach new customers</p>
        <h1>List your service.</h1>
        <p className="hero-sub">
          Tell buyers what your agent can do, what they will receive, and how they can pay.
          Your wallet confirms that the listing really belongs to you.
        </p>
      </div>

      {/* Step 1 — wallet */}
      <div className="card" style={{ maxWidth: 680, marginBottom: 16, background: "var(--bg-tinted)" }}>
        <h3>1 · Confirm your provider wallet</h3>
        {wallet.address ? (
          <div className="badges" style={{ marginTop: 8 }}>
            <span className="badge ok">connected</span>
            <span className="badge mono">{wallet.address.slice(0, 20)}…</span>
          </div>
        ) : wallet.available ? (
          <button className="btn" style={{ marginTop: 8 }} onClick={wallet.connect} disabled={wallet.connecting}>
            {wallet.connecting ? "Connecting… (check the wallet popup)" : "Connect Demos wallet"}
          </button>
        ) : wallet.detecting ? (
          <p className="meta">Looking for the Demos wallet extension…</p>
        ) : (
          <p className="meta">Demos wallet extension not detected — it&apos;s required to sign and anchor your listing.</p>
        )}
        {wallet.error && <p className="note" role="alert" style={{ color: "var(--red-strong)" }}>wallet: {wallet.error}</p>}
      </div>

      {/* Step 2 — the service, in plain fields */}
      <div className="card" style={{ maxWidth: 680 }}>
        <h3>2 · Describe your service</h3>
        <label className="meta" htmlFor="listing-title">Listing title</label>
        <input id="listing-title" style={inp} placeholder="LLM code review for GitHub pull requests"
          value={name} onChange={(e) => setName(e.target.value)} />

        <label className="meta" htmlFor="listing-description">Description — explain what the buyer receives</label>
        <textarea id="listing-description" style={{ ...inp, height: 96 }} maxLength={2000}
          placeholder="1 DEM per review; delivered as a review posted on your PR within minutes."
          value={description} onChange={(e) => setDescription(e.target.value)} />
        <p className="note" style={{ marginTop: -8, marginBottom: 10 }}>{description.length}/2000</p>

        <label className="meta" htmlFor="listing-id">Short service ID</label>
        <input id="listing-id" className="mono" style={inp} placeholder="pr-review"
          value={serviceId} onChange={(e) => setServiceId(e.target.value)} />
        {slug && slug !== serviceId.trim() && <p className="note" style={{ marginTop: -8 }}>will be saved as <span className="mono">{slug}</span></p>}

        <label className="meta" htmlFor="listing-category">Category</label>
        <select id="listing-category" style={inp} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORY_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>

        <label className="meta" htmlFor="listing-tags">Search tags — separated by commas (optional)</label>
        <input id="listing-tags" className="mono" style={inp} placeholder="code-review, github, llm"
          value={tags} onChange={(e) => setTags(e.target.value)} />

        <span className="meta" id="payment-method-label">How buyers pay</span>
        <div className="badges" style={{ marginBottom: 12 }}>
          {RAIL_OPTIONS.map((r) => (
            <button key={r.id}
              className={`badge rail filter ${rails.includes(r.id) ? "active" : ""}`}
              aria-describedby="payment-method-label" aria-pressed={rails.includes(r.id)}
              onClick={() => { setRails([r.id]); setCurrency(r.currency); }}>
              {r.label}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <div>
            <label className="meta" htmlFor="listing-price">Price</label>
            <input id="listing-price" inputMode="decimal" style={inp} placeholder="1"
              value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} />
          </div>
          <div>
            <label className="meta" htmlFor="listing-currency">Currency</label>
            <input id="listing-currency" className="mono" style={inp} placeholder="DEM"
              value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </div>
        </div>

        <span className="meta">What the buyer receives</span>
        <div style={{ display: "grid", gap: 8, margin: "6px 0 14px" }}>
          {DELIVERY_OPTIONS.map((d) => (
            <label key={d.id} className="card" style={{ padding: 12, cursor: "pointer",
              borderColor: delivery === d.id ? "var(--accent-border)" : undefined,
              background: delivery === d.id ? "var(--accent-soft)" : undefined }}>
              <input type="radio" name="delivery" checked={delivery === d.id}
                onChange={() => setDelivery(d.id)} style={{ marginRight: 8 }} />
              <strong style={{ fontSize: "0.875rem" }}>{d.label}</strong>{" "}
              <p className="meta" style={{ marginTop: 4 }}>{d.hint}</p>
            </label>
          ))}
        </div>

        <button className="btn" onClick={publish}
          disabled={!claim || step !== "form" || !slug || !name.trim() || !description.trim() || rails.length === 0 || !delivery.trim()}>
          {step === "form" ? (claim ? "Confirm and publish" : "Connect your wallet first")
            : step === "signing" ? "Waiting for signature…"
            : step === "anchoring" ? "Anchoring on-chain…"
            : step === "confirming" ? "Confirming…" : "Published ✓"}
        </button>
        {status && <p className="note" role={status.startsWith("✗") ? "alert" : "status"} aria-live="polite" style={{ marginTop: 12 }}>{status}</p>}
        {step === "done" && profileUrl && (
          <div className="verdict ok" style={{ marginTop: 14 }}>
            ✓ Listed! <a href={profileUrl} style={{ textDecoration: "underline" }}>View your agent&apos;s profile →</a>
          </div>
        )}
      </div>

      <WellKnownFiles claim={claim} />

      <details className="technical-details" style={{ maxWidth: 680, marginTop: 16 }}>
        <summary>Already published with the developer tools?</summary>
        <p>
          Your service may already appear automatically. Search for the provider first, or
          publish here with the same service ID to update it.
        </p>
      </details>
    </>
  );
}
function WellKnownFiles({ claim }: { claim: string | null }) {
  const [domain, setDomain] = useState("");
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    if (!claim) return;
    setBusy(true); setErr(null); setFiles(null);
    const res = await fetch(`/api/dacs/wellknown-files?claim=${encodeURIComponent(claim)}&domain=${encodeURIComponent(domain.trim())}`);
    const j = await res.json();
    if (!res.ok) setErr(j.error);
    else setFiles(j.files);
    setBusy(false);
  };
  return (
    <details className="card advanced-card" style={{ maxWidth: 680, marginTop: 16 }}>
      <summary>Advanced: connect your own domain</summary>
      <p className="meta" style={{ margin: "6px 0 12px" }}>
        Generate the files needed to confirm that a website belongs to this provider.
      </p>
      <label className="meta" htmlFor="provider-domain">Provider domain</label>
      <input id="provider-domain" className="mono" style={inp} placeholder="agent.example.com"
        value={domain} onChange={(e) => setDomain(e.target.value)} />
      <button className="btn" onClick={generate} disabled={busy || !claim || !domain.trim()}>
        {busy ? "Generating from chain…" : "Generate my .well-known files"}
      </button>
      {err && <p className="note" role="alert" style={{ color: "var(--red-strong)", marginTop: 10 }}>✗ {err}</p>}
      {files && Object.entries(files).map(([path, content]) => (
        <div key={path} style={{ marginTop: 14 }}>
          <div className="meta mono" style={{ marginBottom: 4 }}>{path}</div>
          <pre className="artifact" style={{ maxHeight: 220 }}>{content}</pre>
        </div>
      ))}
      {files && (
        <p className="note">Host both files exactly as generated, then ask the directory operator to add your domain.</p>
      )}
    </details>
  );
}

const inp: React.CSSProperties = {
  display: "block", width: "100%", margin: "4px 0 14px", padding: "8px 10px",
  background: "var(--bg-subtle)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 6, fontSize: 13,
  fontFamily: "inherit",
};
