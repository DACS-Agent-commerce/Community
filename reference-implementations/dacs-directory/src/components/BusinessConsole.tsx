"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import type { DealRecord, SellerRecord } from "@/src/catalog/types";
import { useDemosWallet } from "./useDemosWallet";
import { railLabel, tierMeta } from "./labels";

type View = "overview" | "listings" | "activity" | "revenue" | "reputation" | "agents";
type ActivityFilter = "all" | "attention" | "completed";

type ConsoleListing = {
  id: string;
  title: string;
  status: "Live" | "Paused";
  terms: string;
  rail: string;
  orders: number | null;
};

type ConsoleActivity = {
  id: string;
  service: string;
  customer: string;
  status: "Needs delivery" | "In progress" | "Completed" | "Verification pending";
  value: string;
  when: string;
  proof: "Verified" | "Observed" | "Waiting";
};

type Snapshot = {
  sample: boolean;
  name: string;
  claim: string;
  identityTier: SellerRecord["identityTier"];
  listingCount: number;
  observedJobs: number;
  verifiedJobs: number;
  deliveryRate: number | null;
  needsAttention: number;
  revenue: { dem: string; usdc: string; available: boolean };
  listings: ConsoleListing[];
  activity: ConsoleActivity[];
  chart: Array<{ label: string; dem: number; usdc: number }>;
  evidence: Array<{ label: string; detail: string; state: "Verified" | "Observed" | "Not available" }>;
};

const SAMPLE_SNAPSHOT: Snapshot = {
  sample: true,
  name: "ReviewBot Studio",
  claim: "did:demos:agent:4401feab4dfc36e1166ad0dc1c4987dd0c728a57616fa496c25ca2a260651808",
  identityTier: "verified",
  listingCount: 3,
  observedJobs: 128,
  verifiedJobs: 124,
  deliveryRate: 0.984,
  needsAttention: 3,
  revenue: { dem: "184.0 DEM", usdc: "460.20 USDC", available: true },
  listings: [
    { id: "pr-review", title: "Pull request review", status: "Live", terms: "From 1 DEM", rail: "DEM · x402", orders: 76 },
    { id: "security-pass", title: "Repository security pass", status: "Live", terms: "Request a quote", rail: "x402", orders: 31 },
    { id: "architecture", title: "Architecture consultation", status: "Live", terms: "From 25 USDC", rail: "x402", orders: 21 },
  ],
  activity: [
    { id: "DACS-8219", service: "Pull request review", customer: "BuildPilot", status: "Needs delivery", value: "2.5 DEM", when: "Due in 18 min", proof: "Waiting" },
    { id: "DACS-8217", service: "Security pass", customer: "Sentinel Agent", status: "Verification pending", value: "34 USDC", when: "8 min ago", proof: "Observed" },
    { id: "DACS-8214", service: "Pull request review", customer: "MergeMate", status: "In progress", value: "1 DEM", when: "24 min ago", proof: "Observed" },
    { id: "DACS-8208", service: "Architecture consultation", customer: "Northstar", status: "Completed", value: "42 USDC", when: "Yesterday", proof: "Verified" },
    { id: "DACS-8201", service: "Pull request review", customer: "DeployFox", status: "Completed", value: "3 DEM", when: "2 days ago", proof: "Verified" },
  ],
  chart: [
    { label: "W1", dem: 28, usdc: 19 }, { label: "W2", dem: 45, usdc: 25 },
    { label: "W3", dem: 32, usdc: 49 }, { label: "W4", dem: 61, usdc: 37 },
    { label: "W5", dem: 52, usdc: 59 }, { label: "W6", dem: 74, usdc: 48 },
    { label: "W7", dem: 68, usdc: 73 }, { label: "Now", dem: 88, usdc: 80 },
  ],
  evidence: [
    { label: "Provider ownership", detail: "The connected wallet controls this Demos identity.", state: "Verified" },
    { label: "Listing ownership", detail: "Three listing anchors resolve to this provider.", state: "Verified" },
    { label: "Commercial outcomes", detail: "124 two-sided outcomes pass the current proof policy.", state: "Verified" },
    { label: "Cross-rail history", detail: "Settlement activity has been observed on DEM and x402.", state: "Observed" },
  ],
};

const statusForDeal = (deal: DealRecord): ConsoleActivity["status"] => {
  if (deal.outcome === "completed" && deal.signatureVerified && deal.refsVerified) return "Completed";
  if (deal.outcome === "completed") return "Verification pending";
  if (deal.outcome) return "Completed";
  return "In progress";
};

const shortClaim = (claim: string) => claim.length > 28 ? `${claim.slice(0, 20)}…${claim.slice(-6)}` : claim;

function snapshotForSeller(seller: SellerRecord): Snapshot {
  const verified = seller.deals.filter((deal) =>
    deal.outcome === "completed" && deal.signatureVerified && deal.refsVerified);
  const completed = seller.deals.filter((deal) => deal.outcome === "completed");
  const attention = seller.deals.filter((deal) => deal.outcome === "completed" && !deal.refsVerified).length;
  const activeListings = seller.listings.filter((listing) => listing.status === "active");
  return {
    sample: false,
    name: seller.displayName,
    claim: seller.primaryClaim,
    identityTier: seller.identityTier,
    listingCount: activeListings.length,
    observedJobs: seller.deals.length,
    verifiedJobs: verified.length,
    deliveryRate: seller.reputation.completionRate,
    needsAttention: attention,
    revenue: { dem: "Not indexed", usdc: "Not indexed", available: false },
    listings: activeListings.map((listing) => ({
      id: listing.listingId,
      title: listing.offering.title,
      status: "Live",
      terms: listing.pricing.priceHint
        ? `${listing.pricing.priceHint} ${listing.pricing.currency ?? ""}`.trim()
        : "Terms on request",
      rail: (listing.offering.rails ?? []).map(railLabel).join(" · ") || "Agreed rail",
      orders: null,
    })),
    activity: seller.deals.map((deal) => ({
      id: deal.jobId,
      service: deal.category ?? "Commercial agreement",
      customer: shortClaim(deal.owners.buyer),
      status: statusForDeal(deal),
      value: railLabel(deal.rail),
      when: deal.finalisedAt ? new Date(deal.finalisedAt).toLocaleDateString() : "Observed on-chain",
      proof: deal.signatureVerified && deal.refsVerified ? "Verified" : deal.signatureVerified ? "Observed" : "Waiting",
    })),
    chart: Array.from({ length: 8 }, (_, index) => ({ label: index === 7 ? "Now" : `W${index + 1}`, dem: 0, usdc: 0 })),
    evidence: [
      {
        label: "Provider ownership",
        detail: seller.ownerRegistered
          ? "The catalog registration is signed by this provider."
          : "A signed owner registration has not been indexed yet.",
        state: seller.ownerRegistered ? "Verified" : "Not available",
      },
      {
        label: "Listing ownership",
        detail: `${activeListings.length} active listing anchor${activeListings.length === 1 ? "" : "s"} resolve to this provider.`,
        state: activeListings.length > 0 ? "Verified" : "Not available",
      },
      {
        label: "Commercial outcomes",
        detail: `${verified.length} of ${completed.length} completed outcome${completed.length === 1 ? "" : "s"} pass the full proof policy.`,
        state: verified.length > 0 ? "Verified" : completed.length > 0 ? "Observed" : "Not available",
      },
      {
        label: "Connected identities",
        detail: seller.cci.length > 0 ? `${seller.cci.length} portable identity claim${seller.cci.length === 1 ? "" : "s"} indexed.` : "No portable identity claims are indexed.",
        state: seller.cci.length > 0 ? "Observed" : "Not available",
      },
    ],
  };
}

function Icon({ children }: { children: ReactNode }) {
  return <span className="business-icon" aria-hidden="true">{children}</span>;
}

const navItems: Array<{ id: View; label: string; icon: ReactNode }> = [
  { id: "overview", label: "Overview", icon: <><path d="M4 13h6V4H4v9Zm10 7h6V11h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z" /></> },
  { id: "listings", label: "Listings", icon: <><path d="M5 5h14v14H5zM8 9h8M8 13h5" /></> },
  { id: "activity", label: "Business activity", icon: <><path d="M4 12h4l2.2-5 3.5 10 2.2-5H20" /></> },
  { id: "revenue", label: "Revenue", icon: <><path d="M5 18V9m7 9V5m7 13v-6M3 20h18" /></> },
  { id: "reputation", label: "Reputation", icon: <><path d="m12 3 2.5 5.1 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8L12 3Z" /></> },
  { id: "agents", label: "Agent access", icon: <><rect x="5" y="6" width="14" height="12" rx="3" /><path d="M9 11h.01M15 11h.01M9 15h6M12 3v3" /></> },
];

export default function BusinessConsole({ sellers, generatedAt }: { sellers: SellerRecord[]; generatedAt: number }) {
  const wallet = useDemosWallet();
  const [view, setView] = useState<View>("overview");
  const [session, setSession] = useState<"entry" | "wallet" | "sample">("entry");
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [copied, setCopied] = useState(false);

  const seller = useMemo(() => {
    if (!wallet.address) return null;
    const walletKey = wallet.address.replace(/^0x/, "").toLowerCase();
    return sellers.find((candidate) => candidate.primaryClaim.toLowerCase().endsWith(walletKey)) ?? null;
  }, [sellers, wallet.address]);

  const snapshot = session === "sample"
    ? SAMPLE_SNAPSHOT
    : seller
      ? snapshotForSeller(seller)
      : null;

  const signIn = async () => {
    setSigning(true);
    setSignError(null);
    try {
      const address = wallet.address ?? await wallet.connect();
      if (!address) throw new Error(wallet.error ?? "The wallet did not connect.");
      const message = [
        "DACS Directory business sign-in",
        `domain:${window.location.host}`,
        `address:${address}`,
        `nonce:${crypto.randomUUID()}`,
        `issued-at:${new Date().toISOString()}`,
        "purpose:View business activity for this wallet",
      ].join("\n");
      const signature = await wallet.sign(message, address);
      if (!signature) throw new Error(wallet.error ?? "The wallet did not sign the login message.");
      setSession("wallet");
    } catch (error) {
      setSignError((error as Error).message);
    } finally {
      setSigning(false);
    }
  };

  const signOut = () => {
    setSession("entry");
    setView("overview");
    setSignError(null);
  };

  if (session === "entry") {
    return (
      <section className="business-entry">
        <div className="business-entry-copy">
          <p className="eyebrow">DACS for providers</p>
          <h1>Your agent business,<br /><em>in one place.</em></h1>
          <p>
            See what you sell, what needs attention, and the reputation each completed
            job is building across the open market.
          </p>
          <div className="business-unlocks" aria-label="Business console capabilities">
            <span><i>01</i> Manage live listings</span>
            <span><i>02</i> Follow every agreement</span>
            <span><i>03</i> Carry verified reputation</span>
          </div>
        </div>
        <div className="business-signin-card">
          <div className="business-signin-mark"><span>✦</span></div>
          <p className="eyebrow">Provider console</p>
          <h2>Open your business</h2>
          <p>Connect the Demos wallet that owns your listings. You will sign a login message—there is no transaction or fee.</p>
          <button className="btn business-wallet-button" onClick={signIn} disabled={signing || wallet.detecting || !wallet.available}>
            <span className="wallet-symbol" aria-hidden="true">D</span>
            {signing ? "Check your wallet…" : wallet.detecting ? "Looking for Demos wallet…" : wallet.available ? "Continue with Demos" : "Demos wallet not detected"}
            <span aria-hidden="true">→</span>
          </button>
          {!wallet.detecting && !wallet.available && (
            <p className="business-wallet-help">Install or unlock the Demos wallet extension, then refresh this page.</p>
          )}
          {(signError || wallet.error) && <p className="business-auth-error" role="alert">{signError ?? wallet.error}</p>}
          <div className="business-signin-divider"><span>or review the concept</span></div>
          <button className="business-preview-button" onClick={() => setSession("sample")}>Explore a sample business <span aria-hidden="true">↗</span></button>
          <div className="business-safe-login"><span aria-hidden="true">✓</span><span><strong>Safe wallet entry</strong>No funds move and no permissions are granted.</span></div>
          <p className="business-poc-note">POC: wallet signatures are held only in this browser session. Server verification and secure session cookies are the production follow-up.</p>
        </div>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section className="business-empty-account">
        <div className="business-empty-art" aria-hidden="true"><span>✦</span><i /><i /><i /></div>
        <p className="eyebrow">Wallet connected</p>
        <h1>No provider business is indexed for this wallet yet.</h1>
        <p>
          Your sign-in worked. Publish a service with this wallet or register an existing
          DACS listing, and it will appear here after the next index pass.
        </p>
        <div className="business-empty-actions">
          <Link href="/register" className="btn">Publish a service</Link>
          <button className="btn secondary" onClick={() => setSession("sample")}>Explore the sample console</button>
          <button className="business-text-button" onClick={signOut}>Use another wallet</button>
        </div>
        <span className="business-connected-claim">{shortClaim(wallet.address ?? "")}</span>
      </section>
    );
  }

  const tier = tierMeta(snapshot.identityTier ?? "self-declared");
  const filteredActivity = snapshot.activity.filter((item) => {
    if (activityFilter === "attention") return item.status === "Needs delivery" || item.status === "Verification pending";
    if (activityFilter === "completed") return item.status === "Completed";
    return true;
  });

  const copyManifest = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/.well-known/dacs.json`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section className="business-console">
      <header className="business-mobile-head">
        <span>Business console</span>
        <select value={view} onChange={(event) => setView(event.target.value as View)} aria-label="Business console section">
          {navItems.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
      </header>
      <aside className="business-sidebar">
        <div className="business-provider">
          <span className="business-provider-avatar">{snapshot.name.slice(0, 1).toUpperCase()}</span>
          <span><strong>{snapshot.name}</strong><small>{shortClaim(snapshot.claim)}</small></span>
        </div>
        <nav aria-label="Business console">
          {navItems.map((item) => (
            <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
              <Icon><svg viewBox="0 0 24 24">{item.icon}</svg></Icon>{item.label}
              {item.id === "activity" && snapshot.needsAttention > 0 && <span className="business-nav-count">{snapshot.needsAttention}</span>}
            </button>
          ))}
        </nav>
        <div className="business-sidebar-foot">
          <span className="business-index-state"><i /> Indexed market data</span>
          <small>{generatedAt ? `Updated ${new Date(generatedAt).toLocaleString()}` : "Waiting for first index"}</small>
          <button onClick={signOut}>{session === "sample" ? "Close sample" : "Sign out"}</button>
        </div>
      </aside>

      <div className="business-workspace">
        <div className="business-topbar">
          <div>
            <span className="business-view-kicker">Provider workspace</span>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="business-top-actions">
            {snapshot.sample && <span className="business-sample-chip">Sample business</span>}
            <span className={`badge ${tier.chipClass}`}>{tier.label}</span>
            <Link href="/register" className="btn">+ New listing</Link>
          </div>
        </div>

        {snapshot.sample && (
          <div className="business-demo-banner"><span>Concept data</span>This preview shows the intended experience. Figures are representative, not indexed claims.</div>
        )}

        {view === "overview" && <Overview snapshot={snapshot} onNavigate={setView} />}
        {view === "listings" && <Listings snapshot={snapshot} />}
        {view === "activity" && (
          <Activity snapshot={snapshot} filter={activityFilter} setFilter={setActivityFilter} items={filteredActivity} />
        )}
        {view === "revenue" && <Revenue snapshot={snapshot} />}
        {view === "reputation" && <Reputation snapshot={snapshot} />}
        {view === "agents" && <AgentAccess copied={copied} onCopy={copyManifest} />}
      </div>
    </section>
  );
}

function Metric({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "warm" | "good" }) {
  return (
    <article className={`business-metric ${tone ?? ""}`}>
      <span>{label}</span><strong>{value}</strong><small>{note}</small>
    </article>
  );
}

function Overview({ snapshot, onNavigate }: { snapshot: Snapshot; onNavigate: (view: View) => void }) {
  const rate = snapshot.deliveryRate === null ? "—" : `${(snapshot.deliveryRate * 100).toFixed(1)}%`;
  return (
    <div className="business-view">
      <section className="business-welcome">
        <div><p>Welcome back,</p><h2>{snapshot.name}.</h2><span>Here is what is happening across your agent business.</span></div>
        <button onClick={() => onNavigate("activity")}>Review activity <span aria-hidden="true">→</span></button>
      </section>
      <div className="business-metrics">
        <Metric label="Verified revenue" value={snapshot.revenue.available ? snapshot.revenue.dem : "Not indexed"} note={snapshot.revenue.available ? `Plus ${snapshot.revenue.usdc}` : "Settlement amounts are not in the catalog"} />
        <Metric label="Jobs observed" value={String(snapshot.observedJobs)} note={`${snapshot.verifiedJobs} pass the full proof policy`} />
        <Metric label="Delivery record" value={rate} note={snapshot.deliveryRate === null ? "No verified completion rate yet" : "Across recorded agreements"} tone="good" />
        <Metric label="Needs attention" value={String(snapshot.needsAttention)} note="Delivery or proof requires action" tone={snapshot.needsAttention > 0 ? "warm" : "good"} />
      </div>
      <div className="business-overview-grid">
        <section className="business-panel business-volume-panel">
          <div className="business-panel-head"><div><span>Commercial momentum</span><h3>Settled volume</h3></div><div className="business-chart-key"><span><i className="dem" />DEM</span><span><i className="usdc" />USDC</span></div></div>
          <VolumeChart snapshot={snapshot} />
        </section>
        <section className="business-panel business-attention-panel">
          <div className="business-panel-head"><div><span>Action centre</span><h3>Needs attention</h3></div><button onClick={() => onNavigate("activity")}>View all</button></div>
          {snapshot.activity.filter((item) => item.status === "Needs delivery" || item.status === "Verification pending").slice(0, 3).map((item) => (
            <button className="business-attention-row" key={item.id} onClick={() => onNavigate("activity")}>
              <span className={item.status === "Needs delivery" ? "urgent" : "pending"}>{item.status === "Needs delivery" ? "!" : "⌁"}</span>
              <span><strong>{item.service}</strong><small>{item.status} · {item.when}</small></span><b>→</b>
            </button>
          ))}
          {snapshot.needsAttention === 0 && <div className="business-all-clear"><span>✓</span><strong>You are all caught up.</strong><small>There is no indexed work waiting for action.</small></div>}
        </section>
      </div>
      <section className="business-panel">
        <div className="business-panel-head"><div><span>Your storefront</span><h3>Active listings</h3></div><button onClick={() => onNavigate("listings")}>Manage listings</button></div>
        <ListingTable listings={snapshot.listings.slice(0, 4)} claim={snapshot.claim} compact />
      </section>
    </div>
  );
}

function Listings({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="business-view">
      <section className="business-view-intro"><div><h2>Services buyers can discover</h2><p>Manage the commercial surface of your agent without exposing protocol internals.</p></div><Link href="/register" className="btn">+ Publish a service</Link></section>
      <div className="business-listing-summary">
        <span><strong>{snapshot.listingCount}</strong> live listings</span><i />
        <span><strong>{snapshot.listings.reduce((sum, item) => sum + (item.orders ?? 0), 0) || "—"}</strong> orders attributed</span><i />
        <span><strong>{new Set(snapshot.listings.flatMap((item) => item.rail.split(" · "))).size}</strong> settlement options</span>
      </div>
      <section className="business-panel"><ListingTable listings={snapshot.listings} claim={snapshot.claim} /></section>
      {snapshot.listings.length === 0 && <EmptyPanel title="Publish your first service" copy="Once its anchor is indexed, buyers and agents will be able to discover it here." />}
    </div>
  );
}

function ListingTable({ listings, claim, compact = false }: { listings: ConsoleListing[]; claim: string; compact?: boolean }) {
  if (listings.length === 0) return <div className="business-table-empty">No active listings are indexed for this provider.</div>;
  return (
    <div className="business-table-wrap">
      <table className="business-table">
        <thead><tr><th>Service</th><th>Status</th><th>Terms</th><th>Settlement</th>{!compact && <th>Orders</th>}<th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{listings.map((listing) => (
          <tr key={listing.id}>
            <td><span className="business-service-cell"><i>{listing.title.slice(0, 1)}</i><span><strong>{listing.title}</strong><small>{listing.id}</small></span></span></td>
            <td><span className="business-live-state"><i />{listing.status}</span></td>
            <td><strong>{listing.terms}</strong></td><td>{listing.rail}</td>
            {!compact && <td>{listing.orders ?? "Not attributed"}</td>}
            <td><Link href={`/seller/${encodeURIComponent(claim)}`} aria-label={`Open ${listing.title}`}>↗</Link></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Activity({ snapshot, filter, setFilter, items }: { snapshot: Snapshot; filter: ActivityFilter; setFilter: (filter: ActivityFilter) => void; items: ConsoleActivity[] }) {
  return (
    <div className="business-view">
      <section className="business-view-intro"><div><h2>Every agreement, one clear timeline</h2><p>Separate commercial status from proof status so operators know what to do next.</p></div></section>
      <div className="business-segmented" aria-label="Filter business activity">
        {(["all", "attention", "completed"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? `All (${snapshot.activity.length})` : value === "attention" ? `Needs attention (${snapshot.needsAttention})` : "Completed"}</button>)}
      </div>
      <section className="business-panel business-activity-list">
        {items.map((item) => (
          <article key={item.id}>
            <span className={`business-activity-mark ${item.status.toLowerCase().replaceAll(" ", "-")}`}>{item.status === "Completed" ? "✓" : item.status === "Needs delivery" ? "!" : "⌁"}</span>
            <div className="business-activity-main"><span>{item.id}</span><strong>{item.service}</strong><small>Customer · {item.customer}</small></div>
            <div><span>Commercial state</span><strong>{item.status}</strong><small>{item.when}</small></div>
            <div><span>Value / rail</span><strong>{item.value}</strong><small className={`business-proof ${item.proof.toLowerCase()}`}>{item.proof} proof</small></div>
            <button aria-label={`Open ${item.id}`}>→</button>
          </article>
        ))}
        {items.length === 0 && <div className="business-table-empty">Nothing matches this view.</div>}
      </section>
    </div>
  );
}

function Revenue({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="business-view">
      <section className="business-view-intro"><div><h2>Revenue without false conversions</h2><p>Each asset remains separate until the operator chooses a trusted valuation source.</p></div><button className="btn secondary">Export activity</button></section>
      {!snapshot.revenue.available && <div className="business-data-gap"><span>Data gap</span><strong>Settlement amounts are not part of the current catalog projection.</strong><p>The UI can identify rails and verified outcomes, but it will not infer revenue from incomplete evidence.</p></div>}
      <div className="business-revenue-totals">
        <article><span className="business-asset dem">D</span><div><small>Verified DEM revenue</small><strong>{snapshot.revenue.dem}</strong><span>Demos settlement rail</span></div></article>
        <article><span className="business-asset usdc">$</span><div><small>Verified USDC revenue</small><strong>{snapshot.revenue.usdc}</strong><span>x402 settlement rail</span></div></article>
      </div>
      <section className="business-panel business-revenue-chart"><div className="business-panel-head"><div><span>Last eight weeks</span><h3>Volume by settlement asset</h3></div><div className="business-chart-key"><span><i className="dem" />DEM</span><span><i className="usdc" />USDC</span></div></div><VolumeChart snapshot={snapshot} /></section>
      <p className="business-evidence-note"><span>✓</span>Revenue is counted only when the settlement evidence and completed outcome pass verification. DEM and USDC are never added together.</p>
    </div>
  );
}

function VolumeChart({ snapshot }: { snapshot: Snapshot }) {
  const hasData = snapshot.chart.some((point) => point.dem > 0 || point.usdc > 0);
  return (
    <div className={`business-chart ${hasData ? "" : "empty"}`}>
      <div className="business-chart-grid"><i /><i /><i /><i /></div>
      {snapshot.chart.map((point) => <div className="business-bar-group" key={point.label}><span className="business-bar dem" style={{ height: `${Math.max(point.dem, hasData ? 3 : 0)}%` }} /><span className="business-bar usdc" style={{ height: `${Math.max(point.usdc, hasData ? 3 : 0)}%` }} /><small>{point.label}</small></div>)}
      {!hasData && <span className="business-chart-empty">Verified settlement amounts will appear here.</span>}
    </div>
  );
}

function Reputation({ snapshot }: { snapshot: Snapshot }) {
  const rate = snapshot.deliveryRate === null ? "—" : `${(snapshot.deliveryRate * 100).toFixed(1)}%`;
  return (
    <div className="business-view">
      <section className="business-reputation-hero">
        <div className="business-reputation-score"><span>{rate}</span><small>delivery record</small></div>
        <div><p className="eyebrow">Portable commercial reputation</p><h2>Trust earned through outcomes.</h2><p>This view distinguishes cryptographically verified evidence from activity the indexer has merely observed.</p></div>
      </section>
      <section className="business-panel business-evidence-stack">
        <div className="business-panel-head"><div><span>Evidence ladder</span><h3>What buyers can trust</h3></div><Link href={`/seller/${encodeURIComponent(snapshot.claim)}`}>Public profile ↗</Link></div>
        {snapshot.evidence.map((item, index) => (
          <article key={item.label}><span className={`business-evidence-number ${item.state.toLowerCase().replace(" ", "-")}`}>{item.state === "Verified" ? "✓" : index + 1}</span><div><strong>{item.label}</strong><p>{item.detail}</p></div><span className={`business-evidence-state ${item.state.toLowerCase().replace(" ", "-")}`}>{item.state}</span></article>
        ))}
      </section>
      <div className="business-reputation-stats"><Metric label="Fully verified outcomes" value={String(snapshot.verifiedJobs)} note="Signatures and referenced evidence pass" /><Metric label="Observed agreements" value={String(snapshot.observedJobs)} note="Useful context, not automatically proof" /><Metric label="Live capabilities" value={String(snapshot.listingCount)} note="Discoverable in the open market" /></div>
    </div>
  );
}

function AgentAccess({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <div className="business-view">
      <section className="business-agent-hero"><div className="business-agent-orbit" aria-hidden="true"><span>AI</span><i /><i /><i /></div><div><p className="eyebrow">Built for autonomous buyers</p><h2>Your storefront has a machine-readable entrance.</h2><p>Humans use this console. Agents discover the same market through the DACS manifest and catalog endpoints.</p></div></section>
      <div className="business-agent-grid">
        <section className="business-panel"><div className="business-panel-head"><div><span>Market entry</span><h3>Agent manifest</h3></div><span className="business-live-state"><i />Live</span></div><p className="business-panel-copy">The stable starting point for an agent entering the DACS market.</p><div className="business-endpoint"><code>/.well-known/dacs.json</code><button onClick={onCopy}>{copied ? "Copied ✓" : "Copy URL"}</button></div><a href="/.well-known/dacs.json" className="business-inline-link">Open manifest ↗</a></section>
        <section className="business-panel"><div className="business-panel-head"><div><span>Discovery API</span><h3>Listings catalog</h3></div><span className="business-live-state"><i />Live</span></div><p className="business-panel-copy">Search capabilities, sellers, payment rails, and supported delivery methods.</p><div className="business-endpoint"><code>/api/dacs/listings</code><span>GET</span></div><a href="/api/dacs/listings" className="business-inline-link">Inspect response ↗</a></section>
      </div>
      <section className="business-panel business-capability-roadmap"><div className="business-panel-head"><div><span>Commercial interfaces</span><h3>How agents will do business with you</h3></div></div><div><article className="live"><span>01</span><strong>Discover</strong><p>Capabilities and compatibility are available now.</p><small>Live</small></article><article><span>02</span><strong>Request a quote</strong><p>Structured RFQs will let buyers state intent and constraints.</p><small>Planned</small></article><article><span>03</span><strong>Negotiate</strong><p>Agents can exchange terms before committing to an agreement.</p><small>Planned</small></article><article className="live"><span>04</span><strong>Verify</strong><p>Outcomes and reputation remain independently checkable.</p><small>Live</small></article></div></section>
    </div>
  );
}

function EmptyPanel({ title, copy }: { title: string; copy: string }) {
  return <section className="business-inline-empty"><span>✦</span><div><strong>{title}</strong><p>{copy}</p></div></section>;
}
