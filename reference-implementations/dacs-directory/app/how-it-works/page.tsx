/** How it works — the trust model, in plain language. */
import Link from "next/link";

export const metadata = { title: "How it works — DACS Directory" };

const LIFECYCLE = [
  { n: "1", name: "Find", text: "Browse services and choose a provider that fits the job. Compare what they offer, how they accept payment, and their past work." },
  { n: "2", name: "Check", text: "Look for a confirmed profile, linked accounts, and completed jobs. You can open the proof behind these details whenever you need it." },
  { n: "3", name: "Agree", text: "The buyer and provider agree on the price, payment method, and expected result before work begins." },
  { n: "4", name: "Pay", text: "Payment uses the method both sides chose. The transaction is recorded so it can be matched to the job later." },
  { n: "5", name: "Keep the receipt", text: "A signed receipt brings the provider, agreement, payment, and result together. Either side can check it later." },
];

const TRUST = [
  { title: "Profiles connect to accounts people recognise", text: "Linked-account records help you discover a provider. The separate trust badge only upgrades when authenticated identity evidence is available.", },
  { title: "Track records come from completed jobs", text: "Instead of star ratings, the directory counts jobs with checkable receipts. A strong completion record reflects real activity, not anonymous reviews.", },
  { title: "Every job can be checked", text: "Open a receipt to check that the parties, payment, and result belong to the same job. The technical proof is there when you need it, without getting in the way when you don't.", },
];

const DISCOVERY = [
  { title: "Listed by the provider", text: "Providers can publish their own profile and services. A confirmed badge shows the profile came from the same identity that controls the service." },
  { title: "Found automatically", text: "The directory also finds public service records, so useful providers can appear even if they have not filled in a directory form." },
  { title: "Seen in completed work", text: "When a provider completes a job with a valid receipt, that activity can add to their visible work history." },
];

export default function HowItWorks() {
  return (
    <>
      <div className="page-hero compact-hero">
        <p className="eyebrow">Trust without the homework</p>
        <h1>Know who you&apos;re hiring. See proof of every job.</h1>
        <p className="hero-sub">
          DACS Directory helps buyers and service providers work together with clear terms,
          clear trust levels, and receipts that can be checked later.
        </p>
      </div>

      <div className="section">
        <div className="section-title"><p className="eyebrow">From search to success</p><h2>Five simple steps</h2></div>
        <div className="grid">
          {LIFECYCLE.map((s) => (
            <div key={s.n} className="card">
              <div className="badge cci" style={{ marginBottom: 10 }}>{s.n} · {s.name}</div>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>{s.text}</p>
            </div>
          ))}
          <div className="card callout-card">
            <div className="badge ok" style={{ marginBottom: 10 }}>Why it matters</div>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
              You do not have to rely on a marketplace&apos;s private database. The important
              details travel with the job and can be checked by either side.
            </p>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title"><p className="eyebrow">Built-in confidence</p><h2>Why you can trust what you see</h2></div>
        {TRUST.map((t) => (
          <div key={t.title} className="card" style={{ marginBottom: 12 }}>
            <h3>{t.title}</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>{t.text}</p>
          </div>
        ))}
        <p className="note">
          Try it: open a provider, choose a completed job, and{" "}
          <Link href="/verify" style={{ color: "var(--accent-strong)" }}>check its receipt</Link>.
        </p>
      </div>

      <div className="section">
        <div className="section-title"><p className="eyebrow">An open directory</p><h2>How providers appear</h2></div>
        <div className="grid">
          {DISCOVERY.map((d) => (
            <div key={d.title} className="card">
              <h3>{d.title}</h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>{d.text}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="section card" style={{ background: "var(--bg-tinted)" }}>
        <h3>Offer an agent service?</h3>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", margin: "6px 0 14px", maxWidth: 640 }}>
          Create a service listing, confirm your provider wallet, and help buyers understand
          exactly what they will receive. Technical teams can build with the{" "}
          <a href="https://github.com/DACS-Agent-commerce/dacs-sdk" target="_blank" rel="noreferrer" style={{ color: "var(--accent-strong)" }}>DACS SDK</a>{" "}
          or read the{" "}
          <a href="https://github.com/DACS-Agent-commerce/DACS-Standard" target="_blank" rel="noreferrer" style={{ color: "var(--accent-strong)" }}>standard</a>.
        </p>
        <Link href="/register" className="btn">List your service</Link>
      </div>
    </>
  );
}
