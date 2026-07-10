"use client";
/**
 * Catalog-freshness chip — how far the catalog (a cache, §6.3.6) trails the
 * chain. Reindexing is an authenticated operational action, never a public UI
 * side effect. Green when the cursor is at the tip, amber when it trails.
 */
import { useEffect, useState } from "react";

interface Status {
  generatedAt: number;
  syncedToTx: number;
  chainLatestTx: number | null;
  txsBehind: number | null;
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

  if (!status || status.generatedAt === 0) return null;

  const behind = status.txsBehind;
  const inSync = behind !== null && behind === 0;
  const cls = behind === null ? "" : inSync ? "ok" : "warn";
  const label = behind === null
      ? `synced to tx ${status.syncedToTx.toLocaleString()}`
      : inSync
        ? "in sync with chain"
        : `${behind.toLocaleString()} tx${behind === 1 ? "" : "s"} behind chain`;

  return (
    <span
      className={`sync-chip ${cls}`}
      title={`Catalog scan cursor: tx ${status.syncedToTx.toLocaleString()}${
        status.chainLatestTx !== null ? ` · chain tip: tx ${status.chainLatestTx.toLocaleString()}` : ""
      } · last indexed ${new Date(status.generatedAt).toLocaleString()}. The catalog is a cache of chain state and is refreshed by the operator.`}
    >
      <span className="sync-dot" />
      {label} · indexed {ago(status.generatedAt)}
    </span>
  );
}
