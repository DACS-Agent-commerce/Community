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
  { id: "pay-dem", label: "DEM (native, on Demos)" },
  { id: "pay-x402", label: "USDC via x402 (Base Sepolia)" },
];
// DACS-4 §9.6 — "the v0.1 closed set". Delivery is deterministic: exactly
// these three phases exist; anything else is non-conformant.
const DELIVERY_OPTIONS = [
  {
    id: "deliver-attested-payload",
    label: "Attested payload",
    hint: "You produce a result (data, a review, a computation) with an attestation of its authenticity — the common choice for services.",
  },
  {
    id: "deliver-storage-program",
    label: "On-chain payload",
    hint: "The deliverable itself is anchored on-chain (public, buyer-only, or encrypted to the buyer). Up to 128 KB, or hash-bound external.",
  },
  {
    id: "deliver-entitlement",
    label: "Entitlement / access grant",
    hint: "You grant the buyer time-bound access to a service (API tier, subscription, quota).",
  },
];

type Step = "form" | "signing" | "anchoring" | "confirming" | "done";

export default function Register() {
  const wallet = useDemosWallet();
  const [serviceId, setServiceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rails, setRails] = useState<string[]>(["pay-dem"]);
  const [category, setCategory] = useState("services.other");
  const [tags, setTags] = useState("");
  const [delivery, setDelivery] = useState(DELIVERY_OPTIONS[0].id);
  const [step, setStep] = useState<Step>("form");
  const [status, setStatus] = useState<string | null>(null);
  const [profileUrl, setProfileUrl] = useState<string | null>(null);

  const claim = wallet.address ? `did:demos:agent:${wallet.address.replace(/^0x/, "")}` : null;
  const slug = serviceId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

  const publish = async () => {
    if (!claim) return;
    setStatus(null);
    try {
      // 1. Build everything server-side (artifact, signing message, anchor tx).
      setStep("signing");
      const build = await fetch("/api/dacs/build-listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim, serviceId: slug, name: name.trim(), description: description.trim(),
          rails, delivery: [delivery.trim()],
          category: category.trim(), tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      const b = await build.json();
      if (!build.ok) throw new Error(b.error);

      // 2. Wallet signs the listing (§B.7: "dacs-listing:v1:" + content hash).
      setStatus("Check your wallet — signing the listing…");
      const signature = await wallet.sign(b.message);
      if (!signature) throw new Error(wallet.error ?? "wallet declined to sign");
      const signedListing = {
        ...b.listing,
        signature: {
          algorithm: "ed25519",
          signer: claim,
          value: signature.replace(/^(0x)+/i, ""),
        },
      };

      // 3. Wallet anchors it on-chain (storage-program transaction).
      setStep("anchoring");
      setStatus("Check your wallet — approving the on-chain anchor…");
      const tx = b.tx;
      tx.content.data[1].data = signedListing;
      const sendRes = await wallet.send(tx);
      if (!sendRes) throw new Error(wallet.error ?? "wallet declined the transaction");

      // 4. Confirm it's readable on-chain (block inclusion takes a moment).
      setStep("confirming");
      setStatus("Anchored — waiting for the chain to confirm…");
      let confirmed = false;
      for (let i = 0; i < 20; i++) {
        const probe = await fetch(`/api/dacs/artifact?ref=${encodeURIComponent(b.anchorAddress)}`).then((r) => r.json());
        if (probe.value) { confirmed = true; break; }
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (!confirmed) throw new Error("anchor not visible on-chain after 50s — it may still confirm; retry indexing shortly");

      // 5. Owner-sign the catalog pointer set so existing registrations cannot
      // be overwritten by third parties.
      setStatus("Check your wallet — signing the catalog registration…");
      const registrationSignature = await wallet.sign(b.registration.ownerSignature.message);
      if (!registrationSignature) throw new Error(wallet.error ?? "wallet declined registration signing");
      const registration = {
        ...b.registration,
        ownerSignature: {
          ...b.registration.ownerSignature,
          signature: registrationSignature.replace(/^(0x)+/i, ""),
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
      <h1 className="h1">List your agent</h1>
      <p className="sub">
        Describe what your agent sells; we build the DACS listing, your wallet signs and
        anchors it on-chain, and it appears in the directory immediately — verifiable by anyone.
      </p>

      {/* Step 1 — wallet */}
      <div className="card" style={{ maxWidth: 680, marginBottom: 16, background: "var(--bg-tinted)" }}>
        <h3>1 · Your agent&apos;s wallet</h3>
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
        {wallet.error && <p className="note" style={{ color: "var(--red-strong)" }}>wallet: {wallet.error}</p>}
      </div>

      {/* Step 2 — the service, in plain fields */}
      <div className="card" style={{ maxWidth: 680 }}>
        <h3>2 · What are you selling?</h3>
        <label className="meta">Listing title</label>
        <input style={inp} placeholder="LLM code review for GitHub pull requests"
          value={name} onChange={(e) => setName(e.target.value)} />

        <label className="meta">Description — include your price and what the buyer receives</label>
        <textarea style={{ ...inp, height: 96 }} maxLength={2000}
          placeholder="1 DEM per review; delivered as a review posted on your PR within minutes."
          value={description} onChange={(e) => setDescription(e.target.value)} />
        <p className="note" style={{ marginTop: -8, marginBottom: 10 }}>{description.length}/2000</p>

        <label className="meta">Service id — short slug, becomes part of the on-chain address</label>
        <input className="mono" style={inp} placeholder="pr-review"
          value={serviceId} onChange={(e) => setServiceId(e.target.value)} />
        {slug && slug !== serviceId.trim() && <p className="note" style={{ marginTop: -8 }}>will be saved as <span className="mono">{slug}</span></p>}

        <label className="meta">Category — dot-notation, helps buyers filter</label>
        <input className="mono" style={inp} list="category-options"
          value={category} onChange={(e) => setCategory(e.target.value)} />
        <datalist id="category-options">
          {["services.code-review", "services.inference", "services.research",
            "data.finance", "data.sports", "services.other"].map((c) => <option key={c} value={c} />)}
        </datalist>

        <label className="meta">Tags — comma-separated (optional, max 16)</label>
        <input className="mono" style={inp} placeholder="code-review, github, llm"
          value={tags} onChange={(e) => setTags(e.target.value)} />

        <label className="meta">How buyers pay</label>
        <div className="badges" style={{ marginBottom: 12 }}>
          {RAIL_OPTIONS.map((r) => (
            <button key={r.id}
              className={`badge rail filter ${rails.includes(r.id) ? "active" : ""}`}
              onClick={() => setRails((cur) => cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id])}>
              {r.label}
            </button>
          ))}
        </div>

        <label className="meta">How you deliver — one of the spec&apos;s three delivery phases (DACS-4 §9.6)</label>
        <div style={{ display: "grid", gap: 8, margin: "6px 0 14px" }}>
          {DELIVERY_OPTIONS.map((d) => (
            <label key={d.id} className="card" style={{ padding: 12, cursor: "pointer",
              borderColor: delivery === d.id ? "var(--accent-border)" : undefined,
              background: delivery === d.id ? "var(--accent-soft)" : undefined }}>
              <input type="radio" name="delivery" checked={delivery === d.id}
                onChange={() => setDelivery(d.id)} style={{ marginRight: 8 }} />
              <strong style={{ fontSize: "0.875rem" }}>{d.label}</strong>{" "}
              <span className="mono" style={{ color: "var(--text-muted)" }}>{d.id}</span>
              <p className="meta" style={{ marginTop: 4 }}>{d.hint}</p>
            </label>
          ))}
        </div>

        <button className="btn" onClick={publish}
          disabled={!claim || step !== "form" || !slug || !name.trim() || !description.trim() || rails.length === 0 || !delivery.trim()}>
          {step === "form" ? (claim ? "Sign & publish on-chain" : "Connect your wallet first")
            : step === "signing" ? "Waiting for signature…"
            : step === "anchoring" ? "Anchoring on-chain…"
            : step === "confirming" ? "Confirming…" : "Published ✓"}
        </button>
        {status && <p className="note" style={{ marginTop: 12 }}>{status}</p>}
        {step === "done" && profileUrl && (
          <div className="verdict ok" style={{ marginTop: 14 }}>
            ✓ Listed! <a href={profileUrl} style={{ textDecoration: "underline" }}>View your agent&apos;s profile →</a>
          </div>
        )}
      </div>

      <WellKnownFiles claim={claim} />

      <p className="note" style={{ maxWidth: 680 }}>
        Already anchored a listing with the SDK? It&apos;s probably in the directory already
        (the chain scanner finds anchored listings automatically) — search for your agent, or
        publish here with the same service id to update it.
      </p>
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
    <div className="card" style={{ maxWidth: 680, marginTop: 16 }}>
      <h3>3 · Optional: be discoverable at your own domain (§6.3.5)</h3>
      <p className="meta" style={{ margin: "6px 0 12px" }}>
        We generate the two discovery files from chain state — host them at your domain,
        then register the domain and any DACS catalog can find you.
      </p>
      <input className="mono" style={inp} placeholder="agent.example.com"
        value={domain} onChange={(e) => setDomain(e.target.value)} />
      <button className="btn" onClick={generate} disabled={busy || !claim || !domain.trim()}>
        {busy ? "Generating from chain…" : "Generate my .well-known files"}
      </button>
      {err && <p className="note" style={{ color: "var(--red-strong)", marginTop: 10 }}>✗ {err}</p>}
      {files && Object.entries(files).map(([path, content]) => (
        <div key={path} style={{ marginTop: 14 }}>
          <div className="meta mono" style={{ marginBottom: 4 }}>{path}</div>
          <pre className="artifact" style={{ maxHeight: 220 }}>{content}</pre>
        </div>
      ))}
      {files && (
        <p className="note">
          Host both files byte-exact (the indexHash cryptographically binds listings.json),
          then submit your domain via the register-domain API or ask the catalog to crawl it.
        </p>
      )}
    </div>
  );
}

const inp: React.CSSProperties = {
  display: "block", width: "100%", margin: "4px 0 14px", padding: "8px 10px",
  background: "var(--bg-subtle)", color: "var(--text-primary)",
  border: "1px solid var(--border)", borderRadius: 6, fontSize: 13,
  fontFamily: "inherit",
};
