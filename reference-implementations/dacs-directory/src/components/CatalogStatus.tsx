"use client";
/**
 * Catalog-freshness chip — how far the catalog (a cache, §6.3.6) trails the
 * chain. Reindexing is an authenticated operational action, never a public UI
 * side effect. Green when the cursor is at the tip, amber when it trails.
 */
import { useEffect, useState } from "react";
import { DEAD_LETTER_MAX_LIMIT } from "../catalog/statusDiagnostics.js";

/** The public listing-rejection part of a status reply. */
export interface ListingRejectionDiagnostics {
  total: number;
  publicTotal: number;
  items: Array<{
    locator: string;
    listingId?: string;
    listingVersion?: number;
    code: string;
    message: string;
    guidance: string;
    publicNotice: boolean;
  }>;
}

export interface Status {
  generatedAt: number;
  syncedToTx: number;
  chainLatestTx: number | null;
  txsBehind: number | null;
  indexer?: {
    lastRun?: { status: "running" | "complete" | "failed" } | null;
    listingRejectionDiagnostics?: ListingRejectionDiagnostics;
  };
}

/** Render unresolved authenticated pointer failures and the total when the reply lists fewer. */
export function ListingRejectionNotice({ rejected }: { rejected: ListingRejectionDiagnostics }) {
  const notices = rejected.items.filter((item) => item.publicNotice);
  if (rejected.publicTotal === 0) return null;
  return (
    <details className="listing-rejection-notice">
      <summary>{rejected.publicTotal.toLocaleString()} listing pointer{rejected.publicTotal === 1 ? "" : "s"} could not be indexed</summary>
      <p>Unresolved diagnostics may be retained from an earlier indexing pass for owner-signed registrations and publisher-authenticated hash declarations. Check the registration's storage pointers and the content hashes your discovery index declares, then submit a signed update. Historical versions remain immutable and do not require seller action.</p>
      <ul>
        {notices.map((item, index) => (
          // Two registrations can share a pointer, and the reply omits their claims.
          <li key={`${index}:${item.locator}:${item.code}`}>
            <strong>{item.listingId ?? item.locator}{item.listingVersion ? ` · version ${item.listingVersion}` : ""}</strong>
            <span>{item.message}</span>
            <span>{item.guidance}</span>
            <code>{item.code}</code>
          </li>
        ))}
      </ul>
      {notices.length < rejected.publicTotal && (
        <p className="listing-rejection-truncated">
          Showing {notices.length.toLocaleString()} of {rejected.publicTotal.toLocaleString()}.{" "}
          <a href={`/api/dacs/status?deadLetterLimit=${DEAD_LETTER_MAX_LIMIT}`}>List up to {DEAD_LETTER_MAX_LIMIT}</a>, or look up one
          pointer with <code>?locator=</code>.
        </p>
      )}
    </details>
  );
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function CatalogStatus() {
  const [status, setStatus] = useState<Status | null>(null);

  const load = () =>
    fetch("/api/dacs/status")
      .then((r) => r.json())
      .then((s: Status) => setStatus(s))
      .catch(() => {});

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  return status && <CatalogStatusView status={status} />;
}

/** The freshness chip once a catalog has been saved, and public listing notices even before that. */
export function CatalogStatusView({ status }: { status: Status }) {
  const rejected = status.indexer?.listingRejectionDiagnostics;
  const notice = rejected && rejected.publicTotal > 0 ? <ListingRejectionNotice rejected={rejected} /> : null;
  if (status.generatedAt === 0) return notice ? <div className="catalog-status">{notice}</div> : null;

  const behind = status.txsBehind;
  const inSync = behind !== null && behind === 0;
  const cls = behind === null ? "" : inSync ? "ok" : "warn";
  const label = behind === null
      ? `synced to tx ${status.syncedToTx.toLocaleString()}`
      : inSync
        ? "in sync with chain"
        : `${behind.toLocaleString()} tx${behind === 1 ? "" : "s"} behind chain`;

  return (
    <div className="catalog-status">
      <span
        className={`sync-chip ${cls}`}
        role="status"
        aria-live="polite"
        title={`Catalog scan cursor: tx ${status.syncedToTx.toLocaleString()}${
          status.chainLatestTx !== null ? ` · chain tip: tx ${status.chainLatestTx.toLocaleString()}` : ""
        } · last indexed ${new Date(status.generatedAt).toLocaleString()}. The catalog is a cache of chain state and is refreshed by the operator.`}
      >
        <span className="sync-dot" />
        {label} · indexed {ago(status.generatedAt)}
      </span>
      {notice}
    </div>
  );
}
